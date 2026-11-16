package main

import (
	"context"
	"testing"
	"time"
)

func TestCurriculumEventEditPreservesReferencesAndArchivePolicy(t *testing.T) {
	s, ctx := acceptanceServer(t)
	notificationETAExec(t, s, ctx, `UPDATE groups SET archived=true WHERE id=1;
 UPDATE subjects SET archived=true WHERE id=1;`)
	// Event edits have no curriculum/ownership fields: injected values cannot move the event.
	acceptanceCommand(t, s, 2001, command{
		Kind: "event_update", EventID: 1, Name: "Historical event", StartsAt: time.Now(),
		SubjectID: 999, GroupIDs: &[]int64{999}, TeacherID: 3001,
	}, 200)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM events WHERE id=1 AND subject_id=1 AND teacher_id=2001 AND name='Historical event'", 1)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM event_groups WHERE event_id=1 AND group_id=1", 1)
	// Joining an already existing bound event retains the existing archive policy.
	acceptanceJoin(t, s, 1, 3001)
	acceptanceCommand(t, s, 2001, command{Kind: "strategy", EventID: 1, Strategy: "desc"}, 200)
	acceptanceCommand(t, s, 2001, command{Kind: "next", EventID: 1}, 200)
	before := studentPermissionsRows(t, s, ctx)
	acceptanceCommand(t, s, 3001, command{Kind: "event_update", EventID: 1, Name: "Hijack", StartsAt: time.Now()}, 403)
	studentPermissionsUnchanged(t, s, ctx, before)
}

// Keep one valid group in the mixed fixture: checking only the joining user's
// membership would accept it, even though another event group is unbound.
func inconsistentCurriculumEvent(t *testing.T, shape string) (*server, context.Context) {
	t.Helper()
	s, ctx := acceptanceServer(t)
	if shape == "mixed" {
		notificationETAExec(t, s, ctx, `INSERT INTO groups(id,name) VALUES(2,'Unbound group');
 INSERT INTO event_groups VALUES(1,2);`)
	} else {
		notificationETAExec(t, s, ctx, "DELETE FROM event_groups WHERE event_id=1")
	}
	notificationETAExec(t, s, ctx, `INSERT INTO users(id,name,teacher) VALUES(2002,'Other teacher',true);
 INSERT INTO entries(id,event_id,user_id,position,score) VALUES(1,1,3001,1,0),(2,1,3002,2,0);`)
	return s, ctx
}

func TestCurriculumEventOperationsRequireEveryGroup(t *testing.T) {
	for _, shape := range []string{"mixed", "empty"} {
		t.Run(shape, func(t *testing.T) {
			s, ctx := inconsistentCurriculumEvent(t, shape)
			for _, tc := range []struct {
				name                    string
				cmd                     command
				planned, called, random bool
				rootOnly                bool
			}{
				{name: "open", cmd: command{Kind: "event_action", Action: "open"}},
				{name: "start", cmd: command{Kind: "event_action", Action: "start"}, planned: true},
				{name: "update", cmd: command{Kind: "event_update", Name: "Changed", StartsAt: time.Now()}},
				{name: "strategy", cmd: command{Kind: "strategy", Strategy: "desc"}},
				{name: "next", cmd: command{Kind: "next"}},
				{name: "skip", cmd: command{Kind: "skip", ID: 1}, called: true},
				{name: "finish", cmd: command{Kind: "finish", ID: 1}, called: true},
				{name: "move", cmd: command{Kind: "move", ID: 2, Position: 1}, rootOnly: true},
				{name: "remove", cmd: command{Kind: "remove", ID: 2}, rootOnly: true},
				{name: "shuffle", cmd: command{Kind: "shuffle"}, random: true, rootOnly: true},
				{name: "join", cmd: command{Kind: "join"}},
			} {
				t.Run(tc.name, func(t *testing.T) {
					state, strategy := "live", "fifo"
					if tc.planned {
						state = "planned"
					}
					if tc.random {
						strategy = "random"
					}
					notificationETAExec(t, s, ctx, `UPDATE events SET state=$1,strategy=$2,registration_open=$3,first_called=$4,shuffled=false,manual_order=false WHERE id=1`, state, strategy, tc.name != "open", tc.called)
					notificationETAExec(t, s, ctx, "UPDATE entries SET state='waiting',called_at=NULL,ended_at=NULL,skipped=false WHERE event_id=1")
					if tc.called {
						notificationETAExec(t, s, ctx, "UPDATE entries SET state='called',called_at=now() WHERE id=1")
					}
					tc.cmd.EventID = 1
					if tc.name == "join" {
						before := studentPermissionsRows(t, s, ctx)
						acceptanceCommand(t, s, 3003, tc.cmd, 400)
						studentPermissionsUnchanged(t, s, ctx, before)
						return
					}
					for _, uid := range []int64{1001, 2001, 2002, 3001} {
						status := 400
						if uid == 2002 || uid == 3001 || (uid == 2001 && tc.rootOnly) {
							status = 403
						}
						before := studentPermissionsRows(t, s, ctx)
						acceptanceCommand(t, s, uid, tc.cmd, status)
						studentPermissionsUnchanged(t, s, ctx, before)
					}
				})
			}
		})
	}
}

func TestCurriculumEventRecoveryWithInconsistentGroups(t *testing.T) {
	for _, shape := range []string{"mixed", "empty"} {
		for _, action := range []string{"close", "cancel", "complete"} {
			t.Run(shape+"/"+action, func(t *testing.T) {
				s, ctx := inconsistentCurriculumEvent(t, shape)
				c := command{Kind: "event_action", EventID: 1, Action: action}
				for _, uid := range []int64{2002, 3001} {
					before := studentPermissionsRows(t, s, ctx)
					acceptanceCommand(t, s, uid, c, 403)
					studentPermissionsUnchanged(t, s, ctx, before)
				}
				// A revoked owner cannot use a recovery action, either.
				acceptanceCommand(t, s, 1001, command{Kind: "role", UserID: 2001, Enabled: false}, 200)
				before := studentPermissionsRows(t, s, ctx)
				acceptanceCommand(t, s, 2001, c, 403)
				studentPermissionsUnchanged(t, s, ctx, before)
				acceptanceCommand(t, s, 1001, command{Kind: "role", UserID: 2001, Enabled: true}, 200)
				for _, uid := range []int64{2001, 1001} {
					notificationETAExec(t, s, ctx, `UPDATE events SET state='live',registration_open=true WHERE id=1;
 UPDATE entries SET state='waiting',ended_at=NULL WHERE event_id=1;`)
					acceptanceCommand(t, s, uid, c, 200)
					wantState := "live"
					if action == "cancel" {
						wantState = "cancelled"
					}
					if action == "complete" {
						wantState = "completed"
					}
					notificationETACount(t, s, ctx, "SELECT count(*) FROM events WHERE id=1 AND state=$1 AND NOT registration_open", 1, wantState)
					if action != "close" {
						notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE event_id=1 AND state='closed' AND ended_at IS NOT NULL", 2)
					} else {
						notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE event_id=1 AND state='waiting'", 2)
					}
				}
			})
		}
		t.Run(shape+"/leave", func(t *testing.T) {
			s, ctx := inconsistentCurriculumEvent(t, shape)
			acceptanceCommand(t, s, 3001, command{Kind: "leave", EventID: 1, ID: 1}, 200)
			notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE id=1 AND state='left' AND ended_at IS NOT NULL", 1)
			notificationETACount(t, s, ctx, "SELECT count(*) FROM entries WHERE id=2 AND state='waiting'", 1)
		})
	}
}
