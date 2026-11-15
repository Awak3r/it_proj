package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Reuse the local-only, per-schema fixture without changing its owner's tests.
func acceptanceServer(t *testing.T) (*server, context.Context) {
	t.Helper()
	s, ctx := notificationETAServer(t)
	s.dev = true
	notificationETAExec(t, s, ctx, `
 DELETE FROM entries;
 INSERT INTO users(id,name,teacher) VALUES(2001,'Assigned teacher',true);
 UPDATE events SET teacher_id=2001,registration_open=true;
 INSERT INTO assignments VALUES(1,1,2001);`)
	return s, ctx
}

func acceptanceCommand(t *testing.T, s *server, uid int64, c command, status int, keys ...string) {
	t.Helper()
	body, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	key := fmt.Sprintf("acceptance-%d", time.Now().UnixNano())
	if len(keys) > 0 {
		key = keys[0]
	}
	r := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewReader(body))
	r.Header.Set("X-Dev-User", fmt.Sprint(uid))
	r.Header.Set("Idempotency-Key", key)
	w := httptest.NewRecorder()
	s.auth(s.command)(w, r)
	if w.Code != status {
		t.Fatalf("user %d %s/%s: HTTP %d, want %d: %s", uid, c.Kind, c.Action, w.Code, status, w.Body.String())
	}
	if status != http.StatusOK {
		var failure struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &failure); err != nil || failure.Error == "" {
			t.Fatalf("rejected command missing actionable JSON error: %s", w.Body.String())
		}
	}
}

type acceptanceEntry struct {
	ID       int64      `json:"id"`
	EventID  int64      `json:"event_id"`
	UserID   int64      `json:"user_id"`
	State    string     `json:"state"`
	Position int64      `json:"position"`
	Score    int        `json:"score"`
	JoinedAt time.Time  `json:"joined_at"`
	CalledAt *time.Time `json:"called_at"`
	EndedAt  *time.Time `json:"ended_at"`
}
type acceptanceState struct {
	Me struct {
		ID        int64
		Name      string
		GroupID   int64     `json:"group_id"`
		CreatedAt time.Time `json:"created_at"`
	}
	Entries []acceptanceEntry
	Grades  []struct {
		StudentID int64 `json:"student_id"`
		LabID     int64 `json:"lab_id"`
		Value     *int
		Version   int
		AuthorID  int64 `json:"author_id"`
	}
	Labs []struct {
		ID        int64
		Name      string
		Archived  bool
		SubjectID int64 `json:"subject_id"`
		GroupID   int64 `json:"group_id"`
	}
	Events []struct {
		ID               int64
		State            string
		Shuffled         bool
		RegistrationOpen bool `json:"registration_open"`
	}
}

func acceptanceSnapshot(t *testing.T, s *server, uid int64) acceptanceState {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	r.Header.Set("X-Dev-User", fmt.Sprint(uid))
	w := httptest.NewRecorder()
	s.auth(s.state)(w, r)
	var out acceptanceState
	if w.Code != 200 {
		t.Fatalf("snapshot: HTTP %d: %s", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	// The API does not promise grade-row order; compare data, not query plans.
	sort.Slice(out.Grades, func(i, j int) bool {
		a, b := out.Grades[i], out.Grades[j]
		if a.StudentID != b.StudentID {
			return a.StudentID < b.StudentID
		}
		return a.LabID < b.LabID
	})
	return out
}
func acceptanceOrder(state acceptanceState, eventID int64) []int64 {
	out := []int64{}
	for _, e := range state.Entries {
		if e.EventID == eventID && (e.State == "waiting" || e.State == "called") {
			out = append(out, e.UserID)
		}
	}
	return out
}
func acceptanceWantOrder(t *testing.T, s *server, uid, eventID int64, want []int64) {
	t.Helper()
	if got := acceptanceOrder(acceptanceSnapshot(t, s, uid), eventID); !slices.Equal(got, want) {
		t.Fatalf("viewer %d event %d: order %v, want %v", uid, eventID, got, want)
	}
}
func acceptanceFindEntry(t *testing.T, state acceptanceState, eventID, userID int64, want string) acceptanceEntry {
	t.Helper()
	for _, e := range state.Entries {
		if e.EventID == eventID && e.UserID == userID && e.State == want {
			return e
		}
	}
	t.Fatalf("missing event %d student %d entry in state %s: %+v", eventID, userID, want, state.Entries)
	return acceptanceEntry{}
}
func acceptanceJoin(t *testing.T, s *server, eventID int64, users ...int64) {
	t.Helper()
	for _, u := range users {
		acceptanceCommand(t, s, u, command{Kind: "join", EventID: eventID}, 200)
	}
}
func acceptanceLab(t *testing.T, s *server, number int) {
	t.Helper()
	acceptanceCommand(t, s, 2001, command{Kind: "lab", SubjectID: 1, GroupID: 1, Number: number, Name: fmt.Sprintf("Lab %d", number)}, 200)
}
func acceptanceGrade(t *testing.T, s *server, uid, user, lab int64, value, version int) {
	t.Helper()
	acceptanceCommand(t, s, uid, command{Kind: "grade", UserID: user, LabID: lab, Value: &value, Version: version}, 200)
}

// Progress is computed by the client, not returned as a server counter. This
// checks its inputs, not the rendered UI's arithmetic or labels.
func acceptanceProgress(t *testing.T, state acceptanceState, user int64, passed, total int) {
	t.Helper()
	active := map[int64]bool{}
	for _, l := range state.Labs {
		if l.SubjectID == 1 && l.GroupID == 1 && !l.Archived {
			active[l.ID] = true
		}
	}
	got := 0
	for _, g := range state.Grades {
		if g.StudentID == user && active[g.LabID] && g.Value != nil && *g.Value >= 3 {
			got++
		}
	}
	if got != passed || len(active) != total {
		t.Fatalf("progress inputs for %d: passed=%d total=%d, want %d/%d", user, got, len(active), passed, total)
	}
}
func acceptanceWantGrade(t *testing.T, state acceptanceState, user, lab int64, value *int, version int, author int64) {
	t.Helper()
	found := 0
	for _, g := range state.Grades {
		if g.StudentID == user && g.LabID == lab {
			found++
			if !reflect.DeepEqual(g.Value, value) || g.Version != version || g.AuthorID != author {
				t.Fatalf("unexpected grade: %+v, want value %v version %d author %d", g, value, version, author)
			}
		}
	}
	if found != 1 {
		t.Fatalf("grade pair (%d,%d): got %d rows, want 1", user, lab, found)
	}
}
func acceptancePeer(t *testing.T, s *server, ctx context.Context) *server {
	t.Helper()
	// A distinct pool and server have no application state from the first instance.
	db, err := pgxpool.NewWithConfig(ctx, s.db.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return &server{db: db, dev: true, roots: map[int64]bool{1001: true}}
}
func acceptanceSecondEvent(t *testing.T, s *server, ctx context.Context) {
	t.Helper()
	// Fixture event has an explicit ID; advance its sequence before API creation.
	notificationETAExec(t, s, ctx, "SELECT setval(pg_get_serial_sequence('events','id'),(SELECT max(id) FROM events))")
	acceptanceCommand(t, s, 2001, command{Kind: "event_create", Name: "Second event", SubjectID: 1, GroupIDs: []int64{1}, StartsAt: time.Now(), Strategy: "fifo"}, 200)
	acceptanceCommand(t, s, 2001, command{Kind: "event_action", EventID: 2, Action: "open"}, 200)
	acceptanceCommand(t, s, 2001, command{Kind: "event_action", EventID: 2, Action: "start"}, 200)
}

func TestAcceptanceProfileReentry(t *testing.T) {
	s, ctx := acceptanceServer(t)
	// Local dev identity exercises the persistence path, not real Telegram login.
	acceptanceCommand(t, s, 3999, command{Kind: "profile", Name: "Returning student", GroupID: 1}, 200)
	before := acceptanceSnapshot(t, s, 3999).Me
	after := acceptanceSnapshot(t, acceptancePeer(t, s, ctx), 3999).Me
	if before.ID != 3999 || before.Name != "Returning student" || before.GroupID != 1 || before.CreatedAt.IsZero() || before != after {
		t.Fatalf("profile changed on reentry: %+v -> %+v", before, after)
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM users WHERE id=3999", 1)
}

func TestAcceptanceMembershipReentryAndIndependentCalls(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceSecondEvent(t, s, ctx)
	acceptanceJoin(t, s, 1, 3001)
	acceptanceJoin(t, s, 2, 3001)
	state := acceptanceSnapshot(t, s, 3001)
	old := acceptanceFindEntry(t, state, 1, 3001, "waiting")
	acceptanceFindEntry(t, state, 2, 3001, "waiting")
	notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE user_id=3001 AND state='waiting'", 2)
	acceptanceCommand(t, s, 3001, command{Kind: "leave", EventID: 1, ID: old.ID}, 200)
	acceptanceJoin(t, s, 1, 3001)
	state = acceptanceSnapshot(t, s, 3001)
	newer := acceptanceFindEntry(t, state, 1, 3001, "waiting")
	left := acceptanceFindEntry(t, state, 1, 3001, "left")
	if newer.ID == old.ID || !newer.JoinedAt.After(old.JoinedAt) || left.EndedAt == nil {
		t.Fatalf("reentry did not preserve old history and create a later entry: old=%+v new=%+v", left, newer)
	}
	for _, eventID := range []int64{1, 2} {
		acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: eventID}, 200)
	}
	state = acceptanceSnapshot(t, s, 3001)
	acceptanceFindEntry(t, state, 1, 3001, "called")
	acceptanceFindEntry(t, state, 2, 3001, "called")
	notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE user_id=3001 AND state='called'", 2)
	acceptanceCommand(t, s, 2001, command{Kind: "finish", EventID: 1, ID: newer.ID}, 200)
	acceptanceFindEntry(t, acceptanceSnapshot(t, s, 3001), 2, 3001, "called")
}

func TestAcceptanceFIFOAndTiedJoinOrder(t *testing.T) {
	for _, tied := range []bool{false, true} {
		t.Run(fmt.Sprintf("equal_timestamps=%t", tied), func(t *testing.T) {
			s, ctx := acceptanceServer(t)
			acceptanceJoin(t, s, 1, 3003, 3001, 3002)
			if tied {
				notificationETAExec(t, s, ctx, "UPDATE entries SET joined_at='2026-01-01T00:00:00Z'")
			}
			state := acceptanceSnapshot(t, s, 3001)
			for i := 1; i < len(state.Entries); i++ {
				a, b := state.Entries[i-1], state.Entries[i]
				if b.JoinedAt.Before(a.JoinedAt) || (b.JoinedAt.Equal(a.JoinedAt) && b.ID <= a.ID) {
					t.Fatalf("not ordered by join time/ID: %+v", state.Entries)
				}
			}
			acceptanceWantOrder(t, s, 3001, 1, []int64{3003, 3001, 3002})
			for _, user := range []int64{3003, 3001, 3002} {
				acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
				called := acceptanceFindEntry(t, acceptanceSnapshot(t, s, 2001), 1, user, "called")
				acceptanceCommand(t, s, 2001, command{Kind: "finish", EventID: 1, ID: called.ID}, 200)
			}
		})
	}
}

func TestAcceptanceScoreOrderOneThreeFive(t *testing.T) {
	for _, strategy := range []string{"asc", "desc"} {
		t.Run(strategy, func(t *testing.T) {
			s, ctx := acceptanceServer(t)
			for n := 1; n <= 5; n++ {
				acceptanceLab(t, s, n)
			}
			for i, count := range []int{1, 3, 5, 3} {
				for lab := 1; lab <= count; lab++ {
					acceptanceGrade(t, s, 2001, int64(3001+i), int64(lab), 3+lab%3, 0)
				}
			}
			// Failed, cleared, archived, other-subject and other-group grades do not count.
			acceptanceGrade(t, s, 2001, 3001, 2, 2, 0)
			acceptanceGrade(t, s, 2001, 3001, 3, 4, 0)
			acceptanceCommand(t, s, 2001, command{Kind: "grade", UserID: 3001, LabID: 3, Version: 1}, 200)
			notificationETAExec(t, s, ctx, `
 INSERT INTO groups(id,name) VALUES(2,'Other group');
 INSERT INTO subjects(id,name) VALUES(2,'Other subject');
 INSERT INTO labs(subject_id,group_id,number,name,archived) VALUES(1,1,6,'Archived',true),(2,1,1,'Other subject',false),(1,2,1,'Other group',false);
 INSERT INTO grades(student_id,lab_id,value,author_id) SELECT 3001,id,5,1001 FROM labs WHERE id>5;`)
			acceptanceCommand(t, s, 2001, command{Kind: "strategy", EventID: 1, Strategy: strategy}, 200)
			acceptanceJoin(t, s, 1, 3003, 3001, 3002, 3004)
			want := []int64{3001, 3002, 3004, 3003}
			if strategy == "desc" {
				want = []int64{3003, 3002, 3004, 3001}
			}
			acceptanceWantOrder(t, s, 3001, 1, want)
			notificationETACount(t, s, ctx, "SELECT score FROM entries WHERE user_id=3001", 1)
			notificationETACount(t, s, ctx, "SELECT score FROM entries WHERE user_id=3002", 3)
			notificationETACount(t, s, ctx, "SELECT score FROM entries WHERE user_id=3003", 5)
			acceptanceGrade(t, s, 2001, 3001, 2, 5, 1)
			acceptanceWantOrder(t, s, 3002, 1, want)
			notificationETACount(t, s, ctx, "SELECT score FROM entries WHERE user_id=3001", 1)
		})
	}
}

func TestAcceptanceShufflePermutationSurvivesNewServer(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceCommand(t, s, 2001, command{Kind: "strategy", EventID: 1, Strategy: "random"}, 200)
	acceptanceJoin(t, s, 1, 3001, 3002, 3003, 3004, 3005)
	acceptanceCommand(t, s, 1001, command{Kind: "shuffle", EventID: 1}, 200, "acceptance-shuffle-once")
	order := acceptanceOrder(acceptanceSnapshot(t, s, 3001), 1)
	sorted := slices.Clone(order)
	slices.Sort(sorted)
	if !slices.Equal(sorted, []int64{3001, 3002, 3003, 3004, 3005}) {
		t.Fatalf("shuffle lost or duplicated participants: %v", order)
	}
	peer := acceptancePeer(t, s, ctx)
	for _, viewer := range []int64{1001, 2001, 3001, 3005} {
		acceptanceWantOrder(t, peer, viewer, 1, order)
	}
	notificationETACount(t, peer, ctx, "SELECT count(*) FROM events WHERE id=1 AND shuffled AND NOT first_called", 1)
	acceptanceCommand(t, peer, 1001, command{Kind: "shuffle", EventID: 1}, 200, "acceptance-shuffle-once")
	acceptanceCommand(t, peer, 1001, command{Kind: "shuffle", EventID: 1}, 400)
	acceptanceWantOrder(t, peer, 3001, 1, order)
	acceptanceJoin(t, peer, 1, 3006)
	acceptanceWantOrder(t, peer, 3006, 1, append(slices.Clone(order), 3006))
	notificationETACount(t, peer, ctx, "SELECT count(*) FROM audit WHERE action='shuffle'", 1)
}

func TestAcceptanceSkipPreservesGradesAndProgress(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceLab(t, s, 1)
	acceptanceGrade(t, s, 2001, 3001, 1, 4, 0)
	acceptanceJoin(t, s, 1, 3001, 3002, 3003)
	acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
	before := acceptanceSnapshot(t, s, 2001)
	called := acceptanceFindEntry(t, before, 1, 3001, "called")
	acceptanceCommand(t, s, 2001, command{Kind: "skip", EventID: 1, ID: called.ID}, 200)
	after := acceptanceSnapshot(t, s, 2001)
	waiting := acceptanceFindEntry(t, after, 1, 3001, "waiting")
	if waiting.CalledAt != nil || waiting.Score != called.Score || !reflect.DeepEqual(before.Grades, after.Grades) {
		t.Fatal("skip changed grades, score, or retained called_at")
	}
	acceptanceProgress(t, after, 3001, 1, 1)
	acceptanceWantOrder(t, s, 3002, 1, []int64{3002, 3003, 3001})
	// Skipping an ungraded student must not create even an empty grade row.
	acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
	called = acceptanceFindEntry(t, acceptanceSnapshot(t, s, 2001), 1, 3002, "called")
	acceptanceCommand(t, s, 2001, command{Kind: "skip", EventID: 1, ID: called.ID}, 200)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM grades WHERE student_id=3002", 0)
	acceptanceWantOrder(t, s, 3001, 1, []int64{3003, 3001, 3002})
}

func TestAcceptanceMultipleGradesFinishOnlyCurrentEntry(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceSecondEvent(t, s, ctx)
	acceptanceLab(t, s, 1)
	acceptanceLab(t, s, 2)
	acceptanceJoin(t, s, 1, 3001, 3002)
	acceptanceJoin(t, s, 2, 3001)
	acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
	acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 2}, 200)
	called := acceptanceFindEntry(t, acceptanceSnapshot(t, s, 2001), 1, 3001, "called")
	four, five := 4, 5
	c := command{Kind: "grade", UserID: 3001, LabID: 1, Value: &four}
	acceptanceCommand(t, s, 2001, c, 200, "acceptance-grade-replay")
	acceptanceCommand(t, s, 2001, c, 200, "acceptance-grade-replay")
	acceptanceGrade(t, s, 2001, 3001, 2, 5, 0)
	state := acceptanceSnapshot(t, s, 2001)
	acceptanceWantGrade(t, state, 3001, 1, &four, 1, 2001)
	acceptanceWantGrade(t, state, 3001, 2, &five, 1, 2001)
	acceptanceProgress(t, state, 3001, 2, 2)
	acceptanceFindEntry(t, state, 1, 3001, "called")
	finish := command{Kind: "finish", EventID: 1, ID: called.ID}
	acceptanceCommand(t, s, 2001, finish, 200, "acceptance-finish-replay")
	acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
	acceptanceJoin(t, s, 1, 3001)
	acceptanceCommand(t, s, 2001, finish, 200, "acceptance-finish-replay")
	acceptanceCommand(t, s, 2001, finish, 200) // A new key with the stale entry ID is safe too.
	state = acceptanceSnapshot(t, acceptancePeer(t, s, ctx), 2001)
	completed := acceptanceFindEntry(t, state, 1, 3001, "completed")
	if completed.EndedAt == nil {
		t.Fatal("completed visit has no end time")
	}
	acceptanceFindEntry(t, state, 1, 3002, "called")
	acceptanceFindEntry(t, state, 1, 3001, "waiting")
	acceptanceFindEntry(t, state, 2, 3001, "called")
	acceptanceWantGrade(t, state, 3001, 1, &four, 1, 2001)
	acceptanceWantGrade(t, state, 3001, 2, &five, 1, 2001)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM audit WHERE action='grade_change'", 2)
}

func TestAcceptanceFailingGradeAllowsFinishAndReentry(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceLab(t, s, 1)
	acceptanceJoin(t, s, 1, 3001)
	acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
	called := acceptanceFindEntry(t, acceptanceSnapshot(t, s, 2001), 1, 3001, "called")
	acceptanceGrade(t, s, 2001, 3001, 1, 2, 0)
	acceptanceProgress(t, acceptanceSnapshot(t, s, 3001), 3001, 0, 1)
	acceptanceCommand(t, s, 2001, command{Kind: "finish", EventID: 1, ID: called.ID}, 200)
	acceptanceJoin(t, s, 1, 3001)
	state := acceptanceSnapshot(t, s, 3001)
	acceptanceFindEntry(t, state, 1, 3001, "completed")
	newer := acceptanceFindEntry(t, state, 1, 3001, "waiting")
	if newer.ID == called.ID || newer.Score != 0 || !newer.JoinedAt.After(called.JoinedAt) {
		t.Fatalf("bad failing-grade reentry: %+v", newer)
	}
	two := 2
	acceptanceWantGrade(t, state, 3001, 1, &two, 1, 2001)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE event_id=1 AND user_id=3001", 2)
}

func TestAcceptanceRegistrationCloseAndTerminalHistory(t *testing.T) {
	for _, action := range []string{"complete", "cancel"} {
		t.Run(action, func(t *testing.T) {
			s, ctx := acceptanceServer(t)
			acceptanceSecondEvent(t, s, ctx)
			acceptanceLab(t, s, 1)
			acceptanceGrade(t, s, 2001, 3001, 1, 4, 0)
			acceptanceJoin(t, s, 1, 3001, 3002, 3003)
			acceptanceJoin(t, s, 2, 3002)
			acceptanceCommand(t, s, 2001, command{Kind: "event_action", EventID: 1, Action: "close"}, 200)
			acceptanceCommand(t, s, 3004, command{Kind: "join", EventID: 1}, 400)
			acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
			called := acceptanceFindEntry(t, acceptanceSnapshot(t, s, 2001), 1, 3001, "called")
			acceptanceCommand(t, s, 2001, command{Kind: "finish", EventID: 1, ID: called.ID}, 200)
			acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
			acceptanceCommand(t, s, 2001, command{Kind: "event_action", EventID: 1, Action: action}, 200)
			for _, c := range []command{{Kind: "join", EventID: 1}, {Kind: "next", EventID: 1}, {Kind: "event_action", EventID: 1, Action: "open"}, {Kind: "event_action", EventID: 1, Action: "start"}} {
				acceptanceCommand(t, s, 2001, c, 400)
			}
			state := acceptanceSnapshot(t, acceptancePeer(t, s, ctx), 3001)
			acceptanceFindEntry(t, state, 1, 3001, "completed")
			for _, u := range []int64{3002, 3003} {
				if e := acceptanceFindEntry(t, state, 1, u, "closed"); e.EndedAt == nil {
					t.Fatal("closed history missing ended_at")
				}
			}
			acceptanceFindEntry(t, state, 2, 3002, "waiting")
			acceptanceWantOrder(t, s, 3001, 1, []int64{})
			notificationETACount(t, s, ctx, "SELECT count(*) FROM entries", 4) // No migration or duplicate history.
			wantState := "completed"
			if action == "cancel" {
				wantState = "cancelled"
			}
			notificationETACount(t, s, ctx, "SELECT count(*) FROM events WHERE id=1 AND state=$1 AND NOT registration_open", 1, wantState)
			four := 4
			acceptanceWantGrade(t, state, 3001, 1, &four, 1, 2001)
			acceptanceGrade(t, s, 2001, 3001, 1, 5, 1) // Assignment survives terminal event state.
		})
	}
}

func TestAcceptanceStudentGradebookAndDeniedMutations(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceLab(t, s, 1)
	acceptanceGrade(t, s, 2001, 3001, 1, 4, 0)
	acceptanceGrade(t, s, 2001, 3002, 1, 5, 0)
	acceptanceJoin(t, s, 1, 3001, 3002)
	state := acceptanceSnapshot(t, s, 3001)
	four, five := 4, 5
	acceptanceWantGrade(t, state, 3001, 1, &four, 1, 2001)
	acceptanceWantGrade(t, state, 3002, 1, &five, 1, 2001)
	entry := acceptanceFindEntry(t, state, 1, 3002, "waiting")
	for _, c := range []command{{Kind: "move", EventID: 1, ID: entry.ID, Position: 1}, {Kind: "grade", UserID: 3002, LabID: 1, Value: &four, Version: 1}} {
		acceptanceCommand(t, s, 3001, c, 403)
	}
	after := acceptanceSnapshot(t, s, 3001)
	if !reflect.DeepEqual(state.Entries, after.Entries) || !reflect.DeepEqual(state.Grades, after.Grades) {
		t.Fatal("denied student write mutated queue or grades")
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM audit WHERE actor_id=3001 AND action IN ('grade','move','grade_change')", 0)
}

func TestAcceptanceManualOrderVisibleAndPersistent(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceLab(t, s, 1)
	acceptanceJoin(t, s, 1, 3001, 3002, 3003)
	id := acceptanceFindEntry(t, acceptanceSnapshot(t, s, 1001), 1, 3003, "waiting").ID
	acceptanceCommand(t, s, 1001, command{Kind: "move", EventID: 1, ID: id, Position: 1}, 200)
	acceptanceGrade(t, s, 2001, 3002, 1, 5, 0)
	peer := acceptancePeer(t, s, ctx)
	for _, viewer := range []int64{1001, 2001, 3001, 3002} {
		acceptanceWantOrder(t, peer, viewer, 1, []int64{3003, 3001, 3002})
	}
	acceptanceJoin(t, peer, 1, 3004)
	acceptanceWantOrder(t, s, 3003, 1, []int64{3004, 3003, 3001, 3002})
	notificationETACount(t, s, ctx, "SELECT count(*) FROM events WHERE id=1 AND manual_order", 1)
}

func TestAcceptanceOtherAuthorOutsideQueueAndClear(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceSecondEvent(t, s, ctx)
	acceptanceLab(t, s, 1)
	acceptanceJoin(t, s, 1, 3001, 3002)
	acceptanceJoin(t, s, 2, 3001)
	acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
	before := acceptanceSnapshot(t, s, 2001).Entries
	acceptanceGrade(t, s, 1001, 3003, 1, 5, 0)
	acceptanceGrade(t, s, 2001, 3003, 1, 4, 1)
	state := acceptanceSnapshot(t, s, 2001)
	four := 4
	acceptanceWantGrade(t, state, 3003, 1, &four, 2, 2001)
	acceptanceProgress(t, state, 3003, 1, 1)
	acceptanceGrade(t, s, 2001, 3001, 1, 4, 0)
	acceptanceProgress(t, acceptanceSnapshot(t, s, 2001), 3001, 1, 1)
	for _, u := range []int64{3001, 3003} {
		version := 1
		if u == 3003 {
			version = 2
		}
		acceptanceCommand(t, s, 2001, command{Kind: "grade", UserID: u, LabID: 1, Version: version}, 200)
	}
	state = acceptanceSnapshot(t, s, 2001)
	acceptanceWantGrade(t, state, 3003, 1, nil, 3, 2001)
	acceptanceWantGrade(t, state, 3001, 1, nil, 2, 2001)
	acceptanceProgress(t, state, 3001, 0, 1)
	acceptanceProgress(t, state, 3003, 0, 1)
	if !reflect.DeepEqual(before, state.Entries) {
		t.Fatal("outside-queue edit or clear changed an entry in either event")
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE user_id=3003", 0)
	notificationETACount(t, s, ctx, `SELECT count(*) FROM audit WHERE action='grade_change' AND actor_id=2001 AND payload->>'student_id'='3003' AND payload->>'old'='5' AND payload->>'new'='4' AND at IS NOT NULL`, 1)
}

func TestAcceptanceLabChangesDuringLiveVisit(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceLab(t, s, 1)
	acceptanceLab(t, s, 2)
	acceptanceGrade(t, s, 2001, 3001, 1, 4, 0)
	acceptanceJoin(t, s, 1, 3001, 3002)
	acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
	before := acceptanceSnapshot(t, s, 2001)
	acceptanceProgress(t, before, 3001, 1, 2)
	acceptanceCommand(t, s, 2001, command{Kind: "lab", ID: 1, Number: 1, Name: "Renamed during visit"}, 200)
	acceptanceLab(t, s, 3)
	acceptanceProgress(t, acceptanceSnapshot(t, s, 3001), 3001, 1, 3)
	acceptanceCommand(t, s, 2001, command{Kind: "lab", ID: 1, Number: 1, Name: "Renamed during visit", Enabled: true}, 200)
	after := acceptanceSnapshot(t, s, 3001)
	acceptanceProgress(t, after, 3001, 0, 2)
	found := false
	for _, l := range after.Labs {
		if l.ID == 1 {
			found = l.Name == "Renamed during visit" && l.Archived
		}
	}
	if !found {
		t.Fatal("student snapshot did not expose updated lab")
	}
	four := 4
	acceptanceWantGrade(t, after, 3001, 1, &four, 1, 2001)
	if !reflect.DeepEqual(before.Entries, after.Entries) {
		t.Fatal("lab changes mutated the live queue")
	}
	// A new registration uses the revised active-lab set, not old progress.
	acceptanceCommand(t, s, 3001, command{Kind: "leave", EventID: 1, ID: before.Entries[0].ID}, 200)
	acceptanceJoin(t, s, 1, 3001)
	notificationETACount(t, s, ctx, "SELECT score FROM entries WHERE user_id=3001 AND state='waiting'", 0)
}

func TestAcceptanceRejectedGradePreservesVisit(t *testing.T) {
	s, ctx := acceptanceServer(t)
	acceptanceLab(t, s, 1)
	acceptanceJoin(t, s, 1, 3001)
	acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
	acceptanceGrade(t, s, 2001, 3001, 1, 4, 0)
	before := acceptanceSnapshot(t, s, 2001)
	invalid := 6
	acceptanceCommand(t, s, 2001, command{Kind: "grade", UserID: 3001, LabID: 1, Value: &invalid, Version: 1}, 400)
	five := 5
	acceptanceCommand(t, s, 2001, command{Kind: "grade", UserID: 3001, LabID: 1, Value: &five}, 409)
	after := acceptanceSnapshot(t, s, 2001)
	if !reflect.DeepEqual(before.Grades, after.Grades) || !reflect.DeepEqual(before.Entries, after.Entries) {
		t.Fatal("rejected grade changed committed data or current visit")
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM audit WHERE action='grade_change'", 1)
	// The browser, not the backend, blocks finish while a local edit is pending.
}
