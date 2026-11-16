package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Existing bound records retain their archive policy; new records require active catalogs.
func requireCurriculum(ctx context.Context, tx pgx.Tx, subject, group int64, active bool) error {
	if !exists(ctx, tx, `SELECT EXISTS(SELECT 1 FROM subject_groups sg
 JOIN subjects s ON s.id=sg.subject_id JOIN groups g ON g.id=sg.group_id
 WHERE sg.subject_id=$1 AND sg.group_id=$2 AND (NOT $3 OR (NOT s.archived AND NOT g.archived)))`, subject, group, active) {
		return fail("Предмет не назначен группе или группа/предмет не найдены; для новой работы или события выберите действующую пару в учебном плане")
	}
	return nil
}

func saveSubject(ctx context.Context, tx pgx.Tx, c command) error {
	if !validName(c.Name) {
		return fail("Укажите название")
	}
	if c.ID == 0 && (c.GroupIDs == nil || len(*c.GroupIDs) == 0) {
		return fail("Выберите хотя бы одну действующую группу для нового предмета")
	}
	if c.ID != 0 && !exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM subjects WHERE id=$1)", c.ID) {
		return fail("Предмет не найден")
	}
	if c.GroupIDs != nil {
		seen := map[int64]bool{}
		for _, group := range *c.GroupIDs {
			if seen[group] {
				return fail("Группы предмета не должны повторяться")
			}
			seen[group] = true
			// Archived groups may be retained, but cannot be newly selected.
			if !exists(ctx, tx, `SELECT EXISTS(SELECT 1 FROM groups g WHERE g.id=$1 AND
 (NOT g.archived OR EXISTS(SELECT 1 FROM subject_groups WHERE subject_id=$2 AND group_id=g.id)))`, group, c.ID) {
				return fail("Выберите действующую группу; архивную группу можно только сохранить в существующем назначении")
			}
		}
		var blocked int64
		err := tx.QueryRow(ctx, `SELECT sg.group_id FROM subject_groups sg
 WHERE sg.subject_id=$1 AND NOT (sg.group_id=ANY($2::bigint[])) AND (
 EXISTS(SELECT 1 FROM labs l WHERE l.subject_id=sg.subject_id AND l.group_id=sg.group_id AND NOT l.archived)
 OR EXISTS(SELECT 1 FROM events e JOIN event_groups eg ON eg.event_id=e.id
 WHERE e.subject_id=sg.subject_id AND eg.group_id=sg.group_id AND e.state IN ('planned','live')))
 ORDER BY sg.group_id LIMIT 1`, c.ID, *c.GroupIDs).Scan(&blocked)
		if err == nil {
			return fail(fmt.Sprintf("Нельзя убрать группу %d: сначала архивируйте её работы по предмету и завершите или отмените запланированные/текущие события", blocked))
		}
		if err != pgx.ErrNoRows {
			return err
		}
	}
	if c.ID == 0 {
		if err := tx.QueryRow(ctx, "INSERT INTO subjects(name) VALUES($1) RETURNING id", strings.TrimSpace(c.Name)).Scan(&c.ID); err != nil {
			return err
		}
	} else if _, err := tx.Exec(ctx, "UPDATE subjects SET name=$2,archived=$3 WHERE id=$1", c.ID, strings.TrimSpace(c.Name), c.Enabled); err != nil {
		return err
	}
	if c.GroupIDs == nil {
		return nil
	}
	if _, err := tx.Exec(ctx, "DELETE FROM subject_groups WHERE subject_id=$1 AND NOT (group_id=ANY($2::bigint[]))", c.ID, *c.GroupIDs); err != nil {
		return err
	}
	for _, group := range *c.GroupIDs {
		if _, err := tx.Exec(ctx, "INSERT INTO subject_groups(subject_id,group_id) VALUES($1,$2) ON CONFLICT DO NOTHING", c.ID, group); err != nil {
			return err
		}
	}
	return nil
}
