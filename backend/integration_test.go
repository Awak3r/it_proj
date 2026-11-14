package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type testTransport func(*http.Request) (*http.Response, error)

func (f testTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestIntegration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL required")
	}
	ctx := context.Background()
	base, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer base.Close()
	schema := fmt.Sprintf("test_%d", time.Now().UnixNano())
	if _, e = base.Exec(ctx, "CREATE SCHEMA "+schema); e != nil {
		t.Fatal(e)
	}
	defer base.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
	conf, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	conf.ConnConfig.RuntimeParams["search_path"] = schema
	db, e := pgxpool.NewWithConfig(ctx, conf)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	sql, _ := files.ReadFile("schema.sql")
	if _, e = db.Exec(ctx, string(sql)); e != nil {
		t.Fatal(e)
	}
	s := &server{db: db, dev: true, roots: map[int64]bool{1001: true}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/state", s.auth(s.state))
	mux.HandleFunc("POST /api/command", s.auth(s.command))
	httpServer := httptest.NewServer(mux)
	defer httpServer.Close()
	call := func(user int64, c command, key string) (int, string) {
		payload, _ := json.Marshal(c)
		req, _ := http.NewRequest("POST", httpServer.URL+"/api/command", bytes.NewReader(payload))
		req.Header.Set("X-Dev-User", fmt.Sprint(user))
		if key == "" {
			key = fmt.Sprintf("test-%d", time.Now().UnixNano())
		}
		req.Header.Set("Idempotency-Key", key)
		resp, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Error(e)
			return 0, ""
		}
		defer resp.Body.Close()
		var b bytes.Buffer
		b.ReadFrom(resp.Body)
		return resp.StatusCode, b.String()
	}
	must := func(user int64, c command) {
		t.Helper()
		status, body := call(user, c, "")
		if status != 200 {
			t.Fatalf("%s: %d %s", c.Kind, status, body)
		}
	}
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if e := db.QueryRow(ctx, sql, args...).Scan(&n); e != nil {
			t.Fatal(e)
		}
		return n
	}
	assert := func(ok bool, msg string) {
		t.Helper()
		if !ok {
			t.Fatal(msg)
		}
	}
	must(1001, command{Kind: "profile", Name: "Root"})
	must(1001, command{Kind: "group", Name: "М8О-201"})
	must(1001, command{Kind: "group", Name: "М8О-202"})
	must(1001, command{Kind: "subject", Name: "Программирование"})
	must(1001, command{Kind: "role", UserID: 2001, Enabled: true})
	must(2001, command{Kind: "profile", Name: "Преподаватель"})
	must(1001, command{Kind: "assignment", SubjectID: 1, GroupID: 1, TeacherID: 2001, Enabled: true})
	must(2001, command{Kind: "lab", SubjectID: 1, GroupID: 1, Number: 1, Name: "Массивы"})
	must(2001, command{Kind: "lab", SubjectID: 1, GroupID: 1, Number: 2, Name: "Указатели"})
	for i := int64(3001); i <= 3100; i++ {
		must(i, command{Kind: "profile", Name: fmt.Sprintf("Студент %d", i), GroupID: 1})
	}
	must(4001, command{Kind: "profile", Name: "Другая группа", GroupID: 2})
	makeEvent := func(strategy string) int64 {
		t.Helper()
		must(2001, command{Kind: "event_create", Name: "Сдача", SubjectID: 1, GroupIDs: []int64{1}, StartsAt: time.Now().Add(time.Hour), Strategy: strategy})
		id := int64(count("SELECT max(id) FROM events"))
		must(2001, command{Kind: "event_action", EventID: id, Action: "open"})
		return id
	}
	first := makeEvent("fifo")
	for i := 0; i < 9; i++ {
		makeEvent("fifo")
	}
	t.Run("authorization", func(t *testing.T) {
		for _, c := range []command{{Kind: "role", UserID: 3001, Enabled: true}, {Kind: "lab", SubjectID: 1, GroupID: 1, Number: 3, Name: "Hack"}, {Kind: "event_action", EventID: first, Action: "start"}, {Kind: "shuffle", EventID: first}} {
			status, _ := call(3001, c, "")
			assert(status == 403, "student obtained write privileges")
		}
		status, _ := call(4001, command{Kind: "join", EventID: first}, "")
		assert(status == 400, "other group joined")
		status, _ = call(3001, command{Kind: "profile", Name: "Student", GroupID: 2}, "")
		assert(status == 400, "student switched group")
	})
	t.Run("concurrent duplicate join", func(t *testing.T) {
		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				status, _ := call(3001, command{Kind: "join", EventID: first}, "")
				if status != 200 && status != 409 {
					t.Errorf("unexpected %d", status)
				}
			}()
		}
		wg.Wait()
		assert(count("SELECT count(*) FROM entries WHERE event_id=$1 AND user_id=3001 AND state='waiting'", first) == 1, "duplicate active entries")
	})
	t.Run("100 users and 10 events", func(t *testing.T) {
		var wg sync.WaitGroup
		start := time.Now()
		for i := int64(3002); i <= 3100; i++ {
			wg.Add(1)
			go func(id int64) {
				defer wg.Done()
				status, b := call(id, command{Kind: "join", EventID: first}, "")
				if status != 200 {
					t.Errorf("join: %d %s", status, b)
				}
			}(i)
		}
		wg.Wait()
		assert(count("SELECT count(*) FROM entries WHERE event_id=$1", first) == 100, "missing entries")
		for i := int64(3001); i <= 3100; i++ {
			wg.Add(1)
			go func(id int64) {
				defer wg.Done()
				req, _ := http.NewRequest("GET", httpServer.URL+"/api/state", nil)
				req.Header.Set("X-Dev-User", fmt.Sprint(id))
				r, e := http.DefaultClient.Do(req)
				if e != nil {
					t.Error(e)
					return
				}
				defer r.Body.Close()
				var state map[string]any
				if e = json.NewDecoder(r.Body).Decode(&state); e != nil || r.StatusCode != 200 {
					t.Errorf("state %d: %v", r.StatusCode, e)
				}
			}(i)
		}
		wg.Wait()
		t.Logf("100 joins + 100 concurrent snapshots with 10 events: %s", time.Since(start))
	})
	t.Run("single current call and stale finish", func(t *testing.T) {
		must(2001, command{Kind: "event_action", EventID: first, Action: "start"})
		var wg sync.WaitGroup
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				status, b := call(2001, command{Kind: "next", EventID: first}, "")
				if status != 200 {
					t.Errorf("%d %s", status, b)
				}
			}()
		}
		wg.Wait()
		assert(count("SELECT count(*) FROM entries WHERE event_id=$1 AND state='called'", first) == 1, "multiple called students")
		id := int64(count("SELECT id FROM entries WHERE event_id=$1 AND state='called'", first))
		must(2001, command{Kind: "finish", EventID: first, ID: id})
		must(2001, command{Kind: "next", EventID: first})
		must(2001, command{Kind: "finish", EventID: first, ID: id})
		assert(count("SELECT count(*) FROM entries WHERE event_id=$1 AND state='called'", first) == 1, "stale finish closed new call")
	})
	t.Run("grade independent and optimistic conflict", func(t *testing.T) {
		v := 4
		must(2001, command{Kind: "grade", UserID: 3001, LabID: 1, Value: &v})
		must(2001, command{Kind: "grade", UserID: 3001, LabID: 2, Value: &v})
		status, _ := call(2001, command{Kind: "grade", UserID: 3001, LabID: 1, Value: &v}, "")
		assert(status == 409, "lost update not detected")
		assert(count("SELECT count(*) FROM entries WHERE event_id=$1 AND state='called'", first) == 1, "grade changed queue")
		must(2001, command{Kind: "grade", UserID: 3001, LabID: 1, Version: 1})
		assert(count("SELECT count(*) FROM grades WHERE student_id=3001 AND value>=3") == 1, "clear not reflected")
	})
	t.Run("skip and newcomers", func(t *testing.T) {
		id := int64(count("SELECT id FROM entries WHERE event_id=$1 AND state='called'", first))
		must(2001, command{Kind: "skip", EventID: first, ID: id})
		must(3001, command{Kind: "join", EventID: first})
		assert(count("SELECT id FROM entries WHERE event_id=$1 AND state='waiting' ORDER BY position DESC LIMIT 1", first) == int(id), "newcomer behind skipped")
	})
	t.Run("manual priority and idempotency", func(t *testing.T) {
		id := int64(count("SELECT id FROM entries WHERE event_id=$1 AND state='waiting' AND user_id=3001", first))
		must(1001, command{Kind: "move", EventID: first, ID: id, Position: 1})
		must(3001, command{Kind: "leave", EventID: first, ID: id})
		key := "replay-join-3001"
		c := command{Kind: "join", EventID: first}
		a, _ := call(3001, c, key)
		b, _ := call(3001, c, key)
		assert(a == 200 && b == 200, "retry rejected")
		assert(count("SELECT user_id FROM entries WHERE event_id=$1 AND state='waiting' ORDER BY position LIMIT 1", first) == 3001, "manual insertion not at front")
		c.Kind = "leave"
		status, _ := call(3001, c, key)
		assert(status == 409, "key reuse accepted")
	})
	t.Run("random root only once and durable", func(t *testing.T) {
		id := makeEvent("random")
		must(3001, command{Kind: "join", EventID: id})
		must(3002, command{Kind: "join", EventID: id})
		must(2001, command{Kind: "event_action", EventID: id, Action: "start"})
		status, _ := call(2001, command{Kind: "next", EventID: id}, "")
		assert(status == 400, "call before shuffle")
		status, _ = call(2001, command{Kind: "shuffle", EventID: id}, "")
		assert(status == 403, "teacher shuffled")
		must(1001, command{Kind: "shuffle", EventID: id})
		status, _ = call(1001, command{Kind: "shuffle", EventID: id}, "")
		assert(status == 400, "second shuffle accepted")
		must(3003, command{Kind: "join", EventID: id})
		assert(count("SELECT user_id FROM entries WHERE event_id=$1 ORDER BY position DESC LIMIT 1", id) == 3003, "late join not last")
		assert(count("SELECT count(*) FROM events WHERE id=$1 AND shuffled", id) == 1, "shuffle not persisted")
		must(2001, command{Kind: "event_action", EventID: id, Action: "cancel"})
		assert(count("SELECT count(*) FROM entries WHERE event_id=$1 AND state='closed'", id) == 3, "cancel did not close entries")
	})
	t.Run("close vs complete and notification outbox", func(t *testing.T) {
		must(2001, command{Kind: "event_action", EventID: first, Action: "close"})
		status, _ := call(3001, command{Kind: "join", EventID: first}, "")
		assert(status == 400, "closed registration accepted join")
		must(2001, command{Kind: "next", EventID: first})
		must(2001, command{Kind: "event_action", EventID: first, Action: "complete"})
		assert(count("SELECT count(*) FROM entries WHERE event_id=$1 AND state IN ('called','waiting')", first) == 0, "active entries survived completion")
		assert(count("SELECT count(*) FROM notifications WHERE event_id=$1", first) > 0, "missing durable notifications")
		v := 5
		must(2001, command{Kind: "grade", UserID: 3001, LabID: 1, Value: &v, Version: 2})
	})
	t.Run("student grade scope", func(t *testing.T) {
		req, _ := http.NewRequest("GET", httpServer.URL+"/api/state", nil)
		req.Header.Set("X-Dev-User", "4001")
		r, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer r.Body.Close()
		var out struct {
			Grades []any
			Audit  []any
		}
		json.NewDecoder(r.Body).Decode(&out)
		assert(len(out.Grades) == 0 && len(out.Audit) == 0, "cross-group data exposed")
	})
	t.Run("production rejects dev header", func(t *testing.T) {
		prod := *s
		prod.dev = false
		r := httptest.NewRequest("GET", "/api/state", nil)
		r.Header.Set("X-Dev-User", "1001")
		w := httptest.NewRecorder()
		prod.auth(prod.state)(w, r)
		assert(w.Code == 401 && strings.Contains(w.Body.String(), "Telegram"), "dev auth enabled in production")
	})
	t.Run("revoked access and forged group", func(t *testing.T) {
		v := 4
		c := command{Kind: "grade", UserID: 3099, LabID: 1, Value: &v}
		must(2001, c) // Healthy control: grant is actually usable.
		c.Version = 1
		must(1001, command{Kind: "assignment", SubjectID: 1, GroupID: 1, TeacherID: 2001, Enabled: false})
		before := count("SELECT count(*) FROM audit")
		status, _ := call(2001, c, "")
		assert(status == 403, "revoked assignment still permits writes")
		assert(count("SELECT version FROM grades WHERE student_id=3099 AND lab_id=1") == 1, "denied write changed grade")
		assert(count("SELECT count(*) FROM audit") == before, "denied write created audit")
		r, _ := http.NewRequest("GET", httpServer.URL+"/api/state", nil)
		r.Header.Set("X-Dev-User", "2001")
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		var state struct{ Grades, Labs, Assignments []any }
		err = json.NewDecoder(response.Body).Decode(&state)
		response.Body.Close()
		assert(err == nil && response.StatusCode == 200, "state read failed")
		assert(len(state.Grades) == 0 && len(state.Labs) == 0 && len(state.Assignments) == 0, "revoked assignment exposes gradebook")
		must(1001, command{Kind: "assignment", SubjectID: 1, GroupID: 1, TeacherID: 2001, Enabled: true})
		forged := c
		forged.UserID = 4001
		status, _ = call(2001, forged, "")
		assert(status == 400, "teacher graded a student from another group")
		assert(count("SELECT count(*) FROM grades WHERE student_id=4001") == 0, "forged write persisted")
		event := makeEvent("fifo")
		must(1001, command{Kind: "role", UserID: 2001, Enabled: false})
		status, _ = call(2001, c, "")
		assert(status == 403, "revoked teacher graded")
		status, _ = call(2001, command{Kind: "event_action", EventID: event, Action: "start"}, "")
		assert(status == 403, "revoked teacher controls event")
		must(1001, command{Kind: "role", UserID: 2001, Enabled: true})
		status, _ = call(2001, c, "")
		assert(status == 403, "old assignment silently restored with role")
		must(1001, command{Kind: "assignment", SubjectID: 1, GroupID: 1, TeacherID: 2001, Enabled: true})
		must(2001, c)
		assert(count("SELECT version FROM grades WHERE student_id=3099 AND lab_id=1") == 2, "new grant not usable")
	})
	t.Run("concurrent grade conflict and durable replay", func(t *testing.T) {
		start := make(chan struct{})
		results := make(chan int, 2)
		for _, value := range []int{4, 5} {
			go func(v int) {
				<-start
				status, _ := call(2001, command{Kind: "grade", UserID: 3098, LabID: 1, Value: &v}, "")
				results <- status
			}(value)
		}
		close(start)
		a, b := <-results, <-results
		assert((a == 200 && b == 409) || (a == 409 && b == 200), "concurrent edits did not conflict")
		assert(count("SELECT version FROM grades WHERE student_id=3098 AND lab_id=1") == 1, "lost update incremented version twice")
		before := count("SELECT count(*) FROM audit WHERE action='grade_change'")
		v := 3
		c := command{Kind: "grade", UserID: 3098, LabID: 1, Value: &v, Version: 1}
		var wg sync.WaitGroup
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				status, body := call(2001, c, "durable-grade-retry")
				if status != 200 {
					t.Errorf("replay: %d %s", status, body)
				}
			}()
		}
		wg.Wait()
		assert(count("SELECT version FROM grades WHERE student_id=3098 AND lab_id=1") == 2, "duplicate replay write")
		assert(count("SELECT count(*) FROM audit WHERE action='grade_change'") == before+1, "duplicate grade audit")
		restarted := &server{db: db, dev: true, roots: map[int64]bool{1001: true}}
		payload, _ := json.Marshal(c)
		r := httptest.NewRequest("POST", "/api/command", bytes.NewReader(payload))
		r.Header.Set("X-Dev-User", "2001")
		r.Header.Set("Idempotency-Key", "durable-grade-retry")
		w := httptest.NewRecorder()
		restarted.auth(restarted.command)(w, r)
		assert(w.Code == 200, "replay lost after server recreation")
		assert(count("SELECT version FROM grades WHERE student_id=3098 AND lab_id=1") == 2, "restart replay wrote again")
	})
	t.Run("notification recovery", func(t *testing.T) {
		// This schema belongs to this test. Defer other fixtures' deliveries.
		if _, err := db.Exec(ctx, "UPDATE notifications SET next_at=now()+interval '1 day'"); err != nil {
			t.Fatal(err)
		}
		var id int64
		if err := db.QueryRow(ctx, "INSERT INTO notifications(recipient,kind,message) VALUES(3001,'qa','Test notice') RETURNING id").Scan(&id); err != nil {
			t.Fatal(err)
		}
		calls := 0
		client := &http.Client{Transport: testTransport(func(r *http.Request) (*http.Response, error) {
			calls++
			var payload struct {
				ChatID int64  `json:"chat_id"`
				Text   string `json:"text"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			assert(payload.ChatID == 3001 && payload.Text == "Test notice", "wrong recipient or payload")
			status, body := 200, `{"ok":true}`
			if calls == 1 {
				status, body = 503, `{"ok":false}`
			}
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
		})}
		s.deliver(ctx, client)
		assert(count("SELECT count(*) FROM notifications WHERE id=$1 AND delivered_at IS NULL AND attempts=1 AND next_at>now()", id) == 1, "failed notification lost or not deferred")
		s.deliver(ctx, client)
		assert(calls == 1, "retried before backoff")
		if _, err := db.Exec(ctx, "UPDATE notifications SET next_at=now() WHERE id=$1", id); err != nil {
			t.Fatal(err)
		}
		restarted := &server{db: db}
		restarted.deliver(ctx, client)
		restarted.deliver(ctx, client)
		assert(calls == 2, "delivered notification repeated or retry missing")
		assert(count("SELECT count(*) FROM notifications WHERE id=$1 AND delivered_at IS NOT NULL AND attempts=2", id) == 1, "successful delivery not persisted")
	})
	t.Run("SSE committed changes across instances and reconnect", func(t *testing.T) {
		// Commands use the original server. A separate instance owns the stream.
		peer := &server{db: db, dev: true, updates: newUpdateHub()}
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		signals, unsubscribe := peer.updates.subscribe()
		defer unsubscribe()
		done := make(chan struct{})
		go func() { defer close(done); peer.listenUpdates(ctx) }()
		defer func() { cancel(); <-done }()
		select {
		case <-signals:
		case <-time.After(5 * time.Second):
			t.Fatal("LISTEN did not become ready")
		}
		streamServer := httptest.NewServer(peer.auth(peer.streamUpdates))
		defer streamServer.Close()
		openStream := func() (*http.Response, *bufio.Reader, context.CancelFunc) {
			t.Helper()
			streamCtx, stop := context.WithTimeout(ctx, 5*time.Second)
			r, _ := http.NewRequestWithContext(streamCtx, "GET", streamServer.URL, nil)
			r.Header.Set("X-Dev-User", "3001")
			response, err := http.DefaultClient.Do(r)
			if err != nil {
				stop()
				t.Fatal(err)
			}
			if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" {
				t.Fatalf("invalid stream: %d", response.StatusCode)
			}
			return response, bufio.NewReader(response.Body), stop
		}
		readChange := func(reader *bufio.Reader) {
			t.Helper()
			for _, want := range []string{"event: change\n", "data: {}\n", "\n"} {
				got, err := reader.ReadString('\n')
				if err != nil || got != want {
					t.Fatalf("stream frame %q; expected %q; error %v", got, want, err)
				}
			}
		}
		response, reader, stop := openStream()
		defer response.Body.Close()
		defer stop()
		readChange(reader)
		v := 5
		c := command{Kind: "grade", UserID: 3096, LabID: 2, Value: &v}
		status, _ := call(2001, c, "sse-committed-grade")
		assert(status == 200, "grade command failed")
		readChange(reader)
		assert(count("SELECT value FROM grades WHERE student_id=3096 AND lab_id=2") == 5, "signal preceded committed data")
		select {
		case <-signals:
		case <-time.After(time.Second):
			t.Fatal("missing invalidation")
		}
		status, _ = call(2001, c, "sse-committed-grade")
		assert(status == 200, "replay failed")
		status, _ = call(2001, c, "sse-rejected-grade")
		assert(status == 409, "stale write accepted")
		select {
		case <-signals:
			t.Fatal("replay or rollback emitted invalidation")
		case <-time.After(150 * time.Millisecond):
		}
		stop()
		response.Body.Close()
		response2, reader2, stop2 := openStream()
		defer response2.Body.Close()
		defer stop2()
		readChange(reader2) // Reconnect always requests a current authorized snapshot.
		peer.updates.publish(false)
		line, err := reader2.ReadString('\n')
		assert(err == nil && line == "event: unavailable\n", "listener outage did not enable fallback")
		prod := &server{db: db, updates: peer.updates}
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "/api/updates", nil)
		r.Header.Set("X-Dev-User", "1001")
		prod.auth(prod.streamUpdates)(w, r)
		assert(w.Code == 401, "SSE accepted forged production authentication")
	})
}
