package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func telegramID(data, token string, now time.Time) (int64, error) {
	q, err := url.ParseQuery(data)
	if err != nil {
		return 0, err
	}
	for _, v := range q {
		if len(v) != 1 {
			return 0, errors.New("duplicate auth field")
		}
	}
	hash, err := hex.DecodeString(q.Get("hash"))
	if err != nil {
		return 0, err
	}
	q.Del("hash")
	// Telegram's WebApp HMAC covers every field except hash, including signature if present.
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sortStrings(keys)
	pairs := make([]string, 0, len(q))
	for _, k := range keys {
		pairs = append(pairs, k+"="+q.Get(k))
	}
	secret := hmac.New(sha256.New, []byte("WebAppData"))
	secret.Write([]byte(token))
	mac := hmac.New(sha256.New, secret.Sum(nil))
	mac.Write([]byte(strings.Join(pairs, "\n")))
	if token == "" || !hmac.Equal(hash, mac.Sum(nil)) {
		return 0, errors.New("invalid signature")
	}
	ts, err := strconv.ParseInt(q.Get("auth_date"), 10, 64)
	if err != nil || now.Unix()-ts > 86400 || ts > now.Unix()+30 {
		return 0, errors.New("expired auth")
	}
	var user struct {
		ID int64 `json:"id"`
	}
	if json.Unmarshal([]byte(q.Get("user")), &user) != nil || user.ID <= 0 {
		return 0, errors.New("invalid user")
	}
	return user.ID, nil
}
func (s *server) identity(r *http.Request) (int64, error) {
	if s.dev {
		if v := r.Header.Get("X-Dev-User"); v != "" {
			id, e := strconv.ParseInt(v, 10, 64)
			if e == nil && id > 0 {
				return id, nil
			}
		}
	}
	return telegramID(strings.TrimPrefix(r.Header.Get("Authorization"), "tma "), s.token, time.Now())
}
