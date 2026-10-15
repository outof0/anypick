import SwiftUI

/// In-panel Use With (board 29). Instant-apply; stays in the Quick Panel.
struct MenuBarUseWithSheet: View {
  @ObservedObject var model: MacOSDesignModel
  let appID: String
  let onDismiss: () -> Void
  let openDestination: (DesignDestination) -> Void
  let openMainWindow: () -> Void
  let quit: () -> Void

  @State private var query = ""
  @FocusState private var searchFocused: Bool

  private var app: DesignApp? { model.apps.first { $0.id == appID } }

  private var accountRoutes: [DesignRoute] {
    guard let app else { return [] }
    return trayAccountRoutes(in: app)
  }

  private var filteredAccountRoutes: [DesignRoute] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return accountRoutes }
    return accountRoutes.filter {
      $0.name.localizedCaseInsensitiveContains(trimmed)
        || $0.detail.localizedCaseInsensitiveContains(trimmed)
    }
  }

  private var gatewayRoutes: [DesignRoute] {
    guard let app else { return [] }
    return trayGatewayRoutes(in: app)
  }

  private var hubRoute: DesignRoute? {
    app?.routeOptions.first { $0.kind == .hub }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      header
      searchField
      savedAccountsHeader
      accountGroup
      sharedHeader
      if let hubRoute {
        sharedHubRow(hubRoute)
      }
      if !gatewayRoutes.isEmpty {
        gatewaySummary
      }
      Divider()
      footer
    }
  }

  private var header: some View {
    HStack(spacing: 9) {
      Button(action: onDismiss) {
        Image(systemName: "chevron.left")
          .font(.system(size: 11, weight: .semibold))
          .frame(width: 18, height: 18)
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .accessibilityLabel(model.localized("desktop.common.back"))
      if let app {
        DesignProviderIcon(provider: app.id, fallbackSymbol: app.symbol, size: 30)
        VStack(alignment: .leading, spacing: 2) {
          Text(model.localized("desktop.menu_bar.switch_app_account", replacing: ["app": app.name]))
            .font(.system(size: 14, weight: .semibold))
          Text(headerDetail(for: app))
            .font(TrayFont.detail)
            .foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 0)
    }
    .frame(height: 42)
  }

  private var searchField: some View {
    HStack(spacing: 7) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(.secondary)
      TextField(searchPrompt, text: $query)
        .textFieldStyle(.plain)
        .font(TrayFont.detail)
        .focused($searchFocused)
      Text("⌘F")
        .font(TrayFont.detailStrong)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 5)
        .frame(height: 18)
        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 5))
    }
    .padding(.horizontal, 9)
    .frame(height: 32)
    .background(TrayPaint.cardFill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .strokeBorder(TrayPaint.hairline, lineWidth: 0.5)
    )
    .overlay {
      Button(model.localized("desktop.menu_bar.find")) { searchFocused = true }
        .keyboardShortcut("f", modifiers: .command)
        .opacity(0)
        .accessibilityHidden(true)
    }
    .accessibilityIdentifier("tray.use-with.search")
  }

  private var savedAccountsHeader: some View {
    traySectionTitle(model.localized("desktop.menu_bar.accounts_count", replacing: ["count": String(accountRoutes.count)]))
      .frame(height: 15)
  }

  @ViewBuilder
  private var accountGroup: some View {
    if filteredAccountRoutes.isEmpty {
      VStack(spacing: 4) {
        Image(systemName: "magnifyingglass")
          .foregroundStyle(.secondary)
        Text(model.localized("desktop.accounts.no_results"))
          .font(TrayFont.detailMedium)
        Text(model.localized("desktop.menu_bar.try_another_search"))
          .font(TrayFont.detail)
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity)
      .frame(height: 86)
      .background(TrayPaint.recessedFill, in: RoundedRectangle(cornerRadius: 10))
    } else {
      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(Array(filteredAccountRoutes.enumerated()), id: \.element.id) { index, route in
            if index > 0 { Divider() }
            routeRow(route, trailing: accountTrailing(route))
          }
        }
      }
      .frame(height: accountGroupHeight)
      .background(TrayPaint.recessedFill, in: RoundedRectangle(cornerRadius: 10))
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .strokeBorder(TrayPaint.hairline, lineWidth: 0.5)
      )
    }
  }

  private func routeRow(_ route: DesignRoute, trailing: String) -> some View {
    let state = trayInlineSwitchState(model: model, app: app, route: route)
    return Button {
      select(route)
    } label: {
      HStack(spacing: 8) {
        TrayInlineRouteMark(state: state)
        VStack(alignment: .leading, spacing: 1) {
          Text(route.name)
            .font(state == .current ? TrayFont.detailStrong : TrayFont.detailMedium)
            .foregroundStyle(.primary)
          if !route.detail.isEmpty {
            Text(route.detail)
              .font(TrayFont.detail)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        Spacer(minLength: 6)
        routeStateLabel(state, fallback: trailing)
      }
      .padding(.horizontal, 10)
      .frame(height: 42)
      .background(rowBackground(for: state))
    }
    .buttonStyle(.plain)
    .disabled(model.isBusy)
    .accessibilityLabel(routeAccessibilityLabel(route, state: state))
  }

  @ViewBuilder
  private func routeStateLabel(_ state: TrayInlineSwitchState, fallback: String) -> some View {
    switch state {
    case .current:
      Text(fallback)
        .font(TrayFont.detailStrong)
        .foregroundStyle(TrayPaint.accent)
    case .switching:
      HStack(spacing: 5) {
        ProgressView().controlSize(.small)
        Text(model.localized("desktop.common.switching"))
      }
      .font(TrayFont.detailStrong)
      .foregroundStyle(.secondary)
    case .retry:
      Label(model.localized("desktop.common.try_again"), systemImage: "exclamationmark.triangle.fill")
        .font(TrayFont.detailStrong)
        .foregroundStyle(TrayPaint.attention)
    case .available:
      if !fallback.isEmpty {
        Text(fallback)
          .font(TrayFont.detailMedium)
          .foregroundStyle(.secondary)
      }
    }
  }

  private var sharedHeader: some View {
    traySectionTitle(model.localized("desktop.menu_bar.or_use_shared"))
      .frame(height: 15)
  }

  private func sharedHubRow(_ route: DesignRoute) -> some View {
    Button {
      model.setRoute(appID: appID, routeID: route.id)
    } label: {
      HStack(spacing: 9) {
        Image(systemName: "point.3.connected.trianglepath.dotted")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(TrayPaint.accent)
          .frame(width: 28, height: 28)
        VStack(alignment: .leading, spacing: 2) {
          Text(model.localized("desktop.nav.proxy_hub"))
            .font(TrayFont.detailStrong)
          Text(hubDetail)
            .font(TrayFont.detail)
            .foregroundStyle(.secondary)
        }
        Spacer(minLength: 6)
        Text(model.localized(model.proxyHubEnabled ? "desktop.common.running" : "desktop.common.stopped"))
          .font(TrayFont.detailStrong)
          .foregroundStyle(model.proxyHubEnabled ? TrayPaint.ready : Color.secondary)
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 9)
      .frame(height: 50)
      .background(TrayPaint.cardFill, in: RoundedRectangle(cornerRadius: 10))
      .overlay(
        RoundedRectangle(cornerRadius: 10)
          .strokeBorder(TrayPaint.hairline, lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .disabled(model.isBusy || !model.proxyHubEnabled)
    .accessibilityIdentifier("tray.use-with.hub")
  }

  private var gatewaySummary: some View {
    Button { openDestination(.accounts) } label: {
      HStack(spacing: 9) {
        Image(systemName: "network")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(TrayPaint.accent)
          .frame(width: 28, height: 28)
        Text(model.localized("desktop.accounts.api_gateways"))
          .font(TrayFont.detailStrong)
        Spacer(minLength: 6)
        Text("\(gatewayRoutes.count)")
          .font(TrayFont.detail)
          .foregroundStyle(.secondary)
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 9)
      .frame(height: 50)
      .background(TrayPaint.cardFill, in: RoundedRectangle(cornerRadius: 10))
      .overlay(
        RoundedRectangle(cornerRadius: 10)
          .strokeBorder(TrayPaint.hairline, lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("tray.use-with.gateways")
  }

  private var footer: some View {
    HStack(spacing: 8) {
      Button(action: quit) {
        Text(model.localized("desktop.menu_bar.quit"))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .keyboardShortcut("q", modifiers: .command)
      Button(action: openMainWindow) {
        Text(model.localized("desktop.menu_bar.open_anypick"))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.small)
      .keyboardShortcut("o", modifiers: .command)
    }
    .frame(height: 28)
  }

  private var accountGroupHeight: CGFloat {
    min(CGFloat(filteredAccountRoutes.count * 43), 258)
  }

  private var searchPrompt: String {
    let name = app?.name
      .replacingOccurrences(of: " Code", with: "")
      .replacingOccurrences(of: " CLI", with: "") ?? "app"
    return model.localized("desktop.menu_bar.search_accounts", count: accountRoutes.count, replacing: ["count": String(accountRoutes.count), "app": name])
  }

  private var hubDetail: String {
    let sources = model.hubSourceIDs.count
    let models = model.publishedModels.count
    let sourceText = model.localized("desktop.menu_bar.source_count", count: sources, replacing: ["count": String(sources)])
    let modelText = model.localized("desktop.menu_bar.model_count", count: models, replacing: ["count": String(models)])
    return "\(sourceText) · \(modelText)"
  }

  private func headerDetail(for app: DesignApp) -> String {
    let current = app.routeOptions.first { $0.id == app.selectedRouteID }?.name ?? model.localized("desktop.app_detail.not_selected")
    return model.localized("desktop.menu_bar.current_saved_accounts", replacing: ["current": current, "count": String(accountRoutes.count)])
  }

  private func rowBackground(for state: TrayInlineSwitchState) -> Color {
    switch state {
    case .current, .switching:
      Color(nsColor: .selectedContentBackgroundColor).opacity(0.12)
    case .retry:
      .clear
    case .available:
      .clear
    }
  }

  private func routeAccessibilityLabel(_ route: DesignRoute, state: TrayInlineSwitchState) -> String {
    switch state {
    case .current:
      return model.localized("desktop.menu_bar.route_current_accessibility", replacing: ["route": route.name])
    case .switching:
      return model.localized("desktop.menu_bar.route_switching_accessibility", replacing: ["route": route.name])
    case .retry:
      return model.localized("desktop.menu_bar.route_failed_accessibility", replacing: ["route": route.name])
    case .available:
      return model.localized("desktop.menu_bar.use_route", replacing: ["route": route.name])
    }
  }

  private func accountTrailing(_ route: DesignRoute) -> String {
    guard let app else { return route.badge ?? "" }
    if route.id == app.selectedRouteID {
      if let badge = route.badge { return model.localized("desktop.menu_bar.current_badge", replacing: ["badge": badge]) }
      if model.showUsage, let usage = app.usageRemaining {
        let short = usage
          .replacingOccurrences(of: " remaining", with: "")
          .replacingOccurrences(of: " left", with: "")
        return model.localized("desktop.menu_bar.current_badge", replacing: ["badge": short])
      }
      return model.localized("desktop.common.current")
    }
    return route.badge ?? ""
  }

  private func select(_ route: DesignRoute) {
    model.setRoute(appID: appID, routeID: route.id)
  }
}
