import AppKit
import Foundation
import SwiftUI


@MainActor
final class TrayStore: ObservableObject {
  // MARK: - State

  @Published private(set) var proxyCount: Int
  @Published private(set) var routes: [RouteSnapshot] = []
  @Published private(set) var actions: [ActionSnapshot] = []
  @Published private(set) var usage: [UsageSnapshot] = []
  @Published private(set) var proxies: [ProxySnapshot] = []
  @Published private(set) var accounts: [ManagedAccountSnapshot] = []
  @Published private(set) var hubSources: [HubSourceSnapshot] = []
  @Published private(set) var hubConflicts: [HubConflictSnapshot] = []
  @Published private(set) var hubPublishedModels: [HubPublishedModelSnapshot] = []
  @Published private(set) var hubCatalogs: [HubCatalogSnapshot] = []
  @Published private(set) var logSources: [LogSourceSnapshot] = []
  @Published private(set) var clientModelConfigs: [ClientModelConfigSnapshot] = []
  @Published private(set) var codexProfiles: [CodexProfileSnapshot] = []
  @Published private(set) var codexProfileSources: [CodexProfileSourceSnapshot] = []
  @Published private(set) var gateways: [GatewaySnapshot] = []
  @Published private(set) var accountProviders: [AccountProviderSnapshot] = []
  @Published private(set) var gatewayProviders: [GatewayProviderSnapshot] = []
  @Published private(set) var settings = TraySettingsSnapshot(
    launchAtLogin: false,
    startEnabledProxies: true,
    showQuota: true,
    quotaGuardEnabled: false,
    language: "auto",
    resolvedLanguage: "en",
    languageOptions: LanguageOptionSnapshot.defaultOptions
  )
  @Published private(set) var logsBySource: [String: String] = [:]
  @Published var logStatesBySource: [String: String] = [:]
  @Published private(set) var doctorResult: DoctorResult?
  @Published private(set) var doctorIsRunning = false
  @Published private(set) var doctorError: String?
  @Published var selectedLogSourceId = ""
  @Published var loadingLogSourceId: String?
  @Published private(set) var activity: [ActivityEvent] = []
  @Published private(set) var degradedConditions: [DegradedConditionSnapshot] = []
  @Published private(set) var revision = 0
  /// False until the first supervisor snapshot arrives (avoids empty-flash on launch).
  @Published private(set) var snapshotReady = false
  /// Wall-clock of the last successful snapshot (freshness caption in chrome).
  @Published private(set) var lastSnapshotAt: Date?
  @Published private(set) var busyRequestId: String?
  /// UI-facing busy flag with a short hold so ProgressView does not flash off.
  @Published private(set) var showsBusy = false
  @Published private(set) var busyLabel: String?
  @Published var message: String?
  @Published private(set) var messageIsError = false
  /// Last completed command result, keyed by request id (forms wait on this).
  @Published private(set) var lastResult: CommandResult?
  /// Read-only backup preview state is independent from mutation busy/result state.
  @Published var backupPreview: BackupPreviewResult?
  @Published var backupPreviewRequestId: String?

  @Published private(set) var serviceState: AppServiceConnectionState = .starting
  /// Frame kinds this build has already reported as unreadable. One report per
  /// kind is enough: the engine writes whole frames, so a payload this build
  /// cannot decode will not decode on the next 2.5s tick either, and repeating
  /// the message would bury every real status under it.
  private var unreadableFrames = Set<String>()

  private var inputBuffer = Data()
  private var commandSink: ((String) -> Void)?
  /// The last action the app asked the engine to run (see
  /// retryInvokeWithConsent).
  private var lastInvoke: (requestId: String, actionId: String, label: String)?
  private var silentRequestIDs = Set<String>()
  var loadingLogRequestId: String?
  var logRequestTimeoutTask: Task<Void, Never>?
  var doctorRequestId: String?
  var doctorTimeoutTask: Task<Void, Never>?
  var logPollTask: Task<Void, Never>?
  var logPollSourceId: String?
  var inspectedBackupPath: String?
  var backupPreviewTimeoutTask: Task<Void, Never>?
  var messageDismissTask: Task<Void, Never>?
  private var busyHideTask: Task<Void, Never>?

  // MARK: - Construction

  init(initialCount: Int) {
    proxyCount = initialCount
  }

  // MARK: - Service

  func attachCommandSink(_ sink: @escaping (String) -> Void) {
    commandSink = sink
  }

  /// Relaunch hook for terminal-degraded recovery (the error screen's Try
  /// Again). Wired by AppDelegate next to the command sink; nil in fixture
  /// and tests, where there is no service to relaunch.
  var restartService: (() -> Void)?

  func updateServiceState(_ state: AppServiceConnectionState) {
    serviceState = state
    if case .degraded = state {
      if doctorRequestId != nil {
        finishDoctorRequest(error: "The AnyPick service stopped before Doctor finished.")
      }
      // A crashed or incompatible helper cannot deliver the result for the
      // mutation that was in flight. Release the single-flight slot here so
      // forms can receive the failure and retry instead of staying disabled.
      if let busyRequestId {
        silentRequestIDs.remove(busyRequestId)
        endBusy()
      }
      return
    }
    if state == .ready {
      // A fresh generation gets its own report per frame kind: the user was
      // told to restart, so if the frames still do not decode they must hear
      // it again rather than have it filtered as already-reported.
      unreadableFrames.removeAll()
    }
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
  private func claimBusy(requestId: String, label: String, silentFeedback: Bool = false) -> Bool {
    if busyRequestId != nil {
      let current = busyLabel ?? "another action"
      if !silentFeedback {
        showMessage("Already working on \(current). Try again in a moment.", isError: true)
      }
      return false
    }
    beginBusy(requestId, label: label)
    return true
  }

  func sendMutationCommand<T: Encodable>(
    _ mutation: T,
    requestId: String,
    activityLabel: String,
    silentFeedback: Bool = false
  ) -> String? {
    guard commandCanBeAccepted(silentFeedback: silentFeedback) else { return nil }
    guard let data = encodeCommand(mutation) else { return nil }
    let command = "mutate\t\(data.base64EncodedString())"
    guard command.lengthOfBytes(using: .utf8) <= 16 * 1024 else {
      showMessage(
        "This request is too large to send. Shorten entered values or select fewer accounts, then try again.",
        isError: true
      )
      return nil
    }
    guard claimBusy(requestId: requestId, label: activityLabel, silentFeedback: silentFeedback) else {
      return nil
    }
    if silentFeedback {
      silentRequestIDs.insert(requestId)
    } else {
      showMessage("Working on \(activityLabel)…", isError: false)
    }
    emit(command)
    return requestId
  }

  /// Termination hook. Production wires the delegate path (menu-bar Quit
  /// semantics: Dock/⌘Q hides instead of killing); unset falls back to a
  /// plain terminate. The hook keeps TrayStore free of the app delegate so
  /// the unit-test target can compile the store without the app scene.
  var quitHandler: (() -> Void)?


  // MARK: - Frame consume, invoke, and mutation pipeline

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
  func invoke(actionId: String, label: String, allowForeignConfig: Bool = false) -> String? {
    guard commandCanBeAccepted() else { return nil }
    let requestId = UUID().uuidString
    let invocation = Invocation(
      requestId: requestId,
      revision: revision,
      actionId: actionId,
      allowForeignConfig: allowForeignConfig ? true : nil
    )
    guard let data = encodeCommand(invocation) else { return nil }
    guard claimBusy(requestId: requestId, label: label) else { return nil }
    // Remembered so a CLIENT_CONFIG_FOREIGN refusal can be retried with the
    // user's consent instead of dead-ending the sheet that raised it. Keyed by
    // request id: a later mutation must not be answered by replaying this
    // action.
    lastInvoke = (requestId: requestId, actionId: actionId, label: label)
    showMessage("Working on \(label)…", isError: false)
    emit("invoke\t\(data.base64EncodedString())")
    return requestId
  }

  /// Re-runs the action whose takeover the engine refused, now with the user's
  /// consent. Only the refused request may be retried: any other id means the
  /// offer is stale, and replaying a different action under consent would be
  /// exactly the unasked-for takeover the gate exists to prevent.
  @discardableResult
  func retryInvokeWithConsent(requestId: String) -> String? {
    guard let target = lastInvoke, target.requestId == requestId else { return nil }
    return invoke(actionId: target.actionId, label: target.label, allowForeignConfig: true)
  }

  @discardableResult
  func applyModelRoles(
    clientId: String,
    roleActionIds: [String: String],
    label: String,
    scope: String = "connection"
  ) -> String? {
    // Empty roles clear the pins (reset); anything else still needs a default.
    if !roleActionIds.isEmpty {
      guard roleActionIds["default"] != nil else { return nil }
    }
    guard commandCanBeAccepted() else { return nil }
    let requestId = UUID().uuidString
    let command = ModelRolesCommand(
      requestId: requestId,
      revision: revision,
      clientId: clientId,
      roleActionIds: roleActionIds,
      scope: scope
    )
    guard let data = encodeCommand(command) else { return nil }
    guard claimBusy(requestId: requestId, label: "\(label) models") else { return nil }
    showMessage("Applying \(label) models…", isError: false)
    emit("model-roles\t\(data.base64EncodedString())")
    return requestId
  }

  @discardableResult
  func mutate(
    operation: String,
    name: String? = nil,
    providerId: String? = nil,
    sourceId: String? = nil,
    methodId: String? = nil,
    label: String? = nil,
    endpoint: String? = nil,
    apiKey: String? = nil,
    region: String? = nil,
    gatewayId: String? = nil,
    defaultModel: String? = nil,
    overwrite: Bool? = nil,
    enabled: Bool? = nil,
    language: String? = nil,
    kind: String? = nil,
    profile: String? = nil,
    path: String? = nil,
    transportPolicy: String? = nil,
    sourceIDs: [String]? = nil,
    activityLabel: String,
    silentFeedback: Bool = false
  ) -> String? {
    let requestId = UUID().uuidString
    let mutation = Mutation(
      requestId: requestId,
      operation: operation,
      providerId: providerId,
      sourceId: sourceId,
      methodId: methodId,
      name: name,
      path: path,
      label: label,
      endpoint: endpoint,
      apiKey: apiKey,
      region: region,
      gatewayId: gatewayId,
      defaultModel: defaultModel,
      overwrite: overwrite,
      enabled: enabled,
      language: language,
      kind: kind,
      profile: profile,
      transportPolicy: transportPolicy,
      sourceIds: sourceIDs
    )
    return sendMutation(mutation, activityLabel: activityLabel, silentFeedback: silentFeedback)
  }

  func sendMutation(
    _ mutation: Mutation,
    activityLabel: String,
    silentFeedback: Bool = false
  ) -> String? {
    sendMutationCommand(
      mutation,
      requestId: mutation.requestId,
      activityLabel: activityLabel,
      silentFeedback: silentFeedback
    )
  }

  func cancelMutation(requestId: String) {
    guard busyRequestId == requestId else { return }
    let request = CancellationRequest(requestId: requestId)
    guard let data = encodeCommand(request) else { return }
    busyLabel = "cancelling sign-in"
    showMessage("Cancelling sign-in…", isError: false)
    emit("cancel\t\(data.base64EncodedString())")
  }

  func requestDoctor() {
    guard doctorRequestId == nil, commandCanBeAccepted() else { return }
    let requestId = UUID().uuidString
    let request = DoctorRequest(requestId: requestId)
    guard let data = encodeCommand(request) else { return }
    doctorError = nil
    doctorRequestId = requestId
    doctorIsRunning = true
    emit("doctor\t\(data.base64EncodedString())")
    doctorTimeoutTask?.cancel()
    doctorTimeoutTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 25_000_000_000)
      guard !Task.isCancelled, let self, self.doctorRequestId == requestId else { return }
      self.finishDoctorRequest(error: "Doctor did not finish. Try again when AnyPick is ready.")
    }
  }

  private func finishDoctorRequest(error: String? = nil) {
    doctorTimeoutTask?.cancel()
    doctorTimeoutTask = nil
    doctorRequestId = nil
    doctorIsRunning = false
    if let error { doctorError = error }
  }

  private func consume(_ line: String) {
    let fields = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
      .map(String.init)
    guard fields.count == 2 else { return }
    if fields[0] == "snapshot",
       let snapshot: TraySnapshot = decodeFrame("snapshot", fields[1]) {
      apply(snapshot)
      return
    }
    if fields[0] == "snapshot-event",
       let event: AppServiceSnapshotEvent = decodeFrame("snapshot-event", fields[1]),
       event.protocolVersion == 2,
       event.revision == event.snapshot.revision {
      apply(event.snapshot)
      return
    }
    if fields[0] == "usage-event",
       let event: AppServiceUsageEvent = decodeFrame("usage-event", fields[1]),
       event.protocolVersion == 2,
       event.revision >= revision {
      usage = event.usage
      lastSnapshotAt = Date()
      return
    }
    if fields[0] == "doctor",
       let result: DoctorResult = decodeFrame("doctor", fields[1]),
       result.version == 1,
       result.requestId == doctorRequestId {
      doctorResult = result
      doctorError = nil
      finishDoctorRequest()
      return
    }
    if fields[0] == "protocol-error",
       let protocolError: AppServiceErrorFrame = decodeFrame("protocol-error", fields[1]),
       protocolError.protocolVersion == 2 {
      // A protocol error means the engine refused a frame outright and will
      // never answer it. The mutation slot it was holding must be released
      // here, or the sheet that sent it stays disabled with no way out.
      // An unnamed rejection carries no request id. A nil doctor slot would
      // compare equal and swallow the toast, leaving the earlier "Working on"
      // line on screen after the mutation slot had already been released.
      let isDoctorRequest = protocolError.requestId != nil && protocolError.requestId == doctorRequestId
      let isSilentRequest = protocolError.requestId.map { silentRequestIDs.remove($0) != nil } ?? false
      if !isDoctorRequest && !isSilentRequest {
        showMessage(
          concise(protocolError.message, fallback: "AnyPick rejected that request."),
          isError: true
        )
      }
      // A named failure is answered like a failed result: the row that sent it
      // must stop spinning. Without this the operation ran to the host's
      // confirm timeout and reported "did not confirm in time" instead of what
      // the engine said.
      if let requestId = protocolError.requestId {
        // Log and backup-review requests are not mutations: they own their own
        // slots, and the engine's rejection is their terminal answer.
        if requestId == loadingLogRequestId {
          finishLogRequest()
        }
        if requestId == backupPreviewRequestId {
          backupPreviewTimeoutTask?.cancel()
          backupPreviewTimeoutTask = nil
          backupPreviewRequestId = nil
        }
        if requestId == doctorRequestId {
          finishDoctorRequest(error: concise(
            protocolError.message, fallback: "Doctor could not complete the check."
          ))
        }
      }
      if let requestId = protocolError.requestId,
         requestId == busyRequestId,
         lastResult?.requestId != requestId {
        lastResult = CommandResult(
          version: 1,
          requestId: requestId,
          status: "error",
          message: protocolError.message,
          code: protocolError.code,
          suggestions: nil,
          mutated: nil
        )
      }
      // Only a rejection that names no request, or one that names the request
      // the mutation slot is holding, releases that slot. A log or backup
      // rejection has its own slot and must leave the mutation running.
      if protocolError.requestId == nil || protocolError.requestId == busyRequestId {
        if busyRequestId != nil { endBusy() }
      }
      return
    }
    if fields[0] == "status" {
      guard let count = Int(fields[1]) else {
        reportUnreadableFrame("status")
        return
      }
      proxyCount = count
      return
    }
    if fields[0] == "logs",
       let result: ProxyLogsResult = decodeFrame("logs", fields[1]),
       result.version == 1,
       result.requestId == loadingLogRequestId {
      logRequestTimeoutTask?.cancel()
      logRequestTimeoutTask = nil
      // Background polls re-deliver identical tails every 1.75s. Publishing
      // them unconditionally re-renders the log view and resets its scroll,
      // so skip the write when nothing changed. An "error" frame never
      // carries replacement text: keep the last good tail on screen
      // and only publish the state flip.
      let nextState = result.state ?? (result.text.isEmpty ? "empty" : "ready")
      if nextState != "error", logsBySource[result.proxyId] != result.text {
        logsBySource[result.proxyId] = result.text
      }
      if logStatesBySource[result.proxyId] != nextState {
        logStatesBySource[result.proxyId] = nextState
      }
      if loadingLogSourceId == result.proxyId { loadingLogSourceId = nil }
      loadingLogRequestId = nil
      logRequestTimeoutTask?.cancel()
      logRequestTimeoutTask = nil
      return
    }
    if fields[0] == "result",
       let result: CommandResult = decodeFrame("result", fields[1]),
       result.requestId == doctorRequestId {
      finishDoctorRequest(error: result.displayMessage ?? "Doctor could not complete the check.")
      return
    }
    if fields[0] == "backup-preview",
       let result: BackupPreviewResult = decodeFrame("backup-preview", fields[1]),
       result.version == 1,
       result.requestId == backupPreviewRequestId,
       (result.status == "ready"
         ? result.inspectionId != nil && result.createdAt != nil && result.entries != nil
         : result.status == "error"
           && result.error == "inspection-failed"
           && result.code == "BACKUP_INSPECT_FAILED"
           && result.reason != nil) {
      backupPreviewTimeoutTask?.cancel()
      backupPreviewTimeoutTask = nil
      backupPreviewRequestId = nil
      backupPreview = result
      return
    }
    if fields[0] == "result" {
      guard let result: CommandResult = decodeFrame("result", fields[1]) else { return }
      guard result.version == 1, result.requestId == busyRequestId else { return }
      let isSilentRequest = silentRequestIDs.remove(result.requestId) != nil
      let isError = result.status == "error"
      lastResult = result
      if !isSilentRequest {
        showMessage(
          result.displayMessage
            ?? (result.status == "success" ? "Action completed" : "Action failed"),
          isError: isError
        )
      }
      endBusy()
    }
  }

  /// Decodes one frame body, reporting the failure instead of dropping the
  /// frame. Every frame goes through here: a payload this build cannot read
  /// means the app and its bundled engine disagree, and the previous `try?`
  /// per branch turned that into a spinner, a stale pane or nothing at all.
  /// Returning nil skips the frame; validation guards (`protocolVersion == 2`,
  /// `requestId == busyRequestId`) stay at the call sites because a stale or
  /// duplicate frame is normal, not an error.
  private func decodeFrame<T: Decodable>(_ kind: String, _ encoded: String) -> T? {
    guard let data = Data(base64Encoded: encoded),
          let value = try? JSONDecoder().decode(T.self, from: data)
    else {
      reportUnreadableFrame(kind)
      return nil
    }
    return value
  }

  /// Reports a frame this build cannot decode, once per kind, and releases the
  /// mutation slot if one is waiting on it.
  private func reportUnreadableFrame(_ kind: String) {
    guard unreadableFrames.insert(kind).inserted else { return }
    let isState = kind == "snapshot" || kind == "snapshot-event"
    let isSilentRequest = kind == "result" && busyRequestId.map { silentRequestIDs.remove($0) != nil } == true
    if kind != "doctor" && !isSilentRequest {
      showMessage(
        isState
          ? localizedMessage("desktop.main.unreadable_state")
          : localizedMessage("desktop.main.unreadable_response", replacing: ["kind": kind]),
        isError: true
      )
    }
    // Release only the slot this frame answers. A `logs`, `usage-event` or
    // `status` frame has no request id, and releasing the mutation slot for one
    // of those dropped the real ticket for a save/switch that was still
    // running: its result then arrived with nothing waiting for it.
    switch kind {
    case "result", "protocol-error":
      if let requestID = busyRequestId, lastResult?.requestId != requestID {
        // The frame that owned this request is unreadable, so the operation
        // never sees a result. Synthesize the failure here: freeing the slot
        // alone left every sheet that waits on operationResult stuck.
        lastResult = CommandResult(
          version: 1,
          requestId: requestID,
          status: "error",
          message: localizedMessage("desktop.main.unreadable_result"),
          code: "UNREADABLE_RESULT",
          suggestions: nil,
          mutated: nil
        )
      }
      if busyRequestId != nil { endBusy() }
    case "logs":
      finishLogRequest()
    case "doctor":
      finishDoctorRequest(error: localizedMessage("desktop.main.unreadable_doctor"))
    case "backup-preview":
      backupPreviewTimeoutTask?.cancel()
      backupPreviewTimeoutTask = nil
      backupPreviewRequestId = nil
    default:
      break
    }
    if isState {
      // Without the state channel the app is blind: keep the pane honest (the
      // generic error pane when there is nothing to show) and offer the
      // restart, instead of "Starting…" forever with no explanation.
      updateServiceState(.degraded("This build cannot read the service's state."))
    }
  }

  private func localizedMessage(_ key: String, replacing values: [String: String] = [:]) -> String {
    let template = DesktopMessageCatalog.text(
      key,
      preference: settings.language ?? "auto",
      resolved: settings.resolvedLanguage ?? DesktopMessageCatalog.systemLanguage
    )
    return values.reduce(template) { result, entry in
      result.replacingOccurrences(of: "{\(entry.key)}", with: entry.value)
    }
  }

  private func apply(_ snapshot: TraySnapshot) {
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
    hubPublishedModels = snapshot.hubPublishedModels ?? []
    hubCatalogs = snapshot.hubCatalogs ?? []
    clientModelConfigs = snapshot.clientModelConfigs ?? []
    codexProfiles = snapshot.codexProfiles ?? []
    codexProfileSources = snapshot.codexProfileSources ?? []
    gateways = snapshot.gateways
    accountProviders = snapshot.accountProviders
    gatewayProviders = snapshot.gatewayProviders
    settings = snapshot.settings
    // Every snapshot re-delivers the full lists. @Published fires on every
    // assignment even when the value is identical, and each fire rebuilds the
    // Activity list and resets the log scroll — the visible flicker. Only
    // publish on real change.
    let resolvedLogSources =
      snapshot.logSources
      ?? snapshot.proxies.compactMap { proxy in
        guard proxy.logsAvailable != false else { return nil }
        return LogSourceSnapshot(
          id: proxy.id,
          label: proxy.label,
          detail: proxy.detail,
          providerId: proxy.providerId,
          name: proxy.id.components(separatedBy: "/").dropFirst().joined(separator: "/")
        )
      }
    if logSources != resolvedLogSources {
      logSources = resolvedLogSources
    }
    if !logSources.contains(where: { $0.id == selectedLogSourceId }) {
      selectedLogSourceId = logSources.first?.id ?? ""
    }
    if activity != snapshot.activity {
      activity = snapshot.activity
    }
    degradedConditions = snapshot.degradedConditions ?? []
    snapshotReady = true
    lastSnapshotAt = Date()
    if firstSnapshot {
      withAnimation(TrayMotion.standard) {}
    }
  }

  func showMessage(_ value: String, isError: Bool) {
    messageDismissTask?.cancel()
    let value = DesktopMessageCatalog.text(
      source: value,
      preference: settings.language ?? "auto",
      resolved: settings.resolvedLanguage ?? DesktopMessageCatalog.systemLanguage
    )
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

  func emit(_ command: String) {
    commandSink?(command)
  }

  /// Encode one outgoing command, reporting the failure instead of returning
  /// nil into silence. Encoding a DTO should not fail, so reaching this means
  /// the app and the engine disagree about a payload — a state worth telling
  /// the user about, because the button they pressed did nothing at all.
  func encodeCommand<T: Encodable>(_ value: T) -> Data? {
    do {
      return try JSONEncoder().encode(value)
    } catch {
      showMessage(
        "AnyPick could not build that request. Reopen AnyPick and try again.",
        isError: true
      )
      return nil
    }
  }

  private func commandCanBeAccepted(silentFeedback: Bool = false) -> Bool {
    guard commandSink != nil else {
      if !silentFeedback {
        showMessage("AnyPick service is not connected yet. Try again in a moment.", isError: true)
      }
      return false
    }
    switch serviceState {
    case .degraded(let reason):
      if !silentFeedback { showMessage(serviceUnavailableMessage(reason), isError: true) }
      return false
    case .stopped:
      if !silentFeedback {
        showMessage("AnyPick service is stopped. Reopen AnyPick and try again.", isError: true)
      }
      return false
    case .starting, .handshaking, .ready:
      // GoServiceProcess queues commands until its handshake completes.
      return true
    }
  }

  private func serviceUnavailableMessage(_ reason: String) -> String {
    let compact = reason
      .replacingOccurrences(of: "\n", with: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let longestToken = compact
      .split(whereSeparator: { $0 == " " || $0 == "\t" })
      .map(\.count)
      .max() ?? 0
    if compact.hasPrefix("The AnyPick service sent an unexpected")
      || compact.hasPrefix("The AnyPick service sent an invalid")
      || compact.contains("frame larger than")
      || compact.count > 240
      || longestToken >= 80
    {
      return "AnyPick service is unavailable. Reopen AnyPick and try again."
    }
    return "AnyPick service is unavailable. \(concise(reason, fallback: "Reopen AnyPick and try again."))"
  }

  private func concise(_ value: String?, fallback: String) -> String {
    let compact = value?
      .replacingOccurrences(of: "\n", with: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return compact.isEmpty ? fallback : String(compact.prefix(200))
  }
}
