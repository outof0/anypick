import AppKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers
/// Account and gateway queries for the fixture model.
@MainActor
extension MacOSDesignModel {
  func defaultGatewayEndpoint(for provider: String) -> String? {
    gatewayProviderOptions.first(where: { $0.id == provider })?.defaultEndpoint
  }

  func preferredGatewayProvider(for clientID: String?) -> DesignProviderOption? {
    guard let clientID else { return nil }
    return gatewayProviderOptions.first { option in
      option.firstPartyClientIDs.contains {
        $0.caseInsensitiveCompare(clientID) == .orderedSame
      }
    }
  }

  func usageWindows(for account: DesignAccount) -> [DesignUsageWindow] {
    guard isCurrentAccount(account), showUsage else { return [] }
    if let accountUsage { return accountUsage[account.id] ?? [] }
    // Quota is reported for the live login of one provider. Match by engine
    // provider family, not by display name: "OpenAI" (the account row) is the
    // "codex" app, and a fuzzy name match silently dropped its usage.
    let providerID = account.providerID.isEmpty ? account.provider : account.providerID
    let family = nativeProviderFamily(providerID)
    if let app = apps.first(where: { nativeProviderFamily($0.id) == family }) {
      return app.usageWindows
    }
    return apps.first { app in
      app.name.localizedCaseInsensitiveContains(account.provider)
        || account.provider.localizedCaseInsensitiveContains(app.id)
    }?.usageWindows ?? []
  }

  func liveLogin(for provider: String) -> DesignLiveLogin? {
    currentLiveLogins.first {
      $0.providerID.caseInsensitiveCompare(provider) == .orderedSame
        || $0.providerName.caseInsensitiveCompare(provider) == .orderedSame
    }
  }

  func upsertLiveLogin(provider: String, identity: String, appName: String? = nil) {
    let symbol = symbol(for: provider)
    let login = DesignLiveLogin(
      providerID: provider.lowercased(),
      sourceID: nil,
      providerName: provider,
      appName: appName ?? anypickDisplayName(provider),
      identity: identity,
      symbol: symbol
    )
    if let index = liveLogins.firstIndex(where: {
      $0.providerName.caseInsensitiveCompare(provider) == .orderedSame
        || $0.providerID.caseInsensitiveCompare(provider) == .orderedSame
    }) {
      liveLogins[index] = login
    } else {
      liveLogins.append(login)
    }
  }

  func isCurrentAccount(_ account: DesignAccount) -> Bool {
    account.kind == .saved && account.status == .running
  }

  func gatewayRoute(in app: DesignApp, matching gateway: DesignAccount) -> DesignRoute? {
    let rawID =
      gateway.id.hasPrefix("gateway/")
      ? String(gateway.id.dropFirst("gateway/".count))
      : gateway.id
    return app.routeOptions.first { route in
      guard route.kind == .gateway else { return false }
      if route.id == gateway.id || route.id == rawID { return true }
      if route.name.caseInsensitiveCompare(gateway.name) == .orderedSame { return true }
      if gateway.name.localizedCaseInsensitiveContains(route.name)
        || route.name.localizedCaseInsensitiveContains(gateway.name)
      {
        return true
      }
      guard let providerID = route.providerID else { return false }
      return providerID.caseInsensitiveCompare(gateway.provider) == .orderedSame
        || providerID.caseInsensitiveCompare(rawID) == .orderedSame
    }
  }

  func appsCompatible(with gateway: DesignAccount) -> [DesignApp] {
    apps.filter { gatewayRoute(in: $0, matching: gateway) != nil }
  }

  func gatewayRouteChanges(id: String, appIDs: Set<String>) -> [(appID: String, routeID: String)] {
    guard let gateway = accounts.first(where: { $0.id == id && $0.kind == .gateway }) else {
      return []
    }
    var changes = [(appID: String, routeID: String)]()
    for app in appsCompatible(with: gateway) {
      guard let route = gatewayRoute(in: app, matching: gateway) else { continue }
      let shouldUse = appIDs.contains(app.id)
      let using = app.selectedRouteID == route.id
      if shouldUse && !using {
        changes.append((app.id, route.id))
      } else if !shouldUse && using,
        let native = app.routeOptions.first(where: { $0.kind == .native })
      {
        changes.append((app.id, native.id))
      }
    }
    return changes
  }

  func applyMakeCurrent(id: String) {
    guard let index = accounts.firstIndex(where: { $0.id == id }) else { return }
    let provider = accounts[index].provider
    for candidate in accounts.indices where accounts[candidate].provider == provider {
      accounts[candidate].status = candidate == index ? .running : .ready
      accounts[candidate].lastUsed = candidate == index ? "Used now" : "Saved"
    }
    recordActivity(
      title: "\(accounts[index].name) is current",
      detail: "The live \(provider) login now uses this saved account.",
      symbol: "person.crop.circle.badge.checkmark",
      status: .ready
    )
    showFeedback("\(accounts[index].name) is now current.", kind: .success)
  }

  /// Provider+name match the restore flows use to detect an already-saved
  /// account — single source for the Replace dialog and the skip rule.
  func alreadySavedAccount(_ account: DesignAccount) -> Bool {
    // A reviewed import entry carries the engine disposition. Matching the
    // display label instead marks a renamed account as new, and marks a
    // different account that happens to share the label as existing.
    if let replaces = account.importReplacesSaved { return replaces }
    return accounts.contains { $0.provider == account.provider && $0.name == account.name }
  }

  /// SF Symbol fallback when a provider has no bundled brand mark.
  func symbol(for provider: String) -> String {
    DesignBrandAsset.fallbackSymbol(for: provider)
  }
}
