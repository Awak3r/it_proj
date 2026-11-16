package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Each case owns a schema; these tests never seed or reset an application DB.
func notificationETAServer(t *testing.T) (*server, context.Context) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL required (local PostgreSQL only)")
	}
	conf, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid TEST_DATABASE_URL")
	}
	local := func(host string) bool {
		return host == "127.0.0.1" || host == "::1" || host == "localhost" || strings.HasPrefix(host, "/")
	}
	if !local(conf.ConnConfig.Host) {
		t.Fatal("notification/ETA tests require local PostgreSQL")
	}
	for _, fallback := range conf.ConnConfig.Fallbacks {
		if !local(fallback.Host) {
			t.Fatal("notification/ETA tests require local PostgreSQL fallbacks")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	base, err := pgxpool.NewWithConfig(ctx, conf)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(base.Close)
	schema := fmt.Sprintf("notification_eta_%d", time.Now().UnixNano())
	if _, err = base.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if _, err := base.Exec(cleanup, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	conf = conf.Copy()
	conf.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, conf)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	if err = migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	s := &server{db: db, roots: map[int64]bool{1001: true}}
	notificationETAExec(t, s, ctx, `
INSERT INTO groups(id,name) VALUES(1,'Synthetic group');
INSERT INTO subjects(id,name) VALUES(1,'Synthetic subject');
INSERT INTO subject_groups(subject_id,group_id) VALUES(1,1);
INSERT INTO users(id,name,teacher) VALUES(1001,'Synthetic teacher',true);
INSERT INTO users(id,name,group_id) SELECT n,'Synthetic student '||n,1 FROM generate_series(3001,3010) n;
INSERT INTO events(id,name,subject_id,teacher_id,starts_at,state,strategy,duration,room)
 VALUES(1,'Synthetic event',1,1001,now(),'live','fifo',9,'404');
INSERT INTO event_groups(event_id,group_id) VALUES(1,1);
INSERT INTO entries(id,event_id,user_id,position,score)
 SELECT n,1,3000+n,n,0 FROM generate_series(1,5) n;`)
	return s, ctx
}

func notificationETAExec(t *testing.T, s *server, ctx context.Context, sql string, args ...any) {
	t.Helper()
	if _, err := s.db.Exec(ctx, sql, args...); err != nil {
		t.Fatal(err)
	}
}

func notificationETACount(t *testing.T, s *server, ctx context.Context, sql string, want int, args ...any) {
	t.Helper()
	var got int
	if err := s.db.QueryRow(ctx, sql, args...).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("%s: got %d, want %d", sql, got, want)
	}
}

func notificationETACommand(t *testing.T, s *server, c command) {
	t.Helper()
	body, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewReader(body))
	r.Header.Set("Idempotency-Key", fmt.Sprintf("notification-eta-%d", time.Now().UnixNano()))
	w := httptest.NewRecorder()
	s.command(w, r, 1001)
	if w.Code != http.StatusOK {
		t.Fatalf("%s/%s: HTTP %d: %s", c.Kind, c.Action, w.Code, w.Body.String())
	}
}

func notificationETANear(t *testing.T, s *server, ctx context.Context) {
	t.Helper()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = s.nearNotifications(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestFR15NearNotificationEligibility(t *testing.T) {
	for _, tc := range []struct {
		name, state, strategy string
		shuffled              bool
		want                  int
	}{
		{"live FIFO", "live", "fifo", false, 3},
		{"planned", "planned", "fifo", false, 0},
		{"completed", "completed", "fifo", false, 0},
		{"cancelled", "cancelled", "fifo", false, 0},
		{"random before shuffle", "live", "random", false, 0},
		{"random after shuffle", "live", "random", true, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, ctx := notificationETAServer(t)
			notificationETAExec(t, s, ctx, "UPDATE events SET state=$1,strategy=$2,shuffled=$3", tc.state, tc.strategy, tc.shuffled)
			notificationETANear(t, s, ctx)
			notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE kind='near'", tc.want)
			notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE entry_id>3", 0)
		})
	}
}

func TestFR15NearThresholdAndOncePerEntry(t *testing.T) {
	s, ctx := notificationETAServer(t)
	// The called student counts ahead even with a larger stored position;
	// inactive entries must not count towards the two-person threshold.
	notificationETAExec(t, s, ctx, "UPDATE entries SET state='called',position=99,called_at=now() WHERE id=1")
	notificationETAExec(t, s, ctx, "UPDATE entries SET state='left',ended_at=now() WHERE id=2")
	notificationETANear(t, s, ctx)
	notificationETANear(t, s, ctx)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE kind='near'", 2)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE entry_id IN (3,4) AND recipient=3000+entry_id AND event_id=1 AND message LIKE '%Synthetic event%'", 2)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE entry_id IN (1,2,5)", 0)
	// A previously notified entry may leave and re-enter the threshold, but
	// only a genuinely new registration is entitled to another near notice.
	notificationETAExec(t, s, ctx, "UPDATE entries SET position=100 WHERE id=3")
	notificationETANear(t, s, ctx)
	notificationETAExec(t, s, ctx, "UPDATE entries SET position=1 WHERE id=3")
	notificationETANear(t, s, ctx)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE entry_id=3 AND kind='near'", 1)
	notificationETAExec(t, s, ctx, "UPDATE entries SET state='left' WHERE id=3")
	notificationETAExec(t, s, ctx, "INSERT INTO entries(id,event_id,user_id,position,score) VALUES(6,1,3003,0,0)")
	notificationETANear(t, s, ctx)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE recipient=3003 AND kind='near'", 2)
}

func TestFR15CallNotificationContentAndRecall(t *testing.T) {
	for _, room := range []string{"404", ""} {
		t.Run("room="+room, func(t *testing.T) {
			s, ctx := notificationETAServer(t)
			notificationETAExec(t, s, ctx, "DELETE FROM entries WHERE id<>1")
			notificationETAExec(t, s, ctx, "UPDATE events SET room=$1", room)
			notificationETACommand(t, s, command{Kind: "next", EventID: 1})
			notificationETACommand(t, s, command{Kind: "next", EventID: 1})
			notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE kind LIKE 'call-%'", 1)
			var message string
			if err := s.db.QueryRow(ctx, "SELECT message FROM notifications WHERE kind LIKE 'call-%'").Scan(&message); err != nil {
				t.Fatal(err)
			}
			want := "Ваша очередь: Synthetic subject · Synthetic event"
			if room != "" {
				want += " · ауд. " + room
			}
			if message != want {
				t.Fatalf("call message = %q, want %q", message, want)
			}
			notificationETACommand(t, s, command{Kind: "skip", EventID: 1, ID: 1})
			notificationETACommand(t, s, command{Kind: "next", EventID: 1})
			notificationETACount(t, s, ctx, "SELECT count(DISTINCT kind) FROM notifications WHERE kind LIKE 'call-%' AND entry_id=1 AND event_id=1 AND recipient=3001", 2)
		})
	}
}

func TestFR15TerminalNotificationKinds(t *testing.T) {
	for _, tc := range []struct{ action, state, text string }{
		{"complete", "completed", "Событие завершено. Активная запись закрыта."},
		{"cancel", "cancelled", "Событие отменено. Активная запись закрыта."},
	} {
		t.Run(tc.action, func(t *testing.T) {
			s, ctx := notificationETAServer(t)
			notificationETAExec(t, s, ctx, "UPDATE entries SET state='called',called_at=now() WHERE id=1")
			notificationETAExec(t, s, ctx, "UPDATE entries SET state=CASE id WHEN 3 THEN 'completed' WHEN 4 THEN 'left' ELSE 'removed' END WHERE id>=3")
			// Closing registration is not terminal event closure.
			notificationETACommand(t, s, command{Kind: "event_action", EventID: 1, Action: "close"})
			notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE kind='closed'", 0)
			notificationETACommand(t, s, command{Kind: "event_action", EventID: 1, Action: tc.action})
			notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE kind='closed'", 2)
			notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE kind='closed' AND entry_id IN (1,2) AND event_id=1 AND recipient=3000+entry_id AND message=$1", 2, "Synthetic event: "+tc.text)
			notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE id IN (1,2) AND state='closed' AND ended_at IS NOT NULL", 2)
			notificationETACount(t, s, ctx, "SELECT count(*) FROM events WHERE state=$1 AND NOT registration_open", 1, tc.state)
		})
	}
}

type notificationETATransport func(*http.Request) (*http.Response, error)

func (f notificationETATransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestFR15DeliveryFailureDoesNotBlockQueue(t *testing.T) {
	s, ctx := notificationETAServer(t)
	s.token = "synthetic-test-token"
	notificationETACommand(t, s, command{Kind: "next", EventID: 1})
	calls := 0
	client := &http.Client{Transport: notificationETATransport(func(r *http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("synthetic offline transport; no external request")
	})}
	s.deliver(ctx, client)
	if calls != 1 {
		t.Fatalf("transport calls = %d, want 1", calls)
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE kind LIKE 'call-%' AND attempts=1 AND delivered_at IS NULL AND next_at>now()", 1)
	notificationETACommand(t, s, command{Kind: "finish", EventID: 1, ID: 1})
	notificationETACommand(t, s, command{Kind: "next", EventID: 1})
	notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE id=2 AND state='called'", 1)
	// State remains readable after send failure and reflects the new call.
	w := httptest.NewRecorder()
	s.state(w, httptest.NewRequest(http.MethodGet, "/api/state", nil), 3002)
	var state struct {
		Entries []struct {
			ID    int64  `json:"id"`
			State string `json:"state"`
		}
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &state) != nil {
		t.Fatalf("state after failure: HTTP %d: %s", w.Code, w.Body.String())
	}
	for _, entry := range state.Entries {
		if entry.ID == 2 && entry.State == "called" {
			return
		}
	}
	t.Fatal("student snapshot missing current called entry after delivery failure")
}

func TestFR16AverageUsesOnlyCompletedVisitsInCurrentEvent(t *testing.T) {
	s, ctx := notificationETAServer(t)
	notificationETAExec(t, s, ctx, `
UPDATE entries SET state='completed',called_at=now()-interval '10 minutes',ended_at=now() WHERE id=1;
UPDATE entries SET state='completed',called_at=now()-interval '20 minutes',ended_at=now() WHERE id=2;
UPDATE entries SET state='left',called_at=now()-interval '100 minutes',ended_at=now() WHERE id=3;
UPDATE entries SET state='removed',called_at=now()-interval '200 minutes',ended_at=now() WHERE id=4;
UPDATE entries SET state='closed',called_at=now()-interval '300 minutes',ended_at=now() WHERE id=5;
INSERT INTO entries(id,event_id,user_id,position,score,state,ended_at) VALUES(6,1,3006,6,0,'completed',now());
INSERT INTO entries(id,event_id,user_id,position,score,state,called_at) VALUES(7,1,3007,7,0,'called',now()-interval '400 minutes');
INSERT INTO entries(id,event_id,user_id,position,score,state,called_at,ended_at) VALUES(8,1,3008,8,0,'waiting',now()-interval '500 minutes',now());
INSERT INTO events(id,name,subject_id,teacher_id,starts_at,state,strategy)
 VALUES(2,'Other event',1,1001,now(),'live','fifo'),(3,'No samples',1,1001,now(),'planned','fifo');
INSERT INTO entries(id,event_id,user_id,position,score,state,called_at,ended_at)
 VALUES(9,2,3001,1,0,'completed',now()-interval '900 minutes',now());`)
	w := httptest.NewRecorder()
	s.state(w, httptest.NewRequest(http.MethodGet, "/api/state", nil), 1001)
	if w.Code != http.StatusOK {
		t.Fatalf("state: HTTP %d: %s", w.Code, w.Body.String())
	}
	var state struct {
		Events []struct {
			ID      int64    `json:"id"`
			Average *float64 `json:"average_minutes"`
		}
	}
	if err := json.NewDecoder(io.Reader(w.Body)).Decode(&state); err != nil {
		t.Fatal(err)
	}
	if len(state.Events) != 3 {
		t.Fatalf("got %d events, want 3", len(state.Events))
	}
	for _, ev := range state.Events {
		if ev.ID == 3 {
			if ev.Average != nil {
				t.Fatalf("no completed visits: average = %v, want null", *ev.Average)
			}
			continue
		}
		want := 15.0
		if ev.ID == 2 {
			want = 900
		}
		if ev.Average == nil || math.Abs(*ev.Average-want) > 0.001 {
			t.Fatalf("event %d average = %v, want %.1f minutes", ev.ID, ev.Average, want)
		}
	}
}
