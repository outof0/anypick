// Package pricing turns token counts into a dated cost estimate (ADR-0037).
//
// The bundled table lists only prices read from a vendor's published list,
// with the date they were read. A model it does not list gets no estimate
// rather than a guessed one: a confident wrong number is worse than a blank.
// Users add or correct prices in <ANYPICK_HOME>/pricing.json, same shape.
//
// Every figure is an API list-price equivalent. Requests served by a
// subscription login (Claude Pro, ChatGPT) cost the user nothing extra per
// token; for them the estimate says what the same traffic would have cost on
// the API, and surfaces must label it as an estimate with its date.
package pricing

import (
	_ "embed"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

//go:embed prices.json
var bundled []byte

// OverrideFile is the user's price file, beside anypick.db.
const OverrideFile = "pricing.json"

// Price is USD per 1M tokens. A nil cache price is unknown, and those tokens
// are charged at the input price: an upper bound for cache reads, which every
// listed vendor discounts.
type Price struct {
	Input      float64  `json:"input"`
	Output     float64  `json:"output"`
	CacheRead  *float64 `json:"cacheRead,omitempty"`
	CacheWrite *float64 `json:"cacheWrite,omitempty"`
}

// Cost is the estimate in USD for one set of disjoint token counts.
func (p Price) Cost(input, output, cacheRead, cacheWrite int64) float64 {
	cr, cw := p.Input, p.Input
	if p.CacheRead != nil {
		cr = *p.CacheRead
	}
	if p.CacheWrite != nil {
		cw = *p.CacheWrite
	}
	return (float64(input)*p.Input + float64(output)*p.Output +
		float64(cacheRead)*cr + float64(cacheWrite)*cw) / 1e6
}

type file struct {
	AsOf   string           `json:"asOf"`
	Source string           `json:"source"`
	Models map[string]Price `json:"models"`
}

// Table is the bundled prices with the user's overrides applied.
type Table struct {
	AsOf       string
	Source     string
	Overridden []string
	models     map[string]Price
	keys       []string
}

// Load reads the bundled table and merges root/pricing.json over it. A
// malformed override file is an error, not silently ignored: the user wrote
// it to change a number they will read.
func Load(root string) (*Table, error) {
	var base file
	if err := json.Unmarshal(bundled, &base); err != nil {
		return nil, err
	}
	t := &Table{AsOf: base.AsOf, Source: base.Source, models: map[string]Price{}}
	for id, p := range base.Models {
		t.models[strings.ToLower(id)] = p
	}
	if root != "" {
		raw, err := os.ReadFile(filepath.Join(root, OverrideFile))
		switch {
		case errors.Is(err, fs.ErrNotExist):
		case err != nil:
			return nil, err
		default:
			var over file
			if err := json.Unmarshal(raw, &over); err != nil {
				return nil, errors.New(OverrideFile + ": " + err.Error())
			}
			for id, p := range over.Models {
				id = strings.ToLower(strings.TrimSpace(id))
				if id == "" || p.Input < 0 || p.Output < 0 {
					continue
				}
				t.models[id] = p
				t.Overridden = append(t.Overridden, id)
			}
			sort.Strings(t.Overridden)
		}
	}
	for id := range t.models {
		t.keys = append(t.keys, id)
	}
	// Longest first, so "claude-opus-5-5" wins over "claude-opus-5".
	sort.Slice(t.keys, func(i, j int) bool { return len(t.keys[i]) > len(t.keys[j]) })
	return t, nil
}

// Lookup finds a model's price. Ids are matched case-insensitively, after a
// vendor prefix ("anthropic/…"), and either exactly or as a prefix followed by
// "-" or "@", so a dated snapshot ("claude-opus-5-20260101") prices as its
// family.
func (t *Table) Lookup(model string) (Price, bool) {
	if t == nil {
		return Price{}, false
	}
	id := strings.ToLower(strings.TrimSpace(model))
	if i := strings.LastIndex(id, "/"); i >= 0 {
		id = id[i+1:]
	}
	if id == "" {
		return Price{}, false
	}
	if p, ok := t.models[id]; ok {
		return p, true
	}
	for _, key := range t.keys {
		if strings.HasPrefix(id, key) && len(id) > len(key) && (id[len(key)] == '-' || id[len(key)] == '@') {
			return t.models[key], true
		}
	}
	return Price{}, false
}
