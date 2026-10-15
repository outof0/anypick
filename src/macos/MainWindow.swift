import AppKit
import SwiftUI

/// System Settings shell: sidebar List, detail is a NavigationStack.
struct MainWindow: View {
  @ObservedObject var model: MacOSDesignModel
  @Environment(\.openWindow) private var openWindow
  @State private var path = NavigationPath()
  /// Window content height, so sheets cap their scroll area to what fits.
  @State private var windowHeight: CGFloat = 0

  var body: some View {
    NavigationSplitView {
      sidebarColumn
        .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 320)
        .safeAreaInset(edge: .bottom, spacing: 0) { sidebarServiceStatus }
    } detail: {
      detailColumn
        // minWidth: 0 so the Form's ideal width does not grow the window.
        .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)
    }
    .navigationSplitViewStyle(.balanced)
    .alert(
      model.feedback?.title ?? model.localized("desktop.main.unable_to_complete"),
      isPresented: Binding(
        get: { model.feedback?.kind == .error },
        set: { if !$0 { model.dismissFeedback() } }
      )
    ) {
      if model.pendingTakeover != nil {
        // The refusal named CLIENT_CONFIG_FOREIGN: this is the confirmation its
        // suggestion asked for, answered where the user already is. "Replace"
        // is the engine's own verb for it (see the --allow-foreign-config
        // suggestion), and it fits beside Cancel on one row where
        // "Manage with AnyPick" would take a row of its own.
        Button(model.localized("desktop.backups.replace"), action: model.confirmPendingTakeover)
          .help(model.localized("desktop.main.replace_help"))
        Button(model.localized("desktop.common.cancel"), role: .cancel, action: model.dismissFeedback)
          .help(model.localized("desktop.main.cancel_warning_help"))
      } else {
        // A lone dismissal is the default action, not a cancel role: the role
        // is what would bind Escape instead of Return to the only button.
        Button(model.localized("desktop.overview.status_ok"), action: model.dismissFeedback)
          .help(model.localized("desktop.main.dismiss_help"))
      }
    } message: {
      Text(model.feedback?.message ?? "")
    }
    .followingDesignAppearance(model.appearance)
    .frame(minWidth: 920, minHeight: 640)
    .background(
      GeometryReader { proxy in
        Color.clear
          .onAppear { windowHeight = proxy.size.height }
          .onChange(of: proxy.size.height) { _, height in windowHeight = height }
      })
    .environment(
      \.designSheetMaxScrollHeight, designSheetMaxScrollHeight(windowHeight: windowHeight))
    .sheet(
      isPresented: Binding(
        get: { model.showFirstRunWelcome },
        set: { if !$0 { model.dismissFirstRunWelcome() } }
      )
    ) {
      FirstRunWelcomeSheet(model: model)
    }
    .onAppear {
      AnyPickAppDelegate.openMainWindowAction = {
        openWindow(id: "main")
      }
      presentStartupRoute()
      if !model.isProduction {
        openWindow(id: "tray")
      }
    }
    .background(
      MainWindowAccessor { window in
        window.identifier = NSUserInterfaceItemIdentifier("main")
        window.isReleasedWhenClosed = false
        AnyPickAppDelegate.registeredMainWindow = window
      }
    )
    .onChange(of: model.destination) { path = NavigationPath() }
    .onChange(of: model.pendingAccountDetailID) { _, id in
      guard let id else { return }
      model.destination = .accounts
      path.append(DesignRouteID.account(id))
      model.pendingAccountDetailID = nil
    }
  }

  @ViewBuilder
  private var sidebarColumn: some View {
    List(selection: $model.destination) {
      ForEach(DesignDestination.allCases) { destination in
        sidebarRow(destination)
      }
    }
    .listStyle(.sidebar)
    .accessibilityIdentifier("sidebar.navigation")
  }

  private func sidebarRow(_ destination: DesignDestination) -> some View {
    Label {
      Text(model.localized(destination.messageKey))
    } icon: {
      Image(systemName: destination.symbol)
        .symbolRenderingMode(.hierarchical)
    }
    .tag(destination)
    .accessibilityIdentifier("sidebar.\(destination.rawValue)")
  }

  private func presentStartupRoute() {
    if let flow = model.pendingStartupFlow, flow.hasPrefix("proxy-detail") {
      model.pendingStartupFlow = nil
      let targetID: String
      if flow.contains(":") {
        targetID = String(flow.split(separator: ":")[1])
      } else {
        targetID = model.proxies.first?.id ?? ""
      }
      if !targetID.isEmpty {
        path.append(DesignRouteID.proxy(targetID))
        return
      }
    }
    guard model.pendingStartupFlow == "published-models" || model.pendingStartupFlow == "inspect-model" else { return }
    if model.pendingStartupFlow == "published-models" {
      model.pendingStartupFlow = nil
    }
    path.append(DesignRouteID.publishedModels)
  }

  /// Sidebar footer service status.
  private var serviceStatusSummary: String {
    // Visible in every phase: hiding it while loading/error removes the
    // status exactly when it is needed (and pops the layout when it returns).
    if model.phase == .loading { return model.localized("desktop.sidebar.loading") }
    let running = model.proxies.filter { $0.status == .running }.count
      + (model.proxyHubEnabled ? 1 : 0)
    if running == 0 { return model.localized("desktop.sidebar.no_proxies") }
    let message = model.localized(
      running == 1 ? "desktop.sidebar.one_proxy" : "desktop.sidebar.many_proxies"
    )
    return String(format: message, running)
  }

  @ViewBuilder
  private var sidebarServiceStatus: some View {
    VStack(spacing: 0) {
      Divider()
      Label {
        Text(serviceStatusSummary)
      } icon: {
        Image(systemName: DesignDestination.proxies.symbol)
      }
      .font(.footnote)
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("sidebar.service-status")
  }

  @ViewBuilder
  private var detailColumn: some View {
    switch model.phase {
    case .loading:
      DesignLoadingState(model: model)
        .navigationTitle("AnyPick")
    case .error:
      DesignEmptyState(
        title: model.localized("desktop.main.load_failed_title"),
        message: model.isProduction
          ? model.localized("desktop.main.load_failed_production")
          : model.localized("desktop.main.load_failed_fixture"),
        symbol: "exclamationmark.triangle",
        actionTitle: model.localized("desktop.common.try_again"),
        action: model.refresh
      )
      .navigationTitle("AnyPick")
      .accessibilityIdentifier("state.error")
    case .ready, .empty:
      NavigationStack(path: $path) {
        rootPane
          .navigationTitle(model.localized(model.destination.messageKey))
          .navigationDestination(for: DesignRouteID.self) { route in
            switch route {
            case .app(let id):
              AppDetailView(model: model, appID: id)
            case .account(let id):
              if let account = model.accounts.first(where: { $0.id == id }) {
                AccountDetailView(model: model, accountID: account.id)
              } else {
                DesignEmptyState(
                  title: model.localized("desktop.main.account_unavailable_title"),
                  message: model.localized("desktop.main.account_unavailable_detail"),
                  symbol: "person.2"
                )
              }
            case .proxy(let id):
              ProxyDetailView(model: model, proxyID: id)
            case .proxyHub:
              ProxyHubView(model: model)
            case .publishedModels:
              PublishedModelsView(model: model)
            }
          }
      }
    }
  }

  @ViewBuilder
  private var rootPane: some View {
    switch model.destination {
    case .overview: OverviewView(model: model)
    case .apps: AppsView(model: model)
    case .accounts: AccountsView(model: model)
    case .proxyHub: ProxyHubView(model: model)
    case .proxies: ProxiesView(model: model)
    case .activity: ActivityView(model: model)
    case .backups: BackupsView(model: model)
    case .settings: SettingsView(model: model)
    }
  }

}

enum DesignRouteID: Hashable {
  case app(String)
  case account(String)
  case proxy(String)
  case proxyHub
  case publishedModels
}

private struct MainWindowAccessor: NSViewRepresentable {
  let onResolve: (NSWindow) -> Void

  func makeNSView(context: Context) -> NSView {
    let view = NSView()
    DispatchQueue.main.async {
      if let window = view.window {
        onResolve(window)
      }
    }
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    DispatchQueue.main.async {
      if let window = nsView.window {
        onResolve(window)
      }
    }
  }
}
