// Package usagelog keeps one row per response a local proxy, pool or hub
// served: who served it, which model, the status, and the token counts the
// vendor reported (ADR-0037). It owns the usage_events table.
//
// What a row must never hold: request or response content, a header, or a
// credential (ADR 0006). Event has no field that could carry one, and the
// model id is reduced to a bounded set of characters before it is stored,
// because it is the one value that comes from a vendor's response.
//
// Writes are appends from detached proxy children. No row is ever read back
// and rewritten, so there is nothing for the coordinator lock (ADR 0009) to
// serialise that SQLite does not already serialise; taking it on the request
// path would make every served response wait on another process's mutation.
package usagelog

import (
	"context"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/outof0/anypick/go/internal/db"
)

// Retention is how long rows are kept. Usage older than this is pruned when a
// writer starts and when history is read.
const Retention = 90 * 24 * time.Hour

// Event is one served response.
type Event struct {
	// At is the completion time in Unix milliseconds.
	At int64
	// Route is the observe route name the response went through.
	Route    string
	Provider string
	Account  string
	Model    string
	Status   int
	// Token counts as the vendor reported them, normalised so the four are
	// disjoint: InputTokens excludes cached input.
	InputTokens      int64
	OutputTokens     int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	// Reported is false when the response carried no usage at all (an OpenAI
	// stream without include_usage, an error body). Its tokens are zero, not
	// unknown-but-zero, and history counts such rows separately.
	Reported bool
}

var modelChars = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+ -]{0,127}$`)

// CleanModel returns id when it looks like a model id, else "". A vendor body
// is untrusted input, and the model column must not become a place where
// arbitrary response text is kept for 90 days.
func CleanModel(id string) string {
	id = strings.TrimSpace(id)
	if !modelChars.MatchString(id) {
		return ""
	}
	return id
}

// Insert appends events in one transaction.
func Insert(ctx context.Context, database *db.DB, events []Event) error {
	if database == nil || len(events) == 0 {
		return nil
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO usage_events
	  (at_ms, route, provider, account, model, status,
	   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reported)
	  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	defer stmt.Close()
	for _, e := range events {
		reported := 0
		if e.Reported {
			reported = 1
		}
		if _, err := stmt.ExecContext(ctx, e.At, e.Route, e.Provider, e.Account, CleanModel(e.Model), e.Status,
			e.InputTokens, e.OutputTokens, e.CacheReadTokens, e.CacheWriteTokens, reported); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// Prune deletes rows older than Retention.
func Prune(ctx context.Context, database *db.DB, now time.Time) error {
	if database == nil {
		return nil
	}
	_, err := database.ExecContext(ctx, `DELETE FROM usage_events WHERE at_ms < ?`,
		now.Add(-Retention).UnixMilli())
	return err
}

// Row is one (day, provider, account, model) group. Day is the local
// calendar date, YYYY-MM-DD.
type Row struct {
	Day              string `json:"day"`
	Provider         string `json:"provider"`
	Account          string `json:"account"`
	Model            string `json:"model"`
	Requests         int64  `json:"requests"`
	Unreported       int64  `json:"unreported"`
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
}

// Rows returns every group with a row at or after since (Unix ms).
func Rows(ctx context.Context, database *db.DB, since int64) ([]Row, error) {
	if database == nil {
		return nil, nil
	}
	rows, err := database.QueryContext(ctx, `SELECT
	    strftime('%Y-%m-%d', at_ms / 1000, 'unixepoch', 'localtime') AS day,
	    provider, account, model,
	    COUNT(*), SUM(CASE WHEN reported = 0 THEN 1 ELSE 0 END),
	    SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens)
	  FROM usage_events WHERE at_ms >= ?
	  GROUP BY day, provider, account, model
	  ORDER BY day, provider, account, model`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var r Row
		if err := rows.Scan(&r.Day, &r.Provider, &r.Account, &r.Model, &r.Requests, &r.Unreported,
			&r.InputTokens, &r.OutputTokens, &r.CacheReadTokens, &r.CacheWriteTokens); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// maxPending bounds the in-memory queue. A database that stays locked must
// cost dropped history, never a proxy that grows until it is killed.
const maxPending = 2048

// Writer batches events from the request path into periodic inserts, so a
// served response never waits on SQLite.
type Writer struct {
	database *db.DB
	mu       sync.Mutex
	pending  []Event
	dropped  int64
	closed   bool
	wake     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
	stop     chan struct{}
}

// flushEvery is how long an event may wait in memory. A crash loses at most
// this much history.
const flushEvery = 2 * time.Second

// NewWriter prunes expired rows and starts the flush loop.
func NewWriter(ctx context.Context, database *db.DB) *Writer {
	w := &Writer{database: database, wake: make(chan struct{}, 1), done: make(chan struct{}), stop: make(chan struct{})}
	_ = Prune(ctx, database, time.Now())
	go w.loop()
	return w
}

// Record queues one event. It never blocks.
func (w *Writer) Record(e Event) {
	if w == nil {
		return
	}
	w.mu.Lock()
	// A meter that read the recorder just before shutdown may still call in;
	// after Close nothing flushes, so the event is counted as dropped rather
	// than queued where no one will write it.
	if w.closed || len(w.pending) >= maxPending {
		w.dropped++
		w.mu.Unlock()
		return
	}
	w.pending = append(w.pending, e)
	full := len(w.pending) >= 64
	w.mu.Unlock()
	if full {
		select {
		case w.wake <- struct{}{}:
		default:
		}
	}
}

func (w *Writer) loop() {
	defer close(w.done)
	ticker := time.NewTicker(flushEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
		case <-w.wake:
		case <-w.stop:
			w.flush()
			return
		}
		w.flush()
	}
}

func (w *Writer) flush() {
	w.mu.Lock()
	batch := w.pending
	w.pending = nil
	w.mu.Unlock()
	if len(batch) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := Insert(ctx, w.database, batch); err != nil {
		// Requeue, bounded: a busy database gets another try on the next tick
		// instead of losing the batch, and the cap drops the oldest overflow.
		w.mu.Lock()
		room := maxPending - len(w.pending)
		if room > len(batch) {
			room = len(batch)
		}
		w.pending = append(batch[:room:room], w.pending...)
		w.dropped += int64(len(batch) - room)
		w.mu.Unlock()
	}
}

// Close flushes what is queued and stops the loop.
func (w *Writer) Close() {
	if w == nil {
		return
	}
	w.stopOnce.Do(func() {
		w.mu.Lock()
		w.closed = true
		w.mu.Unlock()
		close(w.stop)
	})
	<-w.done
}
