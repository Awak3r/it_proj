package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

func sign(q url.Values, token string) string {
	ks := []string{}
	for k := range q {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	p := []string{}
	for _, k := range ks {
		p = append(p, k+"="+q.Get(k))
	}
	h := hmac.New(sha256.New, []byte("WebAppData"))
	h.Write([]byte(token))
	m := hmac.New(sha256.New, h.Sum(nil))
	m.Write([]byte(strings.Join(p, "\n")))
	q.Set("hash", hex.EncodeToString(m.Sum(nil)))
	return q.Encode()
}
func TestTelegramAuth(t *testing.T) {
	now := time.Now()
	token := "test:secret"
	q := url.Values{"auth_date": {strconv.FormatInt(now.Unix(), 10)}, "user": {`{"id":123,"first_name":"Анна"}`}, "query_id": {"query"}}
	data := sign(q, token)
	id, e := telegramID(data, token, now)
	if e != nil || id != 123 {
		t.Fatalf("valid signature rejected: %v", e)
	}
	for name, v := range map[string]string{"tampered": strings.Replace(data, "123", "124", 1), "duplicate": data + "&user=x", "bad_hash": "hash=nope"} {
		t.Run(name, func(t *testing.T) {
			if _, e := telegramID(v, token, now); e == nil {
				t.Fatal("accepted invalid auth")
			}
		})
	}
	if _, e = telegramID(data, "wrong", now); e == nil {
		t.Fatal("accepted wrong token")
	}
	if _, e = telegramID(data, token, now.Add(25*time.Hour)); e == nil {
		t.Fatal("accepted expired auth")
	}
	if _, e = telegramID(data, token, now.Add(-time.Minute)); e == nil {
		t.Fatal("accepted future auth")
	}
}
