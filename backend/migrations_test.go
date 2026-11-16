package main

import (
	"sync"
	"testing"
)

func TestMigrationsUpgradeAndCompatibility(t *testing.T) {
	s, ctx := notificationETAServer(t)
	// Reconstruct the historical schema, with an existing lab and grade.
	notificationETAExec(t, s, ctx, `ALTER TABLE labs DROP COLUMN weight, DROP COLUMN required;
		DROP TABLE schema_migrations;
		DROP TABLE subject_groups;
		INSERT INTO labs(id,subject_id,group_id,number,name) VALUES(1,1,1,1,'Historical lab');
		INSERT INTO grades(student_id,lab_id,value,author_id) VALUES(3001,1,4,1001);`)
	if err := migrate(ctx, s.db); err != nil {
		t.Fatal(err)
	}
	var weight string
	var required bool
	if err := s.db.QueryRow(ctx, "SELECT weight::text,required FROM labs WHERE id=1").Scan(&weight, &required); err != nil {
		t.Fatal(err)
	}
	if weight != "1" || !required {
		t.Fatalf("upgrade defaults: %s %v", weight, required)
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM grades WHERE student_id=3001 AND lab_id=1 AND value=4 AND version=1", 1)
	notificationETAExec(t, s, ctx, `UPDATE labs SET weight=0.123456789123456789,required=false WHERE id=1`)
	// Concurrent startups and repeated runs must not reapply or reset metadata.
	var wg sync.WaitGroup
	errors := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errors <- migrate(ctx, s.db) }()
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM schema_migrations", 2)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM labs WHERE weight=0.123456789123456789 AND NOT required", 1)
	// An old binary can still run its baseline and INSERT without new columns.
	baseline, err := files.ReadFile("schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	notificationETAExec(t, s, ctx, string(baseline))
	notificationETAExec(t, s, ctx, `INSERT INTO labs(id,subject_id,group_id,number,name) VALUES(2,1,1,2,'Old binary')`)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM labs WHERE id=2 AND weight=1 AND required", 1)
	for _, invalid := range []string{"0", "-1", "1000000.0001", "'NaN'", "'Infinity'", "'-Infinity'"} {
		if _, err := s.db.Exec(ctx, "UPDATE labs SET weight="+invalid+" WHERE id=2"); err == nil {
			t.Fatalf("SQL accepted invalid weight %s", invalid)
		}
	}
	if _, err := s.db.Exec(ctx, "UPDATE labs SET required=NULL WHERE id=2"); err == nil {
		t.Fatal("SQL accepted null required")
	}
	if _, err := s.db.Exec(ctx, "UPDATE labs SET weight=NULL WHERE id=2"); err == nil {
		t.Fatal("SQL accepted null weight")
	}
}

func TestMigrationFailureIsAtomic(t *testing.T) {
	s, ctx := notificationETAServer(t)
	// A conflicting column forces migration failure after the baseline has run.
	notificationETAExec(t, s, ctx, `ALTER TABLE labs DROP COLUMN weight;
		DROP TABLE schema_migrations;
		DROP TABLE subject_groups;
		DROP INDEX entries_event;`)
	if err := migrate(ctx, s.db); err == nil {
		t.Fatal("expected conflicting required column to fail migration")
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='labs' AND column_name='weight'", 0)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='schema_migrations'", 0)
	notificationETACount(t, s, ctx, "SELECT count(*) FROM pg_indexes WHERE schemaname=current_schema() AND indexname='entries_event'", 0)
	// Correcting the conflict permits a clean retry, with no false applied marker.
	notificationETAExec(t, s, ctx, "ALTER TABLE labs DROP COLUMN required")
	if err := migrate(ctx, s.db); err != nil {
		t.Fatal(err)
	}
	notificationETACount(t, s, ctx, "SELECT count(*) FROM schema_migrations", 2)
}
