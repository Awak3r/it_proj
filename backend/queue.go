package main

import (
	"context"
	"crypto/rand"
	"math/big"
	"sort"

	"github.com/jackc/pgx/v5"
)

type event struct {
	ID, Teacher                    int64
	State, Strategy                string
	Open, Shuffled, Called, Manual bool
}
type entry struct {
	ID      int64
	Score   int
	Skipped bool
}

func active(e event) bool { return e.State == "planned" || e.State == "live" }
func (s *server) queueCommand(ctx context.Context, tx pgx.Tx, uid int64, c command) error {
	var ev event
	e := tx.QueryRow(ctx, "SELECT id,teacher_id,state,strategy,registration_open,shuffled,first_called,manual_order FROM events WHERE id=$1 FOR UPDATE", c.EventID).Scan(&ev.ID, &ev.Teacher, &ev.State, &ev.Strategy, &ev.Open, &ev.Shuffled, &ev.Called, &ev.Manual)
	if e != nil {
		return fail("Событие не найдено")
	}
	root := s.roots[uid]
	owner := root || (ev.Teacher == uid && exists(ctx, tx, "SELECT teacher FROM users WHERE id=$1", uid))
	exec := func(q string, args ...any) error { _, e := tx.Exec(ctx, q, args...); return e }
	if c.Kind != "join" && c.Kind != "leave" && !owner {
		return forbidden()
	}
	if !root && (c.Kind == "shuffle" || c.Kind == "move" || c.Kind == "remove") {
		return forbidden()
	}
	if c.Kind == "strategy" && active(ev) && validStrategy(c.Strategy) && ev.Called && !root {
		return forbidden()
	}
	// Inconsistent curricula must not advance the event, but users and owners
	// must still be able to leave, stop registration, or close the event safely.
	recovery := c.Kind == "leave" || (c.Kind == "event_action" && (c.Action == "cancel" || c.Action == "complete" || c.Action == "close"))
	if !recovery && !exists(ctx, tx, `SELECT EXISTS(SELECT 1 FROM event_groups WHERE event_id=$1)
 AND NOT EXISTS(SELECT 1 FROM event_groups eg JOIN events e ON e.id=eg.event_id
 WHERE e.id=$1 AND NOT EXISTS(SELECT 1 FROM subject_groups sg WHERE sg.subject_id=e.subject_id AND sg.group_id=eg.group_id))`, ev.ID) {
		return fail("Предмет не назначен всем группам события или группы не выбраны; восстановите учебный план")
	}
	switch c.Kind {
	case "join":
		if !active(ev) || !ev.Open {
			return fail("Запись закрыта")
		}
		if !exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM users u JOIN event_groups g ON g.group_id=u.group_id JOIN events e ON e.id=g.event_id JOIN subject_groups sg ON sg.subject_id=e.subject_id AND sg.group_id=g.group_id WHERE u.id=$1 AND g.event_id=$2 AND u.name<>'')", uid, ev.ID) {
			return fail("Событие недоступно вашей группе")
		}
		var score int
		if e = tx.QueryRow(ctx, "SELECT count(*) FROM grades g JOIN labs l ON l.id=g.lab_id JOIN users u ON u.id=g.student_id JOIN events e ON e.subject_id=l.subject_id WHERE u.id=$1 AND e.id=$2 AND l.group_id=u.group_id AND NOT l.archived AND g.value>=3", uid, ev.ID).Scan(&score); e != nil {
			return e
		}
		var id int64
		e = tx.QueryRow(ctx, "INSERT INTO entries(event_id,user_id,position,score) VALUES($1,$2,0,$3) RETURNING id", ev.ID, uid, score).Scan(&id)
		if e != nil {
			return e
		}
		waiting, e := waitingEntries(ctx, tx, ev.ID, id)
		if e != nil {
			return e
		}
		item := entry{ID: id, Score: score}
		waiting = insertEntry(waiting, item, ev)
		return setOrder(ctx, tx, waiting)
	case "leave":
		if !active(ev) {
			return fail("Событие закрыто")
		}
		return exec("UPDATE entries SET state='left',ended_at=now() WHERE id=$1 AND event_id=$2 AND user_id=$3 AND state IN ('waiting','called')", c.ID, ev.ID, uid)
	case "event_update":
		if !active(ev) || !validName(c.Name) || c.StartsAt.IsZero() || c.Duration < 0 || c.Duration > 480 || len(c.Room) > 200 || len(c.Description) > 4000 {
			return fail("Проверьте параметры события")
		}

		return exec("UPDATE events SET name=$2,starts_at=$3,room=$4,description=$5,duration=$6 WHERE id=$1", ev.ID, c.Name, c.StartsAt, c.Room, c.Description, c.Duration)
	case "event_action":
		if !active(ev) {
			return fail("Событие уже закрыто")
		}
		switch c.Action {
		case "open", "close":
			return exec("UPDATE events SET registration_open=$2 WHERE id=$1", ev.ID, c.Action == "open")
		case "start":
			if ev.State != "planned" {
				return fail("Приём уже начат")
			}
			return exec("UPDATE events SET state='live' WHERE id=$1", ev.ID)
		case "complete", "cancel":
			state := "completed"
			message := "Событие завершено. Активная запись закрыта."
			if c.Action == "cancel" {
				state = "cancelled"
				message = "Событие отменено. Активная запись закрыта."
			}
			if e = exec("INSERT INTO notifications(recipient,entry_id,event_id,kind,message) SELECT user_id,id,event_id,'closed',(SELECT name FROM events WHERE id=$1)||': '||$2 FROM entries WHERE event_id=$1 AND state IN ('waiting','called') ON CONFLICT DO NOTHING", ev.ID, message); e != nil {
				return e
			}
			if e = exec("UPDATE entries SET state='closed',ended_at=now() WHERE event_id=$1 AND state IN ('waiting','called')", ev.ID); e != nil {
				return e
			}
			return exec("UPDATE events SET state=$2,registration_open=false WHERE id=$1", ev.ID, state)
		default:
			return fail("Неизвестное действие события")
		}
	case "strategy":
		if !active(ev) || !validStrategy(c.Strategy) {
			return fail("Нельзя изменить стратегию")
		}

		if c.Strategy == ev.Strategy {
			return nil
		}
		// A consumed shuffle cannot be rearmed by toggling strategies.
		if c.Strategy == "random" && (ev.Shuffled || ev.Called) {
			return fail("Случайную стратегию нельзя включить после перемешивания или первого вызова")
		}
		if e = exec("UPDATE events SET strategy=$2,manual_order=false WHERE id=$1", ev.ID, c.Strategy); e != nil {
			return e
		}
		items, e := waitingEntries(ctx, tx, ev.ID, 0)
		if e != nil {
			return e
		}
		sortEntries(items, c.Strategy)
		return setOrder(ctx, tx, items)
	case "shuffle":
		if !active(ev) || ev.Strategy != "random" || ev.Shuffled || ev.Called {
			return fail("Перемешивание недоступно")
		}
		items, e := waitingEntries(ctx, tx, ev.ID, 0)
		if e != nil {
			return e
		}
		if len(items) == 0 {
			return fail("Сначала дождитесь участников")
		}
		for i := len(items) - 1; i > 0; i-- {
			n, e := rand.Int(rand.Reader, big.NewInt(int64(i+1)))
			if e != nil {
				return e
			}
			j := int(n.Int64())
			items[i], items[j] = items[j], items[i]
		}
		if e = setOrder(ctx, tx, items); e != nil {
			return e
		}
		return exec("UPDATE events SET shuffled=true,manual_order=false WHERE id=$1", ev.ID)
	case "next":
		if ev.State != "live" {
			return fail("Сначала начните приём")
		}
		if ev.Strategy == "random" && !ev.Shuffled {
			return fail("Сначала root должен перемешать очередь")
		}
		if exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM entries WHERE event_id=$1 AND state='called')", ev.ID) {
			return nil
		}
		var id, user int64
		e = tx.QueryRow(ctx, "SELECT id,user_id FROM entries WHERE event_id=$1 AND state='waiting' ORDER BY position,id LIMIT 1", ev.ID).Scan(&id, &user)
		if e == pgx.ErrNoRows {
			return fail("В очереди пока никого нет")
		}
		if e != nil {
			return e
		}
		if e = exec("UPDATE entries SET state='called',called_at=now() WHERE id=$1", id); e != nil {
			return e
		}
		if e = exec("UPDATE events SET first_called=true WHERE id=$1", ev.ID); e != nil {
			return e
		}
		// Each call (including after skip) has its own notification identity.
		return exec("INSERT INTO notifications(recipient,entry_id,event_id,kind,message) SELECT $2,$3,e.id,'call-'||gen_random_uuid()::text,'Ваша очередь: '||s.name||' · '||e.name||CASE WHEN e.room='' THEN '' ELSE ' · ауд. '||e.room END FROM events e JOIN subjects s ON s.id=e.subject_id WHERE e.id=$1", ev.ID, user, id)
	case "skip", "finish":
		if ev.State != "live" {
			return fail("Приём не идёт")
		}
		// Explicit entry id prevents delayed requests from affecting a subsequent call.
		if !exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM entries WHERE id=$1 AND event_id=$2 AND state='called')", c.ID, ev.ID) {
			return nil
		}
		if c.Kind == "finish" {
			return exec("UPDATE entries SET state='completed',ended_at=now() WHERE id=$1", c.ID)
		}
		if e = exec("UPDATE entries SET state='waiting',skipped=true,called_at=NULL WHERE id=$1", c.ID); e != nil {
			return e
		}
		items, e := waitingEntries(ctx, tx, ev.ID, c.ID)
		if e != nil {
			return e
		}
		items = append(items, entry{ID: c.ID, Skipped: true})
		return setOrder(ctx, tx, items)
	case "remove":
		if !active(ev) {
			return fail("Событие закрыто")
		}
		return exec("UPDATE entries SET state='removed',ended_at=now() WHERE id=$1 AND event_id=$2 AND state IN ('waiting','called')", c.ID, ev.ID)
	case "move":
		if !active(ev) {
			return fail("Событие закрыто")
		}
		if !exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM entries WHERE id=$1 AND event_id=$2 AND state='waiting')", c.ID, ev.ID) {
			return fail("Перемещать можно только ожидающего")
		}
		items, e := waitingEntries(ctx, tx, ev.ID, c.ID)
		if e != nil {
			return e
		}
		p := c.Position - 1
		if p < 0 || p > len(items) {
			return fail("Некорректная позиция")
		}
		items = append(items, entry{})
		copy(items[p+1:], items[p:])
		items[p] = entry{ID: c.ID}
		if e = setOrder(ctx, tx, items); e != nil {
			return e
		}
		return exec("UPDATE events SET manual_order=true WHERE id=$1", ev.ID)
	}
	return fail("Неизвестное действие")
}
func waitingEntries(ctx context.Context, tx pgx.Tx, eventID, exclude int64) ([]entry, error) {
	rows, e := tx.Query(ctx, "SELECT id,score,skipped FROM entries WHERE event_id=$1 AND state='waiting' AND id<>$2 ORDER BY position,id", eventID, exclude)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []entry{}
	for rows.Next() {
		var v entry
		if e = rows.Scan(&v.ID, &v.Score, &v.Skipped); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func setOrder(ctx context.Context, tx pgx.Tx, items []entry) error {
	for i, v := range items {
		if _, e := tx.Exec(ctx, "UPDATE entries SET position=$2 WHERE id=$1", v.ID, i+1); e != nil {
			return e
		}
	}
	return nil
}
func insertEntry(items []entry, v entry, ev event) []entry {
	if ev.Strategy == "random" {
		return append(items, v)
	}
	if ev.Manual {
		return append([]entry{v}, items...)
	}
	index := len(items)
	for i, x := range items {
		if x.Skipped || (ev.Strategy == "asc" && v.Score < x.Score) || (ev.Strategy == "desc" && v.Score > x.Score) {
			index = i
			break
		}
	}
	items = append(items, entry{})
	copy(items[index+1:], items[index:])
	items[index] = v
	return items
}
func sortEntries(items []entry, strategy string) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.Skipped != b.Skipped {
			return !a.Skipped
		}
		if strategy == "asc" && a.Score != b.Score {
			return a.Score < b.Score
		}
		if strategy == "desc" && a.Score != b.Score {
			return a.Score > b.Score
		}
		return a.ID < b.ID
	})
}
func (s *server) nearNotifications(ctx context.Context, tx pgx.Tx) error {
	_, e := tx.Exec(ctx, `INSERT INTO notifications(recipient,entry_id,event_id,kind,message)
 SELECT q.user_id,q.id,q.event_id,'near','Скоро ваша очередь: '||e.name||'. Перед вами не больше двух человек.'
 FROM (SELECT *, row_number() OVER(PARTITION BY event_id ORDER BY CASE WHEN state='called' THEN 0 ELSE 1 END,position,id) AS n FROM entries WHERE state IN ('waiting','called')) q
 JOIN events e ON e.id=q.event_id WHERE q.state='waiting' AND q.n<=3 AND e.state='live' AND (e.strategy<>'random' OR e.shuffled) ON CONFLICT DO NOTHING`)
	return e
}
