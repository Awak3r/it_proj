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

func TestTeacherGlobalAccessAndRoleRevocation(t *testing.T) {
	s, ctx := acceptanceServer(t)
	notificationETAExec(t, s, ctx, `
		DELETE FROM assignments;
		INSERT INTO groups(id,name) VALUES(2,'Other group');
		INSERT INTO subjects(id,name) VALUES(2,'Other subject');
		INSERT INTO users(id,name,teacher) VALUES(2002,'Other teacher',true);
		INSERT INTO users(id,name,group_id) VALUES(4001,'Other student',2);
		SELECT setval(pg_get_serial_sequence('events','id'),1);`)
	for _, pair := range [][2]int64{{1, 1}, {1, 2}, {2, 1}, {2, 2}} {
		acceptanceCommand(t, s, 2001, command{Kind: "lab", SubjectID: pair[0], GroupID: pair[1], Number: 1, Name: "Global lab"}, 200)
	}
	acceptanceGrade(t, s, 2001, 4001, 4, 5, 0)
	acceptanceCommand(t, s, 2001, command{Kind: "event_create", Name: "All groups", SubjectID: 2, GroupIDs: []int64{1, 2}, StartsAt: time.Now().Add(time.Hour), Strategy: "fifo"}, 200)
	acceptanceCommand(t, s, 2001, command{Kind: "event_action", EventID: 2, Action: "open"}, 200)
	acceptanceJoin(t, s, 2, 4001)
	acceptanceJoin(t, s, 1, 3001)

	check := func(uid int64, labs, grades, users, events, entries int) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/api/state", nil)
		w := httptest.NewRecorder()
		s.state(w, r, uid)
		var state struct{ Labs, Grades, Users, Events, Entries, Assignments, Audit []json.RawMessage }
		if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil || w.Code != 200 {
			t.Fatalf("state %d: %d %s: %v", uid, w.Code, w.Body.String(), err)
		}
		if len(state.Labs) != labs || len(state.Grades) != grades || len(state.Users) != users || len(state.Events) != events || len(state.Entries) != entries {
			t.Fatalf("state %d: labs=%d grades=%d users=%d events=%d entries=%d", uid, len(state.Labs), len(state.Grades), len(state.Users), len(state.Events), len(state.Entries))
		}
		if state.Assignments == nil || len(state.Assignments) != 0 {
			t.Fatal("retired assignments must be an empty array")
		}
		if !s.roots[uid] && len(state.Audit) != 0 {
			t.Fatal("non-root audit access")
		}
	}
	check(2001, 4, 1, 14, 2, 2)
	// A different teacher can read every event, not mutate another owner's event.
	check(2002, 4, 1, 14, 2, 2)
	for _, kind := range []string{"event_action", "event_update", "strategy", "next", "skip", "finish", "move", "remove", "shuffle"} {
		before := studentPermissionsRows(t, s, ctx)
		acceptanceCommand(t, s, 2002, command{Kind: kind, EventID: 2, Action: "cancel", Strategy: "desc", Name: "Hijacked", StartsAt: time.Now()}, 403)
		studentPermissionsUnchanged(t, s, ctx, before)
	}
	for _, c := range []command{
		{Kind: "role", UserID: 2002, Enabled: false},
		{Kind: "transfer", UserID: 4001, GroupID: 1},
		{Kind: "group", Name: "Forbidden"},
		{Kind: "subject", Name: "Forbidden"},
		{Kind: "assignment", SubjectID: 1, GroupID: 1, TeacherID: 2001, Enabled: true},
	} {
		acceptanceCommand(t, s, 2001, c, 403)
	}

	// Legacy rows survive retirement, but neither commands nor projections use them.
	notificationETAExec(t, s, ctx, "INSERT INTO assignments VALUES(1,1,2001),(2,2,3001)")
	for _, enabled := range []bool{false, true} {
		before := studentPermissionsRows(t, s, ctx)
		acceptanceCommand(t, s, 1001, command{Kind: "assignment", SubjectID: 1, GroupID: 1, TeacherID: 2001, Enabled: enabled}, 400)
		studentPermissionsUnchanged(t, s, ctx, before)
	}
	check(1001, 4, 1, 14, 2, 2)
	check(3001, 2, 0, 10, 2, 2)
	check(4001, 2, 1, 1, 1, 1)
	acceptanceCommand(t, s, 3001, command{Kind: "lab", SubjectID: 2, GroupID: 2, Number: 2, Name: "Stale assignment"}, 403)
	acceptanceCommand(t, s, 3001, command{Kind: "grade", UserID: 4001, LabID: 4, Version: 1}, 403)

	export := func(uid int64, subject, group int, status int, message string) {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/export?subject_id=%d&group_id=%d", subject, group), nil)
		w := httptest.NewRecorder()
		s.exportGradebook(w, r, uid)
		if w.Code != status || !strings.Contains(w.Body.String(), message) {
			t.Fatalf("export: %d %s", w.Code, w.Body.String())
		}
	}
	// Empty test bot token reaches the post-authorization configuration check.
	export(2001, 2, 2, 400, "бот не настроен")
	export(2001, 999, 2, 400, "не найдены")
	export(2001, 2, 999, 400, "не найдены")
	acceptanceCommand(t, s, 1001, command{Kind: "role", UserID: 2001, Enabled: false}, 200)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM assignments", 2)
	check(2001, 0, 0, 1, 0, 0)
	export(2001, 2, 2, 403, "error")
	for _, c := range []command{
		{Kind: "lab", SubjectID: 1, GroupID: 1, Number: 2, Name: "Revoked"},
		{Kind: "grade", UserID: 4001, LabID: 4, Version: 1},
		{Kind: "event_create", Name: "Revoked", SubjectID: 2, GroupIDs: []int64{2}, StartsAt: time.Now(), Strategy: "fifo"},
		{Kind: "event_action", EventID: 2, Action: "cancel"},
	} {
		before := studentPermissionsRows(t, s, ctx)
		acceptanceCommand(t, s, 2001, c, 403)
		studentPermissionsUnchanged(t, s, ctx, before)
	}
	acceptanceCommand(t, s, 1001, command{Kind: "role", UserID: 2001, Enabled: true}, 200)
	check(2001, 4, 1, 14, 2, 2)
	acceptanceCommand(t, s, 2001, command{Kind: "event_action", EventID: 2, Action: "close"}, 200)
}

func TestTeacherReferenceValidationAndArchives(t *testing.T) {
	s, ctx := acceptanceServer(t)
	notificationETAExec(t, s, ctx, "DELETE FROM assignments; SELECT setval(pg_get_serial_sequence('events','id'),1)")
	for _, pair := range [][2]int64{{0, 1}, {1, 0}, {999, 1}, {1, 999}} {
		for _, uid := range []int64{1001, 2001} {
			before := studentPermissionsRows(t, s, ctx)
			acceptanceCommand(t, s, uid, command{Kind: "lab", SubjectID: pair[0], GroupID: pair[1], Number: 1, Name: "Invalid reference"}, 400)
			acceptanceCommand(t, s, uid, command{Kind: "event_create", SubjectID: pair[0], GroupIDs: []int64{pair[1]}, Name: "Invalid reference", StartsAt: time.Now(), Strategy: "fifo"}, 400)
			studentPermissionsUnchanged(t, s, ctx, before)
		}
	}
	for _, table := range []string{"groups", "subjects"} {
		notificationETAExec(t, s, ctx, "UPDATE "+table+" SET archived=true WHERE id=1")
		acceptanceCommand(t, s, 2001, command{Kind: "event_create", SubjectID: 1, GroupIDs: []int64{1}, Name: "Archived", StartsAt: time.Now(), Strategy: "fifo"}, 400)
		notificationETAExec(t, s, ctx, "UPDATE "+table+" SET archived=false WHERE id=1")
	}
	// Existing lab/grade operations do not reject archived groups or subjects.
	notificationETAExec(t, s, ctx, "UPDATE groups SET archived=true; UPDATE subjects SET archived=true")
	acceptanceCommand(t, s, 2001, command{Kind: "lab", SubjectID: 1, GroupID: 1, Number: 1, Name: "Historical"}, 200)
	acceptanceGrade(t, s, 2001, 3001, 1, 4, 0)
	acceptanceCommand(t, s, 2001, command{Kind: "lab", ID: 1, Number: 1, Name: "Historical", Enabled: true}, 200)
	acceptanceCommand(t, s, 2001, command{Kind: "grade", UserID: 3001, LabID: 1, Version: 1}, 400)
}
