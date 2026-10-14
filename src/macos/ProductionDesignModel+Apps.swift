import AppKit
import Combine
import Foundation
import UniformTypeIdentifiers
/// Snapshot mapping for apps, models, and ordering.
@MainActor
extension ProductionDesignModel {
  func designApp(clientID: String) -> DesignApp? {
    let actions = store.managedActions(clientId: clientID)
    let provider = store.accountProviders.first { $0.clientId == clientID && $0.installed }
    guard !actions.isEmpty || provider != nil else {
      // Actions exist but none are enabled: show an attention row with a fix
      // action instead of dropping the app.
      guard appNeedsAttentionPlaceholder(
        clientID: clientID,
        actions: store.actions,
        providers: store.accountProviders
      ) else { return nil }
      return DesignApp(
        id: clientID,
        name: designAppName(clientID),
        detail: "No usable connection",
        symbol: appSymbol(clientID),
        status: .attention,
        showInQuickPanel: false,
        accountCount: 0,
        selectedRouteID: "",
        routeOptions: [],
        fastModel: "auto",
        reasoningModel: "auto",
        useCompatibleFallback: true,
        attentionMessage: "No compatible login is available for this app."
      )
    }
    let route = store.route(clientId: clientID)
    let selected = actions.first(where: \.selected)
    let config = store.modelConfig(clientID)
    let options = uniqueCompatibleRoutes(
      actions.map {
        DesignRoute(
          id: $0.id,
          name: $0.routeKind == "direct-account"
            ? ($0.upstreamSourceLabel ?? $0.label)
            : $0.label,
          detail: friendlyRouteDetail($0.detail, routeKind: $0.routeKind),
          symbol: routeSymbol($0.routeKind),
          kind: appRouteKind(
            routeKind: $0.routeKind,
            upstreamProviderID: $0.upstreamProviderId,
            clientID: clientID
          ),
          providerID: $0.upstreamProviderId,
          sourceID: $0.sourceId
        )
      },
      selectedID: selected?.id)
    let selectedRoute = selected.flatMap { action in
      options.first { $0.id == action.id }
    }
    let selectedName = selectedRoute?.name
    let selectedDetail = selectedRoute?.detail
    let routeStatus = route?.status.lowercased()
    let configuredRouteUnavailable =
      selected == nil
      && route?.source?.isEmpty == false
      && provider?.livePresent != true
    let status: DesignStatus =
      routeStatus == "attention"
      ? .attention
      : configuredRouteUnavailable
        ? .stopped
        : selected != nil || provider?.livePresent == true || routeStatus == "native"
          || routeStatus == "ready" ? .ready : .stopped
    let nativeIdentity = provider?.liveIdentity.flatMap(displaySafeIdentity)
    let nativeLoginDetail: String? =
      provider?.livePresent == true
      ? (nativeIdentity.map { "Signed in as \($0)" } ?? "Current login")
      : nil
    let connectionDetail =
      selectedName.map { name in
        if let selectedDetail, !selectedDetail.isEmpty,
          selectedDetail != name,
          !selectedDetail.hasPrefix("Direct"), !selectedDetail.hasPrefix("Saved"),
          !selectedDetail.hasPrefix("AnyPick"), !selectedDetail.hasPrefix("Available"),
          !selectedDetail.hasPrefix("Login managed")
        {
          return "Uses \(name) · \(selectedDetail)"
        }
        return "Uses \(name)"
      }
      ?? nativeLoginDetail
      ?? (route?.source?.isEmpty == false ? "Configured source unavailable" : nil)
      ?? "No account selected"
    let usageWindows =
      store.usage(for: clientID)?.windows.map {
        DesignUsageWindow(
          label: $0.label,
          remainingPercent: $0.remainingPercent,
          resetsAtMs: $0.resetsAtMs,
          limitWindowSeconds: $0.limitWindowSeconds,
          group: $0.group
        )
      } ?? []
    return DesignApp(
      id: clientID,
      name: designAppName(clientID),
      detail: connectionDetail,
      symbol: appSymbol(clientID),
      status: status,
      showInQuickPanel: AppPreferences.quickPanelShown(for: clientID) ?? (selected != nil),
      accountCount: options.count,
      selectedRouteID: selected?.id ?? "",
      routeOptions: options,
      fastModel: config?.modelRoles["haiku"] ?? config?.defaultModel ?? "auto",
      reasoningModel: config?.modelRoles["opus"] ?? config?.defaultModel ?? "auto",
      useCompatibleFallback: true,
      modelRoles: config?.roles.map {
        DesignModelRole(
          id: $0.id,
          label: $0.label,
          modelID: config?.modelRoles[$0.id]
            ?? ($0.id == "default" ? config?.defaultModel ?? "" : "")
        )
      } ?? [],
      modelOptions: Array(Set(config?.options.map(\.modelId) ?? [])).sorted(),
      modelEditingAvailable: config?.editable ?? false,
      modelUnavailableReason: config?.unavailableReason,
      usageWindows: usageWindows,
      usageRemaining: usageWindows.first.map { "\($0.remainingPercent)% remaining" },
      attentionMessage: routeStatus == "attention" ? route?.attentionReason : nil
    )
  }

  func appSymbol(_ client: String) -> String { providerSymbol(client) }

  private func designAppName(_ client: String) -> String {
    switch client.lowercased() {
    case "claude": return "Claude Code"
    case "codex": return "Codex"
    case "gemini": return "Gemini"
    case "kiro": return "Kiro"
    case "grok": return "Grok"
    case "opencode": return "OpenCode"
    case "workbuddy", "codebuddy": return "WorkBuddy"
    case "zcode": return "ZCode"
    case "dsh": return "DeepSeek Harness"
    case "commandcode": return "Command Code"
    case "pi": return "Pi"
    case "omp": return "Omp"
    default: return anypickDisplayName(client)
    }
  }

  private func routeSymbol(_ kind: String?) -> String {
    switch kind {
    case "hub": return "point.3.connected.trianglepath.dotted"
    case "gateway": return "network"
    case "pool", "account": return "arrow.triangle.branch"
    default: return "person.crop.circle"
    }
  }

  func nativeAppOrder(_ lhs: DesignApp, _ rhs: DesignApp) -> Bool {
    let priority = ["claude", "codex", "commandcode", "gemini", "kiro", "grok", "opencode", "workbuddy", "zcode", "pi", "omp"]
    let lhsIndex = priority.firstIndex(of: lhs.id) ?? priority.count
    let rhsIndex = priority.firstIndex(of: rhs.id) ?? priority.count
    if lhsIndex != rhsIndex { return lhsIndex < rhsIndex }
    return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
  }
}
