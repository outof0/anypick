// Package modelcache stores cached vendor model lists. Advisory data only:
// a miss costs one HTTP request, never correctness, so a corrupt or absent
// row reads as "no cache". The store owns its SQL and takes no locks — the
// discovery service coordinates them (ADR 0009).
package modelcache

import (
	"context"
	"encoding/json"

	"github.com/outof0/anypick/go/internal/db"
)

type Entry struct {
	Provider  string
	Endpoint  string
	Models    []string
	FetchedAt string
	// Rules is the provider's discovery rule version the list was filtered
	// under (catalog.ModelCatalogRules). Callers compare it; the store only
	// keeps it.
	Rules int
}

// Store is the SQLite-backed cache keyed by provider AND endpoint (the same
// provider id can point at different hosts serving different lists).
type Store struct{ DB *db.DB }

// Get returns the cached list, or nil on miss/corruption.
func (s *Store) Get(ctx context.Context, provider, endpoint string) (*Entry, error) {
	var modelsJSON, fetchedAt string
	var rules int
	err := s.DB.QueryRowContext(ctx,
		`SELECT models_json, fetched_at, rules_version FROM model_catalog_cache WHERE provider = ? AND endpoint = ?`,
		provider, endpoint).Scan(&modelsJSON, &fetchedAt, &rules)
	if err != nil {
		if err.Error() == "sql: no rows in result set" {
			return nil, nil
		}
		return nil, nil // advisory data: treat read failures as a miss
	}
	var models []string
	if json.Unmarshal([]byte(modelsJSON), &models) != nil {
		return nil, nil
	}
	return &Entry{Provider: provider, Endpoint: endpoint, Models: models, FetchedAt: fetchedAt, Rules: rules}, nil
}

// ModelsForProvider returns every model id cached for a provider, across the
// endpoints and account keys it was discovered on, from rows filtered under
// the given rule version. Rotation uses it to decide which accounts can serve
// a requested model; a miss is not an error, because the cache is advisory.
func (s *Store) ModelsForProvider(ctx context.Context, provider string, rules int) ([]string, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT models_json FROM model_catalog_cache WHERE provider = ? AND rules_version = ?`, provider, rules)
	if err != nil {
		return nil, nil
	}
	defer rows.Close()
	seen := map[string]bool{}
	var models []string
	for rows.Next() {
		var modelsJSON string
		if rows.Scan(&modelsJSON) != nil {
			continue
		}
		var cached []string
		if json.Unmarshal([]byte(modelsJSON), &cached) != nil {
			continue
		}
		for _, id := range cached {
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			models = append(models, id)
		}
	}
	return models, nil
}

// Write upserts one cached list.
func (s *Store) Write(ctx context.Context, e *Entry) error {
	raw, err := json.Marshal(e.Models)
	if err != nil {
		return err
	}
	_, err = s.DB.ExecContext(ctx,
		`INSERT INTO model_catalog_cache (provider, endpoint, models_json, fetched_at, rules_version)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(provider, endpoint) DO UPDATE SET
		   models_json = excluded.models_json,
		   fetched_at = excluded.fetched_at,
		   rules_version = excluded.rules_version`,
		e.Provider, e.Endpoint, string(raw), e.FetchedAt, e.Rules)
	return err
}

// Clear drops cached lists, optionally scoped to one provider.
func (s *Store) Clear(ctx context.Context, provider string) error {
	if provider == "" {
		_, err := s.DB.ExecContext(ctx, `DELETE FROM model_catalog_cache`)
		return err
	}
	_, err := s.DB.ExecContext(ctx, `DELETE FROM model_catalog_cache WHERE provider = ?`, provider)
	return err
}
