import AppKit
import SwiftUI

/// Power Quick Panel (board 29 / `d8hjQE`) — Ready, Attention, Use With, First Run.
struct MenuBarMenu: View {
  @ObservedObject var model: MacOSDesignModel
  var openMainWindow: (() -> Void)? = nil
  @Environment(\.openWindow) private var openWindow
  @State private var jump = ""
  @State private var useWithAppID: String?
  @State private var dismissedAttentionKeys = AppPreferences.dismissedAttentionKeys
  @FocusState private var jumpFocused: Bool

  private var primaryApps: [DesignApp] {
    trayPrimaryApps(from: model.quickPanelApps)
  }

  private var otherApps: [DesignApp] {
    trayOtherApps(from: model.quickPanelApps)
  }

  private var visibleAttentionItems: [TrayAttentionItem] {
    trayAttentionItems(from: model).filter { !dismissedAttentionKeys.contains(attentionDismissKey($0)) }
  }

  private var attentionNotice: TrayAttentionItem? {
    visibleAttentionItems.first
  }

  private var scene: DesignTrayScene {
    if useWithAppID != nil { return .useWith }
    switch model.trayScene {
    case .auto:
      if model.apps.isEmpty && model.accounts.isEmpty { return .firstRun }
      // Count what the tray shows: dismissed notices must not hold the
      // scene in attention behind the tray's back.
      return visibleAttentionItems.isEmpty ? .ready : .attention
    default:
      return model.trayScene
    }
  }

  private var needsAttention: Bool { scene == .attention }

  private var reviewCount: Int {
    visibleAttentionItems.count
  }

  private var runningProxyCount: Int { model.proxies.filter { $0.status == .running }.count }

  private var stoppedProxyCount: Int { model.proxies.filter { $0.status == .stopped }.count }

  private var attentionProxyCount: Int {
    model.proxies.filter { $0.status == .attention || $0.status == .unavailable }.count
  }

  private var searchQuery: String {
    jump.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var searchResults: [TraySearchResult] {
    let query = searchQuery
    guard !query.isEmpty else { return [] }

    var results = model.quickPanelApps.compactMap { app -> TraySearchResult? in
      let routeTerms = app.routeOptions.flatMap { [$0.name, $0.detail] }
      guard matchesSearch([app.name, app.detail] + routeTerms, query: query) else { return nil }
      return TraySearchResult(
        id: "app:\(app.id)",
        title: app.name,
        detail: app.detail,
        symbol: app.symbol,
        provider: app.id,
        target: .app(app.id)
      )
    }

    results += model.accounts.compactMap { account -> TraySearchResult? in
      guard
        matchesSearch(
          [account.name, account.detail, account.provider, account.kind.rawValue],
          query: query
        )
      else { return nil }
      return TraySearchResult(
        id: "account:\(account.id)",
        title: account.name,
        detail: [account.provider, account.detail].filter { !$0.isEmpty }.joined(separator: " · "),
        symbol: account.symbol,
        provider: account.provider,
        target: .destination(.accounts)
      )
    }

    results += DesignDestination.trayCases.compactMap { destination -> TraySearchResult? in
      let localizedTitle = model.localized(destination.messageKey)
      guard matchesSearch([localizedTitle], query: query) else {
        return nil
      }
      return TraySearchResult(
        id: "destination:\(destination.id)",
        title: localizedTitle,
        detail: model.localized("desktop.menu_bar.open_in_anypick"),
        symbol: destination.symbol,
        provider: nil,
        target: .destination(destination)
      )
    }

    return Array(results.prefix(12))
  }

  var body: some View {
    Group {
      switch scene {
      case .firstRun:
        firstRunBody
      case .useWith:
        if let appID = useWithAppID ?? model.trayUseWithAppID {
          MenuBarUseWithSheet(
            model: model,
            appID: appID,
            onDismiss: dismissUseWith,
            openDestination: open,
            openMainWindow: { open(nil) },
            quit: quit
          )
        }
      default:
        readyOrAttention
      }
    }
    .padding(scene == .firstRun ? 12 : 8)
    .frame(width: 336, alignment: .leading)
    .onAppear {
      if model.trayScene == .useWith {
        useWithAppID = model.trayUseWithAppID ?? "codex"
      }
    }
  }

  private var firstRunBody: some View {
    VStack(alignment: .leading, spacing: 9) {
      MenuBarFirstRun(model: model) {
        model.requestAddLogin()
        open(nil)
      }
      trayFooterHairline
      homeFooter()
    }
  }

  private var readyOrAttention: some View {
    VStack(alignment: .leading, spacing: 7) {
      searchField
      statusRow
      if let item = attentionNotice {
        MenuBarAttentionNotice(
          item: item,
          extraCount: max(reviewCount - 1, 0),
          onDismiss: { dismissAttentionNotice(item) }
        )
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 7) {
          readyHome
        }
        .fixedSize(horizontal: false, vertical: true)
      }
      .scrollBounceBehavior(.basedOnSize)
      .frame(maxHeight: 560)
      .fixedSize(horizontal: false, vertical: true)
      trayFooterHairline
      homeFooter()
    }
  }

  @ViewBuilder
  private var readyHome: some View {
    if !searchQuery.isEmpty {
      searchHome
    } else {
      if !primaryApps.isEmpty {
        ForEach(primaryApps) { app in
          MenuBarAppCard(model: model, app: app, compact: false) { openUseWith(app.id) }
        }
      }
      if !otherApps.isEmpty {
        MenuBarOtherAppsRow(model: model, apps: otherApps, showMarks: false) { open(.apps) }
      }
      routingServices
    }
  }

  @ViewBuilder
  private var searchHome: some View {
      MenuBarSearchResults(model: model, query: searchQuery, results: searchResults, activate: activateSearchResult)
  }

  private var routingServices: some View {
    VStack(alignment: .leading, spacing: 7) {
      TrayRoutingHeader(model: model, showDetails: false) {}
      MenuBarProxiesRow(
        model: model,
        runningCount: runningProxyCount,
        stoppedCount: stoppedProxyCount,
        attentionCount: attentionProxyCount
      ) { open(.proxies) }
    }
  }

  private var searchField: some View {
    HStack(spacing: 7) {
      Image(systemName: "magnifyingglass")
        .foregroundStyle(.secondary)
        .font(.system(size: 12, weight: .medium))
      TextField(searchPrompt, text: $jump)
        .textFieldStyle(.plain)
        .font(TrayFont.detail)
        .focused($jumpFocused)
        .onSubmit(performJump)
      if jump.isEmpty {
        Text("⌘K")
          .font(TrayFont.detailStrong)
          .foregroundStyle(.secondary)
          .padding(.horizontal, 5)
          .frame(height: 18)
          .background(
            Color.primary.opacity(0.06),
            in: RoundedRectangle(cornerRadius: 5, style: .continuous)
          )
      } else {
        Button {
          jump = ""
          jumpFocused = true
        } label: {
          Image(systemName: "xmark.circle.fill")
            .foregroundStyle(.tertiary)
        }
        .buttonStyle(.plain)
        .help(model.localized("desktop.common.clear_search"))
        .accessibilityLabel(model.localized("desktop.common.clear_search"))
      }
    }
    .padding(.horizontal, 9)
    .frame(height: 32)
    .background(
      Color(nsColor: .controlBackgroundColor).opacity(0.92),
      in: RoundedRectangle(cornerRadius: 8, style: .continuous)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
    )
    .background {
      Button(model.localized("desktop.menu_bar.focus_search")) { jumpFocused = true }
        .keyboardShortcut("k", modifiers: .command)
        .frame(width: 1, height: 1)
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
    .accessibilityIdentifier("tray.jump")
  }

  private var searchPrompt: String {
    let count = model.accounts.filter { $0.kind == .saved }.count
    return model.localized("desktop.menu_bar.search_saved_accounts", count: count, replacing: ["count": String(count)])
  }

  private var statusRow: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(needsAttention ? TrayPaint.attention : TrayPaint.ready)
        .frame(width: 7, height: 7)
      Text(model.localized(needsAttention ? "desktop.common.needs_attention" : "desktop.common.ready"))
        .font(TrayFont.detailStrong)
        .foregroundStyle(needsAttention ? TrayPaint.attention : TrayPaint.ready)
      Text(statusDetail)
        .font(TrayFont.detail)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      Spacer(minLength: 6)
      Button(action: model.refresh) {
        Image(systemName: "arrow.clockwise")
          .foregroundStyle(.secondary)
      }
      .buttonStyle(.borderless)
      .help(model.localized("desktop.common.refresh"))
      .accessibilityLabel(model.localized("desktop.common.refresh"))
    }
    .frame(height: needsAttention ? 28 : 24)
  }

  private var statusDetail: String {
    if needsAttention {
      return model.localized("desktop.menu_bar.issue_count", count: reviewCount, replacing: ["count": String(reviewCount)])
    }
    let appCount = model.quickPanelApps.count
    if model.proxyHubEnabled {
      return model.localized("desktop.menu_bar.hub_online_detail", replacing: ["proxies": String(runningProxyCount), "apps": String(appCount)])
    }
    if runningProxyCount > 0 { return model.localized("desktop.menu_bar.proxies_running_detail", count: appCount, replacing: ["apps": String(appCount)]) }
    return model.localized("desktop.menu_bar.app_count", count: appCount, replacing: ["count": String(appCount)])
  }

  private var trayFooterHairline: some View {
    Rectangle()
      .fill(Color.primary.opacity(0.10))
      .frame(height: 1)
      .padding(.top, 1)
  }

  private func homeFooter() -> some View {
    HStack(spacing: 8) {
      Button(action: quit) {
        Text(model.localized("desktop.menu_bar.quit"))
          .frame(maxWidth: .infinity)
      }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .keyboardShortcut("q", modifiers: .command)
        .accessibilityIdentifier("menu.quit")
      Button {
        open(nil)
      } label: {
        Text(model.localized("desktop.menu_bar.open_anypick"))
          .frame(maxWidth: .infinity)
      }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .keyboardShortcut("o", modifiers: .command)
        .accessibilityIdentifier("menu.open")
    }
    .frame(height: 28)
  }

  private func attentionDismissKey(_ item: TrayAttentionItem) -> String {
    "\(item.id)|\(item.title)"
  }

  private func dismissAttentionNotice(_ item: TrayAttentionItem) {
    dismissedAttentionKeys.formUnion(visibleAttentionItems.map(attentionDismissKey))
    AppPreferences.dismissedAttentionKeys = dismissedAttentionKeys
  }

  private func openUseWith(_ appID: String) {
    useWithAppID = appID
  }

  private func dismissUseWith() {
    useWithAppID = nil
    if model.trayScene == .useWith {
      model.trayScene = .ready
    }
  }

  private func performJump() {
    guard !searchQuery.isEmpty else {
      jumpFocused = true
      return
    }
    guard let result = searchResults.first else {
      NSSound.beep()
      return
    }
    activateSearchResult(result)
  }

  private func matchesSearch(_ values: [String], query: String) -> Bool {
    values.contains { $0.localizedCaseInsensitiveContains(query) }
  }

  private func activateSearchResult(_ result: TraySearchResult) {
    jump = ""
    switch result.target {
    case .app(let appID):
      openUseWith(appID)
    case .destination(let destination):
      open(destination)
    }
  }

  private func open(_ destination: DesignDestination?) {
    if let destination { model.destination = destination }
    if let openMainWindow { openMainWindow() }
    else { openWindow(id: "main") }
    NSApp.activate(ignoringOtherApps: true)
  }

  private func open(_ destination: DesignDestination) {
    open(Optional(destination))
  }

  private func quit() {
    // Route explicit tray Quit through the delegate so it is distinguished
    // from Dock/⌘Q, which intentionally only withdraws the app to the tray.
    guard model.proxyHubEnabled || model.proxies.contains(where: \.enabled) else {
      AnyPickAppDelegate.requestQuit()
      return
    }
    let alert = NSAlert()
    alert.messageText = model.localized("desktop.menu_bar.quit_confirmation_title")
    alert.informativeText = model.localized("desktop.menu_bar.quit_confirmation_detail")
    alert.alertStyle = .warning
    alert.addButton(withTitle: model.localized("desktop.menu_bar.quit"))
    alert.addButton(withTitle: model.localized("desktop.common.cancel"))
    // Escape must reach Cancel, not fall through to the destructive default.
    alert.buttons[1].keyEquivalent = "\u{1b}"
    if alert.runModal() == .alertFirstButtonReturn {
      AnyPickAppDelegate.requestQuit()
    }
  }
}
