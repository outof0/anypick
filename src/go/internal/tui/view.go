package tui

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/app"
	"github.com/outof0/anypick/go/internal/catalog"
	"github.com/outof0/anypick/go/internal/doctor"
	"github.com/outof0/anypick/go/internal/i18n"
)

// Styles. Adaptive colors keep the TUI readable on both light and dark
// terminals instead of assuming the developer's theme.
var (
	styleHeader = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "240", Dark: "245"})

	styleSelected = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.AdaptiveColor{Light: "27", Dark: "39"})

	styleDim = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "245", Dark: "243"})

	styleOK = lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "28", Dark: "42"})

	styleWarn = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "130", Dark: "214"})

	styleError = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "124", Dark: "203"})

	styleFooter = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "240", Dark: "245"})
)

// View renders the whole screen. The wizard and help are full-screen takeovers
// so the user never sees a half-rendered board behind an overlay.
func (m *Model) View() string {
	if m.quitting {
		return ""
	}
	if m.wizard != nil {
		return m.viewWizard()
	}
	if m.showHelp {
		return m.viewHelpFull()
	}
	if m.diagnosis != nil {
		return m.viewDiagnosis()
	}

	width := m.width
	if width == 0 {
		width = 80
	}

	var body []string
	var title string
	var hints string
	switch m.board {
	case boardApps:
		title = "anypick / " + i18n.T("tui.board.apps")
		body = m.viewApps()
		hints = i18n.T("tui.hints.apps")
	case boardAccounts:
		title = "anypick / " + i18n.T("tui.board.accounts")
		if m.accountDrill {
			body = m.viewAccounts()
			hints = i18n.T("tui.hints.accounts")
		} else {
			body = m.viewProviders()
			if m.filtering {
				hints = i18n.T("tui.filter.prompt") + m.filterText + i18n.T("tui.filter.help")
			} else {
				hints = i18n.T("tui.hints.filtered_accounts")
			}
		}
	case boardGateways:
		title = "anypick / " + i18n.T("tui.board.gateways")
		body = m.viewGateways()
		hints = i18n.T("tui.hints.secondary_board")
	case boardProxy:
		title = "anypick / " + i18n.T("tui.board.proxy")
		body = m.viewProxies()
		hints = i18n.T("tui.hints.secondary_board")
	}

	var out strings.Builder
	out.WriteString(styleHeader.Render(title))
	out.WriteString("\n\n")

	if len(body) == 0 {
		out.WriteString(styleDim.Render(i18n.T("tui.empty")) + "\n")
	} else {
		visible := m.visibleRows(body)
		out.WriteString(strings.Join(visible, "\n") + "\n")
	}

	if m.board == boardApps && len(m.apps) > 0 {
		out.WriteString(styleDim.Render(dashed(width)) + "\n")
		for _, h := range m.appsHint() {
			out.WriteString(h + "\n")
		}
	}

	out.WriteString("\n" + styleFooter.Render(hints) + "\n")
	out.WriteString(m.footerStatus())
	if m.confirm != nil {
		out.WriteString("\n" + styleWarn.Render(m.confirm.question+" (y/n)") + "\n")
	}
	if m.prompting {
		out.WriteString("\n" + styleSelected.Render(m.promptLabel) + "\n")
		out.WriteString(styleOK.Render(m.promptText+"_") + "\n")
		if len(m.promptSuggestions) > 0 {
			out.WriteString(styleDim.Render(i18n.T("tui.import.file_prompt")) + "\n")
			for i, path := range m.promptSuggestions {
				mark := " "
				if i == m.promptSuggestionCursor {
					mark = "▸"
				}
				line := fmt.Sprintf("%s %s", mark, path)
				if i == m.promptSuggestionCursor {
					out.WriteString(styleSelected.Render(line) + "\n")
				} else {
					out.WriteString(line + "\n")
				}
			}
		} else {
			out.WriteString(styleDim.Render(i18n.T("tui.import.no_files")) + "\n")
		}
	}
	return out.String()
}

// noColor reports whether NO_COLOR is set (plain terminals fall back to
// ASCII glyphs, per docs/guides/terminal-ui.mdx).
func (m *Model) noColor() bool { return os.Getenv("NO_COLOR") != "" }

func glyph(colored, plain string, noColor bool) string {
	if noColor {
		return plain
	}
	return colored
}

func appStatusGlyph(s AppStatus, noColor bool) string {
	switch s {
	case AppReady:
		return glyph("●", "*", noColor)
	case AppNotSet, AppNative:
		return glyph("○", "o", noColor)
	case AppAttention:
		return glyph("◐", "!", noColor)
	case AppFailed:
		return glyph("×", "x", noColor)
	}
	return "?"
}

func dashed(width int) string {
	if width < 4 {
		width = 4
	}
	return strings.Repeat("─", width-4)
}

func clientName(a *app.App, clientID string) string {
	if cad, err := a.Clients.Get(clientID); err == nil {
		return cad.Name()
	}
	return clientID
}

func (m *Model) viewApps() []string {
	noColor := m.noColor()
	nameW := 0
	for _, r := range m.apps {
		nameW = max(nameW, len(r.DisplayName))
	}
	nameW = min(nameW, 16)

	rows := make([]string, 0, len(m.apps))
	for i, r := range m.apps {
		mark := " "
		if i == m.cursor {
			mark = "▸"
		}
		mid := r.SourceText
		if r.ModelText != "" && r.ModelText != "—" {
			mid += " · " + r.ModelText
		}
		line := fmt.Sprintf("%s %-*s %-*s %s %s",
			mark,
			nameW, truncate(r.DisplayName, nameW),
			32, truncate(mid, 32),
			appStatusGlyph(r.Status, noColor),
			translateAppStatus(r.Status))
		if i == m.cursor {
			rows = append(rows, styleSelected.Render(line))
		} else {
			rows = append(rows, line)
		}
	}
	return rows
}

func (m *Model) appsHint() []string {
	if len(m.apps) == 0 || m.cursor >= len(m.apps) {
		return nil
	}
	r := m.apps[m.cursor]
	switch r.Status {
	case AppReady:
		return []string{
			i18n.F("tui.apps.source", r.DisplayName, r.SourceText),
			i18n.F("tui.apps.model_hint", r.ModelText),
		}
	case AppNative:
		return []string{
			i18n.F("tui.apps.native_login", r.DisplayName),
			i18n.T("tui.apps.take_over_hint"),
		}
	default:
		return []string{
			i18n.F("tui.apps.status", r.DisplayName, translateAppStatus(r.Status)),
			i18n.T("tui.apps.connect_hint"),
		}
	}
}

// visibleRows windows the body so a long list cannot push the footer off a
// short terminal. The cursor is kept in view.
func (m *Model) visibleRows(body []string) []string {
	if len(body) == 0 {
		return body
	}
	reserve := 7 // title + blank + footer + status
	limit := m.height - reserve
	if limit < 3 || limit >= len(body) {
		return body
	}
	start := 0
	if m.cursor > limit-2 {
		start = m.cursor - (limit - 2)
	}
	end := min(len(body), start+limit)
	return body[start:end]
}

func (m *Model) footerStatus() string {
	if m.status == "" {
		return ""
	}
	if m.statusErr {
		return styleError.Render("! "+i18n.Text(m.status)) + "\n"
	}
	return styleOK.Render("✓ "+i18n.Text(m.status)) + "\n"
}

func (m *Model) viewProviders() []string {
	nameW, activeW, idW := 0, 0, 0
	for _, p := range m.providers {
		nameW = max(nameW, len(p.DisplayName))
		activeW = max(activeW, len(activeOrDash(p.ActiveName)))
		idW = max(idW, len(p.Identity))
	}
	nameW = min(nameW, columnCap)
	activeW = min(activeW, columnCap)
	idW = min(idW, columnCap)

	rows := make([]string, 0, len(m.providers))
	for i, p := range m.providers {
		mark := " "
		if i == m.cursor {
			mark = "▸"
		}
		line := fmt.Sprintf("%s %-*s %-*s %-*s %s",
			mark,
			nameW, truncate(p.DisplayName, nameW),
			activeW, truncate(activeOrDash(p.ActiveName), activeW),
			idW, truncate(p.Identity, idW),
			i18n.F("tui.provider.saved_count", p.SavedCount))
		if hint := p.Relation.hint(); hint != "" && hint != "no saved logins" {
			line += "  " + styleWarn.Render(i18n.Text(hint))
		}
		if p.ProxyLabel != "" {
			line += "  " + styleDim.Render(p.ProxyLabel)
		}
		if p.Error != "" {
			line += "  " + styleError.Render(i18n.T("tui.provider.status_unavailable"))
		}
		if i == m.cursor {
			rows = append(rows, styleSelected.Render(line))
		} else {
			rows = append(rows, line)
		}
	}
	return rows
}

func (m *Model) viewAccounts() []string {
	now := time.Now()
	nameW, idW := 0, 0
	for _, r := range m.accounts {
		nameW = max(nameW, len(r.DisplayName()))
		idW = max(idW, len(identityDisplayText(r.Identity, "—")))
	}
	nameW = min(nameW, columnCap)
	idW = min(idW, columnCap)

	rows := make([]string, 0, len(m.accounts))
	for i, r := range m.accounts {
		mark := " "
		if i == m.cursor {
			mark = "▸"
		}
		live := "·"
		if r.LiveMatch {
			live = "●"
		}
		active := ""
		if r.Active {
			active = " " + styleSelected.Render(i18n.T("tui.account.active"))
		}
		line := fmt.Sprintf("%s %s %-*s %-*s %s%s",
			mark, live,
			nameW, truncate(r.DisplayName(), nameW),
			idW, truncate(identityDisplayText(r.Identity, "—"), idW),
			formatRelativeTime(r.UpdatedAt, now), active)
		if r.ProxyLabel != "" {
			line += "  " + styleDim.Render(r.ProxyLabel)
		}
		if i == m.cursor {
			rows = append(rows, styleSelected.Render(line))
		} else {
			rows = append(rows, line)
		}
	}
	return rows
}

func (m *Model) viewGateways() []string {
	rows := make([]string, 0, len(m.gateways))
	for i, r := range m.gateways {
		mark := " "
		if i == m.cursor {
			mark = "▸"
		}
		line := fmt.Sprintf("%s %s", mark, r.Name)
		var extra []string
		if r.Provider != "" {
			extra = append(extra, r.Provider)
		}
		if r.DefaultModel != "" {
			extra = append(extra, i18n.T("tui.account.model_prefix")+r.DefaultModel)
		}
		if r.Endpoint != "" {
			extra = append(extra, r.Endpoint)
		}
		if len(extra) > 0 {
			line += "   " + styleDim.Render(strings.Join(extra, " · "))
		}
		if i == m.cursor {
			rows = append(rows, styleSelected.Render(line))
		} else {
			rows = append(rows, line)
		}
	}
	return rows
}

func (m *Model) viewProxies() []string {
	rows := make([]string, 0, len(m.proxies))
	for i, r := range m.proxies {
		mark := " "
		if i == m.cursor {
			mark = "▸"
		}
		status := i18n.T("tui.proxy.stopped")
		if r.Running {
			status = i18n.T("tui.proxy.running_prefix") + r.Endpoint
		} else if r.Enabled {
			status = i18n.T("tui.proxy.enabled_stopped")
		}
		extra := []string{status}
		line := fmt.Sprintf("%s %-20s %s", mark, r.RefText, styleDim.Render(strings.Join(extra, " · ")))
		if i == m.cursor {
			rows = append(rows, styleSelected.Render(line))
		} else {
			rows = append(rows, line)
		}
	}
	return rows
}

func (m *Model) viewWizard() string {
	w := m.wizard
	stepName := map[wizardStep]string{
		wizardSource:  i18n.T("tui.wizard.step.source"),
		wizardModels:  i18n.T("tui.wizard.step.models"),
		wizardPreview: i18n.T("tui.wizard.step.preview"),
	}[w.step]
	title := fmt.Sprintf("anypick / apps / %s / %s", clientName(m.app, w.clientID), stepName)

	var body []string
	switch w.step {
	case wizardSource:
		body = m.viewWizardSource()
	case wizardModels:
		body = m.viewWizardModels()
	case wizardPreview:
		body = m.viewWizardPreview()
	}

	var footer string
	switch w.step {
	case wizardSource:
		footer = i18n.T("tui.wizard.hints.source")
	case wizardModels:
		footer = i18n.T("tui.wizard.hints.models")
	case wizardPreview:
		if w.planErr != "" {
			footer = i18n.T("tui.wizard.hints.back")
		} else {
			footer = i18n.T("tui.wizard.hints.preview")
		}
	}

	var out strings.Builder
	out.WriteString(styleHeader.Render(title))
	out.WriteString("\n\n")
	if len(body) == 0 {
		out.WriteString(styleDim.Render(i18n.T("tui.wizard.no_options")) + "\n")
	} else {
		out.WriteString(strings.Join(body, "\n") + "\n")
	}
	out.WriteString("\n" + styleFooter.Render(footer) + "\n")
	out.WriteString(m.footerStatus())
	return out.String()
}

func (m *Model) viewWizardSource() []string {
	w := m.wizard
	var lines []string
	lastGroup := ""
	for i, o := range w.sources {
		if o.Group != lastGroup {
			lines = append(lines, styleDim.Render(i18n.Text(o.Group)))
			lastGroup = o.Group
		}
		mark := " "
		if i == w.cursor {
			mark = "▸"
		}
		line := fmt.Sprintf("%s %s", mark, o.Label)
		if o.Sub != "" {
			line += "   " + styleDim.Render(o.Sub)
		}
		if i == w.cursor {
			lines = append(lines, styleSelected.Render(line))
		} else {
			lines = append(lines, line)
		}
	}
	return lines
}

func (m *Model) viewWizardModels() []string {
	w := m.wizard
	var lines []string

	// ModelsForClient discovery: surface the real model list for the chosen
	// source so the user can type a valid id instead of guessing.
	if prov := w.sourceProvider; prov != "" {
		if pol := catalog.Policy(prov); pol != nil {
			seen := make(map[string]bool, len(pol.RoleFriendly)+len(pol.StaticFallback))
			var suggested []string
			for _, id := range append(append([]string{}, pol.RoleFriendly...), pol.StaticFallback...) {
				if !seen[id] {
					seen[id] = true
					suggested = append(suggested, id)
				}
			}
			if len(suggested) > 0 {
				line := i18n.T("tui.wizard.available_models") + strings.Join(suggested, ", ")
				if len(line) > 200 {
					line = line[:197] + "…"
				}
				lines = append(lines, styleDim.Render(line))
			}
		}
	}

	for i, f := range w.fields {
		mark := " "
		if i == w.cursor {
			mark = "▸"
		}
		val := w.model
		if f != "default" {
			val = w.roles[f]
		}
		if val == "" && f != "default" {
			val = i18n.T("tui.wizard.same_as_default")
		}
		if i == w.editingField {
			val = "[" + w.text + "_]"
		}
		line := fmt.Sprintf("%s %-8s %s", mark, i18n.Text(f), val)
		if i == w.cursor {
			lines = append(lines, styleSelected.Render(line))
		} else {
			lines = append(lines, line)
		}
	}
	return lines
}

func (m *Model) viewWizardPreview() []string {
	w := m.wizard
	if w.planErr != "" {
		lines := []string{styleError.Render(i18n.T("tui.wizard.plan_error"))}
		for _, line := range strings.Split(w.planErr, "\n") {
			lines = append(lines, styleError.Render("  "+line))
		}
		lines = append(lines, "", styleDim.Render(i18n.T("tui.wizard.back_hint")))
		return lines
	}
	if w.plan == nil {
		return []string{styleDim.Render(i18n.T("tui.wizard.planning"))}
	}
	lines := []string{
		i18n.F("tui.wizard.confirm_activate", clientName(m.app, w.clientID)),
		"",
	}
	for _, s := range w.plan.Steps {
		lines = append(lines, " · "+planStepLabel(s.Kind))
	}
	return lines
}

func planStepLabel(k activation.StepKind) string {
	switch k {
	case activation.StepResolveSource:
		return i18n.T("tui.plan.resolve_source")
	case activation.StepExpandPreset:
		return i18n.T("tui.plan.expand_preset")
	case activation.StepValidateCompatibility:
		return i18n.T("tui.plan.validate_compatibility")
	case activation.StepValidateCredential:
		return i18n.T("tui.plan.validate_credential")
	case activation.StepInspectClientState:
		return i18n.T("tui.plan.inspect_client_state")
	case activation.StepResolveTransport:
		return i18n.T("tui.plan.resolve_transport")
	case activation.StepValidateExternalDep:
		return i18n.T("tui.plan.validate_external_dependency")
	case activation.StepAllocateProxyLease:
		return i18n.T("tui.plan.allocate_proxy_lease")
	case activation.StepStartProxy:
		return i18n.T("tui.plan.start_local_proxy")
	case activation.StepWaitForHealth:
		return i18n.T("tui.plan.wait_proxy_health")
	case activation.StepEnsureProxyHub:
		return i18n.T("tui.plan.ensure_proxy_hub")
	case activation.StepAttachProxyHubRoute:
		return i18n.T("tui.plan.attach_proxy_hub_route")
	case activation.StepWaitForHubHealth:
		return i18n.T("tui.plan.wait_hub_health")
	case activation.StepValidateProxyHubRoute:
		return i18n.T("tui.plan.validate_proxy_hub_route")
	case activation.StepWriteNativeAuth:
		return i18n.T("tui.plan.write_native_auth")
	case activation.StepWriteClientConfig:
		return i18n.T("tui.plan.write_client_config")
	case activation.StepCreateEnvironmentOverlay:
		return i18n.T("tui.plan.create_environment_overlay")
	case activation.StepCreateTempClientHome:
		return i18n.T("tui.plan.create_temporary_client_home")
	case activation.StepVerifyEffectiveState:
		return i18n.T("tui.plan.verify_effective_state")
	case activation.StepCommitGlobalBinding:
		return i18n.T("tui.plan.commit_global_binding")
	case activation.StepCommitProjectBinding:
		return i18n.T("tui.plan.commit_project_binding")
	case activation.StepSpawnChild:
		return i18n.T("tui.plan.spawn_managed_client")
	case activation.StepReleaseLease:
		return i18n.T("tui.plan.release_proxy_lease")
	case activation.StepRestoreTemporaryState:
		return i18n.T("tui.plan.restore_temporary_state")
	}
	return strings.ToLower(string(k))
}

// viewDiagnosis is the read-only health report overlay for one routing client
// (the Apps board "d diagnose"). It dismisses on any key, so it is a full
// takeover like help — the underlying board is not half-rendered behind it.
func (m *Model) viewDiagnosis() string {
	rep := m.diagnosis
	if rep == nil {
		return ""
	}

	// Every branch assigns style, so it needs no zero value here — giving it
	// one is dead code staticcheck flags.
	label := ""
	var style lipgloss.Style
	switch rep.Status {
	case doctor.StatusOK:
		label, style = i18n.T("tui.diagnosis.healthy"), styleOK
	case doctor.StatusDegraded:
		label, style = i18n.T("tui.diagnosis.needs_attention"), styleWarn
	case doctor.StatusUnhealthy:
		label, style = i18n.T("tui.diagnosis.unhealthy"), styleError
	default:
		label, style = i18n.T("tui.app_status.not_connected"), styleDim
	}

	var out strings.Builder
	out.WriteString(styleHeader.Render("anypick / "+i18n.T("tui.board.diagnose")+" / "+clientName(m.app, rep.ClientID)) + "  ")
	out.WriteString(style.Render(label) + "\n\n")

	if len(rep.Findings) == 0 {
		out.WriteString(styleDim.Render(i18n.T("tui.diagnosis.no_checks")) + "\n")
	}
	for _, f := range rep.Findings {
		var g string
		switch f.Status {
		case "ok":
			g = styleOK.Render("✓")
		case "warn":
			g = styleWarn.Render("!")
		case "fail":
			g = styleError.Render("×")
		default:
			g = styleDim.Render("·")
		}
		line := fmt.Sprintf("  %s %s", g, translateDiagnosisCheck(f.Check))
		if f.Detail != "" {
			line += " — " + f.Detail
		}
		out.WriteString(line + "\n")
	}

	out.WriteString("\n" + styleFooter.Render(i18n.T("tui.dismiss_hint")) + "\n")
	return out.String()
}

func translateAppStatus(status AppStatus) string {
	switch status {
	case AppReady:
		return i18n.T("tui.app_status.ready")
	case AppNative:
		return i18n.T("tui.app_status.native")
	case AppNotSet:
		return i18n.T("tui.app_status.not_set")
	case AppAttention:
		return i18n.T("tui.app_status.attention")
	case AppFailed:
		return i18n.T("tui.app_status.failed")
	default:
		return string(status)
	}
}

func translateDiagnosisCheck(check string) string {
	// Check labels are stable product copy; finding details can contain paths,
	// account names, or values read from a user's config and stay verbatim.
	switch check {
	case "client":
		return i18n.T("tui.diagnosis.check.client")
	case "route":
		return i18n.T("tui.diagnosis.check.route")
	case "proxy":
		return i18n.T("tui.diagnosis.check.proxy")
	default:
		return i18n.Text(check)
	}
}

func (m *Model) viewHelpFull() string {
	lines := []string{
		"",
		i18n.T("tui.help.title"),
		"",
		i18n.T("tui.help.apps"),
		i18n.T("tui.help.accounts"),
		i18n.T("tui.help.gateways"),
		i18n.T("tui.help.proxy"),
		"",
		i18n.T("tui.help.navigation"),
		i18n.T("tui.help.activate"),
		i18n.T("tui.help.shortcuts"),
		i18n.T("tui.help.quit"),
		"",
		i18n.T("tui.help.proxy_secrets"),
	}
	var out strings.Builder
	out.WriteString(styleHeader.Render("anypick / help") + "\n\n")
	out.WriteString(strings.Join(lines, "\n") + "\n")
	return out.String()
}

// columnCap stops one long value from pushing the remaining columns off a
// narrow terminal. Values longer than the cap are truncated, not wrapped.
const columnCap = 28

func truncate(s string, width int) string {
	r := []rune(s)
	if len(r) <= width {
		return s
	}
	if width <= 1 {
		return string(r[:width])
	}
	return string(r[:width-1]) + "…"
}

func activeOrDash(name string) string {
	if name == "" {
		return "—"
	}
	return name
}
