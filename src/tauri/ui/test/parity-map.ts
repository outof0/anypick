/**
 * The macOS to Tauri feature map. One row per macOS feature.
 *
 * "The port is complete" is not something this file can prove on its own, so
 * every macOS feature has to be pointed at the Tauri element that carries it,
 * or written down as deliberately out of scope. A feature with no row fails
 * `test/parity.test.ts`. That is the whole point: the map is the work list, and
 * it cannot go green by accident.
 *
 * `status` is the port's progress, per row:
 *   `done`  — the Tauri element exists and is named here.
 *   `todo`  — macOS has it, Tauri does not. These are the work.
 *   `skip`  — deliberately out of scope, with a reason that must be a reason.
 */

export interface ParityRow {
  /** The macOS `accessibilityIdentifier`, interpolation normalized to `{x}`. */
  macos: string;
  /** The Tauri `data-testid` that carries it. Empty when `status` is not `done`. */
  tauri: string;
  status: 'done' | 'todo' | 'skip';
  /** Required when `status` is `skip`. A platform fact, never "later". */
  reason?: string;
}

export const PARITY: ParityRow[] = [
  // ── Sidebar / shell ────────────────────────────────────────────────────────
  { macos: 'sidebar.navigation', tauri: 'sidebar-navigation', status: 'done' },
  { macos: 'sidebar.{x}', tauri: 'sidebar-{x}', status: 'done' },
  { macos: 'sidebar.service-status', tauri: 'sidebar-service-status', status: 'done' },

  // ── View state ─────────────────────────────────────────────────────────────
  { macos: 'state.loading', tauri: 'state.loading', status: 'done' },
  // One row-level placeholder, not the whole EmptyState: macOS names the bare
  // "nothing here" line, which is a different control from the titled panel.
  { macos: 'state.empty-row', tauri: 'state.empty-row', status: 'done' },
  { macos: 'state.error', tauri: 'state.error', status: 'done' },

  // ── Overview ───────────────────────────────────────────────────────────────
  { macos: 'overview.degraded-conditions', tauri: 'degraded-{x}', status: 'done' },
  { macos: 'overview.get-started', tauri: 'overview-get-started', status: 'done' },
  { macos: 'overview.doctor', tauri: 'overview-doctor', status: 'done' },
  { macos: 'overview.app.{x}', tauri: 'overview.app.{x}', status: 'done' },
  // Three rows, then a way to the rest: the pane is a summary, and listing
  // every app made it a second Apps pane.
  { macos: 'overview.apps.see-all', tauri: 'overview.apps.see-all', status: 'done' },
  { macos: 'overview.review-attention', tauri: 'overview-attention', status: 'done' },
  { macos: 'overview.run-doctor', tauri: 'overview.run-doctor', status: 'done' },
  { macos: 'overview.doctor-error', tauri: 'overview.doctor-error', status: 'done' },
  { macos: 'overview.doctor-summary', tauri: 'overview.doctor-summary', status: 'done' },
  { macos: 'overview.doctor-finding.{x}', tauri: 'overview.doctor-finding.{x}', status: 'done' },
  { macos: 'overview.services-summary', tauri: 'overview-services', status: 'done' },
  { macos: 'overview.activity.{x}', tauri: 'overview-activity-{x}', status: 'done' },
  { macos: 'overview.hide-onboarding', tauri: 'overview.hide-onboarding', status: 'done' },
  { macos: 'overview.onboarding.choose-route', tauri: 'onboarding-choose-route', status: 'done' },
  { macos: 'overview.onboarding.save-login', tauri: 'onboarding-save-login', status: 'done' },
  { macos: 'overview.onboarding.proxy-hub', tauri: 'onboarding-hub', status: 'done' },
  { macos: 'overview.onboarding.use-app', tauri: 'onboarding-use-app', status: 'done' },

  // ── Apps ───────────────────────────────────────────────────────────────────
  { macos: 'apps.list', tauri: 'apps', status: 'done' },
  // The id is the *app*, not the route: macOS has one row per app and the
  // routes live in its menu, so a route-per-row Tauri id would be claiming
  // coverage of a shape this app deliberately does not have.
  { macos: 'apps.row.{x}', tauri: 'apps-row-{x}', status: 'done' },
  { macos: 'apps.add', tauri: 'apps.add', status: 'done' },
  { macos: 'apps.empty.add', tauri: 'apps.empty.add', status: 'done' },
  // macOS keeps these in the row's context menu (`AppsView.swift:96`), so the
  // Tauri row keeps them in its menu too rather than trailing five buttons.
  { macos: 'app.reset', tauri: 'app.disconnect-menu', status: 'done' },
  // Which apps are the user's is a local preference, not engine state: macOS
  // keeps it in `AppPreferences`, and so does the webview.
  { macos: 'app.remove', tauri: 'app.remove-menu', status: 'done' },
  // One radio per supported app rather than one picker: macOS lists each option
  // with its one-line description, which a collapsed dropdown would hide.
  { macos: 'app.add.picker', tauri: 'app.add.picker-{x}', status: 'done' },
  // Every row carries a Change… button, so one open sheet can change any app's
  // connection. macOS reaches the same sheet from the app detail pane instead.
  { macos: 'app.connection.change', tauri: 'app.connection.change-menu', status: 'done' },
  { macos: 'app.connection.disconnect', tauri: 'app.disconnect-menu', status: 'done' },
  // macOS pushes a models sheet from the app's detail pane. The model pickers
  // already live in two places here — the connection sheet's last stage and the
  // Apps pane's own Models group — so this row is the pane's Manage button.
  { macos: 'app.models.manage', tauri: 'app.models.manage', status: 'done' },
  { macos: 'app.models.refresh', tauri: 'apps-refresh-menu', status: 'done' },
  { macos: 'app.models.reset', tauri: 'models-reset-{x}', status: 'done' },
  { macos: 'app.usage.{x}', tauri: 'apps-quota-{x}-{x}', status: 'done' },
  // A refused pin needs an owner for its answer: without a registered
  // `model-roles` flight the result frame could not be told from a snapshot
  // refresh, so the sheet closed on a command the engine had refused.
  { macos: 'app-models.error', tauri: 'app-models.error', status: 'done' },
  { macos: 'app-route.search', tauri: 'app-route.search', status: 'done' },
  { macos: 'app-route.option.{x}', tauri: 'app-route.option.{x}', status: 'done' },
  { macos: 'app-route.stage.{x}', tauri: 'app-route.stage.{x}', status: 'done' },
  // The apply review lists what AnyPick will do. The engine's failure, if the
  // write is refused, arrives as a result frame in the notice banner; a second
  // copy inside the sheet would say the same thing twice.
  { macos: 'app-route.apply-error', tauri: '', status: 'skip', reason: 'A refused apply arrives as a result frame and is shown once in the notice banner. A second slot inside the sheet would duplicate it.' },
  { macos: 'app-route.models.error', tauri: 'app-route.models.error', status: 'done' },
  { macos: 'models.scope', tauri: 'models-scope-{x}', status: 'done' },

  // ── Codex profiles ─────────────────────────────────────────────────────────
  { macos: 'codex-profile.row.{x}', tauri: 'codex-profile-{x}', status: 'done' },
  { macos: 'codex-profile.add', tauri: 'codex-profile.add', status: 'done' },
  { macos: 'codex-profile.name', tauri: 'codex-profile-name', status: 'done' },
  { macos: 'codex-profile.copy.{x}', tauri: 'codex-profile.copy.{x}', status: 'done' },
  { macos: 'codex-profile.more.{x}', tauri: 'codex-profile.more.{x}', status: 'done' },
  { macos: 'codex-profile.create-missing', tauri: 'codex-profile.create-missing', status: 'done' },
  { macos: 'codex-profile.source', tauri: 'codex-profile.source', status: 'done' },
  { macos: 'codex-profile.model', tauri: 'codex-profile.model', status: 'done' },
  { macos: 'codex-profile.transport', tauri: 'codex-profile.transport', status: 'done' },

  // ── Accounts ───────────────────────────────────────────────────────────────
  // A menu, not a segmented control: the option list grows with the number of
  // saved providers, and six segments would be wider than the pane.
  { macos: 'accounts.filter', tauri: 'accounts.filter', status: 'done' },
  { macos: 'accounts.save-login', tauri: 'accounts-add', status: 'done' },
  { macos: 'accounts.add-gateway', tauri: 'accounts.add-gateway', status: 'done' },
  { macos: 'accounts.inspector.make-current', tauri: 'accounts.inspector.make-current', status: 'done' },
  { macos: 'accounts.inspector.test', tauri: 'accounts.inspector.test', status: 'done' },
  { macos: 'accounts.inspector.remove', tauri: 'accounts.inspector.remove', status: 'done' },
  { macos: 'accounts.row.{x}', tauri: 'accounts.row.{x}', status: 'done' },
  { macos: 'accounts.inspector.usage.{x}', tauri: 'accounts-inspector.usage.{x}', status: 'done' },
  { macos: 'accounts.more.{x}', tauri: 'accounts.more.{x}', status: 'done' },
  { macos: 'account.usage.{x}', tauri: 'accounts-inspector.usage.{x}', status: 'done' },
  { macos: 'account-inspect.edit', tauri: 'account-inspect.edit', status: 'done' },
  // macOS interpolates the row key: `hub.account.<id>.error` on an account row
  // and `hub.strategy.<hub>.error` on a rotation row. Each row's own id carries
  // it, because a banner would not say which switch is in a state the user did
  // not choose.
  { macos: '{x}.error', tauri: 'hub.account.{x}.error', status: 'done' },

  // ── Add Account flow ───────────────────────────────────────────────────────
  // One sheet, one provider, one source. The source is a segmented control
  // because macOS uses `.pickerStyle(.segmented)` for it, and the fields below
  // are the ones the chosen source needs.
  { macos: 'account-flow.source', tauri: 'account-flow.source.picker', status: 'done' },
  { macos: 'account-flow.provider', tauri: 'account-flow.provider.picker', status: 'done' },
  { macos: 'account-flow.local-source', tauri: 'account-flow.local-source.picker', status: 'done' },
  { macos: 'account-flow.method', tauri: 'account-flow.method.picker', status: 'done' },
  { macos: 'account-flow.identity', tauri: 'account-flow.identity', status: 'done' },
  { macos: 'account-flow.detect', tauri: 'account-flow.detect', status: 'done' },
  { macos: 'account-flow.clear', tauri: 'account-flow.clear', status: 'done' },
  { macos: 'account-flow.sign-out', tauri: 'account-flow.sign-out', status: 'done' },
  { macos: 'account-flow.blocker', tauri: 'account-flow.blocker', status: 'done' },
  { macos: 'account-flow.name', tauri: 'account-flow.name', status: 'done' },
  { macos: 'account-flow.error', tauri: 'account-flow.error', status: 'done' },
  // The Add Account sheet's primary action is unnamed on macOS, which
  // identifies its inputs instead. The Tauri sheet gives the button an id, and
  // its label says what it will do rather than what the sheet is called.
  { macos: 'account-flow.api-key', tauri: 'account-flow.api-key.input', status: 'done' },
  { macos: 'account-flow.toggle-key-visibility', tauri: 'account-flow.api-key.reveal', status: 'done' },
  { macos: 'account-flow.credential-kind', tauri: 'account-flow.credential-kind.picker', status: 'done' },
  // Paste the provider's own auth file. Both sheets keep the document out of
  // the mutate line and send a temp-file path instead.
  { macos: 'account-flow.auth-json', tauri: 'account-flow.auth-json.input', status: 'done' },
  { macos: 'account-flow.credential-profile', tauri: 'account-flow.credential-profile.picker', status: 'done' },
  { macos: 'account-flow.cloudflare-routing', tauri: 'account-flow.cloudflare-routing.input', status: 'done' },
  { macos: 'account-flow.cloudflare-hint', tauri: 'account-flow.cloudflare-hint', status: 'done' },
  // The plan-status warning comes from the ZCode app own cache, which the
  // webview cannot read, so the Tauri shell answers with `zcode_context`.
  { macos: 'account-flow.zcode-hint', tauri: 'account-flow.zcode-hint', status: 'done' },
  { macos: 'account-edit.name', tauri: 'account-edit-label', status: 'done' },
  { macos: 'account-edit.error', tauri: 'account-edit-label', status: 'done' },

  // ── Gateways ───────────────────────────────────────────────────────────────
  // macOS separates the sheet's own Test Connection control from the
  // already-saved row's Refresh. Both send `gateway-test`; they differ in
  // which arguments they carry, so the saved row is its own feature.
  { macos: 'gateway-flow.test', tauri: 'gateway-flow.test', status: 'done' },
  { macos: 'gateway-flow.name', tauri: 'gateway-flow.name', status: 'done' },
  // The sheet's provider picker, reached through the `Add Gateway` button rather
  // than from a picker the user has to find first.
  { macos: 'gateway-flow.provider', tauri: 'gateway-flow.provider.picker', status: 'done' },
  { macos: 'gateway-flow.api-key', tauri: 'gateway-flow.api-key', status: 'done' },
  { macos: 'gateway-flow.toggle-key-visibility', tauri: 'gateway-flow.api-key.reveal', status: 'done' },
  { macos: 'gateway-flow.account-id', tauri: 'gateway-flow.account-id', status: 'done' },
  { macos: 'gateway-flow.gateway-id', tauri: 'gateway-flow.gateway-id', status: 'done' },
  // A provider that publishes its own base shows it read-only; one that publishes
  // none asks for a URL. Both are this row.
  { macos: 'gateway-flow.endpoint', tauri: 'gateway-flow.endpoint', status: 'done' },
  // The connection row is the test's answer, not a second dialog: the result
  // decides whether the endpoint on screen works.
  { macos: 'gateway-flow.testing', tauri: 'gateway-flow.testing', status: 'done' },
  { macos: 'gateway-flow.available', tauri: 'gateway-flow.available', status: 'done' },
  { macos: 'gateway-flow.unavailable', tauri: 'gateway-flow.unavailable', status: 'done' },
  { macos: 'gateway-connect.app.{x}', tauri: 'gateway-connect-app-{x}', status: 'done' },

  // ── Proxy Hub ──────────────────────────────────────────────────────────────
  { macos: 'hub.service-actions', tauri: 'hub.service-actions', status: 'done' },
  { macos: 'hub.copy-address', tauri: 'hub.copy-address', status: 'done' },
  { macos: 'hub.copy-api-key', tauri: 'hub.copy-api-key', status: 'done' },
  { macos: 'hub.rotate-api-key', tauri: 'hub-rotate-api-key', status: 'done' },
  { macos: 'hub.models', tauri: 'hub.models', status: 'done' },
  { macos: 'hub.conflict.{x}', tauri: 'hub.conflict.{x}', status: 'done' },
  { macos: 'hub.conflict.{x}.picker', tauri: 'hub.conflict.{x}.picker', status: 'done' },
  { macos: 'hub.conflict.{x}.error', tauri: '', status: 'skip', reason: 'The picker is disabled while a choice is in flight and the engine\'s failure arrives as a result frame in the notice banner. A per-row error slot would duplicate it.' },
  // macOS emits `hub.strategy.<hub>` per row and the bare `hub.strategy` when
  // there is only one hub. Both name the same control.
  { macos: 'hub.strategy', tauri: 'hub.strategy.{x}', status: 'done' },
  { macos: 'hub.strategy.{x}', tauri: 'hub.strategy.{x}', status: 'done' },
  { macos: 'hub.account.{x}', tauri: 'hub.account.{x}', status: 'done' },
  // macOS gives the rotation toggle its own id and renders it in the Strategy
  // group. Here the segmented control carries that state instead, because a hub
  // always has a strategy and a switch cannot say which one is selected.
  { macos: 'hub.rotation.{x}', tauri: 'hub.strategy.{x}', status: 'done' },
  // The per-model routing picker on the hub pane. Distinct from the conflict
  // picker: this one picks an owner for one model, not for an overlap group.
  // Published Models carries the same control per row and reaches it from here.
  { macos: 'hub.model-route.{x}', tauri: 'published-models.row-picker-{x}', status: 'done' },

  // ── Published models ───────────────────────────────────────────────────────
  // Reached from the hub's Published Models row and the proxies hub summary.
  // Not a sidebar destination: macOS pushes it onto the detail stack, so here
  // the shell owns the route and the sidebar cannot select it.
  { macos: 'published-models.vendor-picker', tauri: 'published-models.vendor-picker', status: 'done' },
  { macos: 'published-models.group.{x}', tauri: 'published-models.group-{x}', status: 'done' },
  { macos: 'published-models.row.{x}', tauri: 'published-models.row-{x}', status: 'done' },
  { macos: 'published-models.row-picker.{x}', tauri: 'published-models.row-picker-{x}', status: 'done' },
  { macos: 'published-models.switch-row.{x}', tauri: 'published-models.row-{x}', status: 'done' },
  { macos: 'published-models.switch-picker.{x}', tauri: 'published-models.row-picker-{x}', status: 'done' },
  { macos: 'published-models.switch-inspect.{x}', tauri: 'published-models.inspect-{x}', status: 'done' },
  { macos: 'published-models.inspect.{x}', tauri: 'published-models.inspect-{x}', status: 'done' },
  { macos: 'published-models.inspect-route.{x}', tauri: 'published-models.inspect-route', status: 'done' },
  { macos: 'published-models.conflict.{x}', tauri: 'published-models.conflict-{x}', status: 'done' },
  { macos: 'published-models.conflict.{x}.picker', tauri: 'published-models.conflict-{x}.picker', status: 'done' },
  // The picker's failure arrives as a result frame and is shown once in the
  // notice banner. A per-row slot would show it twice.
  {
    macos: 'published-models.conflict.{x}.error',
    tauri: '',
    status: 'skip',
    reason: 'The engine failure arrives as a result frame in the notice banner. A per-row error slot would duplicate it.',
  },
  { macos: 'model-inspect.copy-curl', tauri: 'model-inspect.copy-curl', status: 'done' },
  { macos: 'model-inspect.copy-{x}', tauri: 'model-inspect.copy-{x}', status: 'done' },
  { macos: 'published-models.copy.{x}', tauri: 'published-models.copy-{x}', status: 'done' },

  // ── Proxies ────────────────────────────────────────────────────────────────
  { macos: 'proxies.row.{x}', tauri: 'proxy-{x}', status: 'done' },
  // macOS emits this id on the list row and `proxies.inspector.lifecycle` on the
  // detail, for the same Start/Stop command. One Tauri control serves both, so
  // both rows point at it rather than adding a button that sends the same
  // command twice.
  { macos: 'proxies.row-action.{x}', tauri: 'proxies.row-action.{x}', status: 'done' },
  { macos: 'proxies.inspector.lifecycle', tauri: 'proxies.row-action.{x}', status: 'done' },
  { macos: 'proxies.hub-summary', tauri: 'proxies-hub-summary', status: 'done' },
  { macos: 'proxies.start-all', tauri: 'proxies-start-all', status: 'done' },
  { macos: 'proxies.restart', tauri: 'proxies-restart', status: 'done' },
  { macos: 'proxies.stop-all', tauri: 'proxies-stop-all', status: 'done' },
  { macos: 'proxies.inspector.restart', tauri: 'proxies.inspector.restart-{x}', status: 'done' },
  { macos: 'proxies.inspector.address', tauri: 'proxies.inspector.address', status: 'done' },
  { macos: 'proxies.inspector.copy', tauri: 'proxies.inspector.copy-{x}', status: 'done' },
  { macos: 'proxies.inspector.copy-key', tauri: 'proxies.inspector.copy-key-{x}', status: 'done' },
  { macos: 'proxies.inspector.rotate-key', tauri: 'proxies.inspector.rotate-key-{x}', status: 'done' },
  {
    macos: 'sheet.cancel',
    tauri: '',
    status: 'skip',
    reason: 'A shared component parameter for the sheet Cancel button. Every sheet is one Dialog, so one row would claim all of them; each sheet\'s own trailing button is covered by its feature row.',
  },

  // ── Activity ───────────────────────────────────────────────────────────────
  { macos: 'activity.header', tauri: 'activity', status: 'done' },
  { macos: 'activity.events.well', tauri: 'activity-list', status: 'done' },
  { macos: 'activity.event.{x}', tauri: 'activity.event-{x}', status: 'done' },
  { macos: 'activity.logs.{x}', tauri: 'activity.logs', status: 'done' },
  { macos: 'activity.mode', tauri: 'activity-mode', status: 'done' },
  { macos: 'activity.mode.picker', tauri: 'activity-mode.picker', status: 'done' },
  { macos: 'activity.logs.filter', tauri: 'activity.logs.filter', status: 'done' },
  { macos: 'activity.clear-log', tauri: 'activity-clear-log', status: 'done' },
  { macos: 'activity.clear-events', tauri: 'activity-clear-events', status: 'done' },
  { macos: 'activity.logs.live', tauri: 'activity.logs.live', status: 'done' },
  { macos: 'activity.logs.loading', tauri: 'activity.log-source', status: 'done' },

  // ── Backups ────────────────────────────────────────────────────────────────
  { macos: 'backups.choose-accounts', tauri: 'backups-create', status: 'done' },
  { macos: 'backups.import', tauri: 'backups-import', status: 'done' },
  // macOS keeps the reviewed-backup inventory in `ProductionModel.backups`,
  // which it initialises empty and only the design fixture ever fills — the
  // engine publishes no backup list. So this row cannot exist in either app
  // until the engine grows one; the Tauri rows `backup-entry-<id>` are the
  // import *review*, a different list.
  {
    macos: 'backups.inventory.{x}',
    tauri: '',
    status: 'skip',
    reason: 'No engine field. macOS\'s own production model initialises `backups` empty and never populates it, so the row renders in neither app. The Tauri rows `backup-entry-<id>` are the import review, not this inventory.',
  },
  { macos: 'backups.inspection.{x}', tauri: 'backup-review', status: 'done' },
  // Tauri keeps the reviewed file's commands in the same row menu; the
  // engine does not publish the separate macOS backup inventory.
  { macos: 'backups.more.{x}', tauri: 'backups.more-menu', status: 'done' },
  { macos: 'backup-create.account.{x}', tauri: 'backup-account-{x}', status: 'done' },
  { macos: 'backup-restore.account.{x}', tauri: 'backup-entry-{x}', status: 'done' },

  // ── Settings ───────────────────────────────────────────────────────────────
  { macos: 'settings.pane', tauri: 'settings-pane', status: 'done' },
  { macos: 'settings.open-at-login', tauri: 'setting-{x}', status: 'done' },
  { macos: 'settings.start-enabled-proxies', tauri: 'setting-{x}', status: 'done' },
  { macos: 'settings.show-usage', tauri: 'setting-{x}', status: 'done' },
  { macos: 'settings.quota-guard', tauri: 'setting-{x}', status: 'done' },
  { macos: 'settings.language', tauri: 'settings.language', status: 'done' },
  { macos: 'settings.show-getting-started', tauri: 'settings.show-getting-started', status: 'done' },
  // This release's update surface is macOS-only. Tauri has no updater
  // endpoint/signing key configured; Windows and Linux use their package
  // managers or the GitHub Release assets.
  { macos: 'settings.updates.changelog', tauri: '', status: 'skip', reason: 'The Tauri updater endpoint and signing key are not configured; Windows and Linux use package managers or GitHub Release assets.' },
  { macos: 'settings.updates.check', tauri: '', status: 'skip', reason: 'The Tauri updater endpoint and signing key are not configured; Windows and Linux use package managers or GitHub Release assets.' },
  { macos: 'settings.updates.command', tauri: '', status: 'skip', reason: 'The Tauri updater endpoint and signing key are not configured; Windows and Linux use package managers or GitHub Release assets.' },
  { macos: 'settings.updates.copy-command', tauri: '', status: 'skip', reason: 'The Tauri updater endpoint and signing key are not configured; Windows and Linux use package managers or GitHub Release assets.' },
  { macos: 'settings.updates.current', tauri: '', status: 'skip', reason: 'The Tauri updater endpoint and signing key are not configured; Windows and Linux use package managers or GitHub Release assets.' },
  { macos: 'settings.updates.download', tauri: '', status: 'skip', reason: 'The Tauri updater endpoint and signing key are not configured; Windows and Linux use package managers or GitHub Release assets.' },
  { macos: 'settings.updates.latest', tauri: '', status: 'skip', reason: 'The Tauri updater endpoint and signing key are not configured; Windows and Linux use package managers or GitHub Release assets.' },
  { macos: 'settings.updates.message', tauri: '', status: 'skip', reason: 'The Tauri updater endpoint and signing key are not configured; Windows and Linux use package managers or GitHub Release assets.' },
  { macos: 'settings.updates.progress', tauri: '', status: 'skip', reason: 'The Tauri updater endpoint and signing key are not configured; Windows and Linux use package managers or GitHub Release assets.' },
  { macos: 'settings.updates.retry', tauri: '', status: 'skip', reason: 'The Tauri updater endpoint and signing key are not configured; Windows and Linux use package managers or GitHub Release assets.' },
  { macos: 'settings.updates.reveal', tauri: '', status: 'skip', reason: 'The Tauri updater endpoint and signing key are not configured; Windows and Linux use package managers or GitHub Release assets.' },
  { macos: 'settings.updates.view-on-github', tauri: '', status: 'skip', reason: 'The Tauri updater endpoint and signing key are not configured; Windows and Linux use package managers or GitHub Release assets.' },

  // ── Menu bar ───────────────────────────────────────────────────────────────
  {
    macos: 'menu.open',
    tauri: '',
    status: 'skip',
    reason: 'MenuBarExtra Quick Panel action. Tauri has a native application menu, not this separate AppKit panel.',
  },
  {
    macos: 'menu.quit',
    tauri: '',
    status: 'skip',
    reason: 'Quick Panel action. Tauri provides the platform Quit menu command, not a matching Quick Panel row.',
  },
];

/**
 * The macOS menu-bar Quick Panel has no Tauri counterpart and is not getting
 * one: it is a `MenuBarExtra(.window)` AppKit surface with an `NSAlert` quit
 * and `⌘K`/`⌘O` shortcuts. Tauri ships a system tray, which is a different
 * surface with a different affordance. Each entry below is a platform fact,
 * not a deferral.
 */
export const OUT_OF_SCOPE = new Map<string, string>([
  ['tray.', 'MenuBarExtra(.window) AppKit surface. Tauri ships a system tray, not this window.'],
]);
