// Package pools stores per-provider multi-account
// pools served through that provider's proxy.
package pools

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/refs"
)

// Strategies a pool ring can use. They are also the hub's strategies.
const (
	// StrategyFailover keeps the account that last served at the head.
	StrategyFailover = "failover"
	// StrategyRoundRobin starts each request at the next eligible member.
	StrategyRoundRobin = "round-robin"
	// StrategySoonestReset starts at the member whose unused quota resets
	// soonest, from the quota cache (ADR-0035).
	StrategySoonestReset = "soonest-reset"
)

// ValidStrategy reports whether s names a strategy; empty means failover.
func ValidStrategy(s string) bool {
	switch s {
	case "", StrategyFailover, StrategyRoundRobin, StrategySoonestReset:
		return true
	}
	return false
}

type Member struct {
	Account string `json:"account"`
	Enabled bool   `json:"enabled"`
}

type Pool struct {
	Provider  string   `json:"provider"`
	Mode      string   `json:"mode"` // 'single' | 'multi'
	Enabled   bool     `json:"enabled"`
	Strategy  string   `json:"strategy"` // see the Strategy constants
	Host      string   `json:"host,omitempty"`
	Port      int      `json:"port,omitempty"`
	Members   []Member `json:"members"`
	UpdatedAt string   `json:"updatedAt"`
}

// Store owns the pools table.
//
// Root is the AnyPick data directory: mutating methods take the coordinator
// lock under it themselves (invariant #5), so callers must not depend on an
// ambient lock. A Store without Root cannot take the lock and its mutating
// methods fail closed instead of writing uncoordinated.
type Store struct {
	DB   *sql.DB
	Root string
}

func (s *Store) mutate(ctx context.Context, scope string, fn func(context.Context) error) error {
	if s.Root == "" {
		return anyerr.Newf("pools store has no data root; refusing uncoordinated write", "STATE_CONFLICT")
	}
	return lock.WithMutationLock(ctx, s.Root, scope, fn)
}

func (s *Store) Get(providerID string) (*Pool, error) {
	return s.GetContext(context.Background(), providerID)
}

func (s *Store) GetContext(ctx context.Context, providerID string) (*Pool, error) {
	var mode, strategy string
	var enabled bool
	var host sql.NullString
	var port sql.NullInt64
	var membersJSON string
	var updatedAt string
	err := s.DB.QueryRowContext(ctx,
		`SELECT mode, enabled, strategy, host, port, members_json, updated_at
		 FROM pools WHERE provider = ?`, providerID).
		Scan(&mode, &enabled, &strategy, &host, &port, &membersJSON, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	pool := &Pool{
		Provider:  providerID,
		Mode:      mode,
		Enabled:   enabled,
		Strategy:  strategy,
		Host:      host.String,
		UpdatedAt: updatedAt,
	}
	if port.Valid {
		pool.Port = int(port.Int64)
	}
	if err := json.Unmarshal([]byte(membersJSON), &pool.Members); err != nil {
		pool.Members = []Member{}
	}
	return pool, nil
}

// SetMulti enables multi-account pooling for a provider.
func (s *Store) SetMultiContext(ctx context.Context, providerID string, members []Member, host string, port int) error {
	return s.mutate(ctx, refs.MutationScopeForRef(refs.AccountPoolRef(providerID)), func(c context.Context) error {
		return s.setMultiLocked(c, providerID, members, host, port)
	})
}

func (s *Store) setMultiLocked(ctx context.Context, providerID string, members []Member, host string, port int) error {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
	if members == nil {
		members = []Member{}
	}
	membersJSON, err := json.Marshal(members)
	if err != nil {
		return err
	}
	_, err = s.DB.ExecContext(ctx,
		`INSERT INTO pools (provider, mode, enabled, strategy, host, port, members_json, updated_at)
		 VALUES (?, 'multi', 1, 'failover', ?, ?, ?, ?)
		 ON CONFLICT(provider) DO UPDATE SET
		   mode = 'multi', enabled = 1, strategy = 'failover',
		   host = excluded.host, port = excluded.port,
		   members_json = excluded.members_json,
		   updated_at = excluded.updated_at`,
		providerID, nullIfEmpty(host), nullIfZero(port), string(membersJSON), now)
	return err
}

// Set stores a full pool row (mode/strategy/enabled included). Used by the
// CLI so `enable` can persist non-default modes and strategies instead of
// silently dropping them.
func (s *Store) Set(ctx context.Context, pool Pool) error {
	return s.mutate(ctx, refs.MutationScopeForRef(refs.AccountPoolRef(pool.Provider)), func(c context.Context) error {
		return s.setLocked(c, pool)
	})
}

func (s *Store) setLocked(ctx context.Context, pool Pool) error {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
	members := pool.Members
	if members == nil {
		members = []Member{}
	}
	membersJSON, err := json.Marshal(members)
	if err != nil {
		return err
	}
	_, err = s.DB.ExecContext(ctx,
		`INSERT INTO pools (provider, mode, enabled, strategy, host, port, members_json, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(provider) DO UPDATE SET
		   mode = excluded.mode, enabled = excluded.enabled,
		   strategy = excluded.strategy, host = excluded.host,
		   port = excluded.port, members_json = excluded.members_json,
		   updated_at = excluded.updated_at`,
		pool.Provider, nullIfEmpty(pool.Mode), boolInt(pool.Enabled), nullIfEmpty(pool.Strategy),
		nullIfEmpty(pool.Host), nullIfZero(pool.Port), string(membersJSON), now)
	return err
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *Store) DisableContext(ctx context.Context, providerID string) error {
	return s.mutate(ctx, refs.MutationScopeForRef(refs.AccountPoolRef(providerID)), func(c context.Context) error {
		_, err := s.DB.ExecContext(c,
			`INSERT INTO pools (provider, mode, enabled, strategy, members_json, updated_at)
			 VALUES (?, 'single', 0, 'failover', '[]', ?)
			 ON CONFLICT(provider) DO UPDATE SET enabled = 0, updated_at = excluded.updated_at`,
			providerID, time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00"))
		return err
	})
}

func nullIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func nullIfZero(i int) interface{} {
	if i == 0 {
		return nil
	}
	return i
}
