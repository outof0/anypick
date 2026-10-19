package client

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/transport"
)

// workbuddyAdapter makes WorkBuddy AI / CodeBuddy a *client*: the bundled
// CodeBuddy runtime reads a user-level models.json and treats every entry in it
// as an extra OpenAI-compatible provider. It is Tencent's own extension
// mechanism, so this writes a supported file instead of patching application
// internals.
//
// The entry points at AnyPick's loopback proxy, which is what actually holds
// the borrowed account.
type workbuddyAdapter struct{ home string }

func newWorkBuddy(home string) *workbuddyAdapter { return &workbuddyAdapter{home: home} }

const (
	workbuddyModelsFile             = "models.json"
	workbuddyVendorID               = "anypick"
	workbuddyRestoreFile            = "restore.json"
	workbuddyCustomLocalModelPrefix = "custom-local:"

	// WorkBuddy's agent loop reads these to decide whether the custom model
	// can drive tools and where thinking tokens belong. Official models.json
	// examples always set them; omitting them is how a reasoning slug dumps
	// "Let me write." / "OK." into the visible answer instead of calling tools.
	workbuddyDefaultMaxInputTokens  = 200000
	workbuddyDefaultMaxOutputTokens = 32000
)

// workbuddyModelEntry mirrors one models.json entry. Fields are the documented
// ones; unknown fields on entries AnyPick keeps are preserved as raw JSON.
type workbuddyModelEntry struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Vendor            string `json:"vendor,omitempty"`
	APIKey            string `json:"apiKey,omitempty"`
	URL               string `json:"url,omitempty"`
	MaxInputTokens    int    `json:"maxInputTokens,omitempty"`
	MaxOutputTokens   int    `json:"maxOutputTokens,omitempty"`
	SupportsToolCall  *bool  `json:"supportsToolCall,omitempty"`
	SupportsImages    *bool  `json:"supportsImages,omitempty"`
	SupportsReasoning *bool  `json:"supportsReasoning,omitempty"`

	raw map[string]json.RawMessage
}

func (a *workbuddyAdapter) ID() string        { return "workbuddy" }
func (a *workbuddyAdapter) Name() string      { return "WorkBuddy AI" }
func (a *workbuddyAdapter) ShortName() string { return "WorkBuddy" }

func (a *workbuddyAdapter) Capabilities() *Capabilities {
	return &Capabilities{
		ID:                       "workbuddy",
		AcceptedProtocols:        []transport.Protocol{transport.OpenAI},
		SupportsPersistentConfig: true,
		RequiresDefaultModel:     true,
		ProtocolPreference:       transport.OpenAI,
	}
}

// workbuddyModelsPaths returns the models.json paths used by the bundled
// CodeBuddy runtime. WorkBuddy desktop sets CODEBUDDY_CONFIG_DIR to its own
// ~/.workbuddy-ai root, while standalone CodeBuddy defaults to ~/.codebuddy.
// When both product roots exist, keep both integrations in sync: they are the
// two supported clients represented by this adapter, not guessed legacy paths.
func workbuddyModelsPaths(home string) []string {
	if dir := workbuddyModelConfigDirOverride(); dir != "" {
		return []string{filepath.Join(dir, workbuddyModelsFile)}
	}

	paths := make([]string, 0, 2)
	for _, dir := range []string{".workbuddy-ai", ".codebuddy"} {
		if st, err := os.Stat(filepath.Join(home, dir)); err == nil && st.IsDir() {
			paths = append(paths, filepath.Join(home, dir, workbuddyModelsFile))
		}
	}
	if len(paths) == 0 {
		// WorkBuddy desktop is the installed product and its documented
		// process environment uses this root. Creating the file here also
		// lets the app discover the models on its first Apply.
		paths = append(paths, filepath.Join(home, ".workbuddy-ai", workbuddyModelsFile))
	}
	return paths
}

// WorkBuddyModelsPaths reports every models.json file Apply may write.
// Shared with the runtime recovery journal so backup and apply cannot drift.
func WorkBuddyModelsPaths(home string) []string {
	return workbuddyModelsPaths(home)
}

func workbuddyModelConfigDirOverride() string {
	for _, key := range []string{"CODEBUDDY_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR"} {
		v := strings.TrimSpace(os.Getenv(key))
		if v == "" {
			continue
		}
		if home, err := os.UserHomeDir(); err == nil && (v == "~" || strings.HasPrefix(v, "~/")) {
			return filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(v, "~"), "/"))
		}
		return v
	}
	return ""
}

// readWorkBuddyModels loads one file, refusing to touch it if it is not a JSON
// object — a models.json we cannot parse belongs to the user, not to us.
//
// One shape is accepted as empty rather than foreign: a bare `[]`. The
// WorkBuddy desktop app's model sync rewrites the file to that when its own
// list resolves empty, and refusing it would strand routing forever — the app
// would keep no models and AnyPick would keep declining to write. An empty
// array carries no user entries, so replacing it with the documented object
// loses nothing. Any other non-object shape still refuses.
func readWorkBuddyModels(path string) (map[string]json.RawMessage, error) {
	doc := map[string]json.RawMessage{}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return doc, nil
		}
		return nil, err
	}
	if json.Unmarshal(raw, &doc) != nil || !jsonLooksObject(raw) {
		var empty []json.RawMessage
		if json.Unmarshal(raw, &empty) == nil && len(empty) == 0 {
			return map[string]json.RawMessage{}, nil
		}
		return nil, anyerr.Newf(
			"Refusing to overwrite unreadable WorkBuddy models file at "+path+".",
			"CLIENT_CONFIG_INVALID")
	}
	return doc, nil
}

func workbuddyEntries(doc map[string]json.RawMessage) []workbuddyModelEntry {
	raw, ok := doc["models"]
	if !ok || string(raw) == "null" {
		return nil
	}
	var raws []json.RawMessage
	if json.Unmarshal(raw, &raws) != nil {
		return nil
	}
	entries := make([]workbuddyModelEntry, 0, len(raws))
	for _, item := range raws {
		var e workbuddyModelEntry
		if json.Unmarshal(item, &e) != nil {
			continue
		}
		// Keep unknown fields so a future schema change survives a round trip.
		_ = json.Unmarshal(item, &e.raw)
		entries = append(entries, e)
	}
	return entries
}

func writeWorkBuddyModels(path string, doc map[string]json.RawMessage, entries []workbuddyModelEntry) error {
	items := make([]json.RawMessage, 0, len(entries))
	for _, e := range entries {
		body, err := json.Marshal(e)
		if err != nil {
			return err
		}
		if e.raw == nil {
			items = append(items, body)
			continue
		}
		// Start from the original object so fields we do not model survive,
		// then let the known fields win.
		merged := map[string]json.RawMessage{}
		for k, v := range e.raw {
			merged[k] = v
		}
		var known map[string]json.RawMessage
		if json.Unmarshal(body, &known) == nil {
			for k, v := range known {
				merged[k] = v
			}
		}
		out, err := json.Marshal(merged)
		if err != nil {
			return err
		}
		items = append(items, out)
	}
	list, err := json.Marshal(items)
	if err != nil {
		return err
	}
	doc["models"] = list
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	// path is the user's live models.json (ADR 0004): rename, not truncate.
	return atomicfile.Write(path, append(out, '\n'), 0o600)
}

func workbuddyManagedEntries(
	doc map[string]json.RawMessage,
	template workbuddyModelEntry,
	modelIDs []string,
	accountName string,
) []workbuddyModelEntry {
	kept := make([]workbuddyModelEntry, 0, len(workbuddyEntries(doc))+len(modelIDs))
	for _, existing := range workbuddyEntries(doc) {
		// AnyPick owns exactly its own entries; the user's stay untouched.
		if strings.EqualFold(existing.Vendor, workbuddyVendorID) {
			continue
		}
		kept = append(kept, existing)
	}
	for _, id := range modelIDs {
		id = trimModelID(id)
		if !workbuddyPublishableModelID(id) {
			continue
		}
		managed := template
		// WorkBuddy 5.5 enables its custom-model namespace. It prefixes
		// every unqualified custom id in memory before sending requests, and
		// strips that prefix again on the wire. Writing the namespaced id
		// ourselves avoids the hot-reload path materialising a second copy of
		// every AnyPick model in models.json.
		managed.ID = workbuddyConfigModelID(id)
		managed.Name = workbuddyDisplayName(id, accountName)
		kept = append(kept, managed)
	}
	return kept
}

// workbuddyPublishableModelID drops WorkBuddy's own UI routing aliases.
// Publishing those as custom-local entries makes the desktop treat a
// thinking-only router (onlyReasoning) as a raw OpenAI model, which is the
// "Let me write." / "OK." / "Writing." collapse on the custom-model path.
func workbuddyPublishableModelID(id string) bool {
	id = strings.TrimPrefix(trimModelID(id), workbuddyCustomLocalModelPrefix)
	if id == "" {
		return false
	}
	switch strings.ToLower(id) {
	case "default-model", "fast-model", "balanced-model", "primary-model", "deep-model", "auto-chat":
		return false
	}
	return true
}

// workbuddyDisplayName makes the selected AnyPick account visible in
// WorkBuddy's model picker. WorkBuddy keeps its native account identity in a
// separate daemon/Keychain session, so the model entry is the only honest
// place to show which saved AnyPick subscription the proxy will use.
func workbuddyDisplayName(id, accountName string) string {
	model := strings.TrimPrefix(trimModelID(id), workbuddyCustomLocalModelPrefix)
	accountName = strings.TrimSpace(accountName)
	if accountName == "" {
		return "AnyPick " + model
	}
	return "AnyPick · " + accountName + " · " + model
}

func workbuddyConfigModelID(id string) string {
	if strings.HasPrefix(id, workbuddyCustomLocalModelPrefix) {
		return id
	}
	return workbuddyCustomLocalModelPrefix + id
}

func workbuddyBool(v bool) *bool { return &v }

func workbuddyPublishableIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if workbuddyPublishableModelID(id) {
			out = append(out, id)
		}
	}
	return out
}

func workbuddyProxyEntry(endpoint, apiKey, modelID string) workbuddyModelEntry {
	if apiKey == "" {
		apiKey = "anypick-proxy"
	}
	return workbuddyModelEntry{
		ID:     modelID,
		Name:   "AnyPick " + modelID,
		Vendor: workbuddyVendorID,
		APIKey: apiKey,
		// CodeBuddy's models.json contract wants the complete chat-completions
		// path, not only the OpenAI /v1 base.
		URL:               strings.TrimSuffix(endpoint, "/") + "/v1/chat/completions",
		MaxInputTokens:    workbuddyDefaultMaxInputTokens,
		MaxOutputTokens:   workbuddyDefaultMaxOutputTokens,
		SupportsToolCall:  workbuddyBool(true),
		SupportsImages:    workbuddyBool(true),
		SupportsReasoning: workbuddyBool(true),
	}
}

// workbuddyFileCheckpoint is what Reset needs to put one file back exactly as
// it was: whether it existed at all, and its prior models list if it did.
type workbuddyFileCheckpoint struct {
	Path        string          `json:"path"`
	Present     bool            `json:"present"`
	ModelsValue json.RawMessage `json:"modelsValue,omitempty"`
}

type workbuddyRestoreState struct {
	Version int                       `json:"version"`
	Files   []workbuddyFileCheckpoint `json:"files"`
}

func (a *workbuddyAdapter) Apply(ctx *ApplyContext) (*ApplyResult, error) {
	targetHome := ctx.Home
	if ctx.IsolatedHome != "" {
		targetHome = ctx.IsolatedHome
	}
	modelsPaths := workbuddyModelsPaths(targetHome)
	restorePath := filepath.Join(ctx.AnyPickRoot, "clients", "workbuddy", workbuddyRestoreFile)

	modelID := selectedDefaultModel(ctx)
	publishable := workbuddyPublishableIDs(sourceModelIDs(ctx))
	if ctx.Endpoint == "" || len(publishable) == 0 {
		return nil, anyerr.Newf(
			"WorkBuddy routing needs an endpoint and a selected default model.",
			"CLIENT_CONFIG_INVALID")
	}
	managed := append([]string(nil), modelsPaths...)
	if ctx.IsolatedHome == "" {
		managed = append(managed, restorePath)
	}
	if ctx.DryRun {
		return &ApplyResult{ManagedPaths: managed}, nil
	}

	entry := workbuddyProxyEntry(ctx.Endpoint, ctx.APIKey, modelID)

	checkpoints := make([]workbuddyFileCheckpoint, 0, len(modelsPaths))
	for _, path := range modelsPaths {
		doc, err := readWorkBuddyModels(path)
		if err != nil {
			return nil, err
		}
		// Checkpoint each file once, before the first write, so Reset can put
		// the user's list back even if AnyPick ran several times.
		if ctx.IsolatedHome == "" {
			checkpoints = append(checkpoints, workbuddyFileCheckpoint{
				Path: path, Present: doc["models"] != nil, ModelsValue: doc["models"],
			})
		}
		kept := workbuddyManagedEntries(doc, entry, publishable, ctx.SourceName)
		if err := writeWorkBuddyModels(path, doc, kept); err != nil {
			return nil, err
		}
	}

	// Write the checkpoint after every file succeeded: a checkpoint that
	// claims more than was written would make Reset delete user data.
	if ctx.IsolatedHome == "" {
		if _, statErr := os.Stat(restorePath); os.IsNotExist(statErr) {
			state := workbuddyRestoreState{Version: 1, Files: checkpoints}
			rj, merr := json.MarshalIndent(state, "", "  ")
			if merr != nil {
				return nil, merr
			}
			if mkErr := os.MkdirAll(filepath.Dir(restorePath), 0o700); mkErr != nil {
				return nil, mkErr
			}
			// A checkpoint write that fails must fail the apply: a silent
			// failure leaves an AnyPick-created models.json behind with no
			// record for Reset to restore.
			if werr := atomicfile.Write(restorePath, append(rj, '\n'), 0o600); werr != nil {
				return nil, werr
			}
		}
	}
	return &ApplyResult{ManagedPaths: managed}, nil
}

// RestoreNative drops AnyPick-managed proxy entries so the app returns to
// its native login. The executor calls it for direct bindings (which never
// route through the loopback proxy) instead of Apply: without it a direct
// bind would leave stale proxy entries behind.
func (a *workbuddyAdapter) RestoreNative() error {
	for _, path := range workbuddyModelsPaths(a.home) {
		if err := sweepWorkBuddyManagedEntries(path); err != nil {
			return err
		}
	}
	return nil
}

func (a *workbuddyAdapter) Reset() error {
	restorePath := filepath.Join(anyPickRootFallback(), "clients", "workbuddy", workbuddyRestoreFile)

	restored := map[string]bool{}
	if raw, rerr := os.ReadFile(restorePath); rerr == nil {
		var state workbuddyRestoreState
		if json.Unmarshal(raw, &state) == nil {
			for _, file := range state.Files {
				if rerr := resetWorkBuddyFile(file); rerr != nil {
					return rerr
				}
				restored[file.Path] = true
			}
			_ = os.Remove(restorePath)
		}
	}
	// Product roots that appeared after the checkpoint are not listed in
	// it: sweep their managed entries so no proxy routing survives Reset.
	// Restored files keep their exact prior content and are skipped.
	for _, path := range workbuddyModelsPaths(a.home) {
		if restored[path] {
			continue
		}
		if err := sweepWorkBuddyManagedEntries(path); err != nil {
			return err
		}
	}
	return nil
}

// sweepWorkBuddyManagedEntries removes exactly the AnyPick-owned entries from
// one models file, preserving everything of the user's. A missing file is
// not an error: nothing records AnyPick ever creating it.
func sweepWorkBuddyManagedEntries(path string) error {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	doc, err := readWorkBuddyModels(path)
	if err != nil {
		return err
	}
	kept := make([]workbuddyModelEntry, 0, len(workbuddyEntries(doc)))
	managed := false
	for _, entry := range workbuddyEntries(doc) {
		if strings.EqualFold(entry.Vendor, workbuddyVendorID) {
			managed = true
			continue
		}
		kept = append(kept, entry)
	}
	if !managed {
		return nil
	}
	return writeWorkBuddyModels(path, doc, kept)
}

func resetWorkBuddyFile(file workbuddyFileCheckpoint) error {
	if !file.Present {
		// AnyPick created this file; remove it rather than leaving a stub.
		if err := os.Remove(file.Path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	doc, err := readWorkBuddyModels(file.Path)
	if err != nil {
		return err
	}
	if file.ModelsValue != nil {
		doc["models"] = file.ModelsValue
	} else {
		delete(doc, "models")
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	// Reset rewrites the user's live models file (ADR 0004): rename, not truncate.
	return atomicfile.Write(file.Path, append(out, '\n'), 0o600)
}

func (a *workbuddyAdapter) Inspect() (*InspectResult, error) {
	paths := workbuddyModelsPaths(a.home)
	res := &InspectResult{ConfigPaths: paths}
	managed := false
	for _, path := range paths {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		res.Present = true
		doc, err := readWorkBuddyModels(path)
		if err != nil {
			res.Issues = append(res.Issues, "WorkBuddy models.json is unreadable at "+path)
			continue
		}
		for _, entry := range workbuddyEntries(doc) {
			if strings.EqualFold(entry.Vendor, workbuddyVendorID) {
				managed = true
				break
			}
		}
	}
	switch {
	case !res.Present:
		res.Summary = "no models.json"
	case managed:
		res.Summary = "AnyPick provider configured"
	default:
		res.Summary = "models.json present (no AnyPick entry)"
	}
	res.Native = !managed && len(res.Issues) == 0
	res.RoutingChanged = res.Native && res.Present
	return res, nil
}
