package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

type statisticsState struct {
	Boards []gradeStatistics `json:"grade_statistics"`
	Labs   []labStatistics   `json:"lab_statistics"`
}

func statisticsSnapshot(t *testing.T, s *server, uid int64) statisticsState {
	t.Helper()
	var state statisticsState
	if err := json.Unmarshal(gradingRequest(t, s, uid, nil, 200), &state); err != nil {
		t.Fatal(err)
	}
	if state.Boards == nil || state.Labs == nil {
		t.Fatal("statistics must be arrays, not null or missing")
	}
	return state
}

func statisticsNumber(s string) *json.Number { n := json.Number(s); return &n }

func TestStatisticsRosterCountsAndAccess(t *testing.T) {
	s, ctx := acceptanceServer(t)
	s.dev = false
	s.token = "synthetic-statistics:test"
	notificationETAExec(t, s, ctx, `
 DELETE FROM assignments;
 UPDATE users SET teacher=false WHERE id=1001;
 UPDATE users SET group_id=NULL;
 UPDATE users SET group_id=1 WHERE id IN (2001,3001);
 INSERT INTO groups(id,name) VALUES(2,'Empty'),(3,'Optional only'),(4,'No labs');
 INSERT INTO subjects(id,name) VALUES(2,'Other subject');
 INSERT INTO users(id,name,group_id) VALUES(4001,'Optional student',3),(4002,'No labs student',4);
 INSERT INTO labs(id,subject_id,group_id,number,name,weight,required,archived) VALUES
 (1,1,1,1,'Required weighted',3,true,false),
 (2,1,1,2,'Optional',1,false,false),
 (3,1,1,3,'Required',1,true,false),
 (4,1,1,4,'Archived',100,true,true),
 (5,2,2,1,'Empty roster',1,true,false),
 (6,2,3,1,'Optional without grades',1,false,false),
 (7,2,4,1,'Archived only',1,true,true);
 INSERT INTO grades(student_id,lab_id,value) VALUES
 (3001,1,5),(3001,2,2),(3001,3,NULL),(3001,4,2),
 (2001,1,3),(2001,3,4),
 (4001,1,2),(4001,5,5),(4001,6,NULL);`)
	want := statisticsState{
		Boards: []gradeStatistics{
			{SubjectID: 1, GroupID: 1, StudentsCount: 2, LabsCount: 3, RequiredLabsCount: 2, DebtorsCount: 1, FinalReadyCount: 1, Average: statisticsNumber("3.53"), Distribution: gradeDistribution{Missing: 2, Two: 1, Three: 1, Four: 1, Five: 1}},
			{SubjectID: 2, GroupID: 2, LabsCount: 1, RequiredLabsCount: 1},
			{SubjectID: 2, GroupID: 3, StudentsCount: 1, LabsCount: 1, Distribution: gradeDistribution{Missing: 1}},
		},
		Labs: []labStatistics{
			{LabID: 1, SubjectID: 1, GroupID: 1, StudentsCount: 2, GradedCount: 2, PassedCount: 2, Average: statisticsNumber("4.00")},
			{LabID: 2, SubjectID: 1, GroupID: 1, StudentsCount: 2, GradedCount: 1, FailedCount: 1, MissingCount: 1, Average: statisticsNumber("2.00")},
			{LabID: 3, SubjectID: 1, GroupID: 1, StudentsCount: 2, GradedCount: 1, PassedCount: 1, MissingCount: 1, Average: statisticsNumber("4.00")},
			{LabID: 5, SubjectID: 2, GroupID: 2},
			{LabID: 6, SubjectID: 2, GroupID: 3, StudentsCount: 1, MissingCount: 1},
		},
	}
	for _, uid := range []int64{1001, 2001} {
		if got := statisticsSnapshot(t, s, uid); !reflect.DeepEqual(got, want) {
			t.Fatalf("uid %d: got %+v / %+v; want %+v / %+v", uid, got.Boards, got.Labs, want.Boards, want.Labs)
		}
	}
	for _, uid := range []int64{3001, 4001, 4002, 9001} {
		got := statisticsSnapshot(t, s, uid)
		if len(got.Boards) != 0 || len(got.Labs) != 0 {
			t.Fatalf("student %d received statistics: %+v", uid, got)
		}
	}
	// A stale assignment cannot preserve statistics access after role revocation,
	// even when the former teacher remains enrolled in the board's roster.
	notificationETAExec(t, s, ctx, "INSERT INTO assignments VALUES(2,2,2001)")
	gradingRequest(t, s, 1001, []byte(`{"kind":"role","user_id":2001,"enabled":false}`), 200)
	got := statisticsSnapshot(t, s, 2001)
	if len(got.Boards) != 0 || len(got.Labs) != 0 {
		t.Fatalf("revoked role leaked statistics: %+v", got)
	}
	if state := gradingSnapshot(t, s, 2001); len(state.Summaries) != 2 {
		t.Fatalf("revocation lost own-group summaries: %+v", state.Summaries)
	}
	// Removing every active lab must remove boards rather than multiplying a
	// roster-only join or retaining archived boards.
	notificationETAExec(t, s, ctx, "UPDATE labs SET archived=true")
	got = statisticsSnapshot(t, s, 1001)
	if len(got.Boards) != 0 || len(got.Labs) != 0 {
		t.Fatalf("no active labs: %+v", got)
	}
}

func TestStatisticsExactArithmetic(t *testing.T) {
	s, ctx := acceptanceServer(t)
	s.dev = false
	s.token = "synthetic-statistics:test"
	notificationETAExec(t, s, ctx, `UPDATE users SET group_id=NULL; UPDATE users SET group_id=1 WHERE id IN (3001,3002)`)
	tests := []struct {
		name, setup, average string
		ready                int64
	}{
		{"equal student weights despite different denominators", `
   INSERT INTO labs(id,subject_id,group_id,number,name,weight,required) VALUES
   (1,1,1,1,'A',1,false),(2,1,1,2,'B',3,false);
   INSERT INTO grades(student_id,lab_id,value) VALUES(3001,1,4),(3002,1,5),(3002,2,2);`, "3.38", 2},
		{"do not average rounded summaries", `
   INSERT INTO labs(id,subject_id,group_id,number,name,weight,required) VALUES
   (1,1,1,1,'A',0.506,false),(2,1,1,2,'B',0.494,false),
   (3,1,1,3,'C',0.505,false),(4,1,1,4,'D',0.495,false);
   INSERT INTO grades(student_id,lab_id,value) VALUES(3001,1,4),(3001,2,5),(3002,3,4),(3002,4,5);`, "4.49", 2},
		{"exact decimal below half cent and ignore absent denominator", `
   INSERT INTO labs(id,subject_id,group_id,number,name,weight,required) VALUES
   (1,1,1,1,'A',0.505000000000000000001,false),
   (2,1,1,2,'B',0.494999999999999999999,false);
   INSERT INTO grades(student_id,lab_id,value) VALUES(3001,1,4),(3001,2,5);`, "4.49", 1},
		{"exact half cent", `
   INSERT INTO labs(id,subject_id,group_id,number,name,weight,required) VALUES
   (1,1,1,1,'A',0.505,false),(2,1,1,2,'B',0.495,false);
   INSERT INTO grades(student_id,lab_id,value) VALUES(3001,1,4),(3001,2,5);`, "4.50", 1},
		{"distinct denominators just below aggregate half cent", `
   INSERT INTO labs(id,subject_id,group_id,number,name,weight,required) VALUES
   (1,1,1,1,'A',51.000000000000000000001,false),(2,1,1,2,'B',49,false),
   (3,1,1,3,'C',1,false),(4,1,1,4,'D',1,false);
   INSERT INTO grades(student_id,lab_id,value) VALUES(3001,1,4),(3001,2,5),(3002,3,4),(3002,4,5);`, "4.49", 2},
		{"distinct denominators exactly aggregate half cent", `
   INSERT INTO labs(id,subject_id,group_id,number,name,weight,required) VALUES
   (1,1,1,1,'A',51,false),(2,1,1,2,'B',49,false),
   (3,1,1,3,'C',1,false),(4,1,1,4,'D',1,false);
   INSERT INTO grades(student_id,lab_id,value) VALUES(3001,1,4),(3001,2,5),(3002,3,4),(3002,4,5);`, "4.50", 2},
		{"tiny decimal weights", `
   INSERT INTO labs(id,subject_id,group_id,number,name,weight,required) VALUES
   (1,1,1,1,'A',1e-300,false),(2,1,1,2,'B',1e-300,false);
   INSERT INTO grades(student_id,lab_id,value) VALUES(3001,1,3),(3001,2,4);`, "3.50", 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			notificationETAExec(t, s, ctx, "DELETE FROM grades; DELETE FROM labs")
			notificationETAExec(t, s, ctx, tc.setup)
			got := statisticsSnapshot(t, s, 1001)
			if len(got.Boards) != 1 {
				t.Fatalf("boards: %+v", got.Boards)
			}
			b := got.Boards[0]
			if b.Average == nil || string(*b.Average) != tc.average || b.FinalReadyCount != tc.ready || b.DebtorsCount != 0 || b.StudentsCount != 2 {
				t.Fatalf("board %+v average %v, want %s ready %d", b, b.Average, tc.average, tc.ready)
			}
		})
	}
}

func TestStatisticsLabAverageHalfUp(t *testing.T) {
	s, ctx := acceptanceServer(t)
	s.token = "synthetic-statistics:test"
	notificationETAExec(t, s, ctx, `
 INSERT INTO labs(id,subject_id,group_id,number,name) VALUES(1,1,1,1,'Average');
 INSERT INTO users(id,name,group_id) SELECT 10000+n,'Synthetic',1 FROM generate_series(1,190) n;
 INSERT INTO grades(student_id,lab_id,value) SELECT id,1,CASE WHEN id=3001 THEN 5 ELSE 4 END FROM users WHERE group_id=1;`)
	got := statisticsSnapshot(t, s, 1001)
	if len(got.Labs) != 1 || got.Labs[0].Average == nil || *got.Labs[0].Average != "4.01" || got.Labs[0].StudentsCount != 200 {
		t.Fatalf("actual-grade average 801/200 must round half-up: %+v", got.Labs)
	}
}
