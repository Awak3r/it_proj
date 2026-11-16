package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql migrations/*.sql
var files embed.FS
var sortStrings = sort.Strings

type server struct {
	db      *pgxpool.Pool
	roots   map[int64]bool
	token   string
	dev     bool
	appURL  string
	updates *updateHub
}
type problem struct {
	Code    int
	Message string
}

func (p problem) Error() string     { return p.Message }
func fail(message string) error     { return problem{400, message} }
func forbidden() error              { return problem{403, "Недостаточно прав"} }
func conflict(message string) error { return problem{409, message} }
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, e error) {
	var p problem
	if errors.As(e, &p) {
		writeJSON(w, p.Code, map[string]string{"error": p.Message})
		return
	}
	var pg *pgconn.PgError
	if errors.As(e, &pg) {
		switch pg.Code {
		case "23505":
			writeJSON(w, 409, map[string]string{"error": "Такая запись уже существует"})
			return
		case "23503", "23514", "22P02", "22003":
			writeJSON(w, 400, map[string]string{"error": "Проверьте выбранные значения"})
			return
		}
	}
	log.Printf("request failed: %v", e)
	writeJSON(w, 500, map[string]string{"error": "Не удалось выполнить действие. Повторите попытку."})
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	db, err := pgxpool.New(ctx, env("DATABASE_URL", "postgres://labqueue:labqueue@localhost:5432/labqueue?sslmode=disable"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err = migrate(ctx, db); err != nil {
		log.Fatal(err)
	}
	s := &server{db: db, roots: map[int64]bool{}, token: os.Getenv("BOT_TOKEN"), dev: os.Getenv("DEV_AUTH") == "true", appURL: os.Getenv("APP_URL"), updates: newUpdateHub()}
	for _, v := range strings.Split(os.Getenv("ROOT_TELEGRAM_IDS"), ",") {
		id, e := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		if e == nil && id > 0 {
			s.roots[id] = true
		}
	}
	if len(s.roots) == 0 {
		log.Fatal("ROOT_TELEGRAM_IDS must contain at least one Telegram ID")
	}
	if !s.dev && s.token == "" {
		log.Fatal("BOT_TOKEN is required when DEV_AUTH is disabled")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		if e := db.Ping(r.Context()); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"dev_auth": s.dev}) })
	mux.HandleFunc("GET /api/state", s.auth(s.state))
	mux.HandleFunc("POST /api/export", s.auth(s.exportGradebook))
	mux.HandleFunc("GET /api/updates", s.auth(s.streamUpdates))
	mux.HandleFunc("POST /api/command", s.auth(s.command))
	dist := env("WEB_DIST", "../web/dist")
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		p := filepath.Join(dist, filepath.Clean("/"+r.URL.Path))
		if st, e := os.Stat(p); e == nil && !st.IsDir() {
			http.ServeFile(w, r, p)
			return
		}
		http.ServeFile(w, r, filepath.Join(dist, "index.html"))
	})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	})
	srv := &http.Server{Addr: env("LISTEN_ADDR", ":8080"), Handler: h, BaseContext: func(net.Listener) context.Context { return ctx }, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32768}
	go s.worker(ctx)
	go s.listenUpdates(ctx)
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(c)
	}()
	log.Printf("listening %s; dev_auth=%v", srv.Addr, s.dev)
	if err = srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
func (s *server) auth(next func(http.ResponseWriter, *http.Request, int64)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, e := s.identity(r)
		if e != nil {
			writeJSON(w, 401, map[string]string{"error": "Откройте приложение заново через Telegram"})
			return
		}
		if _, e = s.db.Exec(r.Context(), "INSERT INTO users(id) VALUES($1) ON CONFLICT DO NOTHING", id); e != nil {
			writeError(w, e)
			return
		}
		next(w, r, id)
	}
}

type queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func jsonRows(ctx context.Context, q queryer, sql string, args ...any) (json.RawMessage, error) {
	var b []byte
	e := q.QueryRow(ctx, "SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]') FROM ("+sql+") x", args...).Scan(&b)
	return b, e
}
func (s *server) state(w http.ResponseWriter, r *http.Request, uid int64) {
	ctx := r.Context()
	tx, e := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		writeError(w, e)
		return
	}
	defer tx.Rollback(ctx)
	var me json.RawMessage
	e = tx.QueryRow(ctx, "SELECT to_jsonb(u)||jsonb_build_object('root',$2::boolean) FROM users u WHERE id=$1", uid, s.roots[uid]).Scan(&me)
	if e != nil {
		writeError(w, e)
		return
	}
	result := map[string]any{"me": me, "assignments": []any{}}
	queries := map[string]string{
		"groups": "SELECT * FROM groups ORDER BY name", "subjects": "SELECT * FROM subjects ORDER BY name",
		"users":           `SELECT u.* FROM users u WHERE $2 OR u.id=$1 OR u.group_id=(SELECT group_id FROM users WHERE id=$1) OR (SELECT teacher FROM users WHERE id=$1) ORDER BY u.name`,
		"labs":            `SELECT l.*,l.weight::text AS weight_text FROM labs l WHERE ` + visibleLab + ` ORDER BY number,id`,
		"grades":          `SELECT g.* FROM grades g JOIN labs l ON l.id=g.lab_id WHERE ` + visibleLab,
		"grade_summaries": gradeSummariesSQL,
		"events":          `SELECT e.*, ARRAY(SELECT group_id FROM event_groups WHERE event_id=e.id) AS group_ids, (SELECT name FROM users WHERE id=e.teacher_id) AS teacher_name, (SELECT AVG(EXTRACT(EPOCH FROM (ended_at-called_at)))/60 FROM entries WHERE event_id=e.id AND state='completed' AND called_at IS NOT NULL) AS average_minutes FROM events e WHERE $2 OR (SELECT teacher FROM users WHERE id=$1) OR EXISTS(SELECT 1 FROM event_groups eg WHERE eg.event_id=e.id AND eg.group_id=(SELECT group_id FROM users WHERE id=$1)) ORDER BY e.starts_at DESC`,
		"entries":         `SELECT q.*,u.name AS user_name,u.group_id FROM entries q JOIN users u ON u.id=q.user_id JOIN events e ON e.id=q.event_id WHERE $2 OR (SELECT teacher FROM users WHERE id=$1) OR EXISTS(SELECT 1 FROM event_groups eg WHERE eg.event_id=e.id AND eg.group_id=(SELECT group_id FROM users WHERE id=$1)) ORDER BY q.position,q.id`,
		"audit":           `SELECT * FROM audit WHERE $2 ORDER BY id DESC LIMIT 100`,
	}
	for key, sql := range queries {
		var args []any
		if key != "groups" && key != "subjects" {
			args = []any{uid, s.roots[uid]}
			if key == "audit" {
				sql = strings.ReplaceAll(sql, "$2", "$1")
				args = []any{s.roots[uid]}
			}
		}
		v, err := jsonRows(ctx, tx, sql, args...)
		if err != nil {
			writeError(w, err)
			return
		}
		result[key] = v
	}
	boards, labs, e := readStatistics(ctx, tx, uid, s.roots[uid])
	if e != nil {
		writeError(w, e)
		return
	}
	result["grade_statistics"] = boards
	result["lab_statistics"] = labs
	if e = tx.Commit(ctx); e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 200, result)
}

type command struct {
	Kind        string       `json:"kind"`
	ID          int64        `json:"id"`
	Name        string       `json:"name"`
	GroupID     int64        `json:"group_id"`
	SubjectID   int64        `json:"subject_id"`
	TeacherID   int64        `json:"teacher_id"`
	UserID      int64        `json:"user_id"`
	EventID     int64        `json:"event_id"`
	LabID       int64        `json:"lab_id"`
	GroupIDs    []int64      `json:"group_ids"`
	Number      int          `json:"number"`
	Value       *int         `json:"value"`
	Weight      *json.Number `json:"weight"`
	Required    *bool        `json:"required"`
	Version     int          `json:"version"`
	Enabled     bool         `json:"enabled"`
	StartsAt    time.Time    `json:"starts_at"`
	Room        string       `json:"room"`
	Description string       `json:"description"`
	Duration    int          `json:"duration"`
	Strategy    string       `json:"strategy"`
	Action      string       `json:"action"`
	Position    int          `json:"position"`
}

func (s *server) command(w http.ResponseWriter, r *http.Request, uid int64) {
	body, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 32768))
	if e != nil {
		writeError(w, fail("Слишком большой запрос"))
		return
	}
	var c command
	if json.Unmarshal(body, &c) != nil {
		writeError(w, fail("Некорректный запрос"))
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if len(key) < 8 || len(key) > 128 {
		writeError(w, fail("Нужен Idempotency-Key"))
		return
	}
	sum := sha256.Sum256(body)
	hash := hex.EncodeToString(sum[:])
	ctx := r.Context()
	tx, e := s.db.Begin(ctx)
	if e != nil {
		writeError(w, e)
		return
	}
	defer tx.Rollback(ctx)
	// Serialize mutations: consistent event/grade/role decisions, including same-key retries.
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(764291)"); e != nil {
		writeError(w, e)
		return
	}
	var oldHash string
	var response json.RawMessage
	e = tx.QueryRow(ctx, "SELECT body_hash,response FROM requests WHERE user_id=$1 AND key=$2", uid, key).Scan(&oldHash, &response)
	if e == nil {
		if oldHash != hash {
			writeError(w, conflict("Ключ запроса уже использован"))
			return
		}
		writeJSON(w, 200, response)
		return
	}
	if e != pgx.ErrNoRows {
		writeError(w, e)
		return
	}
	if e = s.execute(ctx, tx, uid, c); e != nil {
		writeError(w, e)
		return
	}
	if e = s.nearNotifications(ctx, tx); e != nil {
		writeError(w, e)
		return
	}
	response = json.RawMessage(`{"ok":true}`)
	if _, e = tx.Exec(ctx, "INSERT INTO audit(actor_id,action,payload) VALUES($1,$2,$3)", uid, c.Kind, body); e == nil {
		_, e = tx.Exec(ctx, "INSERT INTO requests(user_id,key,body_hash,response) VALUES($1,$2,$3,$4)", uid, key, hash, []byte(response))
	}
	if e == nil {
		// PostgreSQL delivers NOTIFY only after commit, including to other app instances.
		_, e = tx.Exec(ctx, "SELECT pg_notify('labturn_updates',current_schema())")
	}
	if e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 200, response)
}
func exists(ctx context.Context, tx pgx.Tx, sql string, args ...any) bool {
	var ok bool
	e := tx.QueryRow(ctx, sql, args...).Scan(&ok)
	return e == nil && ok
}
func (s *server) allowed(ctx context.Context, tx pgx.Tx, uid int64) bool {
	return s.roots[uid] || exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND teacher)", uid)
}
func validName(n string) bool { return len(strings.TrimSpace(n)) > 0 && len(n) <= 200 }
func (s *server) execute(ctx context.Context, tx pgx.Tx, uid int64, c command) error {
	root := s.roots[uid]
	exec := func(sql string, args ...any) error { _, e := tx.Exec(ctx, sql, args...); return e }
	switch c.Kind {
	case "profile":
		if !validName(c.Name) {
			return fail("Укажите имя (до 200 символов)")
		}
		var group *int64
		if e := tx.QueryRow(ctx, "SELECT group_id FROM users WHERE id=$1", uid).Scan(&group); e != nil {
			return e
		}
		if group != nil && *group != c.GroupID {
			return fail("Группу может изменить только root")
		}
		if c.GroupID != 0 && !exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM groups WHERE id=$1 AND NOT archived)", c.GroupID) {
			return fail("Выберите действующую группу")
		}
		return exec("UPDATE users SET name=$2,group_id=NULLIF($3,0) WHERE id=$1", uid, strings.TrimSpace(c.Name), c.GroupID)
	case "group", "subject":
		if !root {
			return forbidden()
		}
		if !validName(c.Name) {
			return fail("Укажите название")
		}
		table := "groups"
		if c.Kind == "subject" {
			table = "subjects"
		}
		if c.ID == 0 {
			return exec("INSERT INTO "+table+"(name) VALUES($1)", strings.TrimSpace(c.Name))
		}
		return exec("UPDATE "+table+" SET name=$2,archived=$3 WHERE id=$1", c.ID, strings.TrimSpace(c.Name), c.Enabled)
	case "role":
		if !root {
			return forbidden()
		}
		if c.UserID <= 0 {
			return fail("Некорректный Telegram ID")
		}
		if e := exec("INSERT INTO users(id) VALUES($1) ON CONFLICT DO NOTHING", c.UserID); e != nil {
			return e
		}
		return exec("UPDATE users SET teacher=$2 WHERE id=$1", c.UserID, c.Enabled)
	case "transfer":
		if !root {
			return forbidden()
		}
		if !exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM groups WHERE id=$1 AND NOT archived)", c.GroupID) {
			return fail("Выберите группу")
		}
		if exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM entries WHERE user_id=$1 AND state IN ('waiting','called'))", c.UserID) {
			return fail("Сначала закройте активные записи студента")
		}
		return exec("UPDATE users SET group_id=$2 WHERE id=$1", c.UserID, c.GroupID)
	case "assignment":
		if !root {
			return forbidden()
		}
		return fail("Назначения преподавателей упразднены: используйте роль преподавателя")
	case "lab":
		if c.ID != 0 {
			if e := tx.QueryRow(ctx, "SELECT subject_id,group_id FROM labs WHERE id=$1", c.ID).Scan(&c.SubjectID, &c.GroupID); e != nil {
				return fail("Работа не найдена")
			}
		}
		if !s.allowed(ctx, tx, uid) {
			return forbidden()
		}
		if !exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM groups g, subjects s WHERE g.id=$1 AND s.id=$2)", c.GroupID, c.SubjectID) {
			return fail("Группа или предмет не найдены")
		}
		if !validName(c.Name) || c.Number <= 0 {
			return fail("Укажите номер и название работы")
		}
		var weight *string
		if c.Weight != nil {
			v := c.Weight.String()
			if !validWeight(v) {
				return fail("Вес работы должен быть больше 0, не больше 1000000 и представим в PostgreSQL numeric")
			}
			weight = &v
		}
		if c.ID == 0 {
			return exec("INSERT INTO labs(subject_id,group_id,number,name,weight,required) VALUES($1,$2,$3,$4,COALESCE($5::numeric,1),COALESCE($6::boolean,true))", c.SubjectID, c.GroupID, c.Number, strings.TrimSpace(c.Name), weight, c.Required)
		}
		return exec("UPDATE labs SET number=$2,name=$3,archived=$4,weight=COALESCE($5::numeric,weight),required=COALESCE($6::boolean,required) WHERE id=$1", c.ID, c.Number, strings.TrimSpace(c.Name), c.Enabled, weight, c.Required)
	case "grade":
		var group int64
		var archived bool
		if e := tx.QueryRow(ctx, "SELECT group_id,archived FROM labs WHERE id=$1", c.LabID).Scan(&group, &archived); e != nil {
			return fail("Работа не найдена")
		}
		if !s.allowed(ctx, tx, uid) {
			return forbidden()
		}
		if archived {
			return fail("Работа в архиве")
		}
		if !exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND group_id=$2)", c.UserID, group) {
			return fail("Студент не состоит в этой группе")
		}
		if c.Value != nil && (*c.Value < 2 || *c.Value > 5) {
			return fail("Оценка: 2, 3, 4, 5 или пусто")
		}
		var version int
		var old *int
		e := tx.QueryRow(ctx, "SELECT version,value FROM grades WHERE student_id=$1 AND lab_id=$2", c.UserID, c.LabID).Scan(&version, &old)
		if e != nil && e != pgx.ErrNoRows {
			return e
		}
		if version != c.Version {
			return conflict("Оценка уже изменена. Обновите ведомость и повторите правку.")
		}
		if e = exec("INSERT INTO grades(student_id,lab_id,value,author_id) VALUES($1,$2,$3,$4) ON CONFLICT(student_id,lab_id) DO UPDATE SET value=$3,author_id=$4,version=grades.version+1,updated_at=now()", c.UserID, c.LabID, c.Value, uid); e != nil {
			return e
		}
		payload, _ := json.Marshal(map[string]any{"student_id": c.UserID, "lab_id": c.LabID, "old": old, "new": c.Value})
		return exec("INSERT INTO audit(actor_id,action,payload) VALUES($1,'grade_change',$2)", uid, payload)
	case "event_create":
		if !validName(c.Name) || len(c.GroupIDs) == 0 || c.StartsAt.IsZero() || !validStrategy(c.Strategy) || c.Duration < 0 || c.Duration > 480 || len(c.Room) > 200 || len(c.Description) > 4000 {
			return fail("Проверьте название, группы, дату и стратегию")
		}
		teacher := uid
		if root && c.TeacherID != 0 {
			teacher = c.TeacherID
		}
		if !s.allowed(ctx, tx, uid) {
			return forbidden()
		}
		for _, g := range c.GroupIDs {
			if !exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM groups g, subjects s WHERE g.id=$1 AND s.id=$2 AND NOT g.archived AND NOT s.archived)", g, c.SubjectID) {
				return fail("Группа или предмет в архиве")
			}
		}
		var id int64
		if e := tx.QueryRow(ctx, "INSERT INTO events(name,subject_id,teacher_id,starts_at,room,description,duration,strategy) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id", strings.TrimSpace(c.Name), c.SubjectID, teacher, c.StartsAt, c.Room, c.Description, c.Duration, c.Strategy).Scan(&id); e != nil {
			return e
		}
		for _, g := range c.GroupIDs {
			if e := exec("INSERT INTO event_groups VALUES($1,$2) ON CONFLICT DO NOTHING", id, g); e != nil {
				return e
			}
		}
		return nil
	case "join", "leave", "event_action", "event_update", "strategy", "next", "skip", "finish", "move", "remove", "shuffle":
		return s.queueCommand(ctx, tx, uid, c)
	default:
		return fail("Неизвестное действие")
	}
}
func validStrategy(v string) bool { return v == "fifo" || v == "asc" || v == "desc" || v == "random" }
