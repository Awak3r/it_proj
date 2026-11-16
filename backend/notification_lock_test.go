package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Delivery holds its transaction open both during HTTP and while recording the
// outcome. Neither phase may stall commands, even for an unrelated event.
func TestFR15FinishDoesNotWaitForDeliveryTransaction(t *testing.T) {
	for _, stage := range []string{"row-lock", "retry-update", "delivered-update", "http-in-flight"} {
		for _, otherEvent := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/other-event=%v", stage, otherEvent), func(t *testing.T) {
				s, ctx := notificationETAServer(t)
				notificationETAExec(t, s, ctx, "UPDATE entries SET state='called',called_at=now() WHERE id=1")
				notificationETANear(t, s, ctx)
				eventID, entryID := int64(1), int64(1)
				if otherEvent {
					notificationETAExec(t, s, ctx, `INSERT INTO events(id,name,subject_id,teacher_id,starts_at,state,strategy) VALUES(2,'Other event',1,1001,now(),'live','fifo'); INSERT INTO event_groups VALUES(2,1); INSERT INTO entries(id,event_id,user_id,position,score,state,called_at) VALUES(6,2,3006,1,0,'called',now());`)
					eventID, entryID = 2, 6
				}
				var release func()
				if stage == "http-in-flight" {
					s.token = "synthetic-test-token"
					entered, unblock, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
					client := &http.Client{Transport: notificationETATransport(func(r *http.Request) (*http.Response, error) {
						close(entered)
						select {
						case <-unblock:
						case <-r.Context().Done():
							return nil, r.Context().Err()
						}
						return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true}`)), Header: make(http.Header)}, nil
					})}
					go func() { defer close(done); s.deliver(ctx, client) }()
					release = func() { close(unblock); <-done }
					defer release()
					select {
					case <-entered:
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
				} else {
					tx, err := s.db.Begin(ctx)
					if err != nil {
						t.Fatal(err)
					}
					defer tx.Rollback(context.Background())
					if _, err = tx.Exec(ctx, "SELECT id FROM notifications WHERE entry_id=2 AND kind='near' FOR UPDATE"); err != nil {
						t.Fatal(err)
					}
					if stage == "retry-update" {
						_, err = tx.Exec(ctx, "UPDATE notifications SET attempts=attempts+1,next_at=now()+interval '15 seconds' WHERE entry_id=2 AND kind='near'")
					}
					if stage == "delivered-update" {
						_, err = tx.Exec(ctx, "UPDATE notifications SET attempts=attempts+1,delivered_at=now() WHERE entry_id=2 AND kind='near'")
					}
					if err != nil {
						t.Fatal(err)
					}
				}
				body, _ := json.Marshal(command{Kind: "finish", EventID: eventID, ID: entryID})
				requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				defer cancel()
				r := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewReader(body)).WithContext(requestCtx)
				r.Header.Set("Idempotency-Key", "notification-lock-probe-finish")
				w := httptest.NewRecorder()
				done := make(chan struct{})
				started := time.Now()
				go func() { defer close(done); s.command(w, r, 1001) }()
				select {
				case <-done:
					t.Logf("finish completed in %s while delivery transaction remained open: HTTP %d", time.Since(started), w.Code)
				case <-time.After(time.Second):
					followerDone := make(chan struct{})
					follower := httptest.NewRequest(http.MethodPost, "/api/command", strings.NewReader(fmt.Sprintf(`{"kind":"event_action","event_id":%d,"action":"close"}`, eventID))).WithContext(requestCtx)
					follower.Header.Set("Idempotency-Key", "notification-lock-probe-follower")
					go func() { defer close(followerDone); s.command(httptest.NewRecorder(), follower, 1001) }()
					time.Sleep(100 * time.Millisecond)
					rows, err := s.db.Query(ctx, `SELECT a.pid,a.wait_event_type,a.wait_event,a.query,pg_blocking_pids(a.pid)::text FROM pg_stat_activity a WHERE a.datname=current_database() AND cardinality(pg_blocking_pids(a.pid))>0`)
					if err != nil {
						t.Fatal(err)
					}
					for rows.Next() {
						var pid int
						var kind, event, query, blockers string
						if err := rows.Scan(&pid, &kind, &event, &query, &blockers); err != nil {
							t.Fatal(err)
						}
						t.Logf("WAIT pid=%d %s/%s blockers=%s query=%s", pid, kind, event, blockers, query)
					}
					rows.Close()
					<-done
					<-followerDone
					t.Errorf("finish waited on delivery: %s HTTP %d %s", time.Since(started), w.Code, w.Body.String())
				}
				if w.Code != http.StatusOK {
					t.Fatalf("finish: HTTP %d %s", w.Code, w.Body.String())
				}
				notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE id=$1 AND state='completed'", 1, entryID)
				notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE entry_id=2 AND kind='near'", 1)
				wantNew := 1
				if otherEvent {
					wantNew = 0
				}
				notificationETACount(t, s, ctx, "SELECT count(*) FROM notifications WHERE entry_id=4 AND kind='near'", wantNew)
				// The global advisory lock must also be available to subsequent commands.
				notificationETACommand(t, s, command{Kind: "event_action", EventID: eventID, Action: "close"})
				notificationETACount(t, s, ctx, "SELECT count(*) FROM audit WHERE action='finish'", 1)
				// Replay must preserve the same atomic response without adding audit rows.
				r = httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewReader(body)).WithContext(requestCtx)
				r.Header.Set("Idempotency-Key", "notification-lock-probe-finish")
				replay := httptest.NewRecorder()
				s.command(replay, r, 1001)
				if replay.Code != http.StatusOK {
					t.Fatalf("replay: %d %s", replay.Code, replay.Body.String())
				}
				notificationETACount(t, s, ctx, "SELECT count(*) FROM audit WHERE action='finish'", 1)
			})
		}
	}
}
