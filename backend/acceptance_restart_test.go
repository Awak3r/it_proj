package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"reflect"
	"runtime"
	"slices"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"
)

const acceptanceRestartMarker = "LABTURN_ACCEPTANCE_RESTART_CHILD"

func TestAcceptanceRestartMainHelper(t *testing.T) {
	if os.Getenv(acceptanceRestartMarker) != "1" {
		t.Skip("subprocess entry point only")
	}
	main()
}

type acceptanceAppProcess struct {
	cmd       *exec.Cmd
	done      chan struct{}
	waitErr   error
	url       string
	client    *http.Client
	transport *http.Transport
	stopped   bool
}

func (p *acceptanceAppProcess) stop() error {
	if p.stopped {
		return nil
	}
	p.stopped = true
	defer p.transport.CloseIdleConnections()
	select {
	case <-p.done:
		return fmt.Errorf("app exited before SIGTERM: %v", p.waitErr)
	default:
	}
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		_ = p.cmd.Process.Kill()
		select {
		case <-p.done:
		case <-time.After(3 * time.Second):
		}
		return fmt.Errorf("could not terminate app: %w", err)
	}
	select {
	case <-p.done:
		if p.waitErr != nil {
			return fmt.Errorf("app did not exit cleanly on SIGTERM: %w", p.waitErr)
		}
		return nil
	case <-time.After(5 * time.Second):
		_ = p.cmd.Process.Kill()
		select {
		case <-p.done:
		case <-time.After(3 * time.Second):
			return fmt.Errorf("app could not be reaped after kill")
		}
		return fmt.Errorf("app required kill after SIGTERM timeout")
	}
}

func acceptanceStartApp(t *testing.T, ctx context.Context, dsn string) *acceptanceAppProcess {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	p := &acceptanceAppProcess{
		cmd:  exec.Command(executable, "-test.run=^TestAcceptanceRestartMainHelper$", "-test.count=1", "-test.timeout=25s"),
		done: make(chan struct{}),
		url:  "http://" + addr,
		transport: &http.Transport{
			DialContext: (&net.Dialer{Timeout: time.Second}).DialContext,
		},
	}
	p.client = &http.Client{Transport: p.transport, Timeout: time.Second}
	// Do not inherit application secrets, proxy settings, or a remote DB endpoint.
	p.cmd.Env = []string{
		acceptanceRestartMarker + "=1",
		"DATABASE_URL=" + dsn,
		"TEST_DATABASE_URL=" + dsn,
		"BOT_TOKEN=",
		"DEV_AUTH=true",
		"ROOT_TELEGRAM_IDS=1001",
		"LISTEN_ADDR=" + addr,
		"APP_URL=" + p.url,
	}
	// Startup errors may contain the DSN; never relay child logs into test output.
	p.cmd.Stdout, p.cmd.Stderr = io.Discard, io.Discard
	if err := p.cmd.Start(); err != nil {
		t.Fatalf("start app subprocess: %v", err)
	}
	go func() {
		p.waitErr = p.cmd.Wait()
		close(p.done)
	}()
	t.Cleanup(func() {
		if err := p.stop(); err != nil {
			t.Error(err)
		}
	})

	readyCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-p.done:
			t.Fatalf("app exited during startup: %v (child logs suppressed)", p.waitErr)
		default:
		}
		r, err := http.NewRequestWithContext(readyCtx, http.MethodGet, p.url+"/api/health", nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := p.client.Do(r)
		if err == nil {
			var health struct{ OK bool }
			decodeErr := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&health)
			response.Body.Close()
			if response.StatusCode == http.StatusOK && decodeErr == nil && health.OK {
				return p
			}
		}
		select {
		case <-p.done:
			t.Fatalf("app exited during startup: %v (child logs suppressed)", p.waitErr)
		case <-readyCtx.Done():
			t.Fatal("app did not become healthy within readiness deadline")
		case <-tick.C:
		}
	}
}

func acceptanceRestartRequest(t *testing.T, ctx context.Context, p *acceptanceAppProcess, uid int64, c *command, status int) []byte {
	t.Helper()
	method, path := http.MethodGet, "/api/state"
	var payload []byte
	var err error
	if c != nil {
		method, path = http.MethodPost, "/api/command"
		payload, err = json.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
	}
	r, err := http.NewRequestWithContext(ctx, method, p.url+path, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("X-Dev-User", fmt.Sprint(uid))
	if c != nil {
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", fmt.Sprintf("restart-http-%d", time.Now().UnixNano()))
	}
	response, err := p.client.Do(r)
	if err != nil {
		t.Fatalf("local app HTTP request: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != status {
		t.Fatalf("%s %s: HTTP %d, want %d", method, path, response.StatusCode, status)
	}
	if status != http.StatusOK {
		var failure struct{ Error string }
		if json.Unmarshal(body, &failure) != nil || failure.Error == "" {
			t.Fatal("rejected command did not return a JSON error")
		}
	}
	return body
}

func acceptanceRestartSnapshot(t *testing.T, ctx context.Context, p *acceptanceAppProcess, uid int64) acceptanceState {
	t.Helper()
	var state acceptanceState
	body := acceptanceRestartRequest(t, ctx, p, uid, nil, http.StatusOK)
	if err := json.Unmarshal(body, &state); err != nil {
		t.Fatal(err)
	}
	sort.Slice(state.Grades, func(i, j int) bool {
		a, b := state.Grades[i], state.Grades[j]
		if a.StudentID != b.StudentID {
			return a.StudentID < b.StudentID
		}
		return a.LabID < b.LabID
	})
	return state
}

func TestAcceptanceShuffleSurvivesOSProcessRestart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("SIGTERM restart test requires a POSIX host, such as WSL or a Linux runner")
	}
	s, ctx := acceptanceServer(t)
	dsn, err := url.Parse(os.Getenv("TEST_DATABASE_URL"))
	if err != nil || (dsn.Scheme != "postgres" && dsn.Scheme != "postgresql") {
		t.Fatal("restart test requires a local TEST_DATABASE_URL PostgreSQL URI")
	}
	var schema string
	if err := s.db.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(schema, "notification_eta_") || s.db.Config().ConnConfig.RuntimeParams["search_path"] != schema {
		t.Fatal("restart test requires the acceptance fixture's isolated schema")
	}
	query := dsn.Query()
	query.Set("search_path", schema)
	dsn.RawQuery = query.Encode()

	acceptanceLab(t, s, 1)
	acceptanceLab(t, s, 2)
	acceptanceGrade(t, s, 2001, 3001, 1, 4, 0)
	acceptanceGrade(t, s, 2001, 3002, 2, 5, 0)
	acceptanceCommand(t, s, 2001, command{Kind: "strategy", EventID: 1, Strategy: "random"}, 200)
	acceptanceJoin(t, s, 1, 3001, 3002, 3003, 3004, 3005)

	first := acceptanceStartApp(t, ctx, dsn.String())
	acceptanceRestartRequest(t, ctx, first, 1001, &command{Kind: "shuffle", EventID: 1}, http.StatusOK)
	before := acceptanceRestartSnapshot(t, ctx, first, 3001)
	order := acceptanceOrder(before, 1)
	participants := slices.Clone(order)
	slices.Sort(participants)
	if !slices.Equal(participants, []int64{3001, 3002, 3003, 3004, 3005}) {
		t.Fatalf("shuffle lost or duplicated participants: %v", order)
	}
	if len(before.Events) != 1 || before.Events[0].ID != 1 || !before.Events[0].Shuffled {
		t.Fatal("first process snapshot missing persisted shuffle flag")
	}
	four, five := 4, 5
	acceptanceWantGrade(t, before, 3001, 1, &four, 1, 2001)
	acceptanceWantGrade(t, before, 3002, 2, &five, 1, 2001)
	if err := first.stop(); err != nil {
		t.Fatal(err)
	}

	second := acceptanceStartApp(t, ctx, dsn.String())
	t.Logf("real main() restart: PID %d terminated and reaped; replacement PID %d", first.cmd.Process.Pid, second.cmd.Process.Pid)
	for _, viewer := range []int64{1001, 2001, 3001, 3005} {
		after := acceptanceRestartSnapshot(t, ctx, second, viewer)
		if !reflect.DeepEqual(before.Entries, after.Entries) || !reflect.DeepEqual(before.Events, after.Events) || !reflect.DeepEqual(before.Grades, after.Grades) {
			t.Fatalf("persisted queue, shuffle flag, or grades changed after OS-process restart for viewer %d", viewer)
		}
	}
	acceptanceRestartRequest(t, ctx, second, 1001, &command{Kind: "shuffle", EventID: 1}, http.StatusBadRequest)
	afterRejection := acceptanceRestartSnapshot(t, ctx, second, 3001)
	if !reflect.DeepEqual(before.Entries, afterRejection.Entries) || !reflect.DeepEqual(before.Events, afterRejection.Events) || !reflect.DeepEqual(before.Grades, afterRejection.Grades) {
		t.Fatal("rejected second shuffle changed persisted state")
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM audit WHERE action='shuffle'", 1)
	if err := second.stop(); err != nil {
		t.Fatal(err)
	}
}
