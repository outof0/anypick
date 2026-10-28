package gemini

import (
	"regexp"
	"strings"
)

// GeminiModelIntent is the friendly intent a client name maps to.
type GeminiModelIntent string

// Intents a friendly client name maps to. Code Assist's tieredModelIds use
// the same three tiers, so a catalog can name the vendor's route for each.
const (
	IntentQuality GeminiModelIntent = "quality"
	IntentFast    GeminiModelIntent = "fast"
	IntentLite    GeminiModelIntent = "lite"
)

// GeminiModelResolution keeps the client-facing model id separate from the
// exact endpoint id accepted by an OAuth provider such as Code Assist.
type GeminiModelResolution struct {
	ID         string
	UpstreamID string
	Remapped   bool
	Reason     string // case|alias|effort|intent|default|unavailable
}

// GeminiModelDescriptor is one catalog entry.
type GeminiModelDescriptor struct {
	ID string
	// UpstreamID is the id sent to the provider when it differs from ID.
	UpstreamID  string
	DisplayName string
	Recommended bool
}

// GeminiModelCatalog is the live account model list.
type GeminiModelCatalog struct {
	Models            []GeminiModelDescriptor
	DefaultModelID    string
	PreferredModelIDs []string
	// TierRoutes is the upstream route the vendor uses for each intent. A
	// route is not listed in Models: clients reach it by intent only.
	TierRoutes map[GeminiModelIntent]string
}

// ModelCatalogInput accepts either a bare id list or a structured catalog.
type ModelCatalogInput interface{}

// MapToGeminiModel normalizes a client model id without changing the requested
// model (strips a models/ prefix; bare id after the last slash).
func MapToGeminiModel(model string) string {
	raw := strings.TrimSpace(model)
	if raw == "" {
		return ""
	}
	bare := raw
	if strings.Contains(raw, "/") {
		if parts := strings.Split(raw, "/"); len(parts) > 0 {
			bare = parts[len(parts)-1]
		}
	}
	if strings.HasPrefix(bare, "models/") {
		return bare[len("models/"):]
	}
	return bare
}

// ResolveGeminiModel resolves a friendly/foreign model name against the live
// account catalog. Concrete ids always pass through, including ids released
// after this proxy. Ports resolveGeminiModel (translate-models.ts).
func ResolveGeminiModel(requested string, available ModelCatalogInput, effort string) GeminiModelResolution {
	catalog := normalizeModelCatalog(available)
	ids := make([]string, 0, len(catalog.Models))
	for _, m := range catalog.Models {
		ids = append(ids, m.ID)
	}
	id := MapToGeminiModel(requested)
	if id != "" {
		for _, candidate := range ids {
			if candidate == id {
				return resolutionForCatalogID(candidate, catalog, id, "")
			}
		}
		for _, candidate := range ids {
			if strings.EqualFold(candidate, id) {
				return resolutionForCatalogID(candidate, catalog, id, "case")
			}
		}

		// Code Assist model ids are opaque and can differ from their
		// user-facing names; match aliases from the live catalog.
		aliasMatches := make([]GeminiModelDescriptor, 0)
		normID := normalizeModelName(id)
		for _, model := range catalog.Models {
			if modelAliases(model).Has(normID) {
				aliasMatches = append(aliasMatches, model)
			}
		}
		defaultAlias := preferCatalogModel(aliasMatches, catalog)
		alias := preferCatalogModelForEffort(aliasMatches, catalog, effort)
		if alias.ID != "" {
			return resolutionForDescriptor(alias, id, ternary(alias.ID != defaultAlias.ID, "effort", "alias"))
		}

		// AnyPick 1.1.x saved tier routes with Google's "-tiered" cut off
		// (gemini-3.8-flash) in bindings and client configs. Google never
		// published that id, so it is read back as the route it was cut from,
		// and only while the live catalog still names that route. No new id
		// is ever derived this way.
		for _, route := range catalog.TierRoutes {
			if strings.EqualFold(route, id+"-tiered") {
				return GeminiModelResolution{ID: id, UpstreamID: route, Remapped: true, Reason: "legacy"}
			}
		}

		intent := modelIntent(id)
		if route := catalog.TierRoutes[intent]; intent != "" && route != "" {
			// The client keeps the name it asked for; only egress uses the
			// vendor's tier route.
			return GeminiModelResolution{ID: id, UpstreamID: route, Remapped: true, Reason: "intent"}
		}
		if intent == "" {
			// Unknown concrete ids are intentionally not rejected; the live
			// catalog can be stale during a rollout.
			return GeminiModelResolution{ID: id, UpstreamID: id, Remapped: false}
		}
		selected := SelectGeminiModel(ids, intent)
		if selected != "" {
			return resolutionForCatalogID(selected, catalog, id, "intent")
		}
		return GeminiModelResolution{ID: "", Remapped: true, Reason: "unavailable"}
	}

	selected := ""
	for _, candidate := range ids {
		if candidate == catalog.DefaultModelID {
			selected = candidate
			break
		}
	}
	if selected == "" {
		selected = SelectGeminiModel(ids, IntentQuality)
	}
	if selected != "" {
		return resolutionForCatalogID(selected, catalog, "", "default")
	}
	return GeminiModelResolution{ID: "", Remapped: false, Reason: "unavailable"}
}

func resolutionForCatalogID(id string, catalog GeminiModelCatalog, requested, reason string) GeminiModelResolution {
	for _, model := range catalog.Models {
		if model.ID == id {
			return resolutionForDescriptor(model, requested, reason)
		}
	}
	return GeminiModelResolution{ID: id, UpstreamID: id, Remapped: id != requested, Reason: reason}
}

func resolutionForDescriptor(model GeminiModelDescriptor, requested, reason string) GeminiModelResolution {
	upstreamID := strings.TrimSpace(model.UpstreamID)
	if upstreamID == "" {
		upstreamID = model.ID
	}
	return GeminiModelResolution{
		ID:         model.ID,
		UpstreamID: upstreamID,
		Remapped:   model.ID != requested,
		Reason:     reason,
	}
}

func normalizeModelCatalog(available ModelCatalogInput) GeminiModelCatalog {
	switch v := available.(type) {
	case []string:
		models := make([]GeminiModelDescriptor, 0, len(v))
		for _, id := range v {
			models = append(models, GeminiModelDescriptor{ID: id})
		}
		return GeminiModelCatalog{Models: models}
	case GeminiModelCatalog:
		return v
	case *GeminiModelCatalog:
		if v != nil {
			return *v
		}
	}
	return GeminiModelCatalog{}
}

type modelAliasSet struct {
	members map[string]bool
}

func (s modelAliasSet) Has(value string) bool { return s.members[value] }

func modelAliases(model GeminiModelDescriptor) modelAliasSet {
	aliases := modelAliasSet{members: map[string]bool{normalizeModelName(model.ID): true}}
	if model.DisplayName == "" {
		return aliases
	}
	aliases.members[normalizeModelName(model.DisplayName)] = true
	baseDisplayName := model.DisplayName
	if idx := strings.Index(baseDisplayName, "("); idx >= 0 {
		baseDisplayName = strings.TrimSpace(baseDisplayName[:idx])
	}
	aliases.members[normalizeModelName(baseDisplayName)] = true
	return aliases
}

func normalizeModelName(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.TrimPrefix(value, "models/")
	re := regexp.MustCompile(`[^a-z0-9]+`)
	value = re.ReplaceAllString(value, "-")
	value = strings.Trim(value, "-")
	return value
}

func preferCatalogModel(matches []GeminiModelDescriptor, catalog GeminiModelCatalog) GeminiModelDescriptor {
	if len(matches) == 0 {
		return GeminiModelDescriptor{}
	}
	byID := make(map[string]GeminiModelDescriptor, len(matches))
	for _, m := range matches {
		byID[m.ID] = m
	}
	if catalog.DefaultModelID != "" {
		if m, ok := byID[catalog.DefaultModelID]; ok {
			return m
		}
	}
	for _, id := range catalog.PreferredModelIDs {
		if m, ok := byID[id]; ok {
			return m
		}
	}
	for _, m := range matches {
		if m.Recommended {
			return m
		}
	}
	return matches[0]
}

func preferCatalogModelForEffort(matches []GeminiModelDescriptor, catalog GeminiModelCatalog, effort string) GeminiModelDescriptor {
	target := reasoningEffortRank(effort)
	if target == -1 {
		return preferCatalogModel(matches, catalog)
	}
	type ranked struct {
		model    GeminiModelDescriptor
		distance int
	}
	var rankedMatches []ranked
	closest := -1
	for _, model := range matches {
		r := catalogModelEffortRank(model)
		if r == -1 {
			continue
		}
		d := abs(r - target)
		if closest == -1 || d < closest {
			closest = d
		}
		rankedMatches = append(rankedMatches, ranked{model, d})
	}
	if len(rankedMatches) == 0 {
		return preferCatalogModel(matches, catalog)
	}
	var best []GeminiModelDescriptor
	for _, rm := range rankedMatches {
		if rm.distance == closest {
			best = append(best, rm.model)
		}
	}
	return preferCatalogModel(best, catalog)
}

func catalogModelEffortRank(model GeminiModelDescriptor) int {
	tier := ""
	if idx := strings.Index(model.DisplayName, "("); idx >= 0 {
		tier = strings.Trim(model.DisplayName[idx+1:], "()")
	}
	return reasoningEffortRank(tier)
}

func reasoningEffortRank(value string) int {
	normalized := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(value, "_", " ")))
	switch normalized {
	case "none", "minimal", "extra low":
		return 0
	case "low":
		return 1
	case "medium":
		return 2
	case "high":
		return 3
	case "xhigh", "extra high":
		return 4
	case "max":
		return 5
	default:
		return -1
	}
}

// SelectGeminiModel picks the newest matching tier from ids actually exposed by
// the account, given a friendly intent.
func SelectGeminiModel(available []string, intent GeminiModelIntent) string {
	seen := map[string]bool{}
	var ranked []string
	for _, id := range available {
		if id = strings.TrimSpace(id); id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ranked = append(ranked, id)
	}
	sortGeminiModelIDs(ranked)
	for _, id := range ranked {
		switch intent {
		case IntentLite:
			if modelIDHas(id, "lite") {
				return id
			}
		case IntentFast:
			if modelIDHas(id, "flash") && !modelIDHas(id, "lite") {
				return id
			}
		default:
			if modelIDHas(id, "pro") && !modelIDHas(id, "flash") {
				return id
			}
		}
	}
	switch intent {
	case IntentLite:
		for _, id := range ranked {
			if modelIDHas(id, "flash") {
				return id
			}
		}
	case IntentFast:
		for _, id := range ranked {
			if modelIDHas(id, "lite") {
				return id
			}
		}
	default:
		for _, id := range ranked {
			if !modelIDHas(id, "flash") && !modelIDHas(id, "lite") {
				return id
			}
		}
	}
	if len(ranked) > 0 {
		return ranked[0]
	}
	return ""
}

func modelIDHas(id, token string) bool {
	return strings.Contains(strings.ToLower(id), token)
}

func modelIntent(model string) GeminiModelIntent {
	id := strings.ToLower(model)
	// A concrete Gemini/Gemma id must never be rewritten just because its name
	// contains a tier word such as "flash" or "pro".
	if matched := regexp.MustCompile(`^(?:gemini|gemma)-\d`); matched.MatchString(id) {
		return ""
	}
	if id == "lite" || id == "haiku" || strings.Contains(id, "lite") {
		return IntentLite
	}
	if id == "flash" || id == "mini" || strings.Contains(id, "flash") || strings.Contains(id, "mini") || id == "fast" {
		return IntentFast
	}
	if id == "gemini" || id == "auto" || strings.Contains(id, "latest") ||
		strings.Contains(id, "pro") || strings.Contains(id, "sonnet") ||
		strings.Contains(id, "opus") || strings.HasPrefix(id, "gpt") || strings.Contains(id, "codex") {
		return IntentQuality
	}
	return ""
}

// ParseGeminiModelVersion returns the major.minor of a live Google model id
// (e.g. gemini-<major>.<minor>-<tier> → [major, minor]).
func ParseGeminiModelVersion(id string) [2]int {
	m := regexp.MustCompile(`^gemini-(\d+)(?:\.(\d+))?`).FindStringSubmatch(strings.ToLower(id))
	if m == nil {
		return [2]int{0, 0}
	}
	major := atoiSafe(m[1])
	minor := 0
	if m[2] != "" {
		minor = atoiSafe(m[2])
	}
	return [2]int{major, minor}
}

// CompareGeminiModelIDs sorts live ListModels results: newer major.minor
// first, then family, stable names before preview/exp. Does not invent ids.
func CompareGeminiModelIDs(a, b string) int {
	av := ParseGeminiModelVersion(a)
	bv := ParseGeminiModelVersion(b)
	if av[0] != bv[0] {
		return bv[0] - av[0]
	}
	if av[1] != bv[1] {
		return bv[1] - av[1]
	}
	fa := geminiFamilyRank(a)
	fb := geminiFamilyRank(b)
	if fa != fb {
		return fa - fb
	}
	na := geminiModelNoise(a)
	nb := geminiModelNoise(b)
	if na != nb {
		if na < nb {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
}

func sortGeminiModelIDs(ids []string) {
	// insertion sort to avoid importing sort for a tiny list; stable enough.
	for i := 1; i < len(ids); i++ {
		for j := i; j > 0 && CompareGeminiModelIDs(ids[j-1], ids[j]) > 0; j-- {
			ids[j-1], ids[j] = ids[j], ids[j-1]
		}
	}
}

func geminiFamilyRank(id string) int {
	lower := strings.ToLower(id)
	if strings.Contains(lower, "flash-lite") || strings.Contains(lower, "flashlite") || regexp.MustCompile(`(^|-)lite($|-)`).MatchString(lower) {
		return 2
	}
	if strings.Contains(lower, "flash") {
		return 1
	}
	if strings.Contains(lower, "pro") {
		return 0
	}
	return 3
}

func geminiModelNoise(id string) float64 {
	lower := strings.ToLower(id)
	penalty := 0.0
	if strings.Contains(lower, "preview") || strings.Contains(lower, "exp") || strings.Contains(lower, "latest") {
		penalty += 10
	}
	return penalty + float64(min(len(lower), 80))*0.01
}

func ternary(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func atoiSafe(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}
