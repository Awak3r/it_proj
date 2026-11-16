package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTeacherStudentCommandsAndLegacyState(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceLab(t, s, 1)
	// Simulate existing dual-role data, including historical grades and queues.
	notificationETAExec(t, s, ctx, `
 UPDATE users SET group_id=1 WHERE id IN (1001,2001);
 INSERT INTO grades(student_id,lab_id,value) VALUES(2001,1,5);
 INSERT INTO entries(event_id,user_id,position,score,state) VALUES(1,2001,1,1,'completed');`)
	for _, uid := range []int64{1001, 2001} {
		for _, c := range []command{
			{Kind: "profile", Name: "Teacher", GroupID: 1},
			{Kind: "join", EventID: 1},
		} {
			before := studentPermissionsRows(t, s, ctx)
			acceptanceCommand(t, s, uid, c, 400)
			studentPermissionsUnchanged(t, s, ctx, before)
		}
		before := studentPermissionsRows(t, s, ctx)
		acceptanceCommand(t, s, 1001, command{Kind: "transfer", UserID: uid, GroupID: 1}, 400)
		acceptanceCommand(t, s, 2001, command{Kind: "grade", UserID: uid, LabID: 1, Value: intPointer(4)}, 400)
		studentPermissionsUnchanged(t, s, ctx, before)
	}
	// Also reject another teacher's queue, not just the owner's own queue.
	notificationETAExec(t, s, ctx, "UPDATE events SET teacher_id=1001 WHERE id=1")
	acceptanceCommand(t, s, 2001, command{Kind: "join", EventID: 1}, 400)
	for _, viewer := range []int64{1001, 2001, 3001} {
		w := httptest.NewRecorder()
		s.state(w, httptest.NewRequest(http.MethodGet, "/api/state", nil), viewer)
		var state struct {
			Me struct {
				GroupID *int64 `json:"group_id"`
			}
			Users []struct {
				ID      int64
				Teacher bool
				GroupID *int64 `json:"group_id"`
			}
			Summaries []gradingSummary `json:"grade_summaries"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil || w.Code != 200 {
			t.Fatalf("state: %d %s: %v", w.Code, w.Body.String(), err)
		}
		if viewer != 3001 && state.Me.GroupID != nil {
			t.Fatal("legacy teacher profile exposes a student group")
		}
		for _, u := range state.Users {
			if u.Teacher && u.GroupID != nil {
				t.Fatalf("teacher in student roster: %+v", u)
			}
		}
		for _, summary := range state.Summaries {
			if summary.StudentID == 1001 || summary.StudentID == 2001 {
				t.Fatalf("teacher summary: %+v", summary)
			}
		}
	}
	// Renaming a legacy teacher with no group normalizes membership, not history.
	acceptanceCommand(t, s, 2001, command{Kind: "profile", Name: "Renamed teacher"}, 200)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM users WHERE id=2001 AND teacher AND group_id IS NULL", 1)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM grades WHERE student_id=2001 AND value=5", 1)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE user_id=2001 AND state='completed'", 1)
	acceptanceCommand(t, s, 2001, command{Kind: "lab", SubjectID: 1, GroupID: 1, Number: 2, Name: "Teaching still allowed"}, 200)
	acceptanceGrade(t, s, 2001, 3001, 1, 4, 0)
}

func intPointer(v int) *int { return &v }

func TestPromotionRejectsActiveQueuesAndPreservesHistory(t *testing.T) {
	for _, state := range []string{"waiting", "called"} {
		t.Run(state, func(t *testing.T) {
			s, ctx := acceptanceServer(t)
			acceptanceJoin(t, s, 1, 3001)
			if state == "called" {
				acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
			}
			acceptanceLab(t, s, 1)
			acceptanceGrade(t, s, 2001, 3001, 1, 5, 0)
			before := studentPermissionsRows(t, s, ctx)
			acceptanceCommand(t, s, 1001, command{Kind: "role", UserID: 3001, Enabled: true}, 400)
			studentPermissionsUnchanged(t, s, ctx, before)
			var entryID int64
			if err := s.db.QueryRow(ctx, "SELECT id FROM entries WHERE user_id=3001").Scan(&entryID); err != nil {
				t.Fatal(err)
			}
			acceptanceCommand(t, s, 3001, command{Kind: "leave", EventID: 1, ID: entryID}, 200)
			for i := 0; i < 2; i++ {
				acceptanceCommand(t, s, 1001, command{Kind: "role", UserID: 3001, Enabled: true}, 200)
				notificationETACount(t, s, ctx, "SELECT count(*) FROM users WHERE id=3001 AND teacher AND group_id IS NULL", 1)
				acceptanceCommand(t, s, 3001, command{Kind: "join", EventID: 1}, 400)
				acceptanceCommand(t, s, 1001, command{Kind: "role", UserID: 3001, Enabled: false}, 200)
				// Revocation does not silently re-enroll the former teacher.
				notificationETACount(t, s, ctx, "SELECT count(*) FROM users WHERE id=3001 AND NOT teacher AND group_id IS NULL", 1)
				acceptanceCommand(t, s, 3001, command{Kind: "join", EventID: 1}, 400)
				acceptanceCommand(t, s, 1001, command{Kind: "transfer", UserID: 3001, GroupID: 1}, 200)
			}
			acceptanceJoin(t, s, 1, 3001)
			notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE id=$1 AND state='left'", 1, entryID)
			notificationETACount(t, s, ctx, "SELECT count(*) FROM grades WHERE student_id=3001 AND value=5 AND version=1", 1)
		})
	}
}

func TestLegacyTeacherActiveQueueRecovery(t *testing.T) {
	s, ctx := acceptanceServer(t)
	notificationETAExec(t, s, ctx, `
 UPDATE users SET group_id=1 WHERE id=2001;
 INSERT INTO entries(event_id,user_id,position,score) VALUES(1,2001,1,0);`)
	before := studentPermissionsRows(t, s, ctx)
	acceptanceCommand(t, s, 1001, command{Kind: "role", UserID: 2001, Enabled: true}, 400)
	acceptanceCommand(t, s, 2001, command{Kind: "join", EventID: 1}, 400)
	studentPermissionsUnchanged(t, s, ctx, before)
	var entryID int64
	if err := s.db.QueryRow(ctx, "SELECT id FROM entries WHERE user_id=2001").Scan(&entryID); err != nil {
		t.Fatal(err)
	}
	acceptanceCommand(t, s, 2001, command{Kind: "leave", EventID: 1, ID: entryID}, 200)
	acceptanceCommand(t, s, 1001, command{Kind: "role", UserID: 2001, Enabled: true}, 200)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE id=$1 AND state='left'", 1, entryID)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM users WHERE id=2001 AND teacher AND group_id IS NULL", 1)
}

func TestRootWithoutTeacherRoleCanRemainStudent(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceCommand(t, s, 1001, command{Kind: "role", UserID: 1001, Enabled: false}, 200)
	acceptanceCommand(t, s, 1001, command{Kind: "profile", Name: "Root student", GroupID: 1}, 200)
	acceptanceLab(t, s, 1)
	acceptanceGrade(t, s, 2001, 1001, 1, 5, 0)
	acceptanceJoin(t, s, 1, 1001)
	notificationETAExec(t, s, ctx, "UPDATE events SET teacher_id=1001 WHERE id=1")
	before := studentPermissionsRows(t, s, ctx)
	acceptanceCommand(t, s, 1001, command{Kind: "join", EventID: 1}, 400)
	studentPermissionsUnchanged(t, s, ctx, before)
	// Root's administrative/event-owner powers do not require the teacher flag.
	acceptanceCommand(t, s, 1001, command{Kind: "event_action", EventID: 1, Action: "close"}, 200)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM users WHERE id=1001 AND NOT teacher AND group_id=1", 1)
	w := httptest.NewRecorder()
	s.state(w, httptest.NewRequest(http.MethodGet, "/api/state", nil), 1001)
	var result struct {
		Summaries []gradingSummary  `json:"grade_summaries"`
		Boards    []gradeStatistics `json:"grade_statistics"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != 200 {
		t.Fatalf("state: %s: %v", w.Body.String(), err)
	}
	found := false
	for _, summary := range result.Summaries {
		if summary.StudentID == 1001 {
			found = true
		}
	}
	if !found || len(result.Boards) != 1 || result.Boards[0].StudentsCount != 11 {
		t.Fatalf("root missing from student calculations: %+v", result)
	}
}
