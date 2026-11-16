package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Only invalidation signals leave this hub. Each client reads its own authorized
// snapshot via /api/state; no grades, names or identifiers travel in the stream.
type updateHub struct {
	mu      sync.Mutex
	online  bool
	clients map[chan struct{}]struct{}
}

func newUpdateHub() *updateHub {
	return &updateHub{clients: make(map[chan struct{}]struct{})}
}

func (h *updateHub) subscribe() (chan struct{}, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := make(chan struct{}, 1)
	h.clients[c] = struct{}{}
	return c, func() { h.mu.Lock(); delete(h.clients, c); h.mu.Unlock() }
}

func (h *updateHub) publish(online bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.online = online
	for c := range h.clients {
		select {
		case c <- struct{}{}:
		default:
		} // Slow clients need one fresh snapshot.
	}
}

func (h *updateHub) available() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.online
}

func (s *server) listenUpdates(ctx context.Context) {
	for ctx.Err() == nil {
		s.listenOnce(ctx)
		s.updates.publish(false)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (s *server) listenOnce(ctx context.Context) {
	// A dedicated connection, not one per subscriber and not held from the API pool.
	config := s.db.Config().ConnConfig.Copy()
	config.ConnectTimeout = 5 * time.Second
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		conn.Close(cleanup)
	}()
	var schema string
	if err = conn.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		return
	}
	if _, err = conn.Exec(ctx, "LISTEN labturn_updates"); err != nil {
		return
	}
	// Also invalidates snapshots after a listener outage: notifications aren't durable.
	s.updates.publish(true)
	for {
		waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		n, err := conn.WaitForNotification(waitCtx)
		cancel()
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			pingCtx, stop := context.WithTimeout(ctx, 5*time.Second)
			err = conn.Ping(pingCtx)
			stop()
			if err == nil {
				continue
			}
		}
		if err != nil {
			return
		}
		if n.Payload == schema {
			s.updates.publish(true)
		}
	}
}

func (s *server) streamUpdates(w http.ResponseWriter, r *http.Request, _ int64) {
	if s.updates == nil {
		http.Error(w, "Updates unavailable", http.StatusServiceUnavailable)
		return
	}
	changes, unsubscribe := s.updates.subscribe()
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	send := func(message string) bool {
		// Override the normal HTTP write timeout for each bounded streaming write.
		if err := rc.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return false
		}
		if _, err := fmt.Fprint(w, message); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	invalidate := func() bool {
		if !s.updates.available() {
			return send("event: unavailable\ndata: {}\n\n")
		}
		return send("event: change\ndata: {}\n\n")
	}
	if !invalidate() {
		return
	}
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	// Periodically reconnect to revalidate Telegram credentials and release old streams.
	lifetime := time.NewTimer(30 * time.Minute)
	defer lifetime.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-lifetime.C:
			return
		case <-changes:
			if !invalidate() {
				return
			}
		case <-tick.C:
			if _, err := s.identity(r); err != nil {
				return
			}
			if !send(": heartbeat\n\n") {
				return
			}
		}
	}
}
