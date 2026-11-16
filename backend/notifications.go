package main

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"io"
	"net/http"
	"time"
)

func (s *server) worker(ctx context.Context) {
	if s.token == "" {
		return
	}
	tick := time.NewTicker(time.Second * 2)
	defer tick.Stop()
	client := &http.Client{Timeout: 8 * time.Second}
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.deliver(ctx, client)
		}
	}
}
func (s *server) deliver(ctx context.Context, client *http.Client) {
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return
	}
	defer tx.Rollback(ctx)
	var id, recipient int64
	var message string
	var attempts int
	e = tx.QueryRow(ctx, "SELECT id,recipient,message,attempts FROM notifications WHERE delivered_at IS NULL AND next_at<=now() AND attempts<8 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1").Scan(&id, &recipient, &message, &attempts)
	if e == pgx.ErrNoRows || e != nil {
		return
	}
	payload := map[string]any{"chat_id": recipient, "text": message}
	if s.appURL != "" {
		payload["reply_markup"] = map[string]any{"inline_keyboard": [][]any{{map[string]any{"text": "Открыть очередь", "web_app": map[string]string{"url": s.appURL}}}}}
	}
	data, _ := json.Marshal(payload)
	req, e := http.NewRequestWithContext(ctx, "POST", "https://api.telegram.org/bot"+s.token+"/sendMessage", bytes.NewReader(data))
	if e != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	ok := false
	resp, e := client.Do(req)
	if e == nil {
		var result struct {
			OK bool `json:"ok"`
		}
		json.NewDecoder(io.LimitReader(resp.Body, 65536)).Decode(&result)
		resp.Body.Close()
		ok = resp.StatusCode == 200 && result.OK
	}
	if ok {
		_, e = tx.Exec(ctx, "UPDATE notifications SET delivered_at=now(),attempts=attempts+1 WHERE id=$1", id)
	} else {
		delay := time.Duration(1<<min(attempts, 7)) * 15 * time.Second
		_, e = tx.Exec(ctx, "UPDATE notifications SET attempts=attempts+1,next_at=$2 WHERE id=$1", id, time.Now().Add(delay))
	}
	if e == nil {
		tx.Commit(ctx)
	}
}
