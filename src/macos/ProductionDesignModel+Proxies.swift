import AppKit
import Combine
import Foundation
import UniformTypeIdentifiers
/// Snapshot mapping for proxies.
@MainActor
extension ProductionDesignModel {
  func designProxy(_ proxy: ProxySnapshot) -> DesignProxy {
    let required = proxyIsRequired(proxy)
    return DesignProxy(
      id: proxy.id,
      name: friendlyProxyName(label: proxy.label, providerId: proxy.providerId, using: self),
      detail: proxy.address ?? proxy.detail,
      symbol: providerSymbol(proxy.providerId),
      provider: proxy.providerId,
      status: proxy.running ? .running : proxy.enabled && required ? .attention : .stopped,
      port: servicePort(from: proxy.address) ?? 0,
      enabled: proxy.enabled,
      apiKey: "",
      hasToken: proxy.hasToken == true
    )
  }

  private func proxyIsRequired(_ proxy: ProxySnapshot) -> Bool {
    // The engine puts the provider in sourceId (`account/<provider>/<name>`).
    // It does not send upstreamProviderId, so matching that field never
    // marked a stopped proxy an app is using.
    let selectedByApp = store.actions.contains { action in
      guard action.selected,
        action.presentation == "app-route",
        action.routeKind != "direct-account",
        let account = parseAccountSource(action.sourceId)
      else { return false }
      return account.provider == proxy.providerId
    }
    let selectedByHub =
      store.proxyHub?.running == true
      && store.hubSources.contains { $0.enabled && $0.providerId == proxy.providerId }
    return selectedByApp || selectedByHub
  }

  func designServiceID(_ proxy: ProxySnapshot) -> String {
    proxy.providerId == "proxy-hub" ? "hub" : proxy.id
  }
}
