package usagelog

import (
	"context"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/db"
)

func openDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateSchema(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func TestWriterFlushesOnCloseAndRowsGroup(t *testing.T) {
	ctx := context.Background()
	database := openDB(t)
	w := NewWriter(ctx, database)
	now := time.Now().UnixMilli()
	for i := 0; i < 3; i++ {
		w.Record(Event{At: now, Route: "hub", Provider: "claude", Account: "work", Model: "claude-opus-5-5",
			Status: 200, InputTokens: 10, OutputTokens: 2, CacheReadTokens: 5, Reported: true})
	}
	w.Record(Event{At: now, Route: "hub", Provider: "claude", Account: "work", Model: "claude-opus-5-5", Status: 200})
	w.Close()

	rows, err := Rows(ctx, database, now-1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %+v, want one group", rows)
	}
	r := rows[0]
	if r.Requests != 4 || r.Unreported != 1 || r.InputTokens != 30 || r.OutputTokens != 6 || r.CacheReadTokens != 15 {
		t.Fatalf("row = %+v", r)
	}
	if r.Day != time.UnixMilli(now).Format("2006-01-02") {
		t.Fatalf("day = %q, want the local date", r.Day)
	}
}

func TestPruneDropsRowsPastRetention(t *testing.T) {
	ctx := context.Background()
	database := openDB(t)
	now := time.Now()
	old := now.Add(-Retention - time.Hour).UnixMilli()
	if err := Insert(ctx, database, []Event{
		{At: old, Route: "hub", Provider: "p", Account: "a", Status: 200},
		{At: now.UnixMilli(), Route: "hub", Provider: "p", Account: "a", Status: 200},
	}); err != nil {
		t.Fatal(err)
	}
	if err := Prune(ctx, database, now); err != nil {
		t.Fatal(err)
	}
	rows, _ := Rows(ctx, database, 0)
	if len(rows) != 1 || rows[0].Requests != 1 {
		t.Fatalf("rows after prune = %+v", rows)
	}
}

func TestCleanModel(t *testing.T) {
	for in, want := range map[string]string{
		"claude-opus-5-5":         "claude-opus-5-5",
		" anthropic/claude@x ":    "anthropic/claude@x",
		"":                        "",
		"bad\nid":                 "",
		"{\"a\":1}":               "",
		string(make([]byte, 200)): "",
	} {
		if got := CleanModel(in); got != want {
			t.Errorf("CleanModel(%q) = %q, want %q", in, got, want)
		}
	}
}
