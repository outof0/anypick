import AppKit
import Combine
import Foundation
import UniformTypeIdentifiers
/// Activity, log, and setting helpers.
@MainActor
extension ProductionDesignModel {
  /// Send a setting mutate, holding the local value until it settles.
  func sendSetting(key: String, changed: Bool, mutate: () -> String?) {
    guard changed else { return }
    pendingSettings.insert(key)
    guard let requestID = mutate() else {
      pendingSettings.remove(key)
      return
    }
    pendingOperations[requestID] = "setting-\(key)"
    operationResult = nil
  }

  // Activity is always the journal-backed event history. Live logs travel on
  // the separate liveLogLines path; mapping them into DesignActivity here used
  // index-based ids ("log-<index>-<hash>") that shifted on every appended
  // line, re-identifying the whole list on each 1.75s poll — the flicker.
  func designActivity() -> [DesignActivity] {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm"
    return store.activity.filter { !clearedActivityIDs.contains($0.id) }.map {
      DesignActivity(
        id: $0.id,
        day: activityDayLabel($0.date),
        time: formatter.string(from: $0.date),
        title: $0.message,
        detail: activityDetail($0.kind, isError: $0.isError),
        symbol: activitySymbol($0.kind),
        status: $0.isError ? .attention : .ready,
        provider: $0.provider,
        kind: $0.kind
      )
    }
  }

  private func activityDayLabel(_ date: Date) -> String {
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return "Today" }
    if calendar.isDateInYesterday(date) { return "Yesterday" }
    return date.formatted(date: .abbreviated, time: .omitted)
  }

  var selectedLogSource: LogSourceSnapshot? {
    store.logSources.first { $0.id == store.selectedLogSourceId } ?? store.logSources.first
  }

  func designLogLines() -> [String] {
    guard let source = selectedLogSource,
      let text = store.logsBySource[source.id], !text.isEmpty
    else { return [] }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    // The cleared state is content-anchored: only hide while the tail still
    // starts with the cleared snapshot. Rotation or a restart replaces the
    // content — even at the same length — so reset and show the new logs
    // instead of hiding them behind a stale count.
    var hidden = 0
    if let snapshot = clearedLogSnapshots[source.id] {
      if lines.starts(with: snapshot) {
        hidden = snapshot.count
      } else {
        clearedLogSnapshots.removeValue(forKey: source.id)
      }
    }
    let visible = visibleLogLines(lines, hiddenCount: &hidden)
    return visible
  }

  func synchronizeLogState() {
    // Every assignment below goes through setLogState so an unchanged
    // state/message pair stays quiet instead of rebuilding the pane.
    guard let source = selectedLogSource else {
      setLogState(.unavailable, message: localized("desktop.activity.choose_log_source"))
      return
    }
    // Background polls set loadingLogSourceId on every 1.75s tick. Flipping
    // to .loading each time swaps the notice row (ProgressView in/out) and
    // hides the Live badge — the flicker. When a tail is already on screen,
    // stay .ready through the refresh; only the first load shows .loading.
    if store.loadingLogSourceId == source.id,
      store.logsBySource[source.id]?.isEmpty != false
    {
      setLogState(
        .loading,
        message: localized("desktop.activity.loading_logs_for_source", replacing: ["source": source.label])
      )
      return
    }
    let serviceRunning: Bool
    if store.proxyHub?.id == source.id {
      serviceRunning = store.proxyHub?.running == true
    } else if let proxy = store.proxies.first(where: { $0.id == source.id }) {
      serviceRunning = proxy.running
    } else {
      // An orphaned source is unavailable rather than an empty log.
      setLogState(.unavailable, message: localized("desktop.activity.log_unavailable_detail"))
      return
    }
    if !serviceRunning {
      let startTarget = store.proxyHub?.id == source.id
        ? localized("desktop.nav.proxy_hub") : localized("desktop.activity.kind_proxy")
      setLogState(
        .stopped,
        message: localized("desktop.activity.stopped_log_detail", replacing: ["service": startTarget])
      )
      return
    }
    switch store.logStatesBySource[source.id] {
    case "error":
      setLogState(.error, message: localized("desktop.activity.showing_loaded_logs"))
    case "empty":
      setLogState(.empty, message: localized("desktop.activity.service_no_logs"))
    case "ready":
      setLogState(.ready, message: nil)
    default:
      setLogState(
        store.logsBySource[source.id]?.isEmpty == false ? .ready : .idle, message: nil)
    }
  }

  /// @Published fires on every set even when the value is identical; route
  /// all log-state writes through here so steady states stay quiet.
  private func setLogState(_ state: DesignLogState, message: String?) {
    if logState != state {
      logState = state
    }
    if logStateMessage != message {
      logStateMessage = message
    }
  }

  private func activityDetail(_ kind: String, isError: Bool) -> String {
    switch kind {
    case "account":
      return localized(isError ? "desktop.activity.detail_account_not_changed" : "desktop.activity.detail_account_updated")
    case "gateway":
      return localized(isError ? "desktop.activity.detail_gateway_not_changed" : "desktop.activity.detail_gateway_updated")
    case "proxy":
      return localized(isError ? "desktop.activity.detail_proxy_attention" : "desktop.activity.detail_proxy_updated")
    case "quota":
      return localized(isError ? "desktop.activity.detail_usage_failed" : "desktop.activity.detail_usage_refreshed")
    case "settings":
      return localized(isError ? "desktop.activity.detail_setting_not_changed" : "desktop.activity.detail_setting_updated")
    default:
      return localized(isError ? "desktop.activity.detail_routing_kept" : "desktop.activity.detail_routing_updated")
    }
  }

  func nativeAccountOrder(_ lhs: DesignAccount, _ rhs: DesignAccount) -> Bool {
    if lhs.kind != rhs.kind { return lhs.kind == .saved }
    let lhsIndex = nativeProviderPriority(lhs.provider)
    let rhsIndex = nativeProviderPriority(rhs.provider)
    if lhsIndex != rhsIndex { return lhsIndex < rhsIndex }
    return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
  }

  private func activitySymbol(_ kind: String) -> String {
    switch kind {
    case "account": return "person.crop.circle"
    case "gateway": return "network"
    case "proxy": return "bolt.circle"
    case "quota": return "gauge.with.dots.needle.67percent"
    default: return "arrow.left.arrow.right.circle"
    }
  }
}
