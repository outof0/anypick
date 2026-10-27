import AppKit
import Combine
import Foundation
import UniformTypeIdentifiers
/// Snapshot mapping for hub sources.
@MainActor
extension ProductionDesignModel {
  func designHubSource(_ source: HubSourceSnapshot) -> DesignHubSource {
    var detail = source.detail.trimmingCharacters(in: .whitespacesAndNewlines)
    if detail.isEmpty || detail.contains("/") || detail.caseInsensitiveCompare(source.providerId) == .orderedSame {
      if let account = store.accounts.first(where: {
        $0.providerId == source.providerId && ($0.name == source.name || $0.label == source.label || $0.id.hasSuffix("/\(source.name)"))
      }), !account.detail.isEmpty {
        detail = account.detail
      }
    }
    return DesignHubSource(
      id: source.id,
      name: source.label,
      detail: detail,
      provider: nativeProviderName(source.providerId),
      providerID: source.providerId,
      symbol: providerSymbol(source.providerId),
      enabled: source.enabled,
      warning: source.warning,
      modelCount: source.modelCount ?? 0,
      rotates: source.rotates ?? false,
      rotatesAccountCount: source.accountCount ?? 0,
      poolSource: source.poolSource ?? false,
      hub: source.hub ?? "default",
      strategy: source.strategy ?? ""
    )
  }

  func normalizedHubOwnerID(_ ownerID: String?) -> String? {
    guard let ownerID, !ownerID.isEmpty else { return nil }
    if store.hubSources.contains(where: { $0.id == ownerID }) {
      return ownerID
    }
    // Older engine snapshots used provider/account. Resolve that legacy form
    // against the complete source ids without guessing across providers.
    let suffix = "/" + ownerID
    if let match = store.hubSources.first(where: { $0.id.hasSuffix(suffix) }) {
      return match.id
    }
    // If ownerID is a provider ID (e.g. "provider/opencode" or "opencode")
    let clean = ownerID.hasPrefix("provider/") ? String(ownerID.dropFirst(9)) : ownerID
    if let match = store.hubSources.first(where: {
      $0.providerId.lowercased() == clean.lowercased()
    }) {
      return match.id
    }
    return ownerID
  }
}
