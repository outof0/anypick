import AppKit
import Combine
import Foundation
import UniformTypeIdentifiers
/// Snapshot mapping for accounts and gateways.
@MainActor
extension ProductionDesignModel {
  func parseAccountSource(_ sourceID: String) -> (provider: String, name: String)? {
    let prefix = "account/"
    guard sourceID.hasPrefix(prefix) else { return nil }
    let parts = sourceID.dropFirst(prefix.count).split(separator: "/", maxSplits: 1)
    guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
    return (String(parts[0]), String(parts[1]))
  }

  func parseGatewaySource(_ sourceID: String) -> String? {
    let prefix = "gateway/"
    guard sourceID.hasPrefix(prefix) else { return nil }
    let name = String(sourceID.dropFirst(prefix.count))
    return name.isEmpty ? nil : name
  }

  func designAccount(_ account: ManagedAccountSnapshot) -> DesignAccount {
    DesignAccount(
      id: account.id,
      name: account.label,
      detail: account.detail,
      provider: nativeProviderName(account.providerId),
      symbol: providerSymbol(account.providerId),
      kind: .saved,
      status: account.active ? .running : .ready,
      lastUsed: account.active ? "Used now" : "Saved",
      providerID: account.providerId,
      canRefreshQuota: account.canRefreshQuota == true,
      savedQuota: account.savedQuota.map { quota in
        DesignSavedQuota(
          checkedAt: Date(timeIntervalSince1970: Double(quota.fetchedAtMs) / 1000),
          windows: quota.windows.map {
            DesignUsageWindow(label: $0.label, remainingPercent: $0.remainingPercent,
              resetsAtMs: $0.resetsAtMs, limitWindowSeconds: $0.limitWindowSeconds, group: $0.group)
          }
        )
      }
    )
  }

  func designGateway(_ gateway: GatewaySnapshot) -> DesignAccount {
    DesignAccount(
      id: "gateway/\(gateway.id)",
      name: gateway.name,
      detail: gateway.detail,
      provider: nativeProviderName(gateway.providerId),
      symbol: providerSymbol(gateway.providerId),
      kind: .gateway,
      status: gateway.ready ? .ready : .unavailable,
      lastUsed: gateway.ready ? "Available" : "Needs attention",
      providerID: gateway.providerId
    )
  }

  /// Tooltip for the provider picker. A row the user cannot act on keeps the
  /// engine's description, except when a sign-in method exists but its
  /// launcher is missing — then the picker says so instead of just dimming.
  static func accountProviderDetail(_ source: AccountProviderSnapshot) -> String {
    let methods = source.loginMethods ?? []
    if !methods.isEmpty, !methods.contains(where: \.available), source.livePresent != true {
      if let reason = methods.compactMap(\.unavailableReason).first(where: { !$0.isEmpty }) {
        return reason
      }
    }
    return source.detail
  }

  func accountProvider(for value: String) -> AccountProviderSnapshot? {
    store.accountProviders.first {
      $0.id.caseInsensitiveCompare(value) == .orderedSame
        || $0.providerId.caseInsensitiveCompare(value) == .orderedSame
        || $0.label.caseInsensitiveCompare(value) == .orderedSame
        || nativeProviderName($0.providerId).caseInsensitiveCompare(value) == .orderedSame
    }
  }

  func gatewayProvider(for value: String) -> GatewayProviderSnapshot? {
    store.gatewayProviders.first {
      $0.id.caseInsensitiveCompare(value) == .orderedSame
        || $0.label.caseInsensitiveCompare(value) == .orderedSame
        || nativeProviderName($0.id).caseInsensitiveCompare(value) == .orderedSame
    }
  }

  func gatewaySnapshot(for id: String) -> GatewaySnapshot? {
    let raw = id.hasPrefix("gateway/") ? String(id.dropFirst("gateway/".count)) : id
    return store.gateways.first { $0.id == raw || $0.name == raw }
  }
}
