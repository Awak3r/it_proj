package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"

	"testing"
	"time"
)

// Include tables omitted or partially represented by /api/state, especially
// roles, assignments, audit, the notification outbox and idempotency records.
func studentPermissionsRows(t *testing.T, s *server, ctx context.Context) map[string]string {
	t.Helper()
	out := make(map[string]string)
	var queries []string
	for _, table := range []string{"users", "groups", "subjects", "subject_groups", "assignments", "labs", "grades", "events", "event_groups", "entries", "audit", "notifications", "requests"} {
		queries = append(queries, "SELECT '"+table+"', COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text FROM "+table+" r")
	}
	// One statement provides one snapshot and avoids a round trip per table.
	rows, err := s.db.Query(ctx, strings.Join(queries, " UNION ALL "))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var table, data string
		if err := rows.Scan(&table, &data); err != nil {
			t.Fatal(err)
		}
		out[table] = data
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func studentPermissionsUnchanged(t *testing.T, s *server, ctx context.Context, before map[string]string) {
	t.Helper()
	after := studentPermissionsRows(t, s, ctx)
	for table, rows := range before {
		if rows != after[table] {
			t.Errorf("denied student request mutated %s", table)
		}
	}
}

func TestStudentPermissionsCommands(t *testing.T) {
	s, ctx := acceptanceServer(t)
	notificationETAExec(t, s, ctx, "INSERT INTO groups(id,name) VALUES(2,'Other group'); SELECT setval(pg_get_serial_sequence('groups','id'),2); SELECT setval(pg_get_serial_sequence('subjects','id'),1); SELECT setval(pg_get_serial_sequence('events','id'),1)")
	acceptanceLab(t, s, 1)
	acceptanceGrade(t, s, 2001, 3001, 1, 4, 0)
	acceptanceGrade(t, s, 2001, 3002, 1, 4, 0)
	acceptanceJoin(t, s, 1, 3001, 3002)
	acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, http.StatusOK)
	state := acceptanceSnapshot(t, s, 1001)
	called := acceptanceFindEntry(t, state, 1, 3001, "called").ID
	waiting := acceptanceFindEntry(t, state, 1, 3002, "waiting").ID
	five := 5
	required := false
	weight := json.Number("2.5")
	startsAt := time.Now().Add(time.Hour)

	tests := []struct {
		name    string
		command command
		setup   string
	}{
		{"group create", command{Kind: "group", Name: "Student-created group"}, ""},
		{"group edit", command{Kind: "group", ID: 1, Name: "Renamed group"}, ""},
		{"group archive", command{Kind: "group", ID: 1, Name: "Synthetic group", Enabled: true}, ""},
		{"subject create", command{Kind: "subject", Name: "Student-created subject"}, ""},
		{"subject edit", command{Kind: "subject", ID: 1, Name: "Renamed subject"}, ""},
		{"subject archive", command{Kind: "subject", ID: 1, Name: "Synthetic subject", Enabled: true}, ""},
		{"role self grant", command{Kind: "role", UserID: 3001, Enabled: true}, ""},
		{"role revoke teacher", command{Kind: "role", UserID: 2001, Enabled: false}, ""},
		{"transfer", command{Kind: "transfer", UserID: 3003, GroupID: 2}, ""},
		{"assignment grant", command{Kind: "assignment", SubjectID: 1, GroupID: 2, TeacherID: 2001, Enabled: true}, ""},
		{"assignment revoke", command{Kind: "assignment", SubjectID: 1, GroupID: 1, TeacherID: 2001, Enabled: false}, ""},
		{"lab create", command{Kind: "lab", SubjectID: 1, GroupID: 1, Number: 2, Name: "Student-created lab"}, ""},
		{"lab edit", command{Kind: "lab", ID: 1, SubjectID: 1, GroupID: 1, Number: 1, Name: "Renamed lab"}, ""},
		{"lab archive", command{Kind: "lab", ID: 1, Number: 1, Name: "Lab 1", Enabled: true}, ""},
		{"lab grading metadata", command{Kind: "lab", ID: 1, Number: 1, Name: "Lab 1", Weight: &weight, Required: &required}, ""},
		{"grade self set", command{Kind: "grade", UserID: 3001, LabID: 1, Value: &five, Version: 1}, ""},
		{"grade other set", command{Kind: "grade", UserID: 3002, LabID: 1, Value: &five, Version: 1}, ""},
		{"grade create", command{Kind: "grade", UserID: 3003, LabID: 1, Value: &five}, ""},
		{"grade self clear", command{Kind: "grade", UserID: 3001, LabID: 1, Version: 1}, ""},
		{"grade other clear", command{Kind: "grade", UserID: 3002, LabID: 1, Version: 1}, ""},
		{"event create", command{Kind: "event_create", Name: "Student-created event", SubjectID: 1, GroupIDs: &[]int64{1}, StartsAt: startsAt, Strategy: "fifo"}, ""},
		{"event create forged teacher", command{Kind: "event_create", Name: "Forged teacher event", SubjectID: 1, GroupIDs: &[]int64{1}, TeacherID: 2001, StartsAt: startsAt, Strategy: "fifo"}, ""},
		{"event update", command{Kind: "event_update", EventID: 1, Name: "Renamed event", StartsAt: startsAt, Room: "505", Description: "Changed", Duration: 15}, ""},
		{"registration open", command{Kind: "event_action", EventID: 1, Action: "open"}, "UPDATE events SET registration_open=false WHERE id=1"},
		{"registration close", command{Kind: "event_action", EventID: 1, Action: "close"}, ""},
		{"event start", command{Kind: "event_action", EventID: 1, Action: "start"}, "UPDATE events SET state='planned' WHERE id=1"},
		{"event complete", command{Kind: "event_action", EventID: 1, Action: "complete"}, ""},
		{"event cancel", command{Kind: "event_action", EventID: 1, Action: "cancel"}, ""},
		{"strategy before call", command{Kind: "strategy", EventID: 1, Strategy: "desc"}, ""},
		{"strategy after call", command{Kind: "strategy", EventID: 1, Strategy: "desc"}, "UPDATE events SET first_called=true WHERE id=1"},
		{"next", command{Kind: "next", EventID: 1}, "UPDATE entries SET state='waiting',called_at=NULL WHERE event_id=1"},
		{"skip", command{Kind: "skip", EventID: 1, ID: called}, ""},
		{"finish", command{Kind: "finish", EventID: 1, ID: called}, ""},
		{"move", command{Kind: "move", EventID: 1, ID: waiting, Position: 1}, ""},
		{"remove waiting", command{Kind: "remove", EventID: 1, ID: waiting}, ""},
		{"remove called", command{Kind: "remove", EventID: 1, ID: called}, ""},
		{"shuffle", command{Kind: "shuffle", EventID: 1}, "UPDATE events SET strategy='random' WHERE id=1; UPDATE entries SET state='waiting',called_at=NULL WHERE event_id=1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Keep each target actionable: denials must not be caused by a stale
			// grade version, missing row, terminal event or already-current call.
			notificationETAExec(t, s, ctx, "UPDATE events SET state='live',strategy='fifo',registration_open=true,first_called=false,shuffled=false WHERE id=1; UPDATE entries SET state='waiting',called_at=NULL WHERE event_id=1")
			notificationETAExec(t, s, ctx, "UPDATE entries SET state='called',called_at=now() WHERE id=$1", called)
			if tt.setup != "" {
				notificationETAExec(t, s, ctx, tt.setup)
			}
			before := studentPermissionsRows(t, s, ctx)
			// Cleanup still checks rollback if the HTTP assertion fails fatally.
			t.Cleanup(func() { studentPermissionsUnchanged(t, s, ctx, before) })
			acceptanceCommand(t, s, 3001, tt.command, http.StatusForbidden)
		})
	}
}

func TestStudentPermissionsAuditRootOnly(t *testing.T) {
	s, _ := acceptanceServer(t)
	acceptanceLab(t, s, 1)
	acceptanceGrade(t, s, 2001, 3001, 1, 4, 0)
	for _, uid := range []int64{1001, 2001, 3001} {
		t.Run(fmt.Sprintf("user_%d", uid), func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/state", nil)
			w := httptest.NewRecorder()
			s.state(w, r, uid)
			if w.Code != http.StatusOK {
				t.Fatalf("state: HTTP %d: %s", w.Code, w.Body.String())
			}
			var state struct {
				Audit []json.RawMessage `json:"audit"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
				t.Fatal(err)
			}
			if s.roots[uid] {
				if len(state.Audit) == 0 {
					t.Fatal("root cannot see existing audit records")
				}
			} else if len(state.Audit) != 0 {
				t.Fatalf("non-root received %d audit records", len(state.Audit))
			}
		})
	}
}

func TestStudentPermissionsExport(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceLab(t, s, 1)
	acceptanceGrade(t, s, 2001, 3001, 1, 4, 0)
	// A nonempty synthetic token ensures a missing authorization check cannot
	// be hidden by the unconfigured-bot guard. Never allow real network I/O.
	s.token = "student-permissions-test:synthetic"
	originalTransport := http.DefaultTransport
	networkCalls := 0
	http.DefaultTransport = testTransport(func(r *http.Request) (*http.Response, error) {
		networkCalls++
		return nil, errors.New("network disabled for student export test")
	})
	t.Cleanup(func() { http.DefaultTransport = originalTransport })

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/export", s.auth(s.exportGradebook))
	for _, group := range []int64{1, 2} {
		t.Run(fmt.Sprintf("group_%d", group), func(t *testing.T) {
			if group == 2 {
				notificationETAExec(t, s, ctx, "INSERT INTO groups(id,name) VALUES(2,'Other group')")
			}
			before := studentPermissionsRows(t, s, ctx)
			t.Cleanup(func() {
				studentPermissionsUnchanged(t, s, ctx, before)
				if networkCalls != 0 {
					t.Errorf("student export attempted %d network requests", networkCalls)
				}
			})
			r := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/export?subject_id=1&group_id=%d", group), nil)
			r.Header.Set("X-Dev-User", "3001")
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != http.StatusForbidden {
				t.Fatalf("student export: HTTP %d, want 403: %s", w.Code, w.Body.String())
			}

		})
	}
}
