package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"

	"strings"
	"testing"
	"time"
)

func TestSubjectGroupsMigrationBackfillAndRerun(t *testing.T) {
	s, ctx := acceptanceServer(t)
	notificationETAExec(t, s, ctx, `DROP TABLE subject_groups;
 DELETE FROM schema_migrations WHERE version='0002_subject_groups.sql';
 INSERT INTO groups(id,name,archived) VALUES(2,'Archived',true),(3,'Unused',false);
 INSERT INTO subjects(id,name,archived) VALUES(2,'Historical',true),(3,'Unused',false);
 INSERT INTO labs(id,subject_id,group_id,number,name,archived) VALUES
 (1,1,1,1,'Active',false),(2,2,2,1,'Archived',true),(3,2,2,2,'Duplicate pair',true);
 INSERT INTO grades(student_id,lab_id,value) VALUES(3001,2,5);
 INSERT INTO events(id,name,subject_id,teacher_id,starts_at,state,strategy) VALUES
 (2,'Completed',1,2001,now(),'completed','fifo'),(3,'Cancelled',2,2001,now(),'cancelled','fifo');
 INSERT INTO event_groups VALUES(2,2),(3,1);
 INSERT INTO assignments VALUES(3,3,2001);`)
	before := map[string]string{}
	for _, table := range []string{"labs", "grades", "events", "event_groups", "entries", "assignments"} {
		var beforeValue *string
		if err := s.db.QueryRow(ctx, "SELECT jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text FROM "+table+" r").Scan(&beforeValue); err != nil {
			t.Fatal(err)
		}
		if beforeValue != nil {
			before[table] = *beforeValue
		}
	}
	if err := migrate(ctx, s.db); err != nil {
		t.Fatal(err)
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM subject_groups", 4)
	for _, pair := range [][2]int64{{1, 1}, {2, 2}, {1, 2}, {2, 1}} {
		notificationETACount(t, s, ctx, "SELECT count(*) FROM subject_groups WHERE subject_id=$1 AND group_id=$2", 1, pair[0], pair[1])
	}
	for table, want := range before {
		var got string
		if err := s.db.QueryRow(ctx, "SELECT jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text FROM "+table+" r").Scan(&got); err != nil || got != want {
			t.Fatalf("migration changed %s: %v", table, err)
		}
	}
	// Re-running startup must not recreate a deliberately removed historical pair.
	notificationETAExec(t, s, ctx, "DELETE FROM subject_groups WHERE subject_id=2 AND group_id=2")
	if err := migrate(ctx, s.db); err != nil {
		t.Fatal(err)
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM subject_groups", 3)
	for _, sql := range []string{
		"INSERT INTO subject_groups VALUES(1,1)",
		"INSERT INTO subject_groups VALUES(999,1)",
		"INSERT INTO subject_groups VALUES(1,999)",
	} {
		if _, err := s.db.Exec(ctx, sql); err == nil {
			t.Fatalf("missing pair constraint: %s", sql)
		}
	}
}

func TestSubjectCurriculumCreateEditAndPermissions(t *testing.T) {
	s, ctx := acceptanceServer(t)
	notificationETAExec(t, s, ctx, `SELECT setval(pg_get_serial_sequence('subjects','id'),1);
 INSERT INTO groups(id,name,archived) VALUES(2,'Active',false),(3,'Archived',true);`)
	for _, groups := range []*[]int64{nil, &[]int64{}, &[]int64{999}, &[]int64{0}, &[]int64{3}, &[]int64{1, 1}, &[]int64{1, 999}} {
		before := studentPermissionsRows(t, s, ctx)
		acceptanceCommand(t, s, 1001, command{Kind: "subject", Name: "Invalid", GroupIDs: groups}, 400)
		studentPermissionsUnchanged(t, s, ctx, before)
	}
	create := command{Kind: "subject", Name: " New subject ", GroupIDs: &[]int64{1, 2}}
	for _, uid := range []int64{2001, 3001} {
		before := studentPermissionsRows(t, s, ctx)
		acceptanceCommand(t, s, uid, create, 403)
		studentPermissionsUnchanged(t, s, ctx, before)
	}
	acceptanceCommand(t, s, 1001, create, 200, "curriculum-create")
	acceptanceCommand(t, s, 1001, create, 200, "curriculum-create")
	var id int64
	if err := s.db.QueryRow(ctx, "SELECT id FROM subjects WHERE name='New subject'").Scan(&id); err != nil {
		t.Fatal(err)
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM subject_groups WHERE subject_id=$1", 2, id)
	// Both omitted and JSON null preserve links, even when an assigned group is archived.
	notificationETAExec(t, s, ctx, "UPDATE groups SET archived=true WHERE id=2")
	acceptanceCommand(t, s, 1001, command{Kind: "subject", ID: id, Name: "Renamed", Enabled: true}, 200)
	r := httptest.NewRequest(http.MethodPost, "/api/command", strings.NewReader(fmt.Sprintf(`{"kind":"subject","id":%d,"name":"Null edit","group_ids":null}`, id)))
	r.Header.Set("Idempotency-Key", "curriculum-null")
	w := httptest.NewRecorder()
	s.command(w, r, 1001)
	if w.Code != 200 {
		t.Fatalf("null edit: %d %s", w.Code, w.Body.String())
	}
	acceptanceCommand(t, s, 1001, command{Kind: "subject", ID: id, Name: "Retained archived", GroupIDs: &[]int64{1, 2}}, 200)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM subject_groups WHERE subject_id=$1", 2, id)
	acceptanceCommand(t, s, 1001, command{Kind: "subject", ID: id, Name: "Empty curriculum", GroupIDs: &[]int64{}}, 200)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM subject_groups WHERE subject_id=$1", 0, id)
	before := studentPermissionsRows(t, s, ctx)
	acceptanceCommand(t, s, 1001, command{Kind: "subject", ID: id, Name: "Cannot re-add archived", GroupIDs: &[]int64{2}}, 400)
	acceptanceCommand(t, s, 1001, command{Kind: "subject", ID: 999, Name: "Missing", GroupIDs: &[]int64{}}, 400)
	studentPermissionsUnchanged(t, s, ctx, before)
}

func TestSubjectCurriculumUnlinkGuards(t *testing.T) {
	for _, blocker := range []string{"lab", "planned", "live"} {
		t.Run(blocker, func(t *testing.T) {
			s, ctx := acceptanceServer(t)
			notificationETAExec(t, s, ctx, `INSERT INTO groups(id,name) VALUES(2,'Second');
 INSERT INTO subject_groups VALUES(1,2);
 INSERT INTO labs(id,subject_id,group_id,number,name,archived) VALUES(1,1,2,1,'Historical',true);
 INSERT INTO grades(student_id,lab_id,value) VALUES(3001,1,4);`)
			if blocker == "lab" {
				notificationETAExec(t, s, ctx, "UPDATE labs SET archived=false WHERE id=1")
			} else {
				notificationETAExec(t, s, ctx, `INSERT INTO events(id,name,subject_id,teacher_id,starts_at,state,strategy)
 VALUES(2,'Blocking event',1,2001,now(),$1,'fifo');`, blocker)
				notificationETAExec(t, s, ctx, "INSERT INTO event_groups VALUES(2,2)")
			}
			before := studentPermissionsRows(t, s, ctx)
			edit := command{Kind: "subject", ID: 1, Name: "Changed", GroupIDs: &[]int64{1}}
			acceptanceCommand(t, s, 1001, edit, 400)
			acceptanceCommand(t, s, 1001, command{Kind: "subject", ID: 1, Name: "Empty", GroupIDs: &[]int64{}}, 400)
			studentPermissionsUnchanged(t, s, ctx, before)
			// Error identifies the group and gives a concrete recovery path.
			r := httptest.NewRequest(http.MethodPost, "/api/command", strings.NewReader(`{"kind":"subject","id":1,"name":"Changed","group_ids":[1]}`))
			r.Header.Set("Idempotency-Key", "guard-message")
			w := httptest.NewRecorder()
			s.command(w, r, 1001)
			if w.Code != 400 || !strings.Contains(w.Body.String(), "группу 2") || !strings.Contains(w.Body.String(), "архивируйте") {
				t.Fatalf("unlink error: %d %s", w.Code, w.Body.String())
			}
			notificationETAExec(t, s, ctx, "UPDATE labs SET archived=true; UPDATE events SET state='cancelled' WHERE id=2")
			acceptanceCommand(t, s, 1001, edit, 200)
			notificationETACount(t, s, ctx, "SELECT count(*) FROM subject_groups WHERE group_id=2", 0)
			notificationETACount(t, s, ctx, "SELECT count(*) FROM labs", 1)
			notificationETACount(t, s, ctx, "SELECT count(*) FROM grades", 1)
			if blocker != "lab" {
				notificationETACount(t, s, ctx, "SELECT count(*) FROM event_groups WHERE event_id=2", 1)
			}
		})
	}
}

func TestCurriculumForgedPairsVisibilityAndRevocation(t *testing.T) {
	s, ctx := acceptanceServer(t)
	notificationETAExec(t, s, ctx, `INSERT INTO groups(id,name) VALUES(2,'Second'),(3,'Unbound');
 INSERT INTO subjects(id,name) VALUES(2,'Second'),(3,'No groups');
 INSERT INTO subject_groups VALUES(2,2);
 INSERT INTO users(id,name,group_id) VALUES(4001,'Second student',2);
 INSERT INTO labs(id,subject_id,group_id,number,name) VALUES(1,1,1,1,'Bound'),(2,2,2,1,'Bound other'),(3,2,1,1,'Forged');
 INSERT INTO grades(student_id,lab_id,value) VALUES(3001,1,4),(4001,2,5),(3001,3,5);
 INSERT INTO events(id,name,subject_id,teacher_id,starts_at,state,strategy,registration_open)
 VALUES(2,'Forged event',2,2001,now(),'planned','fifo',true);
 INSERT INTO event_groups VALUES(2,1);
 SELECT setval(pg_get_serial_sequence('events','id'),2);`)
	for _, uid := range []int64{1001, 2001} {
		for _, c := range []command{
			{Kind: "lab", SubjectID: 2, GroupID: 1, Number: 2, Name: "Forged"},
			{Kind: "lab", ID: 3, Number: 1, Name: "Forged edit", Enabled: true},
			{Kind: "grade", LabID: 3, UserID: 3001, Version: 1},
			{Kind: "event_create", SubjectID: 1, GroupIDs: &[]int64{1, 2}, Name: "Mixed", StartsAt: time.Now(), Strategy: "fifo"},
			{Kind: "event_update", EventID: 2, Name: "Forged edit", StartsAt: time.Now()},
		} {
			before := studentPermissionsRows(t, s, ctx)
			acceptanceCommand(t, s, uid, c, 400)
			studentPermissionsUnchanged(t, s, ctx, before)
		}
		r := httptest.NewRequest(http.MethodPost, "/api/export?subject_id=2&group_id=1", nil)
		w := httptest.NewRecorder()
		s.exportGradebook(w, r, uid)
		if w.Code != 400 || !strings.Contains(w.Body.String(), "не назначен") {
			t.Fatalf("unbound export: %d %s", w.Code, w.Body.String())
		}
	}
	before := studentPermissionsRows(t, s, ctx)
	acceptanceCommand(t, s, 3001, command{Kind: "join", EventID: 2}, 400)
	studentPermissionsUnchanged(t, s, ctx, before)
	read := func(uid int64, subjects, links, labs int) {
		t.Helper()
		before := studentPermissionsRows(t, s, ctx)
		r := httptest.NewRequest(http.MethodGet, "/api/state", nil)
		w := httptest.NewRecorder()
		s.state(w, r, uid)

		// me is an object, so decode just the arrays used by this check.
		var all map[string]json.RawMessage
		if err := json.Unmarshal(w.Body.Bytes(), &all); err != nil || w.Code != 200 {
			t.Fatalf("state: %d %s", w.Code, w.Body.String())
		}
		raw := map[string][]json.RawMessage{}
		for _, key := range []string{"subjects", "subject_groups", "labs", "grades", "grade_summaries", "grade_statistics", "lab_statistics", "events"} {
			var rawSlice []json.RawMessage
			if err := json.Unmarshal(all[key], &rawSlice); err != nil {
				t.Fatal(err)
			}
			raw[key] = rawSlice
		}
		if len(raw["subjects"]) != subjects || len(raw["subject_groups"]) != links || len(raw["labs"]) != labs || len(raw["grades"]) != labs {
			t.Fatalf("scope %d: subjects=%d links=%d labs=%d grades=%d", uid, len(raw["subjects"]), len(raw["subject_groups"]), len(raw["labs"]), len(raw["grades"]))
		}
		wantStats := 0
		if subjects == 3 {
			wantStats = 2
		} else {
			var ownGroup int64 = 1
			if uid == 4001 {
				ownGroup = 2
			}
			for _, row := range raw["subject_groups"] {
				var link struct {
					Subject int64 `json:"subject_id"`
					Group   int64 `json:"group_id"`
				}
				if err := json.Unmarshal(row, &link); err != nil || link.Subject != ownGroup || link.Group != ownGroup {
					t.Fatalf("wrong own-group curriculum: %s", row)
				}
			}
			for _, row := range raw["events"] {
				var ev struct{ ID int64 }
				if err := json.Unmarshal(row, &ev); err != nil || ev.ID == 2 {
					t.Fatalf("unbound event visible to student: %s", row)
				}
			}
		}
		if len(raw["grade_statistics"]) != wantStats || len(raw["lab_statistics"]) != wantStats {
			t.Fatalf("statistics scope %d: %s / %s", uid, all["grade_statistics"], all["lab_statistics"])
		}
		for _, key := range []string{"labs", "grades", "grade_summaries", "grade_statistics", "lab_statistics"} {
			for _, row := range raw[key] {
				var item struct {
					ID      int64
					LabID   int64 `json:"lab_id"`
					Subject int64 `json:"subject_id"`
					Group   int64 `json:"group_id"`
				}
				if err := json.Unmarshal(row, &item); err != nil {
					t.Fatal(err)
				}
				if (key == "labs" && item.ID == 3) || item.LabID == 3 || (item.Subject == 2 && item.Group == 1) {
					t.Fatalf("unbound data leaked in %s: %s", key, row)
				}
			}
		}
		studentPermissionsUnchanged(t, s, ctx, before)
	}
	read(1001, 3, 2, 2)
	read(2001, 3, 2, 2)
	read(3001, 1, 1, 1)
	read(4001, 1, 1, 1)
	// Revoked teachers keep own-group curriculum, not global management or catalog access.
	notificationETAExec(t, s, ctx, "UPDATE users SET group_id=1 WHERE id=2001")
	acceptanceCommand(t, s, 1001, command{Kind: "role", UserID: 2001, Enabled: false}, 200)
	read(2001, 1, 1, 1)
	before = studentPermissionsRows(t, s, ctx)
	acceptanceCommand(t, s, 2001, command{Kind: "subject", ID: 1, Name: "Revoked", GroupIDs: &[]int64{1, 2}}, 403)
	studentPermissionsUnchanged(t, s, ctx, before)
}
