import AppKit
import Foundation
import SwiftUI

// Module: Store.swift — split from AnyPickTray.swift for maintainability.

@MainActor
final class TrayStore: ObservableObject {
  @Published private(set) var proxyCount: Int
  @Published private(set) var routes: [RouteSnapshot] = []
  @Published private(set) var actions: [ActionSnapshot] = []
  @Published private(set) var usage: [UsageSnapshot] = []
  @Published private(set) var proxies: [ProxySnapshot] = []
  @Published private(set) var accounts: [ManagedAccountSnapshot] = []
  @Published private(set) var hubSources: [HubSourceSnapshot] = []
  @Published private(set) var hubConflicts: [HubConflictSnapshot] = []
  @Published private(set) var logSources: [LogSourceSnapshot] = []
  @Published private(set) var clientModelConfigs: [ClientModelConfigSnapshot] = []
  @Published private(set) var gateways: [GatewaySnapshot] = []
  @Published private(set) var accountProviders: [AccountProviderSnapshot] = []
  @Published private(set) var gatewayProviders: [GatewayProviderSnapshot] = []
  @Published private(set) var settings = TraySettingsSnapshot(
    launchAtLogin: false,
    startEnabledProxies: true,
    showQuota: true,
    quotaGuardEnabled: false
  )
  @Published private(set) var logsBySource: [String: String] = [:]
  @Published private(set) var logStatesBySource: [String: String] = [:]
  @Published private(set) var selectedLogSourceId = ""
  @Published private(set) var loadingLogSourceId: String?
  @Published private(set) var activity: [ActivityEvent] = []
  @Published private(set) var revision = 0
  /// False until the first supervisor snapshot arrives (avoids empty-flash on launch).
  @Published private(set) var snapshotReady = false
  /// Wall-clock of the last successful snapshot (freshness caption in chrome).
  @Published private(set) var lastSnapshotAt: Date?
  @Published private(set) var busyRequestId: String?
  /// UI-facing busy flag with a short hold so ProgressView does not flash off.
  @Published private(set) var showsBusy = false
  @Published private(set) var busyLabel: String?
  @Published private(set) var message: String?
  @Published private(set) var messageIsError = false
  /// Last completed command result, keyed by request id (forms wait on this).
  @Published private(set) var lastResult: CommandResult?

  private var inputBuffer = Data()
  private var loadingLogRequestId: String?
  private var logRequestTimeoutTask: Task<Void, Never>?
  private var logPollTask: Task<Void, Never>?
  private var logPollSourceId: String?
  private var messageDismissTask: Task<Void, Never>?
  private var busyHideTask: Task<Void, Never>?

  init(initialCount: Int) {
    proxyCount = initialCount
  }

  private func beginBusy(_ requestId: String, label: String) {
    busyHideTask?.cancel()
    busyHideTask = nil
    busyRequestId = requestId
    busyLabel = label
    showsBusy = true
  }

  private func endBusy() {
    busyRequestId = nil
    busyLabel = nil
    busyHideTask?.cancel()
    // Hold the spinner ≥350ms so layout does not strobe on fast mutations.
    busyHideTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 350_000_000)
      guard let self, !Task.isCancelled, self.busyRequestId == nil else { return }
      self.showsBusy = false
    }
  }

  /// Returns false (and surfaces a message) when another mutation is already in flight.
  @discardableResult
  private func claimBusy(requestId: String, label: String) -> Bool {
    if busyRequestId != nil {
      let current = busyLabel ?? "another action"
      showMessage("Already working on \(current). Try again in a moment.", isError: true)
      return false
    }
    beginBusy(requestId, label: label)
    return true
  }

  var appRouteClients: [String] {
    var seen = Set<String>()
    return actions
      .filter { $0.enabled && $0.presentation == "app-route" }
      .compactMap { action in seen.insert(action.client).inserted ? action.client : nil }
  }

  var nativeAccounts: [ActionSnapshot] {
    actions.filter { $0.enabled && $0.presentation == "native-account" }
  }

  var nativeAccountClients: [String] {
    var seen = Set<String>()
    return nativeAccounts.compactMap { action in
      seen.insert(action.client).inserted ? action.client : nil
    }
  }

  var nativeSourceIds: [String] {
    var seen = Set<String>()
    return nativeAccounts.compactMap { action in
      seen.insert(action.sourceId).inserted ? action.sourceId : nil
    }
  }

  var primaryUsageText: String? {
    guard let window = usage.first?.windows.first else { return nil }
    return "\(window.remainingPercent)%"
  }

  var proxyHub: ProxySnapshot? {
    proxies.first { $0.providerId == "proxy-hub" }
  }

  var unavailableHubSources: [HubSourceSnapshot] {
    hubSources.filter { source in
      guard source.enabled else { return false }
      if let warning = source.warning?.trimmingCharacters(in: .whitespacesAndNewlines),
         !warning.isEmpty {
        return true
      }
      let status = source.status?.lowercased() ?? ""
      return ["attention", "error", "unavailable"].contains(status)
    }
  }

  var routingChoiceCount: Int {
    hubConflicts.filter { $0.kind == "source-choice" }.count
  }

  var routingIssueCount: Int {
    hubConflicts.filter { $0.kind != "source-choice" }.count + unavailableHubSources.count
  }

  /// Badge / menu-bar attention: routing issues + unresolved source choices.
  var attentionCount: Int {
    routingIssueCount + routingChoiceCount
  }

  /// True until AnyPick has persisted a source or route. Installed CLIs are
  /// device capabilities, not evidence that setup has happened.
  var isFirstRun: Bool {
    snapshotReady
      && accounts.isEmpty
      && gateways.isEmpty
      && !routes.contains(where: { $0.source?.isEmpty == false })
  }

  /// Installed clients come from native installation probes, not from route
  /// actions. A fresh AnyPick install has no route actions to display yet.
  var hasInstalledClient: Bool {
    accountProviders.contains { $0.clientId != nil && $0.installed }
  }

  /// Accounts exist but no installable app-route client is visible yet.
  var needsInstalledApps: Bool {
    snapshotReady
      && !accounts.isEmpty
      && !hasInstalledClient
  }

  /// Short relative freshness for chrome (“Updated just now”).
  func snapshotFreshnessText(now: Date = Date()) -> String? {
    guard let lastSnapshotAt else { return nil }
    let seconds = now.timeIntervalSince(lastSnapshotAt)
    if seconds < 8 { return "Updated just now" }
    if seconds < 60 { return "Updated \(max(1, Int(seconds)))s ago" }
    if seconds < 3600 { return "Updated \(max(1, Int(seconds / 60)))m ago" }
    return "Updated \(max(1, Int(seconds / 3600)))h ago"
  }

  func appActions(_ client: String) -> [ActionSnapshot] {
    actions.filter { $0.enabled && $0.presentation == "app-route" && $0.client == client }
  }

  func nativeActions(_ client: String) -> [ActionSnapshot] {
    nativeAccounts.filter { $0.client == client }
  }

  func nativeSourceActions(_ sourceId: String) -> [ActionSnapshot] {
    nativeAccounts.filter { $0.sourceId == sourceId }
  }

  func route(_ client: String) -> RouteSnapshot? {
    routes.first { $0.client == client }
  }

  func modelConfig(_ client: String) -> ClientModelConfigSnapshot? {
    clientModelConfigs.first { $0.client == client || $0.clientId == client }
  }

  /// Match usage cards by short client name, display name, or source id.
  func usage(for client: String) -> UsageSnapshot? {
    let needle = client.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return nil }
    let display = anypickDisplayName(needle)
    return usage.first { card in
      card.client.caseInsensitiveCompare(needle) == .orderedSame
        || card.client.caseInsensitiveCompare(display) == .orderedSame
        || card.account.localizedCaseInsensitiveContains(needle)
        || needle.localizedCaseInsensitiveContains(card.client)
    }
  }

  func consume(_ data: Data) {
    inputBuffer.append(data)
    while let newline = inputBuffer.firstIndex(of: 10) {
      let lineData = inputBuffer.prefix(upTo: newline)
      inputBuffer.removeSubrange(...newline)
      guard let line = String(data: lineData, encoding: .utf8) else { continue }
      consume(line)
    }
  }

  func invoke(_ action: ActionSnapshot) {
    guard action.enabled else { return }
    _ = invoke(actionId: action.id, label: action.label)
  }

  @discardableResult
  func invoke(actionId: String, label: String) -> String? {
    let requestId = UUID().uuidString
    let invocation = Invocation(requestId: requestId, revision: revision, actionId: actionId)
    guard let data = try? JSONEncoder().encode(invocation) else { return nil }
    guard claimBusy(requestId: requestId, label: label) else { return nil }
    showMessage("Working on \(label)…", isError: false)
    emit("invoke\t\(data.base64EncodedString())")
    return requestId
  }

  @discardableResult
  func applyModelRoles(clientId: String, roleActionIds: [String: String], label: String) -> String? {
    guard roleActionIds["default"] != nil else { return nil }
    let requestId = UUID().uuidString
    let command = ModelRolesCommand(
      requestId: requestId,
      revision: revision,
      clientId: clientId,
      roleActionIds: roleActionIds
    )
    guard let data = try? JSONEncoder().encode(command) else { return nil }
    guard claimBusy(requestId: requestId, label: "\(label) models") else { return nil }
    showMessage("Applying \(label) models…", isError: false)
    emit("model-roles\t\(data.base64EncodedString())")
    return requestId
  }

  @discardableResult
  func mutate(
    operation: String,
    name: String,
    providerId: String? = nil,
    sourceId: String? = nil,
    label: String? = nil,
    endpoint: String? = nil,
    apiKey: String? = nil,
    region: String? = nil,
    defaultModel: String? = nil,
    overwrite: Bool? = nil,
    enabled: Bool? = nil,
    activityLabel: String
  ) -> String? {
    let requestId = UUID().uuidString
    let mutation = Mutation(
      requestId: requestId,
      operation: operation,
      providerId: providerId,
      sourceId: sourceId,
      name: name,
      label: label,
      endpoint: endpoint,
      apiKey: apiKey,
      region: region,
      defaultModel: defaultModel,
      overwrite: overwrite,
      enabled: enabled
    )
    guard let data = try? JSONEncoder().encode(mutation) else { return nil }
    guard claimBusy(requestId: requestId, label: activityLabel) else { return nil }
    showMessage("Working on \(activityLabel)…", isError: false)
    emit("mutate\t\(data.base64EncodedString())")
    return requestId
  }

  func requestLogs(_ source: LogSourceSnapshot, lines: Int = 160, silent: Bool = false) {
    requestLogs(
      id: source.id,
      providerId: source.providerId,
      name: source.name,
      lines: lines,
      silent: silent
    )
  }

  func selectLogSource(_ sourceId: String) {
    guard logSources.contains(where: { $0.id == sourceId }) else { return }
    selectedLogSourceId = sourceId
  }

  func requestLogs(_ proxy: ProxySnapshot, lines: Int = 80, silent: Bool = false) {
    requestLogs(
      id: proxy.id,
      providerId: proxy.providerId,
      name: proxy.id.components(separatedBy: "/").dropFirst().joined(separator: "/"),
      lines: lines,
      silent: silent
    )
  }

  /// Poll the selected log source while the Logs panel is visible.
  func startLogPolling(for sourceId: String) {
    guard logPollSourceId != sourceId else { return }
    stopLogPolling()
    logPollSourceId = sourceId
    logPollTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        guard self.logPollSourceId == sourceId else { return }
        if let source = self.logSources.first(where: { $0.id == sourceId }),
           self.loadingLogSourceId == nil {
          self.requestLogs(source, silent: true)
        }
        try? await Task.sleep(nanoseconds: 1_750_000_000)
      }
    }
  }

  func stopLogPolling() {
    logPollTask?.cancel()
    logPollTask = nil
    logPollSourceId = nil
  }

  private func requestLogs(
    id: String,
    providerId: String,
    name: String,
    lines: Int,
    silent: Bool = false
  ) {
    guard loadingLogSourceId == nil else { return }
    let requestId = UUID().uuidString
    let request = ProxyLogsRequest(
      requestId: requestId,
      providerId: providerId,
      name: name,
      lines: lines
    )
    guard let data = try? JSONEncoder().encode(request) else { return }
    logRequestTimeoutTask?.cancel()
    loadingLogSourceId = id
    loadingLogRequestId = requestId
    emit("logs\t\(data.base64EncodedString())")
    logRequestTimeoutTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 10_000_000_000)
      guard !Task.isCancelled,
            let self,
            self.loadingLogRequestId == requestId else { return }
      // Background polls fail quietly; keep the last good tail on screen.
      if !silent {
        self.logsBySource[id] = "The log request timed out. Refresh to try again."
        self.logStatesBySource[id] = "error"
        self.showMessage("The log request timed out. Refresh to try again.", isError: true)
      }
      self.loadingLogSourceId = nil
      self.loadingLogRequestId = nil
    }
  }

  func openAnyPick() { emit("open") }
  func refreshAll() { emit("refresh") }
  func restartProxies() {
    mutate(
      operation: "proxy-restart-all",
      name: "all",
      activityLabel: "restarting enabled proxies"
    )
  }
  func stopProxies() {
    mutate(operation: "proxy-stop-all", name: "all", activityLabel: "stopping all proxies")
  }
  func navigate(_ screen: String) { emit("navigate\t\(screen)") }

  func copyAddress(_ address: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(address, forType: .string)
    showMessage("Copied \(address)", isError: false)
  }

  func copyLogs(for sourceId: String) {
    guard let text = logsBySource[sourceId], !text.isEmpty else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    showMessage("Copied visible logs", isError: false)
  }

  func dismissMessage() {
    messageDismissTask?.cancel()
    messageDismissTask = nil
    withAnimation(TrayMotion.message) { message = nil }
  }

  func quitAnyPick() {
    emit("quit")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { NSApp.terminate(nil) }
  }

  private func consume(_ line: String) {
    let fields = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
      .map(String.init)
    guard fields.count == 2 else { return }
    if fields[0] == "snapshot",
       let data = Data(base64Encoded: fields[1]),
       let snapshot = try? JSONDecoder().decode(TraySnapshot.self, from: data) {
      let firstSnapshot = !snapshotReady
      revision = snapshot.revision
      proxyCount = snapshot.proxyCount
      routes = snapshot.routes
      actions = snapshot.actions
      usage = snapshot.usage
      proxies = snapshot.proxies
      accounts = snapshot.accounts
      hubSources = snapshot.hubSources ?? []
      hubConflicts = snapshot.hubConflicts ?? []
      logSources = snapshot.logSources ?? snapshot.proxies.compactMap { proxy in
        guard proxy.logsAvailable != false else { return nil }
        return LogSourceSnapshot(
          id: proxy.id,
          label: proxy.label,
          detail: proxy.detail,
          providerId: proxy.providerId,
          name: proxy.id.components(separatedBy: "/").dropFirst().joined(separator: "/")
        )
      }
      clientModelConfigs = snapshot.clientModelConfigs ?? []
      if !logSources.contains(where: { $0.id == selectedLogSourceId }) {
        selectedLogSourceId = logSources.first?.id ?? ""
      }
      gateways = snapshot.gateways
      accountProviders = snapshot.accountProviders
      gatewayProviders = snapshot.gatewayProviders
      settings = snapshot.settings
      activity = snapshot.activity
      snapshotReady = true
      lastSnapshotAt = Date()
      // Soft fade-in of the first real state (respect Reduce Motion via TrayMotion).
      if firstSnapshot {
        withAnimation(TrayMotion.standard) {}
      }
      return
    }
    if fields[0] == "status", let count = Int(fields[1]) {
      proxyCount = count
      return
    }
    if fields[0] == "logs",
       let data = Data(base64Encoded: fields[1]),
       let result = try? JSONDecoder().decode(ProxyLogsResult.self, from: data),
       result.version == 1,
       result.requestId == loadingLogRequestId {
      logRequestTimeoutTask?.cancel()
      logRequestTimeoutTask = nil
      logsBySource[result.proxyId] = result.text
      logStatesBySource[result.proxyId] = result.state ?? (result.text.isEmpty ? "empty" : "ready")
      if loadingLogSourceId == result.proxyId { loadingLogSourceId = nil }
      loadingLogRequestId = nil
      return
    }
    if fields[0] == "result",
       let data = Data(base64Encoded: fields[1]),
       let result = try? JSONDecoder().decode(CommandResult.self, from: data),
       result.version == 1,
       result.requestId == busyRequestId {
      let isError = result.status == "error"
      lastResult = result
      showMessage(
        concise(
          result.message,
          fallback: result.status == "success" ? "Action completed" : "Action failed"
        ),
        isError: isError
      )
      endBusy()
    }
  }

  private func showMessage(_ value: String, isError: Bool) {
    messageDismissTask?.cancel()
    withAnimation(TrayMotion.message) {
      message = value
      messageIsError = isError
    }
    if isError {
      trayHapticError()
    } else if !value.hasPrefix("Working on"), !value.hasPrefix("Applying ") {
      // Success only — skip “Working on …” intermediate toasts.
      trayHapticSuccess()
    }
    // VoiceOver / accessibility: announce status without forcing focus.
    NSAccessibility.post(
      element: NSApp as Any,
      notification: .announcementRequested,
      userInfo: [
        .announcement: value as NSString,
        .priority: (isError
          ? NSAccessibilityPriorityLevel.high
          : NSAccessibilityPriorityLevel.medium).rawValue as NSNumber,
      ]
    )
    // Errors stay until dismissed; successes auto-clear after a short beat.
    guard !isError else { return }
    messageDismissTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 4_000_000_000)
      guard !Task.isCancelled else { return }
      self?.dismissMessage()
    }
  }

  private func emit(_ command: String) {
    FileHandle.standardOutput.write(Data("\(command)\n".utf8))
    try? FileHandle.standardOutput.synchronize()
  }

  private func concise(_ value: String?, fallback: String) -> String {
    let compact = value?
      .replacingOccurrences(of: "\n", with: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return compact.isEmpty ? fallback : String(compact.prefix(200))
  }
}
