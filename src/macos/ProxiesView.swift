import AppKit
import SwiftUI

struct ProxiesView: View {
  @ObservedObject var model: MacOSDesignModel
  @State private var confirmation: DesignConfirmation?
  @State private var searchQuery = ""
  @State private var startAllInProgress = false
  @State private var startAllTitle = "Start All Proxies"

  private var filteredProxies: [DesignProxy] {
    let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return model.proxies }
    return model.proxies.filter { proxy in
      [
        proxy.name,
        proxyDisplayName(for: proxy),
        proxy.detail,
        proxy.provider,
        proxy.status.rawValue,
        anypickDisplayName(proxy.provider)
      ].contains { $0.localizedCaseInsensitiveContains(query) }
    }
  }

  var body: some View {
    Group {
      // An empty collection replaces the pane, the way AccountsView does it:
      // ContentUnavailableView is the system's empty state and fills the
      // content area. Nesting it inside a Form Section turned it into a
      // card-sized hero — a grouped Form paints each Section as an inset
      // group, so the system empty state grew a container it was never meant
      // to have.
      if model.proxies.isEmpty {
        DesignEmptyState(
          title: model.localized("desktop.proxies.no_account_proxies"),
          message: model.localized("desktop.proxies.no_proxies_detail"),
          symbol: "server.rack",
          actionTitle: model.localized("desktop.nav.accounts"),
          action: { model.destination = .accounts }
        )
      } else if filteredProxies.isEmpty {
        DesignEmptyState(
          title: model.localized("desktop.hub.no_results"),
          message: model.localized("desktop.proxies.no_results_detail"),
          symbol: "magnifyingglass",
          actionTitle: model.localized("desktop.common.clear_search"),
          action: { searchQuery = "" }
        )
      } else {
        inventory
      }
    }
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        DesignToolbarSearch(text: $searchQuery, prompt: model.localized("desktop.proxies.search"))
          .frame(minWidth: 160, idealWidth: 180, maxWidth: 220)
      }
    }
    .designConfirmation($confirmation, model: model)
  }

  private func requestStopAll() {
    confirmation = DesignConfirmation(
      id: "stop-all-proxies",
      title: model.localized("desktop.proxies.stop_all_title"),
      message: model.localized("desktop.proxies.stop_all_message"),
      action: .confirm(model.localized("desktop.proxies.stop_all_action")) { model.stopAllProxies() }
    )
  }

  private func requestStop(_ proxy: DesignProxy) {
    confirmation = DesignConfirmation(
      id: "stop-proxy",
      title: model.localized("desktop.proxies.stop_proxy_title")
        .replacingOccurrences(of: "{name}", with: proxy.name),
      message: model.localized("desktop.proxies.stop_proxy_message"),
      action: .confirm(model.localized("desktop.common.stop")) { model.setProxyEnabled(id: proxy.id, enabled: false) }
    )
  }

  private func requestRotate(_ proxy: DesignProxy) {
    confirmation = DesignConfirmation(
      id: "rotate-proxy-key",
      title: model.localized("desktop.proxies.rotate_key_title")
        .replacingOccurrences(of: "{name}", with: proxy.name),
      message: model.localized("desktop.proxies.rotate_message"),
      action: .confirm(model.localized("desktop.common.rotate_key")) { model.rotateProxyKey(id: proxy.id) }
    )
  }

  /// The pane's one job: the Proxy Hub shortcut, then one row per account proxy.
  private var inventory: some View {
    DesignGroupedPane(contentIdentifier: "proxies.list", actions: { paneActions }) {
      Section {
        NavigationLink(value: DesignRouteID.proxyHub) {
          DesignIdentityRow(
            title: model.localized("desktop.nav.proxy_hub"),
            detail: hubSummarySubtitle
          ) {
            Image(systemName: DesignDestination.proxyHub.symbol)
              .foregroundStyle(.secondary)
          } trailing: {
            DesignStatusLabel(model: model, status: model.proxyHubEnabled ? .running : .stopped)
          }
        }
        .accessibilityIdentifier("proxies.hub-summary")
      } header: {
        Text(model.localized("desktop.nav.proxy_hub"))
      } footer: {
        Text(model.localized("desktop.proxies.hub_footer"))
      }

      Section {
        ForEach(filteredProxies) { proxy in
          let title = proxyDisplayName(for: proxy)
          let subtitle = proxySubtitle(for: proxy, title: title)
          NavigationLink(value: DesignRouteID.proxy(proxy.id)) {
            DesignIdentityRow(
              title: title,
              detail: subtitle,
              issue: proxyIssue(proxy)
            ) {
              DesignProviderIcon(provider: proxy.provider, fallbackSymbol: proxy.symbol)
            } trailing: {
              lifecycleAction(proxy)
            }
          }
          .accessibilityIdentifier("proxies.row.\(proxy.id)")
          .contextMenu {
            if proxy.status == .running {
              Button(model.localized("desktop.common.stop"), role: .destructive) { requestStop(proxy) }
                .help(model.localized("desktop.proxies.stop_help"))
                .disabled(
                  model.isBusy || startAllInProgress || model.serviceOperations[proxy.id] != nil
                )
              Button(model.localized("desktop.common.restart")) { model.restartProxy(id: proxy.id) }
                .help(model.localized("desktop.proxies.restart_help"))
                .disabled(
                  model.isBusy || startAllInProgress || model.serviceOperations[proxy.id] != nil
                )
              if proxy.port > 0 {
                Button(model.localized("desktop.common.copy_address")) {
                  let address = "http://127.0.0.1:\(proxy.port)"
                  if model.pasteString(address) {
                    model.announceOnly("Copied \(proxy.name) address.")
                  } else {
                    model.announceOnly("Couldn’t copy \(proxy.name) address.")
                  }
                }
                .help(model.localized("desktop.proxies.copy_address_help"))
              }
              if model.proxyCanCopyAPIKey(proxy) {
                Button(model.localized("desktop.common.copy_api_key")) { model.copyProxyAPIKey(id: proxy.id) }
                  .help(model.localized("desktop.proxies.copy_key_help"))
              }
              Button(model.localized("desktop.common.rotate_key")) {
                requestRotate(proxy)
              }
              .help(model.localized("desktop.proxies.rotate_help"))
            } else {
              Button(model.localized("desktop.common.start")) { model.setProxyEnabled(id: proxy.id, enabled: true) }
                .help(model.localized("desktop.proxies.start_help"))
                .disabled(
                  model.isBusy || startAllInProgress || model.serviceOperations[proxy.id] != nil
                )
            }
          }
          .accessibilityAction(named: model.localized(proxy.status == .running ? "desktop.common.stop" : "desktop.common.start")) {
            guard !startAllInProgress else { return }
            if proxy.status == .running {
              requestStop(proxy)
            } else {
              model.setProxyEnabled(id: proxy.id, enabled: true)
            }
          }
        }
      } header: {
        Text(model.localized("desktop.proxies.account_proxies"))
      } footer: {
        Text(
          model.localized("desktop.proxies.endpoint_footer")
        )
      }
    }
  }

  private var paneActions: some View {
    DesignPaneActions {
      if hasProxiesToStart || startAllInProgress {
        DesignSheetButton(
          title: startAllInProgress
            ? startAllTitle
            : model.localized(hasRunningProxy ? "desktop.proxies.start_remaining" : "desktop.proxies.start_all"),
          enabled: !model.isBusy && !startAllInProgress && !hasPendingProxyOperation,
          identifier: "proxies.start-all"
        ) {
          startAllProxies()
        }
      }
      DesignSheetButton(
        title: model.localized("desktop.proxies.restart_running"),
        enabled: !model.isBusy && !startAllInProgress && hasRunningProxy,
        identifier: "proxies.restart"
      ) { model.restartRunningProxies() }
      DesignSheetButton(
        title: model.localized("desktop.proxies.stop_all_action"),
        enabled: !model.isBusy && !startAllInProgress && hasRunningProxy,
        destructive: true,
        identifier: "proxies.stop-all"
      ) { requestStopAll() }
    }
  }

  @ViewBuilder
  private func lifecycleAction(_ proxy: DesignProxy) -> some View {
    // Explicit bordered style: inside a NavigationLink label a default-styled
    // Button has its tap swallowed into navigation, so Start/Stop silently
    // did nothing. Keep the control visible so lifecycle actions remain
    // discoverable with a pointer, keyboard, or assistive technology.
    // HIG: while busy the button stays and spins inside it — it is never
    // swapped out for a bare spinner.
    let busyRow = model.serviceOperations[proxy.id] != nil
    let busy = model.isBusy || busyRow || (startAllInProgress && !busyRow)
    Group {
      // `enabled` is the persisted auto-start/configuration flag. It is not
      // the lifecycle state of the process, so it must never choose Stop.
      if proxy.status == .running {
        Button(role: .destructive) {
          requestStop(proxy)
        } label: {
          ZStack {
            if busyRow { ProgressView().controlSize(.small) } else { Text(model.localized("desktop.common.stop")) }
          }
          .frame(minWidth: 46)
        }
        .disabled(busy)
        .help(model.localized("desktop.proxies.stop_help"))
        .accessibilityLabel("\(model.localized("desktop.common.stop")) \(proxy.name)")
      } else {
        Button {
          model.setProxyEnabled(id: proxy.id, enabled: true)
        } label: {
          ZStack {
            if busyRow { ProgressView().controlSize(.small) } else { Text(model.localized("desktop.common.start")) }
          }
          .frame(minWidth: 46)
        }
        .disabled(busy)
        .help(model.localized("desktop.proxies.start_help"))
        .accessibilityLabel("\(model.localized("desktop.common.start")) \(proxy.name)")
      }
    }
    .buttonStyle(.bordered)
    .controlSize(.small)
    .accessibilityIdentifier("proxies.row-action.\(proxy.id)")
  }

  private var hasRunningProxy: Bool {
    model.proxies.contains { $0.status == .running }
  }

  private var hasProxiesToStart: Bool {
    model.proxies.contains { $0.status != .running }
  }

  private var hasPendingProxyOperation: Bool {
    model.proxies.contains { model.serviceOperations[$0.id] != nil }
  }

  @MainActor
  private func startAllProxies() {
    guard !startAllInProgress, !model.isBusy, !hasPendingProxyOperation else { return }
    startAllTitle = model.localized(hasRunningProxy ? "desktop.proxies.start_remaining" : "desktop.proxies.start_all")
    startAllInProgress = true
    Task { @MainActor in
      defer { startAllInProgress = false }

      let proxyIDs = model.proxies.filter { $0.status != .running }.map(\.id)
      for proxyID in proxyIDs {
        while model.isBusy {
          try? await Task.sleep(nanoseconds: 50_000_000)
        }
        guard let proxy = model.proxies.first(where: { $0.id == proxyID }),
          proxy.status != .running
        else { continue }

        model.setProxyEnabled(id: proxyID, enabled: true)
        // Production installs an operation only after the service accepted the
        // request. A missing operation means stop the batch after surfacing the
        // rejection; otherwise later rows would produce duplicate alerts.
        guard model.serviceOperations[proxyID] != nil else { return }

        while model.isBusy || model.serviceOperations[proxyID] != nil {
          try? await Task.sleep(nanoseconds: 50_000_000)
        }
      }
    }
  }

  private var hubSummarySubtitle: String {
    if model.proxyHubEnabled {
      let modelCount = model.publishedModels.filter { !$0.needsChoice }.count
      let countKey = modelCount == 1 ? "desktop.hub.model_count" : "desktop.hub.models_count"
      let count = model.localized(countKey).replacingOccurrences(of: "{count}", with: String(modelCount))
      return "http://127.0.0.1:\(model.proxyHubPort) · \(count) \(model.localized("desktop.hub.models_published"))"
    }
    return model.localized("desktop.proxies.hub_footer")
  }

  private func proxyDisplayName(for proxy: DesignProxy) -> String {
    friendlyProxyName(label: proxy.name, providerId: proxy.provider, using: model)
  }

  private func proxySubtitle(for proxy: DesignProxy, title: String) -> String {
    if let op = model.serviceOperations[proxy.id]?.localizedLabel(using: model) {
      return op
    }
    let statusText = friendlyProxyStatusSubtitle(
      status: proxy.status,
      port: proxy.port,
      detail: proxy.detail,
      using: model
    )
    let providerName = anypickDisplayName(proxy.provider)
    let cleanDetail = proxy.detail.trimmingCharacters(in: .whitespacesAndNewlines)
    let isRawAddressOrStatus = cleanDetail.isEmpty
      || cleanDetail.hasPrefix("http://")
      || cleanDetail.hasPrefix("https://")
      || cleanDetail.hasPrefix("127.0.0.1")
      || cleanDetail.hasPrefix("[::1]")
      || cleanDetail.localizedCaseInsensitiveCompare("stopped") == .orderedSame
      || cleanDetail.localizedCaseInsensitiveCompare("running") == .orderedSame

    if !isRawAddressOrStatus {
      var accountPart = cleanDetail
      if let range = cleanDetail.range(of: " · ") {
        accountPart = String(cleanDetail[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
      }
      if !accountPart.isEmpty && !title.localizedCaseInsensitiveContains(accountPart) {
        return "\(accountPart) · \(statusText)"
      }
    }

    if !title.localizedCaseInsensitiveContains(providerName) {
      return "\(providerName) · \(statusText)"
    }
    return statusText
  }

  private func proxyIssue(_ proxy: DesignProxy) -> String? {
    if let failure = model.serviceFailures[proxy.id] { return failure }
    switch proxy.status {
    case .attention, .unavailable:
      return "This proxy isn’t running."
    case .ready, .running, .stopped:
      return nil
    }
  }
}
