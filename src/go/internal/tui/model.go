package tui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/app"
	"github.com/outof0/anypick/go/internal/doctor"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/i18n"
	"github.com/outof0/anypick/go/internal/paths"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/store"
	"github.com/outof0/anypick/go/internal/transfer"
	"github.com/outof0/anypick/go/internal/transport"
)

// board is the current primary view. The Go TUI cycles Apps → Accounts →
// Gateways → Proxy with tab, and any secondary board returns to Apps on esc.
// Apps is "the product" (docs/guides/terminal-ui.mdx): it answers what each
// routing app (Claude / Codex) should use right now.
type board int

const (
	boardApps board = iota
	boardAccounts
	boardGateways
	boardProxy
)

// wizardStep is the route-build flow: source → models → preview.
type wizardStep int

const (
	wizardSource wizardStep = iota
	wizardModels
	wizardPreview
)

// Model is the bubbletea model. It holds no secrets: proxy tokens returned by
// StartProxy are discarded here by design (invariant #2).
type Model struct {
	app *app.App
	ctx context.Context

	board board

	apps         []AppRow
	providers    []ProviderRow
	providerFull []ProviderRow // unfiltered list; providers is the filtered view
	accounts     []AccountRow
	gateways     []GatewayRow
	proxies      []ProxyRow

	// accountDrill: within the Accounts board, true once a provider is opened.
	cursor          int
	accountProvider string
	accountDrill    bool
	filtering       bool
	filterText      string

	width  int
	height int

	wizard    *wizardState
	confirm   *confirmState
	showHelp  bool
	diagnosis *doctor.Report

	// prompting captures a one-line file path for import. enter runs promptRun
	// with the typed text; esc cancels.
	prompting              bool
	promptText             string
	promptLabel            string
	promptRun              func(string) tea.Cmd
	promptSuggestions      []string
	promptSuggestionCursor int

	status      string
	statusErr   bool
	statusCause error
	quitting    bool
}

type confirmState struct {
	question string
	run      func() tea.Msg
}

// wizardState is the in-progress route build. Nothing is written until the
// preview's final confirm dispatches activation.Execute.
type wizardState struct {
	clientID string
	step     wizardStep

	sources []SourceOption
	cursor  int
	chosen  SourceOption
	// sourceProvider is the catalog provider the chosen source resolves to,
	// used to surface the real model list for the wizard's model step.
	sourceProvider string

	fields       []string
	model        string
	roles        map[string]string
	editingField int
	text         string

	plan    *activation.Plan
	planErr string
}

// formatErrWithSuggestions keeps the recovery commands on the text the TUI
// can render. err.Error() alone drops anyerr.Suggestions.
func formatErrWithSuggestions(err error) string {
	if err == nil {
		return ""
	}
	var ae *anyerr.Error
	if !errors.As(err, &ae) || len(ae.Suggestions) == 0 {
		return err.Error()
	}
	return err.Error() + "\n" + strings.Join(ae.Suggestions, "\n")
}

// New builds the initial model, landing on the Apps board.
func New(ctx context.Context, a *app.App) *Model {
	return &Model{app: a, ctx: ctx, board: boardApps}
}

type appsLoadedMsg struct{ rows []AppRow }
type providersLoadedMsg struct{ rows []ProviderRow }
type accountsLoadedMsg struct {
	rows []AccountRow
	err  error
}
type gatewaysLoadedMsg struct{ rows []GatewayRow }
type proxiesLoadedMsg struct{ rows []ProxyRow }

type wizardSourcesLoadedMsg struct{ opts []SourceOption }
type planReadyMsg struct {
	plan *activation.Plan
	err  error
}

// actionMsg is the outcome of any service call.
type actionMsg struct {
	text string
	err  error
}

// diagnoseMsg carries a per-client health report (doctor.DiagnoseClient).
type diagnoseMsg struct{ report *doctor.Report }

func loadAppsCmd(ctx context.Context, a *app.App) tea.Cmd {
	return func() tea.Msg { return appsLoadedMsg{rows: LoadApps(ctx, a)} }
}

func loadGatewaysCmd(ctx context.Context, a *app.App) tea.Cmd {
	return func() tea.Msg { return gatewaysLoadedMsg{rows: LoadGateways(ctx, a)} }
}

func loadProxiesCmd(ctx context.Context, a *app.App) tea.Cmd {
	return func() tea.Msg { return proxiesLoadedMsg{rows: LoadProxies(ctx, a)} }
}

func loadWizardSourcesCmd(ctx context.Context, a *app.App, clientID string) tea.Cmd {
	return func() tea.Msg {
		return wizardSourcesLoadedMsg{opts: LoadSourceOptions(ctx, a, clientID)}
	}
}

// planWizardCmd runs the pure planner so the preview can show the exact steps
// the CLI would execute. Planning has no side effects (invariant #3).
func planWizardCmd(ctx context.Context, a *app.App, clientID string, ref refs.Ref, model string, roles map[string]string) tea.Cmd {
	return func() tea.Msg {
		providerSet := map[string]bool{}
		for _, id := range a.Providers.IDs() {
			providerSet[id] = true
		}
		req := activation.Request{
			Mode:            activation.ModePersistent,
			Client:          clientID,
			Source:          &ref,
			Model:           model,
			ModelRoles:      roles,
			TransportPolicy: transport.PolicyAuto,
		}
		// Native same-provider routes skip the wizard's model step, so the
		// planner must bootstrap the default itself. Best-effort catalog;
		// the failure is kept so the preview can explain itself.
		if ref.Kind == refs.KindAccount && a.Proxy != nil {
			models, derr := a.Proxy.DiscoverModels(ctx, ref.Provider, ref.Name)
			req.ModelCatalog, req.ModelCatalogErr = models, derr
		}
		plan, err := activation.PlanActivation(ctx, req, a.Deps, activation.Options{})
		if err != nil {
			return planReadyMsg{err: err}
		}
		return planReadyMsg{plan: plan}
	}
}

// activateWizardCmd is the only mutating step: it executes the committed plan.
// On success it records a source-resume hint, exactly like `anypick use`.
func activateWizardCmd(ctx context.Context, a *app.App, plan *activation.Plan) tea.Cmd {
	return func() tea.Msg {
		if _, err := activation.Execute(ctx, plan, a.Deps, activation.ExecuteOptions{}); err != nil {
			return actionMsg{err: err}
		}
		if plan.BindingSpec != nil {
			_ = a.BindingSvc.RecordSourceResumeContext(ctx, *plan.BindingSpec)
		}
		display := clientIDOf(plan)
		if plan.ResolvedSource != nil {
			display = fmt.Sprintf("%s × %s", display, refs.DisplayRef(plan.ResolvedSource.Ref))
		}
		return actionMsg{text: fmt.Sprintf("activated %s", display)}
	}
}

func clientIDOf(plan *activation.Plan) string {
	if plan == nil {
		return ""
	}
	return plan.Client
}

// diagnoseCmd runs read-only health checks for one routing client. It never
// mutates anything — doctor.DiagnoseClient is a pure inspection.
func diagnoseCmd(ctx context.Context, a *app.App, clientID string) tea.Cmd {
	return func() tea.Msg {
		rep, err := doctor.DiagnoseClient(ctx, doctor.Deps{
			Clients:   a.Clients,
			Providers: a.Providers,
			Bindings:  a.BindingSvc,
			Store:     a.Store,
			Profiles:  a.Runtime.ProfileSvc,
			Presets:   a.PresetSvc,
			Accounts:  a.Accounts,
			Proxy:     a.Proxy,
		}, clientID)
		if err != nil {
			return diagnoseMsg{report: &doctor.Report{ClientID: clientID, Status: doctor.StatusUnhealthy}}
		}
		return diagnoseMsg{report: rep}
	}
}

// defaultExportPath stages an exported account under the AnyPick data root,
// never a browsed folder like ~/Downloads: the envelope holds live
// credentials in plaintext, so a copy left where the OS surfaces downloads
// outlives the user's intent to keep it. The caller echoes the exact path in
// the export status line, so the file stays findable without being browsed.
func defaultExportPath(root, providerID, name string) string {
	return filepath.Join(paths.Root(root), "exports",
		fmt.Sprintf("anypick-%s-%s.json", providerID, name))
}

func exportAccountCmd(ctx context.Context, a *app.App, providerID, name string) tea.Cmd {
	return func() tea.Msg {
		outPath := defaultExportPath(a.Root, providerID, name)
		if err := transfer.ExportEnvelope(a.Store, ctx, providerID, name, outPath); err != nil {
			return actionMsg{err: err}
		}
		return actionMsg{text: fmt.Sprintf("exported %s/%s → %s", providerID, name, outPath)}
	}
}

// exportProviderCmd exports every saved account of a provider to its own file.
func exportProviderCmd(ctx context.Context, a *app.App, providerID string) tea.Cmd {
	return func() tea.Msg {
		accounts, err := a.Store.ListAccounts(ctx, providerID)
		if err != nil {
			return actionMsg{err: err}
		}
		if len(accounts) == 0 {
			return actionMsg{text: fmt.Sprintf("no saved accounts for %s to export", providerID)}
		}
		var exported []string
		for _, acct := range accounts {
			outPath := defaultExportPath(a.Root, providerID, acct.Meta.Name)
			if werr := transfer.ExportEnvelope(a.Store, ctx, providerID, acct.Meta.Name, outPath); werr != nil {
				return actionMsg{err: werr}
			}
			exported = append(exported, acct.Meta.Name)
		}
		return actionMsg{text: fmt.Sprintf("exported %d account(s) for %s → %s",
			len(exported), providerID, filepath.Join(paths.Root(a.Root), "exports"))}
	}
}

// importAccountCmd reads the envelope to learn its account name, then imports
// it under that name (force=false so an existing account is not clobbered).
func importAccountCmd(ctx context.Context, a *app.App, providerID, inPath string, force bool) tea.Cmd {
	return func() tea.Msg {
		metas, ierr := a.Accounts.Import(ctx, accounts.ImportRequest{
			Paths: []string{inPath}, ProviderID: providerID, Force: force,
		})
		if ierr != nil {
			return actionMsg{err: withImportPathSuggestions(ierr, a.Root)}
		}
		if len(metas) == 1 {
			return actionMsg{text: fmt.Sprintf("imported %s/%s", metas[0].Provider, metas[0].Name)}
		}
		return actionMsg{text: importedAccountsMessage(metas)}
	}
}

func importedAccountsMessage(metas []store.Meta) string {
	if len(metas) == 0 {
		return "imported 0 accounts"
	}
	parts := make([]string, 0, len(metas))
	for _, meta := range metas {
		parts = append(parts, meta.Provider+"/"+meta.Name)
	}
	return fmt.Sprintf("imported %d account(s): %s", len(metas), strings.Join(parts, ", "))
}

func withImportPathSuggestions(err error, root string) error {
	if err == nil {
		return nil
	}
	var ae *anyerr.Error
	if !errors.As(err, &ae) {
		suggestions := append([]string{"Choose a JSON envelope or AnyPick backup file from the list."}, importPathCandidates(root)...)
		return anyerr.Newf(err.Error(), "IMPORT_MISSING", anyerr.WithSuggestions(suggestions...))
	}
	suggestions := []string{"Choose a JSON envelope or AnyPick backup file from the list."}
	suggestions = append(suggestions, importPathCandidates(root)...)
	ae.Suggestions = appendUniqueTUISuggestions(ae.Suggestions, suggestions...)
	return err
}

func appendUniqueTUISuggestions(existing []string, additions ...string) []string {
	seen := make(map[string]bool, len(existing)+len(additions))
	for _, value := range existing {
		seen[value] = true
	}
	for _, value := range additions {
		if value != "" && !seen[value] {
			existing = append(existing, value)
			seen[value] = true
		}
	}
	return existing
}

func importPathCandidates(root string) []string {
	dirs := make([]string, 0, 2)
	if cwd, err := os.Getwd(); err == nil {
		dirs = append(dirs, cwd)
	}
	// A live app always supplies its resolved data root. Keeping the fallback
	// out when the model is deliberately app-less also keeps preview/tests from
	// enumerating a developer's real ~/.anypick directory.
	if root != "" {
		dirs = append(dirs, filepath.Join(paths.Root(root), "exports"))
	}
	seen := map[string]bool{}
	var out []string
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			ext := strings.ToLower(filepath.Ext(entry.Name()))
			if ext != ".json" && ext != ".anypick-backup" {
				continue
			}
			path := filepath.Join(dir, entry.Name())
			if !seen[path] {
				seen[path] = true
				out = append(out, path)
			}
		}
	}
	sort.Strings(out)
	if len(out) > 12 {
		out = out[:12]
	}
	return out
}

func (m *Model) openImportPrompt(providerID string) {
	root := ""
	if m.app != nil {
		root = m.app.Root
	}
	m.prompting = true
	m.promptLabel = fmt.Sprintf("import into %s — choose a .json file:", providerID)
	m.promptText = ""
	m.promptSuggestions = importPathCandidates(root)
	m.promptSuggestionCursor = 0
	m.promptRun = func(path string) tea.Cmd {
		return importAccountCmd(m.ctx, m.app, providerID, path, false)
	}
}

func loadProvidersCmd(ctx context.Context, a *app.App) tea.Cmd {
	return func() tea.Msg {
		return providersLoadedMsg{rows: LoadProviders(ctx, a)}
	}
}

func loadAccountsCmd(ctx context.Context, a *app.App, providerID string) tea.Cmd {
	return func() tea.Msg {
		rows, err := LoadAccounts(ctx, a, providerID)
		return accountsLoadedMsg{rows: rows, err: err}
	}
}

func useCmd(ctx context.Context, a *app.App, providerID, name string) tea.Cmd {
	return func() tea.Msg {
		reapplied := 0
		// The reapply is part of the switch transaction: a failure restores the
		// previous account (pointer, binding, proxy) instead of leaving bound
		// clients pointed at the account that was just switched away from.
		res, err := a.Accounts.Use(ctx, providerID, name, accounts.UseOptions{
			PostSwitch: func(pc context.Context) error {
				n, rerr := a.ReapplyClientsBoundTo(pc, refs.AccountRef(providerID, name), app.ReapplyOptions{})
				reapplied = n
				return rerr
			},
		})
		if err != nil {
			return actionMsg{err: err}
		}
		from := res.From
		if from == "" {
			from = "(none)"
		}
		text := fmt.Sprintf("switched %s: %s → %s", providerID, from, res.To)
		if reapplied > 0 {
			text += fmt.Sprintf("; reapplied %d client(s)", reapplied)
		}
		return actionMsg{text: text}
	}
}

func saveLiveCmd(ctx context.Context, a *app.App, providerID string) tea.Cmd {
	return func() tea.Msg {
		cur, err := a.Accounts.Current(ctx, providerID)
		if err != nil {
			return actionMsg{err: err}
		}
		if cur == nil || !cur.Live.Present {
			return actionMsg{text: fmt.Sprintf(
				"no live login detected for %s — sign in with the official tool first", providerID)}
		}
		meta, err := a.Accounts.Save(ctx, providerID, suggestAccountName(cur.Live.Identity), false)
		if err != nil {
			return actionMsg{err: err}
		}
		return actionMsg{text: fmt.Sprintf("saved %s/%s", providerID, meta.Name)}
	}
}

func deleteCmd(ctx context.Context, a *app.App, providerID, name string) tea.Cmd {
	return func() tea.Msg {
		deleted, err := a.Accounts.Delete(ctx, providerID, name)
		if err != nil {
			return actionMsg{err: err}
		}
		text := fmt.Sprintf("deleted %s/%s", providerID, name)
		if len(deleted.Profiles) > 0 {
			text += fmt.Sprintf(" (+%d named profile: %s)", len(deleted.Profiles),
				strings.Join(deleted.Profiles, ", "))
		}
		if a.ProxyHub != nil {
			pruned, perr := a.ProxyHub.PruneAccount(ctx, providerID, name)
			if perr != nil {
				text += fmt.Sprintf(" (hub cleanup failed: %s)", perr)
			} else if len(pruned) > 0 {
				text += fmt.Sprintf(". Hub references dropped: %s", strings.Join(pruned, ", "))
			}
			if a.Deps != nil && a.Deps.SpawnHubChild != nil {
				if configs, lerr := a.ProxyHub.ListConfigsContext(ctx); lerr != nil {
					text += fmt.Sprintf(" (hub refresh failed: %s)", lerr)
				} else if rerr := hub.ReloadUnsynced(configs, a.Deps.SpawnHubChild); rerr != nil {
					text += fmt.Sprintf(" (hub refresh failed: %s)", rerr)
				}
			}
		}
		return actionMsg{text: text}
	}
}

func toggleProxyCmd(ctx context.Context, a *app.App, providerID, name string, running bool) tea.Cmd {
	return func() tea.Msg {
		if running {
			if err := a.Proxy.Stop(ctx, providerID, name); err != nil {
				return actionMsg{err: err}
			}
			return actionMsg{text: fmt.Sprintf("stopped proxy for %s/%s", providerID, name)}
		}
		res, err := a.Proxy.StartProxy(ctx, providerID, name)
		if err != nil {
			return actionMsg{err: err}
		}
		// res.Token is deliberately dropped: the footer shows the endpoint only.
		return actionMsg{text: fmt.Sprintf("proxy listening on %s", res.Endpoint)}
	}
}

func (m *Model) Init() tea.Cmd { return loadAppsCmd(m.ctx, m.app) }

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		if m.confirm != nil {
			return m.updateConfirm(msg)
		}
		if m.showHelp {
			if msg.String() == "esc" || msg.String() == "?" || msg.String() == "q" {
				m.showHelp = false
			}
			return m, nil
		}
		if m.wizard != nil {
			return m.updateWizardKey(msg)
		}
		if m.diagnosis != nil {
			m.diagnosis = nil
			return m, nil
		}
		return m.updateBoardKey(msg)

	case appsLoadedMsg:
		m.apps = msg.rows
		m.clampCursor()
		return m, nil
	case providersLoadedMsg:
		m.providerFull = msg.rows
		m.providers = msg.rows
		m.filterText = ""
		m.clampCursor()
		return m, nil
	case accountsLoadedMsg:
		if msg.err != nil {
			m.statusErr = true
			m.status = msg.err.Error()
			m.accounts = nil
			return m, nil
		}
		m.accounts = msg.rows
		m.cursor = 0
		return m, nil
	case gatewaysLoadedMsg:
		m.gateways = msg.rows
		m.clampCursor()
		return m, nil
	case proxiesLoadedMsg:
		m.proxies = msg.rows
		m.clampCursor()
		return m, nil
	case wizardSourcesLoadedMsg:
		if m.wizard != nil {
			m.wizard.sources = msg.opts
			m.wizard.cursor = 0
		}
		return m, nil
	case planReadyMsg:
		if m.wizard != nil {
			m.wizard.plan = msg.plan
			if msg.err != nil {
				m.wizard.planErr = formatErrWithSuggestions(msg.err)
			} else {
				m.wizard.planErr = ""
			}
		}
		return m, nil
	case diagnoseMsg:
		m.diagnosis = msg.report
		return m, nil
	case actionMsg:
		m.statusErr = msg.err != nil
		m.statusCause = msg.err
		if msg.err != nil {
			m.status = formatErrWithSuggestions(msg.err)
		} else {
			m.status = msg.text
		}
		m.wizard = nil
		m.prompting = false
		m.promptText = ""
		m.promptSuggestions = nil
		m.promptSuggestionCursor = 0
		return m, m.boardLoadCmd()
	}
	return m, nil
}

func (m *Model) clampCursor() {
	switch m.board {
	case boardApps:
		m.cursor = clamp(m.cursor, len(m.apps))
	case boardAccounts:
		if m.accountDrill {
			m.cursor = clamp(m.cursor, len(m.accounts))
		} else {
			m.cursor = clamp(m.cursor, len(m.providers))
		}
	case boardGateways:
		m.cursor = clamp(m.cursor, len(m.gateways))
	case boardProxy:
		m.cursor = clamp(m.cursor, len(m.proxies))
	}
}

func clamp(c, n int) int {
	if n == 0 {
		return 0
	}
	if c >= n {
		return n - 1
	}
	if c < 0 {
		return 0
	}
	return c
}

func (m *Model) boardLoadCmd() tea.Cmd {
	switch m.board {
	case boardApps:
		return loadAppsCmd(m.ctx, m.app)
	case boardAccounts:
		if m.accountDrill {
			return loadAccountsCmd(m.ctx, m.app, m.accountProvider)
		}
		return loadProvidersCmd(m.ctx, m.app)
	case boardGateways:
		return loadGatewaysCmd(m.ctx, m.app)
	case boardProxy:
		return loadProxiesCmd(m.ctx, m.app)
	}
	return nil
}

func (m *Model) updateConfirm(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y", "enter":
		run := m.confirm.run
		m.confirm = nil
		return m, run
	case "n", "N", "esc", "q":
		m.confirm = nil
		m.status = i18n.T("tui.status.cancelled")
		m.statusErr = false
		return m, nil
	}
	return m, nil
}

func (m *Model) cycleBoard(dir int) {
	order := []board{boardApps, boardAccounts, boardGateways, boardProxy}
	idx := 0
	for i, b := range order {
		if b == m.board {
			idx = i
		}
	}
	idx = (idx + dir) % len(order)
	if idx < 0 {
		idx += len(order)
	}
	m.board = order[idx]
	m.cursor = 0
	m.accountDrill = false
}

func (m *Model) updateBoardKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	if m.filtering {
		return m.updateFilterKey(msg)
	}
	if m.prompting {
		return m.updatePromptKey(msg)
	}

	switch key {
	case "ctrl+c":
		m.quitting = true
		return m, tea.Quit
	case "q":
		// q closes the TUI only from the Apps home (the spec's "Keys on Apps"),
		// so a stray q never drops a drilled board.
		if m.board == boardApps {
			m.quitting = true
			return m, tea.Quit
		}
	case "?", "h":
		// h is an alias of ?: the docs used to promise it, users type it out of
		// vim instinct, and it costs nothing to make the reflex work.
		m.showHelp = true
		return m, nil
	case "tab":
		m.cycleBoard(1)
		return m, m.boardLoadCmd()
	case "r":
		return m, m.boardLoadCmd()
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
		return m, nil
	case "down", "j":
		m.cursor = min(m.cursor+1, max(0, m.listLen()-1))
		return m, nil
	}

	switch m.board {
	case boardApps:
		return m.appsKey(key)
	case boardAccounts:
		return m.accountsKey(key)
	case boardGateways:
		return m.gatewaysKey(key)
	case boardProxy:
		return m.proxyKey(key)
	}
	return m, nil
}

func (m *Model) listLen() int {
	switch m.board {
	case boardApps:
		return len(m.apps)
	case boardAccounts:
		if m.accountDrill {
			return len(m.accounts)
		}
		return len(m.providers)
	case boardGateways:
		return len(m.gateways)
	case boardProxy:
		return len(m.proxies)
	}
	return 0
}

func (m *Model) appsKey(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "enter", "l", "right":
		if m.cursor >= len(m.apps) {
			return m, nil
		}
		return m.openWizard(m.apps[m.cursor].ClientID)
	case "a":
		m.board = boardAccounts
		m.cursor = 0
		m.accountDrill = false
		m.status = ""
		return m, loadProvidersCmd(m.ctx, m.app)
	case "g":
		m.board = boardGateways
		m.cursor = 0
		return m, loadGatewaysCmd(m.ctx, m.app)
	case "p":
		m.board = boardProxy
		m.cursor = 0
		return m, loadProxiesCmd(m.ctx, m.app)
	case "d":
		if m.cursor >= len(m.apps) {
			return m, nil
		}
		return m, diagnoseCmd(m.ctx, m.app, m.apps[m.cursor].ClientID)
	}
	return m, nil
}

func (m *Model) openWizard(clientID string) (tea.Model, tea.Cmd) {
	m.wizard = &wizardState{clientID: clientID, step: wizardSource, cursor: 0, editingField: -1}
	return m, loadWizardSourcesCmd(m.ctx, m.app, clientID)
}

func (m *Model) accountsKey(key string) (tea.Model, tea.Cmd) {
	if !m.accountDrill {
		switch key {
		case "enter", "l", "right":
			if m.cursor >= len(m.providers) {
				return m, nil
			}
			m.accountProvider = m.providers[m.cursor].ID
			m.accountDrill = true
			m.cursor = 0
			m.status = ""
			return m, loadAccountsCmd(m.ctx, m.app, m.accountProvider)
		case "a":
			// "Add a login": in a no-secret TUI the only way to add is to
			// snapshot the current live login for the highlighted provider.
			if m.cursor >= len(m.providers) {
				return m, nil
			}
			return m, saveLiveCmd(m.ctx, m.app, m.providers[m.cursor].ID)
		case "v":
			if m.cursor >= len(m.providers) {
				return m, nil
			}
			m.status = m.providerDetail(m.providers[m.cursor])
			m.statusErr = false
			return m, nil
		case "e":
			if m.cursor >= len(m.providers) {
				return m, nil
			}
			return m, exportProviderCmd(m.ctx, m.app, m.providers[m.cursor].ID)
		case "i":
			if m.cursor >= len(m.providers) {
				return m, nil
			}
			p := m.providers[m.cursor]
			m.openImportPrompt(p.ID)
			return m, nil
		case "f":
			if len(m.providers) == 0 {
				return m, nil
			}
			m.providerFull = m.providers
			m.filtering = true
			m.filterText = ""
			m.status = ""
			return m, nil
		case "esc":
			m.board = boardApps
			m.cursor = 0
			return m, loadAppsCmd(m.ctx, m.app)
		}
		return m, nil
	}

	// Navigation keys work even with an empty account list, so handle them
	// before the empty-list guard that gates the per-row actions.
	switch key {
	case "esc":
		m.accountDrill = false
		m.cursor = 0
		m.status = ""
		return m, loadProvidersCmd(m.ctx, m.app)
	case "r":
		return m, loadAccountsCmd(m.ctx, m.app, m.accountProvider)
	}
	if m.cursor >= len(m.accounts) {
		return m, nil
	}
	row := m.accounts[m.cursor]
	switch key {
	case "enter", "u", "l", "right":
		return m, useCmd(m.ctx, m.app, row.ProviderID, row.Name)
	case "v":
		m.status = m.accountDetail(row)
		m.statusErr = false
		return m, nil
	case "p":
		return m, toggleProxyCmd(m.ctx, m.app, row.ProviderID, row.Name, row.ProxyRunning)
	case "s", "a":
		// s = save a changed live login; a = add a login (snapshot live). Both
		// snapshot the current live login for this provider.
		return m, saveLiveCmd(m.ctx, m.app, row.ProviderID)
	case "d":
		m.confirm = &confirmState{
			question: i18n.F("tui.confirm.delete_account", row.ProviderID, row.Name),
			run:      deleteCmd(m.ctx, m.app, row.ProviderID, row.Name),
		}
		return m, nil
	case "i":
		m.openImportPrompt(row.ProviderID)
		return m, nil
	case "e":
		return m, exportAccountCmd(m.ctx, m.app, row.ProviderID, row.Name)
	}
	return m, nil
}

// updateFilterKey captures a provider-name substring while the filter is open.
// enter/esc leave filtering and restore the full provider list; navigation is
// suspended so every printable key extends the query.
func (m *Model) updateFilterKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "esc":
		m.filtering = false
		m.filterText = ""
		return m, loadProvidersCmd(m.ctx, m.app)
	case "enter":
		m.filtering = false
		m.status = ""
		return m, nil
	case "backspace", "ctrl+h":
		if len(m.filterText) > 0 {
			m.filterText = m.filterText[:len(m.filterText)-1]
		}
		m.applyProviderFilter()
		return m, nil
	default:
		if len(key) == 1 {
			m.filterText += key
			m.applyProviderFilter()
		}
		return m, nil
	}
}

func (m *Model) applyProviderFilter() {
	q := strings.ToLower(m.filterText)
	filtered := make([]ProviderRow, 0, len(m.providerFull))
	for _, p := range m.providerFull {
		if q == "" ||
			strings.Contains(strings.ToLower(p.ID), q) ||
			strings.Contains(strings.ToLower(p.DisplayName), q) {
			filtered = append(filtered, p)
		}
	}
	m.providers = filtered
	m.cursor = 0
}

// updatePromptKey captures a one-line file path for import. enter runs
// promptRun with the typed text (which performs the transfer); esc cancels and
// drops back to the board. Navigation is suspended so every printable rune
// extends the path.
func (m *Model) updatePromptKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "esc":
		m.prompting = false
		m.promptText = ""
		m.promptSuggestions = nil
		m.promptSuggestionCursor = 0
		m.promptRun = nil
		m.status = ""
		return m, nil
	case "enter":
		run := m.promptRun
		text := m.promptText
		if text == "" && len(m.promptSuggestions) > 0 && m.promptSuggestionCursor >= 0 &&
			m.promptSuggestionCursor < len(m.promptSuggestions) {
			text = m.promptSuggestions[m.promptSuggestionCursor]
		}
		m.prompting = false
		m.promptText = ""
		m.promptSuggestions = nil
		m.promptSuggestionCursor = 0
		m.promptRun = nil
		if run != nil {
			return m, run(text)
		}
		return m, nil
	case "backspace", "ctrl+h":
		if len(m.promptText) > 0 {
			m.promptText = m.promptText[:len(m.promptText)-1]
		}
		return m, nil
	case "up":
		if len(m.promptSuggestions) > 0 {
			m.promptSuggestionCursor--
			if m.promptSuggestionCursor < 0 {
				m.promptSuggestionCursor = len(m.promptSuggestions) - 1
			}
		}
		return m, nil
	case "down", "tab":
		if len(m.promptSuggestions) > 0 {
			m.promptSuggestionCursor = (m.promptSuggestionCursor + 1) % len(m.promptSuggestions)
			if key == "tab" {
				m.promptText = m.promptSuggestions[m.promptSuggestionCursor]
			}
		}
		return m, nil
	default:
		if len(key) == 1 {
			m.promptText += key
			m.promptSuggestionCursor = -1
		}
		return m, nil
	}
}

func (m *Model) providerDetail(p ProviderRow) string {
	if p.Error != "" {
		return fmt.Sprintf("%s: status unavailable — %s", p.DisplayName, p.Error)
	}
	h := p.Relation.hint()
	if h == "" {
		h = string(p.Relation)
	}
	return fmt.Sprintf("%s · %d saved · %s", p.DisplayName, p.SavedCount, h)
}

func (m *Model) accountDetail(r AccountRow) string {
	parts := []string{r.DisplayName()}
	if r.Identity != "" {
		parts = append(parts, "identity "+identityDisplayText(r.Identity, r.Name))
	}
	if r.Active {
		parts = append(parts, "active")
	}
	if r.ProxyRunning {
		parts = append(parts, "proxy running")
	} else if r.ProxyEnabled {
		parts = append(parts, "proxy stopped")
	}
	if r.UpdatedAt != "" {
		parts = append(parts, "updated "+r.UpdatedAt)
	}
	return strings.Join(parts, " · ")
}

func (m *Model) gatewaysKey(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "a", "d":
		m.status = i18n.T("tui.placeholder.gateway_actions")
		m.statusErr = false
	case "esc":
		m.board = boardApps
		m.cursor = 0
		return m, loadAppsCmd(m.ctx, m.app)
	}
	return m, nil
}

func (m *Model) proxyKey(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "s", "r":
		m.status = i18n.T("tui.placeholder.proxy_actions")
		m.statusErr = false
	case "esc":
		m.board = boardApps
		m.cursor = 0
		return m, loadAppsCmd(m.ctx, m.app)
	}
	return m, nil
}

func (m *Model) updateWizardKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	w := m.wizard
	if w.editingField >= 0 {
		return m.wizardEditKey(msg)
	}
	key := msg.String()

	switch w.step {
	case wizardSource:
		switch key {
		case "up", "k":
			if w.cursor > 0 {
				w.cursor--
			}
		case "down", "j":
			w.cursor = min(w.cursor+1, max(0, len(w.sources)-1))
		case "enter", "l", "right":
			return m.wizardChooseSource()
		case "esc":
			m.wizard = nil
			m.status = ""
		}
	case wizardModels:
		switch key {
		case "up", "k":
			if w.cursor > 0 {
				w.cursor--
			}
		case "down", "j":
			w.cursor = min(w.cursor+1, max(0, len(w.fields)-1))
		case "enter", "l", "right":
			w.editingField = w.cursor
			w.text = m.wizardFieldValue(w.cursor)
		case "a":
			return m.wizardPlan()
		case "esc":
			w.step = wizardSource
			w.cursor = 0
		}
	case wizardPreview:
		switch key {
		case "enter", "l", "right":
			if w.planErr != "" || w.plan == nil {
				return m, nil
			}
			return m, activateWizardCmd(m.ctx, m.app, w.plan)
		case "esc":
			w.step = wizardModels
			w.cursor = 0
		}
	}
	return m, nil
}

func (m *Model) wizardChooseSource() (tea.Model, tea.Cmd) {
	w := m.wizard
	if w.cursor >= len(w.sources) {
		return m, nil
	}
	chosen := w.sources[w.cursor]
	w.chosen = chosen
	w.sourceProvider = m.sourceProviderFor(chosen.Ref)
	native := clientNativeProvider(m.app, w.clientID)
	if chosen.Ref.Kind == refs.KindAccount && chosen.Ref.Provider == native {
		// Native same-provider switch keeps the app's own model picker, so the
		// models step is skipped.
		return m.wizardPlanFrom(chosen.Ref, "", nil)
	}
	w.fields = wizardModelFields(w.clientID)
	w.model = ""
	w.roles = map[string]string{}
	w.cursor = 0
	w.step = wizardModels
	return m, nil
}

// sourceProviderFor resolves a route source to the catalog provider whose
// model list the wizard should surface (ModelsForClient discovery). Gateways
// carry their provider in the profile; accounts pools carry it on the ref.
func (m *Model) sourceProviderFor(ref refs.Ref) string {
	switch ref.Kind {
	case refs.KindGateway:
		if pr, err := m.app.Runtime.ProfileSvc.GetContext(m.ctx, ref.Name); err == nil && pr != nil {
			return pr.Meta.Provider
		}
	case refs.KindAccount, refs.KindAccountPool:
		return ref.Provider
	}
	return ""
}

func wizardModelFields(clientID string) []string {
	if clientID == "claude" {
		return []string{"default", "sonnet", "opus", "haiku"}
	}
	return []string{"default"}
}

func (m *Model) wizardPlan() (tea.Model, tea.Cmd) {
	w := m.wizard
	roles := map[string]string{}
	for _, f := range []string{"sonnet", "opus", "haiku"} {
		if v := w.roles[f]; v != "" {
			roles[f] = v
		}
	}
	w.step = wizardPreview
	w.plan = nil
	w.planErr = ""
	return m, planWizardCmd(m.ctx, m.app, w.clientID, w.chosen.Ref, w.model, roles)
}

func (m *Model) wizardPlanFrom(ref refs.Ref, model string, roles map[string]string) (tea.Model, tea.Cmd) {
	w := m.wizard
	w.step = wizardPreview
	w.plan = nil
	w.planErr = ""
	return m, planWizardCmd(m.ctx, m.app, w.clientID, ref, model, roles)
}

func (m *Model) wizardFieldValue(i int) string {
	w := m.wizard
	if i < 0 || i >= len(w.fields) {
		return ""
	}
	switch w.fields[i] {
	case "default":
		return w.model
	default:
		return w.roles[w.fields[i]]
	}
}

func (m *Model) wizardCommitField() {
	w := m.wizard
	if w.editingField < 0 || w.editingField >= len(w.fields) {
		return
	}
	f := w.fields[w.editingField]
	switch f {
	case "default":
		w.model = w.text
	default:
		w.roles[f] = w.text
	}
}

func (m *Model) wizardEditKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	w := m.wizard
	key := msg.String()
	switch key {
	case "esc":
		w.editingField = -1
		w.text = ""
	case "enter":
		m.wizardCommitField()
		w.editingField = -1
		w.text = ""
	case "backspace", "ctrl+h":
		if len(w.text) > 0 {
			w.text = w.text[:len(w.text)-1]
		}
	default:
		if len(key) == 1 {
			w.text += key
		}
	}
	return m, nil
}
