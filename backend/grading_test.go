package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

type gradingSummary struct {
	StudentID      int64    `json:"student_id"`
	SubjectID      int64    `json:"subject_id"`
	GroupID        int64    `json:"group_id"`
	Average        *float64 `json:"average"`
	FinalHint      *int     `json:"final_hint"`
	RequiredTotal  int      `json:"required_total"`
	RequiredPassed int      `json:"required_passed"`
}

type gradingState struct {
	Summaries []gradingSummary `json:"grade_summaries"`
	Labs      []struct {
		ID         int64
		Weight     float64
		WeightText string `json:"weight_text"`
		Required   bool
	}
	Grades []json.RawMessage
	Users  []struct{ ID int64 }
}

// Synthetic, freshly signed initData exercises the real auth path locally only.
func gradingRequest(t *testing.T, s *server, uid int64, body []byte, status int) []byte {
	t.Helper()
	method, path := http.MethodGet, "/api/state"
	if body != nil {
		method, path = http.MethodPost, "/api/command"
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	q := url.Values{"auth_date": {strconv.FormatInt(time.Now().Unix(), 10)}, "user": {fmt.Sprintf(`{"id":%d}`, uid)}}
	r.Header.Set("Authorization", "tma "+sign(q, s.token))
	r.Header.Set("Idempotency-Key", fmt.Sprintf("weighted-%d", time.Now().UnixNano()))
	w := httptest.NewRecorder()
	if body == nil {
		s.auth(s.state)(w, r)
	} else {
		s.auth(s.command)(w, r)
	}
	if w.Code != status {
		t.Fatalf("HTTP %d, want %d: %s", w.Code, status, w.Body.String())
	}
	return w.Body.Bytes()
}

func gradingSnapshot(t *testing.T, s *server, uid int64) gradingState {
	t.Helper()
	var state gradingState
	if err := json.Unmarshal(gradingRequest(t, s, uid, nil, 200), &state); err != nil {
		t.Fatal(err)
	}
	if state.Summaries == nil {
		t.Fatal("grade_summaries must be an array, not null or missing")
	}
	return state
}

func TestWeightedGradingArithmetic(t *testing.T) {
	s, ctx := notificationETAServer(t)
	s.token = "synthetic-weighted:test"
	type lab struct {
		weight   string
		required bool
		grade    *int
		archived bool
		nullRow  bool
	}
	integer := func(v int) *int { return &v }
	number := func(v float64) *float64 { return &v }
	cases := []struct {
		name          string
		labs          []lab
		average       *float64
		hint          *int
		total, passed int
	}{
		{"no labs", nil, nil, nil, 0, 0},
		{"required missing", []lab{{weight: "1", required: true}}, number(2), nil, 1, 0},
		{"required null", []lab{{weight: "1", required: true, nullRow: true}}, number(2), nil, 1, 0},
		{"required 2", []lab{{weight: "1", required: true, grade: integer(2)}}, number(2), nil, 1, 0},
		{"required 3", []lab{{weight: "1", required: true, grade: integer(3)}}, number(3), integer(3), 1, 1},
		{"required 5", []lab{{weight: "1", required: true, grade: integer(5)}}, number(5), integer(5), 1, 1},
		{"optional missing", []lab{{weight: "1"}}, nil, nil, 0, 0},
		{"optional null", []lab{{weight: "1", nullRow: true}}, nil, nil, 0, 0},
		{"optional 2 does not gate", []lab{{weight: "1", grade: integer(2)}}, number(2), integer(2), 0, 0},
		{"optional excludes denominator", []lab{{weight: "1", required: true, grade: integer(5)}, {weight: "100"}, {weight: "100", nullRow: true}}, number(5), integer(5), 1, 1},
		{"optional weighted 2", []lab{{weight: "1", required: true, grade: integer(5)}, {weight: "3", grade: integer(2)}}, number(2.75), integer(3), 1, 1},
		{"weighted missing required", []lab{{weight: "3", required: true}, {weight: "1", required: true, grade: integer(5)}}, number(2.75), nil, 2, 1},
		{"half up 3.5", []lab{{weight: "1", required: true, grade: integer(3)}, {weight: "1", required: true, grade: integer(4)}}, number(3.5), integer(4), 2, 2},
		{"half up 4.5", []lab{{weight: "1", required: true, grade: integer(4)}, {weight: "1", required: true, grade: integer(5)}}, number(4.5), integer(5), 2, 2},
		{"no double rounding below 3.5", []lab{{weight: "501", required: true, grade: integer(3)}, {weight: "499", required: true, grade: integer(4)}}, number(3.5), integer(3), 2, 2},
		{"no double rounding below 4.5", []lab{{weight: "501", required: true, grade: integer(4)}, {weight: "499", required: true, grade: integer(5)}}, number(4.5), integer(4), 2, 2},
		{"display half up", []lab{{weight: "0.505", grade: integer(4)}, {weight: "0.495", grade: integer(5)}}, number(4.5), integer(4), 0, 0},
		{"display avoids intermediate division rounding", []lab{{weight: "0.505000000000000000001", grade: integer(4)}, {weight: "0.494999999999999999999", grade: integer(5)}}, number(4.49), integer(4), 0, 0},
		{"exact hint below half at high precision", []lab{{weight: "0.500000000000000000001", grade: integer(4)}, {weight: "0.499999999999999999999", grade: integer(5)}}, number(4.5), integer(4), 0, 0},
		{"above half", []lab{{weight: "499", grade: integer(2)}, {weight: "501", grade: integer(3)}}, number(2.5), integer(3), 0, 0},
		{"fractional weights", []lab{{weight: "0.125", required: true, grade: integer(3)}, {weight: "0.375", required: true, grade: integer(5)}}, number(4.5), integer(5), 2, 2},
		{"tiny weights", []lab{{weight: "1e-300", grade: integer(3)}, {weight: "1e-300", grade: integer(4)}}, number(3.5), integer(4), 0, 0},
		{"archived excluded", []lab{{weight: "100", required: true, grade: integer(2), archived: true}, {weight: "1", grade: integer(5)}}, number(5), integer(5), 0, 0},
		{"only archived", []lab{{weight: "1", required: true, archived: true}}, nil, nil, 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			notificationETAExec(t, s, ctx, "DELETE FROM grades; DELETE FROM labs")
			active := false
			for i, l := range tc.labs {
				id := int64(i + 1)
				notificationETAExec(t, s, ctx, "INSERT INTO labs(id,subject_id,group_id,number,name,weight,required,archived) VALUES($1::bigint,1,1,$1::int,'Synthetic lab',$2::numeric,$3,$4)", id, l.weight, l.required, l.archived)
				if !l.archived {
					active = true
				}
				if l.grade != nil || l.nullRow {
					notificationETAExec(t, s, ctx, "INSERT INTO grades(student_id,lab_id,value) VALUES(3001,$1,$2)", id, l.grade)
				}
			}
			state := gradingSnapshot(t, s, 3001)
			if !active {
				if len(state.Summaries) != 0 {
					t.Fatalf("no active board: %+v", state.Summaries)
				}
				return
			}
			if len(state.Summaries) != 10 {
				t.Fatalf("want all 10 classmates, got %d", len(state.Summaries))
			}
			got := state.Summaries[0]
			want := gradingSummary{StudentID: 3001, SubjectID: 1, GroupID: 1, Average: tc.average, FinalHint: tc.hint, RequiredTotal: tc.total, RequiredPassed: tc.passed}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %+v average=%v hint=%v; want %+v", got, got.Average, got.FinalHint, want)
			}
		})
	}
}

func TestWeightedSummaryNoStudents(t *testing.T) {
	s, ctx := notificationETAServer(t)
	s.token = "synthetic-weighted:test"
	notificationETAExec(t, s, ctx, `INSERT INTO groups(id,name) VALUES(2,'Empty group');
		INSERT INTO labs(subject_id,group_id,number,name) VALUES(1,2,1,'Empty board')`)
	state := gradingSnapshot(t, s, 1001)
	if len(state.Labs) != 1 || len(state.Summaries) != 0 {
		t.Fatalf("board without students: %+v", state)
	}
}

func TestWeightedLabMetadata(t *testing.T) {
	s, ctx := acceptanceServer(t)
	s.dev = false
	s.token = "synthetic-weighted:test"
	request := func(uid int64, body string, status int) { t.Helper(); gradingRequest(t, s, uid, []byte(body), status) }
	request(2001, `{"kind":"lab","subject_id":1,"group_id":1,"number":1,"name":"Old client"}`, 200)
	state := gradingSnapshot(t, s, 2001)
	if len(state.Labs) != 1 || state.Labs[0].Weight != 1 || !state.Labs[0].Required {
		t.Fatalf("bad defaults: %+v", state.Labs)
	}
	request(2001, `{"kind":"lab","id":1,"number":1,"name":"Weighted","weight":0.123456789,"required":false}`, 200)
	request(2001, `{"kind":"lab","id":1,"number":1,"name":"Legacy rename"}`, 200)
	state = gradingSnapshot(t, s, 2001)
	if state.Labs[0].Weight != 0.123456789 || state.Labs[0].Required {
		t.Fatalf("legacy edit lost metadata: %+v", state.Labs)
	}
	request(2001, `{"kind":"lab","id":1,"number":1,"name":"Archive","enabled":true}`, 200)
	state = gradingSnapshot(t, s, 2001)
	if len(state.Summaries) != 0 || state.Labs[0].Weight != 0.123456789 || state.Labs[0].Required {
		t.Fatal("archive lost metadata or retained summary")
	}
	request(2001, `{"kind":"lab","id":1,"number":1,"name":"Restore","required":true}`, 200)
	state = gradingSnapshot(t, s, 2001)
	if state.Labs[0].Weight != 0.123456789 || !state.Labs[0].Required {
		t.Fatal("required-only edit changed weight")
	}
	request(2001, `{"kind":"lab","id":1,"number":1,"name":"Weight only","weight":1000000}`, 200)
	state = gradingSnapshot(t, s, 2001)
	if state.Labs[0].Weight != 1000000 || !state.Labs[0].Required {
		t.Fatal("weight-only edit changed required")
	}
	for _, weight := range []string{"0", "-1", "1000000.00001", "1e309", `"NaN"`, `"Infinity"`} {
		request(2001, fmt.Sprintf(`{"kind":"lab","id":1,"number":1,"name":"Invalid","weight":%s}`, weight), 400)
	}
	for _, weight := range []string{"5e-324", "0.000000001", "1000000"} {
		request(2001, fmt.Sprintf(`{"kind":"lab","id":1,"number":1,"name":"Valid","weight":%s}`, weight), 200)
	}
	request(3001, `{"kind":"lab","id":1,"number":1,"name":"No","weight":2}`, 403)
	request(2001, `{"kind":"lab","subject_id":1,"group_id":2,"number":1,"name":"No","weight":2}`, 403)
	request(1001, `{"kind":"lab","subject_id":1,"group_id":1,"number":2,"name":"Optional create","weight":2.75,"required":false,"grade_summaries":[{"average":5,"final_hint":5}]}`, 200)
	state = gradingSnapshot(t, s, 3001)
	if len(state.Labs) != 2 || state.Labs[1].Weight != 2.75 || state.Labs[1].Required {
		t.Fatalf("explicit create metadata: %+v", state.Labs)
	}
	if len(state.Summaries) != 10 || state.Summaries[0].Average == nil || *state.Summaries[0].Average != 2 || state.Summaries[0].FinalHint != nil {
		t.Fatal("client-supplied summary affected server calculation")
	}
	// Internal callers must not bypass decimal grammar or finite validation.
	for _, v := range []json.Number{"NaN", "Infinity", "-Infinity", "1/2", "0x1p0"} {
		tx, err := s.db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		err = s.execute(ctx, tx, 2001, command{Kind: "lab", ID: 1, Number: 1, Name: "Nonfinite", Weight: &v})
		tx.Rollback(ctx)
		if p, ok := err.(problem); !ok || p.Code != 400 {
			t.Fatalf("nonfinite accepted: %v", err)
		}
	}
	// Auth failures cannot read the derived statistics, even with a dev header.
	r := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	r.Header.Set("X-Dev-User", "1001")
	w := httptest.NewRecorder()
	s.auth(s.state)(w, r)
	if w.Code != 401 {
		t.Fatalf("unsigned state HTTP %d", w.Code)
	}
}

func TestWeightedExactDecimalAPI(t *testing.T) {
	for _, quoted := range []bool{false, true} {
		t.Run(fmt.Sprintf("quoted=%t", quoted), func(t *testing.T) {
			s, _ := acceptanceServer(t)
			s.dev = false
			s.token = "synthetic-weighted:test"
			encodeWeight := func(text string) string {
				if quoted {
					b, _ := json.Marshal(text)
					return string(b)
				}
				return text
			}
			weights := []string{"0.500000000000000000001", "0.499999999999999999999"}
			for i, weight := range weights {
				gradingRequest(t, s, 2001, []byte(fmt.Sprintf(`{"kind":"lab","subject_id":1,"group_id":1,"number":%d,"name":"Exact decimal","weight":%s}`, i+1, encodeWeight(weight))), 200)
				gradingRequest(t, s, 2001, []byte(fmt.Sprintf(`{"kind":"grade","lab_id":%d,"user_id":3001,"value":%d}`, i+1, i+4)), 200)
			}
			check := func() {
				t.Helper()
				state := gradingSnapshot(t, s, 3001)
				if len(state.Labs) != 2 {
					t.Fatalf("labs: %+v", state.Labs)
				}
				for i, lab := range state.Labs {
					if lab.WeightText != weights[i] {
						t.Fatalf("weight lost precision: %q, want %q", lab.WeightText, weights[i])
					}
				}
				summary := state.Summaries[0]
				if summary.Average == nil || *summary.Average != 4.5 || summary.FinalHint == nil || *summary.FinalHint != 4 {
					t.Fatalf("below-half pair rounded before aggregation: %+v", summary)
				}
			}
			check()
			// Exact text returned to a form must survive a quoted-weight edit;
			// old clients that omit weight must preserve that precision too.
			for i, lab := range gradingSnapshot(t, s, 2001).Labs {
				body, _ := json.Marshal(map[string]any{"kind": "lab", "id": lab.ID, "number": i + 1, "name": "Form roundtrip", "weight": lab.WeightText})
				gradingRequest(t, s, 2001, body, 200)
			}
			gradingRequest(t, s, 2001, []byte(`{"kind":"lab","id":1,"number":1,"name":"Legacy rename"}`), 200)
			check()
			for _, invalid := range []string{"1000000.00000000001", "1000000.0000000000000000000001", "1e-16384", "1e131073", "1e999999999999999999999999999999", "1e-999999999999999999999999999999", "0e999999999999999999999999999999"} {
				gradingRequest(t, s, 2001, []byte(fmt.Sprintf(`{"kind":"lab","id":1,"number":1,"name":"Reject","weight":%s}`, encodeWeight(invalid))), 400)
			}
			check()
			for _, valid := range []string{"1000000.000000000000000000000", "999999.999999999999999999999", "0." + strings.Repeat("0", 999) + "1", "0." + strings.Repeat("0", 16382) + "1"} {
				gradingRequest(t, s, 2001, []byte(fmt.Sprintf(`{"kind":"lab","id":1,"number":1,"name":"Exact range","weight":%s}`, encodeWeight(valid))), 200)
				if got := gradingSnapshot(t, s, 2001).Labs[0].WeightText; got != valid {
					t.Fatalf("exact accepted value changed: length %d, want length %d", len(got), len(valid))
				}
			}
			// Quoted values obey decimal grammar, not rational/hex syntax.
			for _, invalid := range []string{"1/2", "NaN", "Infinity", "0x1p0", "+1", "01", ".5", "1.", " 1", "1 "} {
				body, _ := json.Marshal(map[string]any{"kind": "lab", "id": 1, "number": 1, "name": "Bad string", "weight": invalid})
				gradingRequest(t, s, 2001, body, 400)
			}
		})
	}
}

func TestWeightedDualRoleMembership(t *testing.T) {
	s, ctx := acceptanceServer(t)
	s.dev = false
	s.token = "synthetic-weighted:test"
	notificationETAExec(t, s, ctx, `
		UPDATE users SET group_id=1 WHERE id=2001;
		INSERT INTO groups(id,name) VALUES(2,'Unrelated group');
		INSERT INTO subjects(id,name) VALUES(2,'Other subject');
		INSERT INTO users(id,name,group_id) VALUES(4001,'Other student',2);
		INSERT INTO labs(id,subject_id,group_id,number,name) VALUES
			(1,1,1,1,'Own assigned'),(2,2,1,1,'Own unassigned'),
			(3,1,2,1,'Other assigned'),(4,2,2,1,'Other unassigned');
		INSERT INTO assignments VALUES(1,2,2001);
		INSERT INTO grades(student_id,lab_id,value) VALUES(2001,2,4),(4001,3,5),(4001,4,5);`)
	check := func(otherAssigned bool) {
		t.Helper()
		state := gradingSnapshot(t, s, 2001)
		wantLabs, wantSummaries, wantGrades := 2, 22, 1
		if otherAssigned {
			wantLabs, wantSummaries, wantGrades = 3, 23, 2
		}
		if len(state.Labs) != wantLabs || len(state.Summaries) != wantSummaries || len(state.Grades) != wantGrades {
			t.Fatalf("dual-role visibility: labs=%d summaries=%d grades=%d", len(state.Labs), len(state.Summaries), len(state.Grades))
		}
		for _, lab := range state.Labs {
			if lab.ID == 4 || (!otherAssigned && lab.ID == 3) {
				t.Fatalf("unrelated lab leaked: %d", lab.ID)
			}
		}
		ownSummary := false
		for _, summary := range state.Summaries {
			if summary.GroupID == 2 && (!otherAssigned || summary.SubjectID != 1) {
				t.Fatalf("unrelated summary leaked: %+v", summary)
			}
			if summary.StudentID == 2001 && summary.SubjectID == 2 && summary.GroupID == 1 {
				ownSummary = true
				if summary.Average == nil || *summary.Average != 4 || summary.FinalHint == nil || *summary.FinalHint != 4 || summary.RequiredPassed != 1 {
					t.Fatalf("dual-role own summary: %+v", summary)
				}
			}
		}
		if !ownSummary {
			t.Fatal("teacher's own student summary missing")
		}
		classmate := false
		for _, user := range state.Users {
			if user.ID == 3001 {
				classmate = true
			}
			if user.ID == 4001 && !otherAssigned {
				t.Fatal("revoked group member leaked")
			}
		}
		if !classmate {
			t.Fatal("teacher cannot read own-group classmates")
		}
	}
	check(true)
	gradingRequest(t, s, 1001, []byte(`{"kind":"assignment","subject_id":1,"group_id":2,"teacher_id":2001,"enabled":false}`), 200)
	check(false)
	// Every viewer sees the dual-role member's student summary as well.
	state := gradingSnapshot(t, s, 3001)
	found := false
	for _, summary := range state.Summaries {
		if summary.StudentID == 2001 && summary.SubjectID == 2 {
			found = true
		}
	}
	if !found {
		t.Fatal("classmate cannot see dual-role member's summary")
	}
	// Revoking the role must disable even a stale outside-group assignment,
	// without changing student membership or own-group read access.
	notificationETAExec(t, s, ctx, "INSERT INTO assignments VALUES(1,2,2001); UPDATE users SET teacher=false WHERE id=2001")
	check(false)
}

func TestWeightedSummaryScopeAndRevocation(t *testing.T) {
	s, ctx := acceptanceServer(t)
	s.dev = false
	s.token = "synthetic-weighted:test"
	notificationETAExec(t, s, ctx, `
	INSERT INTO groups(id,name) VALUES(2,'Other group');
	INSERT INTO subjects(id,name) VALUES(2,'Other subject');
	INSERT INTO users(id,name,group_id) VALUES(4001,'Other student',2);
	INSERT INTO labs(subject_id,group_id,number,name) VALUES(1,1,1,'A'),(2,1,1,'B'),(1,2,1,'C'),(2,2,1,'D');
	INSERT INTO grades(student_id,lab_id,value) SELECT 3001,id,5 FROM labs WHERE group_id=1;
	INSERT INTO grades(student_id,lab_id,value) SELECT 4001,id,5 FROM labs WHERE group_id=2;`)
	check := func(uid int64, labs, summaries, grades int) {
		t.Helper()
		state := gradingSnapshot(t, s, uid)
		if len(state.Labs) != labs || len(state.Summaries) != summaries || len(state.Grades) != grades {
			t.Fatalf("uid %d: labs=%d summaries=%d grades=%d", uid, len(state.Labs), len(state.Summaries), len(state.Grades))
		}
	}
	check(1001, 4, 22, 4)
	check(3001, 2, 20, 2)
	check(4001, 2, 2, 2)
	check(2001, 1, 10, 1)
	check(9001, 0, 0, 0)
	// A teacher who is also a student retains the whole own-group gradebook.
	notificationETAExec(t, s, ctx, "UPDATE users SET group_id=1 WHERE id=2001")
	check(2001, 2, 22, 2)
	gradingRequest(t, s, 1001, []byte(`{"kind":"assignment","subject_id":1,"group_id":1,"teacher_id":2001,"enabled":false}`), 200)
	check(2001, 2, 22, 2)
	gradingRequest(t, s, 2001, []byte(`{"kind":"lab","id":1,"number":1,"name":"Revoked","weight":2}`), 403)
	notificationETAExec(t, s, ctx, "UPDATE users SET group_id=NULL WHERE id=2001; INSERT INTO assignments VALUES(1,1,2001); UPDATE users SET teacher=false WHERE id=2001")
	check(2001, 0, 0, 0)
	gradingRequest(t, s, 2001, []byte(`{"kind":"lab","id":1,"number":1,"name":"Stale role","weight":2}`), 403)
	// A moved student's old grades must not create summaries in the old group.
	notificationETAExec(t, s, ctx, "UPDATE users SET group_id=2 WHERE id=3001")
	check(3001, 2, 4, 2)
}
