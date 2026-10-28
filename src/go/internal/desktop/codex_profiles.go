package desktop

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"

	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/transport"
)

// CodexProfileRow contains only routing metadata and a launch command. The
// command points at owner-only files but never includes their proxy secrets.
type CodexProfileRow struct {
	Name            string `json:"name"`
	SourceID        string `json:"sourceId"`
	SourceLabel     string `json:"sourceLabel"`
	ModelID         string `json:"modelId"`
	TransportPolicy string `json:"transportPolicy"`
	LaunchCommand   string `json:"launchCommand"`
	// AppOpenable says the profile can be opened in the Codex desktop app
	// from this machine (codex-profile-open). Only macOS can launch the app
	// with a per-instance CODEX_HOME.
	AppOpenable bool `json:"appOpenable"`
}

// CodexProfileSourceRow is an app-route option with its source-scoped model
// list. Model catalogs are cached/static reads here; snapshot generation never
// performs vendor discovery.
type CodexProfileSourceRow struct {
	SourceID string   `json:"sourceId"`
	Kind     string   `json:"kind"`
	Label    string   `json:"label"`
	Detail   string   `json:"detail"`
	Selected bool     `json:"selected"`
	Models   []string `json:"models"`
}

func (b *snapshotBuilder) codexProfiles(ctx context.Context) {
	if b == nil || b.srv == nil || b.srv.Deps.Activation == nil {
		return
	}
	store := b.srv.Deps.Activation.ClientProfiles
	if store == nil {
		return
	}
	providers := map[string]bool{}
	if b.srv.Deps.Providers != nil {
		for _, id := range b.srv.Deps.Providers.IDs() {
			providers[id] = true
		}
	}
	parseContext := &refs.ParseContext{AccountProviders: providers}

	// Route action rows are the same capability-filtered choices the Apps pane
	// offers. Resolve their stable source refs to model ids for the profile sheet.
	sourcesByID := map[string]CodexProfileSourceRow{}
	for _, action := range b.snap.Actions {
		if action.ClientID != "codex" || !action.Enabled || action.SourceID == "" {
			continue
		}
		source, err := refs.ParseRef(action.SourceID, parseContext)
		if err != nil || !codexProfileSourceKind(source.Kind) {
			continue
		}
		sourceID := refs.SerializeRef(source)
		row, ok := sourcesByID[sourceID]
		if !ok {
			row = CodexProfileSourceRow{
				SourceID: sourceID,
				Kind:     string(source.Kind),
				Label:    action.Label,
				Detail:   action.Detail,
				Selected: action.Selected,
				Models:   b.modelOptionsFor(ctx, source, nil),
			}
		} else if action.Selected {
			row.Selected = true
		}
		sourcesByID[sourceID] = row
	}
	for _, row := range sourcesByID {
		b.snap.CodexProfileSources = append(b.snap.CodexProfileSources, row)
	}
	// Stable display order keeps the picker calm across refreshes.
	sort.SliceStable(b.snap.CodexProfileSources, func(i, j int) bool {
		return b.snap.CodexProfileSources[i].Label < b.snap.CodexProfileSources[j].Label
	})

	profiles, err := store.ListContext(ctx, "codex")
	if err != nil {
		b.srv.logErr(fmt.Errorf("read Codex profiles for snapshot: %w", err))
		return
	}
	for _, named := range profiles {
		sourceID := refs.SerializeRef(named.Spec.Source)
		sourceLabel := refs.DisplayRef(named.Spec.Source)
		if source, ok := sourcesByID[sourceID]; ok && source.Label != "" {
			sourceLabel = source.Label
		}
		policy := named.Spec.TransportPolicy
		if policy == "" {
			policy = string(transport.PolicyAuto)
		}
		b.snap.CodexProfiles = append(b.snap.CodexProfiles, CodexProfileRow{
			Name:            named.Name,
			SourceID:        sourceID,
			SourceLabel:     sourceLabel,
			ModelID:         primaryModelOf(named.Spec),
			TransportPolicy: policy,
			LaunchCommand: client.CodexProfileLaunchCommand(
				b.srv.Deps.Root, named.Name, codexProfileNeedsEnv(ctx, b.srv, &named)),
			AppOpenable: client.CodexProfileAppSupported(),
		})
	}
}

func codexProfileSourceKind(kind refs.Kind) bool {
	switch kind {
	case refs.KindAccount, refs.KindGateway, refs.KindProxyHub, refs.KindAccountPool:
		return true
	default:
		return false
	}
}

func codexProfileNeedsEnv(ctx context.Context, srv *Server, named *client.NamedProfile) bool {
	if named == nil || named.Spec.Source.Kind != refs.KindAccount {
		return true
	}
	if srv == nil || srv.Deps.Activation == nil {
		return named.Spec.TransportPolicy == string(transport.PolicyProxy)
	}
	resolved, err := activation.MaterializeResolvedSource(ctx, named.Spec.Source, srv.Deps.Activation)
	if err != nil {
		return named.Spec.TransportPolicy == string(transport.PolicyProxy)
	}
	capability, err := transport.ResolveTransportPolicy(
		resolved.Adapter, "codex", transport.Policy(named.Spec.TransportPolicy))
	if err != nil {
		return named.Spec.TransportPolicy == string(transport.PolicyProxy)
	}
	return capability != transport.Direct
}

func codexProfileNeedsModel(source refs.Ref, policy string) bool {
	// A native Codex account can keep Codex's own default model selection.
	// Every route through AnyPick's compatible proxy needs a concrete model id;
	// otherwise Codex falls back to its built-in OpenAI catalog.
	return source.Kind != refs.KindAccount || source.Provider != "codex" || policy == string(transport.PolicyProxy)
}

func (s *Server) codexProfileDefaultModel(source refs.Ref, models []string) string {
	if preferred := s.providerFallbackDefaultModel(source.Provider); preferred != "" && containsModel(models, preferred) {
		return preferred
	}
	for _, model := range models {
		if model = strings.TrimSpace(model); model != "" {
			return model
		}
	}
	return ""
}

func (s *Server) mutateCodexProfileSave(ctx context.Context, m Mutate, result Result) Result {
	return s.mutateCodexProfile(ctx, m, result, false)
}

func (s *Server) mutateCodexProfileUpdate(ctx context.Context, m Mutate, result Result) Result {
	return s.mutateCodexProfile(ctx, m, result, true)
}

func (s *Server) mutateCodexProfileSync(ctx context.Context, m Mutate, result Result) Result {
	if s.Deps.Activation == nil || s.Deps.Activation.ClientProfiles == nil {
		return result.Fail(serviceUnavailableErr("Codex profile service"))
	}
	providers := map[string]bool{}
	if s.Deps.Providers != nil {
		for _, id := range s.Deps.Providers.IDs() {
			providers[id] = true
		}
	}
	parseContext := &refs.ParseContext{AccountProviders: providers}
	profiles, err := s.Deps.Activation.ClientProfiles.ListContext(ctx, "codex")
	if err != nil {
		return result.Fail(err)
	}
	profiledSources := make(map[string]bool, len(profiles))
	usedNames := make(map[string]string, len(profiles)+len(m.SourceIDs))
	for _, profile := range profiles {
		profiledSources[refs.SerializeRef(profile.Spec.Source)] = true
		usedNames[profile.Name] = refs.SerializeRef(profile.Spec.Source)
	}

	created, skipped, failed := 0, 0, 0
	mutationUncertain := false
	failureDetails := make([]string, 0, 2)
	seenSources := make(map[string]bool, len(m.SourceIDs))
	for _, sourceID := range m.SourceIDs {
		source, err := refs.ParseRef(strings.TrimSpace(sourceID), parseContext)
		if err != nil || source.Kind != refs.KindAccount {
			skipped++
			continue
		}
		canonicalID := refs.SerializeRef(source)
		if seenSources[canonicalID] || profiledSources[canonicalID] {
			skipped++
			continue
		}
		seenSources[canonicalID] = true
		name := codexAutoProfileName(source, usedNames)
		outcome := s.mutateCodexProfile(ctx, Mutate{
			Name:            name,
			SourceID:        canonicalID,
			TransportPolicy: string(transport.PolicyAuto),
		}, Result{Version: ProtocolVersion, RequestID: m.RequestID, Status: "success"}, false)
		if outcome.Status != "success" {
			failed++
			mutationUncertain = mutationUncertain || outcome.Mutated
			if len(failureDetails) < cap(failureDetails) {
				failureDetails = append(failureDetails, codexProfileSyncFailureDetail(source, outcome))
			}
			continue
		}
		created++
		profiledSources[canonicalID] = true
		usedNames[name] = canonicalID
	}

	switch {
	case failed > 0 && created == 0:
		result.Status = "error"
		result.Code = "CODEX_PROFILE_SYNC_FAILED"
		result.Mutated = mutationUncertain
		result.Message = codexProfileSyncFailureMessage(created, failed, failureDetails)
	case failed > 0:
		result.Status = "error"
		result.Code = "CODEX_PROFILE_SYNC_PARTIAL"
		result.Mutated = mutationUncertain
		result.Message = codexProfileSyncFailureMessage(created, failed, failureDetails)
	case created == 0:
		result.Message = "No missing Codex profiles needed to be created."
	default:
		result.Message = fmt.Sprintf("Created %d Codex profiles. Existing profiles were left unchanged.", created)
	}
	if skipped > 0 && created > 0 && failed == 0 {
		result.Message = fmt.Sprintf("Created %d Codex profiles; skipped %d accounts that already had a profile.", created, skipped)
	}
	return result
}

func codexProfileSyncFailureDetail(source refs.Ref, outcome Result) string {
	label := displaySafeIdentity(refs.DisplayRef(source))
	if label == "" {
		label = "an account"
	}
	if runes := []rune(label); len(runes) > 80 {
		label = string(runes[:80])
	}
	reason := displaySafeMessage(outcome.Message)
	if outcome.Code == "CODEX_PROFILE_MODELS_UNAVAILABLE" {
		reason = "model catalog unavailable"
	}
	if reason == "" || reason == unsafeDisplayFallback {
		reason = "could not be prepared"
	}
	if runes := []rune(reason); len(runes) > 80 {
		reason = string(runes[:80])
	}
	return label + ": " + reason
}

func codexProfileSyncFailureMessage(created, failed int, details []string) string {
	if created == 0 {
		prefix := "No Codex profiles were created"
		return prefix + "; " + codexProfileSyncFailureSuffix(failed, details) + "."
	}
	accountLabel := "accounts"
	if failed == 1 {
		accountLabel = "account"
	}
	return fmt.Sprintf("Created %d Codex profiles; %d %s could not be prepared: %s.",
		created, failed, accountLabel, codexProfileSyncFailureSuffix(failed, details))
}

func codexProfileSyncFailureSuffix(failed int, details []string) string {
	if len(details) == 0 {
		return "Retry Create Missing Profiles after the affected account issue is resolved"
	}
	message := strings.Join(details, "; ")
	if remaining := failed - len(details); remaining > 0 {
		message += fmt.Sprintf("; and %d more", remaining)
	}
	return message + ". Retry Create Missing Profiles to try again"
}

func codexAutoProfileName(source refs.Ref, used map[string]string) string {
	var slug strings.Builder
	separator := false
	for _, r := range strings.ToLower(source.Provider + "-" + source.Name) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			slug.WriteRune(r)
			separator = false
		} else if !separator {
			slug.WriteByte('-')
			separator = true
		}
	}
	base := strings.Trim(slug.String(), "-")
	if base == "" {
		base = "account"
	}
	if len(base) <= 64 {
		if _, exists := used[base]; !exists {
			return base
		}
	}
	digest := sha256.Sum256([]byte(refs.SerializeRef(source)))
	suffix := hex.EncodeToString(digest[:4])
	for n := 0; ; n++ {
		candidateSuffix := suffix
		if n > 0 {
			candidateSuffix = fmt.Sprintf("%s-%d", suffix, n)
		}
		prefixLimit := 64 - len(candidateSuffix) - 1
		prefix := strings.TrimRight(base, "-")
		if len(prefix) > prefixLimit {
			prefix = strings.TrimRight(prefix[:prefixLimit], "-")
		}
		candidate := prefix + "-" + candidateSuffix
		if _, exists := used[candidate]; !exists {
			return candidate
		}
	}
}

func (s *Server) mutateCodexProfile(ctx context.Context, m Mutate, result Result, update bool) Result {
	if s.Deps.Activation == nil || s.Deps.Activation.ClientProfiles == nil {
		return result.Fail(serviceUnavailableErr("Codex profile service"))
	}
	if err := client.ValidateCodexProfileName(m.Name); err != nil {
		return result.Fail(anyerr.Newf(err.Error(), "INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage)))
	}
	parseContext := &refs.ParseContext{AccountProviders: map[string]bool{}}
	if s.Deps.Providers != nil {
		for _, id := range s.Deps.Providers.IDs() {
			parseContext.AccountProviders[id] = true
		}
	}
	source, err := refs.ParseRef(strings.TrimSpace(m.SourceID), parseContext)
	if err != nil || !codexProfileSourceKind(source.Kind) {
		if err == nil {
			err = anyerr.Newf("Choose a saved account, API gateway, or Proxy Hub route.", "INVALID_REFERENCE",
				anyerr.WithExitCode(anyerr.InvalidUsage))
		}
		return result.Fail(err)
	}
	policy := strings.TrimSpace(m.TransportPolicy)
	if policy == "" {
		policy = string(transport.PolicyAuto)
	}
	model := strings.TrimSpace(m.DefaultModel)
	catalog := s.sourceModelCatalog(ctx, source)
	if model == "" && codexProfileNeedsModel(source, policy) {
		if len(catalog) == 0 && source.Kind == refs.KindAccount {
			if _, err := s.warmAccountModelCatalog(ctx, source.Provider, source.Name); err != nil {
				return result.Fail(anyerr.Newf(
					"Could not discover models for this Codex profile. Refresh the account's model list and try again.",
					"CODEX_PROFILE_MODELS_UNAVAILABLE", anyerr.WithCause(err)))
			}
			catalog = s.sourceModelCatalog(ctx, source)
		}
		if len(catalog) == 0 {
			return result.Fail(anyerr.Newf(
				"This Codex route has no discovered models. Choose a model or refresh its model catalog before adding the profile.",
				"CODEX_PROFILE_MODELS_UNAVAILABLE"))
		}
		model = s.codexProfileDefaultModel(source, catalog)
		if model == "" {
			return result.Fail(anyerr.Newf("This Codex route has no usable model id.", "CODEX_PROFILE_MODELS_UNAVAILABLE"))
		}
	}
	request := activation.Request{
		Mode:            activation.ModeProfile,
		Client:          "codex",
		ProfileName:     m.Name,
		Source:          &source,
		ModelCatalog:    catalog,
		TransportPolicy: transport.Policy(policy),
	}
	if model != "" {
		request.Model = model
	}
	plan, err := activation.PlanActivation(ctx, request, s.Deps.Activation, activation.Options{})
	if err != nil {
		return result.Fail(err)
	}
	// Refuse accidental replacement from the Add Profile sheet. Callers may
	// remove and recreate a profile after reviewing the destructive action.
	err = lock.WithMutationLocks(ctx, s.Deps.Root,
		[]string{"client/codex", "client-profile/codex/" + m.Name}, func(c context.Context) error {
			existing, err := s.Deps.Activation.ClientProfiles.GetContext(c, "codex", m.Name)
			if err != nil {
				return err
			}
			if existing != nil && !update {
				return anyerr.Newf("A Codex profile with that name already exists. Remove it first, then add it again.",
					"CLIENT_PROFILE_EXISTS", anyerr.WithExitCode(anyerr.InvalidUsage))
			}
			if existing == nil && update {
				return anyerr.Newf("Codex profile "+m.Name+" was not found.", "CODEX_PROFILE_NOT_FOUND")
			}
			_, err = activation.Execute(c, plan, s.Deps.Activation, activation.ExecuteOptions{})
			return err
		}, 0)
	if err != nil {
		return result.Fail(err)
	}
	if update {
		result.Message = fmt.Sprintf("Updated Codex profile %s.", m.Name)
	} else {
		result.Message = fmt.Sprintf("Added Codex profile %s.", m.Name)
	}
	return result
}

func (s *Server) mutateCodexProfileOpen(ctx context.Context, m Mutate, result Result) Result {
	if s.Deps.Activation == nil {
		return result.Fail(serviceUnavailableErr("Codex profile service"))
	}
	// The CLI's `codex profile open` runs the same function, so both write
	// the same app config and launch the same way.
	if err := activation.OpenCodexProfileApp(ctx, m.Name, s.Deps.Activation); err != nil {
		return result.Fail(err)
	}
	result.Message = fmt.Sprintf("Opened Codex profile %s in the Codex app.", m.Name)
	return result
}

func (s *Server) mutateCodexProfileRemove(ctx context.Context, m Mutate, result Result) Result {
	if s.Deps.Activation == nil || s.Deps.Activation.ClientProfiles == nil || s.Deps.Clients == nil {
		return result.Fail(serviceUnavailableErr("Codex profile service"))
	}
	// Removal is shared with the CLI and the account-deletion cascade: the
	// same plan, the same files, the same order. A second implementation here
	// is how one of the four removal paths starts disagreeing with the others.
	named, removal, err := activation.PlanNamedProfileRemoval(ctx, "codex", m.Name, s.Deps.Activation)
	if err != nil {
		return result.Fail(err)
	}
	err = activation.RemoveNamedProfiles(ctx, []activation.ProfileRemoval{removal}, s.Deps.Activation,
		func(c context.Context) error {
			current, gerr := s.Deps.Activation.ClientProfiles.GetContext(c, "codex", m.Name)
			if gerr != nil {
				return gerr
			}
			if current == nil {
				return activation.NamedProfileNotFound(m.Name)
			}
			if activation.NamedProfileChanged(named, current) {
				return anyerr.Newf("The Codex profile changed. Refresh and review it before removing it.", "STATE_CONFLICT")
			}
			return nil
		})
	if err != nil {
		return result.Fail(err)
	}
	result.Message = fmt.Sprintf("Removed Codex profile %s.", m.Name)
	return result
}
