import AppKit
import Combine
import Foundation
import UniformTypeIdentifiers

let anyPickBackupType = UTType(filenameExtension: "anypick-backup") ?? .data
@MainActor
func makeAnyPickImportPanel() -> NSOpenPanel {
  let panel = NSOpenPanel()
  panel.allowedContentTypes = [anyPickBackupType, .json]
  panel.allowsMultipleSelection = false
  panel.canChooseDirectories = false
  panel.canChooseFiles = true
  return panel
}

// Adapts the versioned tray snapshot/command protocol to the design-system UI.
// Snapshots stay redacted. A proxy API key is fetched only when the user copies
// it, then pasted without being stored on the model.
@MainActor
final class ProductionDesignModel: MacOSDesignModel {
  // MARK: - State

  let store: TrayStore
  private var storeObserver: AnyCancellable?
  private var lastResultId: String?
  private var synchronizeScheduled = false
  var pendingOperations = [String: String]()
  private var pendingRouteChanges = [(appID: String, routeID: String)]()
  private var pendingRouteRequestID: String?
  /// Model edits that arrived together with a route change. A route switch
  /// takes the single-flight slot, so the edit waits here and is applied
  /// once the snapshot confirms the new route — the switch never drops it.
  /// Dropped when the switch fails.
  private var pendingModelRoleEdits = [String: (routeID: String, roles: [String: String], scope: String)]()
  private var pendingConfigEdits = [
    String: (routeID: String, fast: String, reasoning: String, fallback: Bool)
  ]()
  private var serviceRequests = [String: (id: String, operation: DesignServiceOperation)]()
  private var pendingServiceAnnouncements = [String: String]()
  private var confirmedServiceOperations = Set<String>()
  /// Desired hub-source state per in-flight toggle, keyed by
  /// hubSourceServiceID. Snapshot confirmation (not the faster
  /// command-accepted result) clears the row spinner.
  private var hubSourcePending = [String: Bool]()
  /// A strategy the user picked, shown until the snapshot names it.
  private var hubStrategyPending = [String: String]()
  /// Gateway names awaiting creation, keyed by requestID. The post-create
  /// Auto-connect arms only on the success result, never on accept.
  private var pendingGatewayNames = [String: String]()
  private var pendingAutoCodexProfileFingerprints = [String: Set<String>]()
  private var attemptedAutoCodexProfileFingerprints = Set<String>()
  /// Backup rows awaiting a confirmed forget, keyed by requestID. The staged
  /// Server copy and the row clear only on the success result.
  private var pendingForgetBackupIDs = [String: String]()
  /// Apps whose removal waits on a successful client-reset. The preference
  /// is dropped only when that reset is accepted; a refused or failed reset
  /// leaves the app in the list and the client on its current config.
  private var pendingAppRemovals = [String: String]()
  /// Copy requests waiting on a proxy-token result, keyed by request id.
  /// The value is the row id the checkmark watches ("hub" or a proxy id).
  private var pendingProxyTokenCopies = [String: String]()
  /// Settings with an in-flight mutate, keyed by property name. synchronize()
  /// skips overwriting these: the binding already flipped local-first,
  /// and rewriting the stale snapshot value until the supervisor acks reads
  /// as flicker. Cleared by the command result, or when the command loop
  /// goes idle as a backstop.
  var pendingSettings = Set<String>()

  /// The native shell may lose the helper after accepting a mutation. The
  /// result frame is then impossible to receive, so synchronize() converts
  /// the pending operation into a normal failure when the store reports the
  /// degraded service state. Clearing the map makes this one-shot.
  private func failPendingOperationsIfServiceDegraded() {
    guard case .degraded(let reason) = store.serviceState else { return }

    if case .inFlight(let appID, let from, let to, let routeID) = switchPhase {
      switchPhase = .recovery(appID: appID, requested: to, kept: from, routeID: routeID)
    }
    pendingRouteChanges.removeAll()
    pendingRouteRequestID = nil
    pendingModelRoleEdits.removeAll()
    pendingConfigEdits.removeAll()
    // Rows that were waiting on the service must stop waiting on it: a spinner
    // or an optimistic switch left behind claims work is still happening.
    for serviceID in serviceOperations.keys {
      cancelServiceTimeout(for: serviceID)
    }
    // Rows whose only state is a service operation get the reason on the row
    // itself: the Needs Attention banner explains the service, not which switch
    // stopped answering.
    for service in serviceRequests.values {
      serviceFailures[service.id] = reason
    }
    serviceOperations.removeAll()
    hubSourcePending.removeAll()
    hubStrategyPending.removeAll()
    serviceRequests.removeAll()
    pendingServiceAnnouncements.removeAll()
    confirmedServiceOperations.removeAll()
    // A refusal that is waiting for the user's answer cannot be answered by a
    // service that is gone; leaving it would offer a sheet that cannot complete.
    pendingTakeover = nil
    pendingGatewayNames.removeAll()
    pendingForgetBackupIDs.removeAll()
    pendingAppRemovals.removeAll()
    pendingProxyTokenCopies.removeAll()
    // A successful gateway create arms the next snapshot to open the connect
    // sheet; a service that died meanwhile must not leave that armed.
    pendingGatewayConnectName = nil

    var importWasRunning = false
    if case .importing = backupInspectionState {
      importWasRunning = true
      // A backup import that lost its service never returns: its sheet would
      // stay "Importing…" with the primary disabled and no alert to dismiss.
      backupInspectionState = .atomicFailure
      backupInspectionMessage = reason
    }

    guard !pendingOperations.isEmpty || !pendingSettings.isEmpty else {
      if importWasRunning { showFeedback(reason, kind: .error) }
      return
    }

    let pending = pendingOperations
    // Automatic profile creation retries when the service comes back, so a
    // service death does not need a second alert on top of the degraded
    // banner. A sync the user asked for does not retry itself.
    let hasVisiblePendingWork = pending.values.contains {
      $0 != "codex-profile-auto-sync"
    } || !pendingSettings.isEmpty || importWasRunning
    pendingOperations.removeAll()
    pendingAutoCodexProfileFingerprints.removeAll()
    attemptedAutoCodexProfileFingerprints.removeAll()
    pendingSettings.removeAll()
    if pending.values.contains("account-switch") {
      switchingAccountID = nil
    }
    // Report every stranded operation, not just the first: the views that
    // observe operationResult are a subset of the ones that start operations,
    // so the feedback banner is what actually tells the user what failed.
    for requestID in pending.keys.sorted() {
      guard let operation = pending[requestID] else { continue }
      operationResult = DesignOperationResult(
        requestID: requestID,
        operation: operation,
        succeeded: false,
        message: reason
      )
    }
    if hasVisiblePendingWork { showFeedback(reason, kind: .error) }
  }

  /// Watchdogs that fail a service operation when no snapshot confirms it
  /// in time. Without them a lost snapshot would spin the row forever.
  private var serviceTimeoutTasks = [String: Task<Void, Never>]()
  var clearedActivityIDs = Set<String>()
  /// Log lines hidden by Clear, per source: the exact tail on screen when
  /// cleared. New lines append visibly; a rotation or restart that no longer
  /// starts with this snapshot resets instead of hiding the new logs.
  var clearedLogSnapshots = [String: [String]]()
  var importedBackupFileName: String?
  var presentedInspectionID: String?
  private var didResetFirstRunOnboarding = false

  // MARK: - Derived state

  override var isProduction: Bool { true }

  override var currentLiveLogins: [DesignLiveLogin] {
    store.accountProviders.filter { $0.livePresent == true }.map { source in
      let appID = source.clientId ?? source.providerId
      return DesignLiveLogin(
        providerID: source.providerId,
        sourceID: source.sourceId,
        providerName: source.clientId.map(anypickDisplayName)
          ?? nativeProviderName(source.providerId),
        appName: source.clientId.map(anypickDisplayName) ?? source.label,
        identity: source.liveIdentity.flatMap(displaySafeIdentity),
        symbol: appSymbol(appID)
      )
    }
  }

  // MARK: - Construction

  init(store: TrayStore) {
    self.store = store
    super.init(
      destination: .overview,
      phase: .loading,
      appearance: .system,
      activityShowsLogs: false,
      apps: [],
      accounts: [],
      proxies: [],
      activity: [],
      backups: []
    )
    storeObserver = store.objectWillChange.sink { [weak self] _ in
      // The @MainActor-isolated synchronize() cannot be called from a
      // non-isolated DispatchQueue.main.async closure under Swift 5.10+
      // actor isolation checking: the closure runs on the main thread but is
      // not main-actor-typed, so the runtime can silently drop the call and
      // the SwiftUI binding never sees the new state. A Task hopped onto
      // MainActor is the documented way and matches how SwiftUI itself
      // dispatches update notifications.
      Task { @MainActor [weak self] in
        guard let self, !self.synchronizeScheduled else { return }
        self.synchronizeScheduled = true
        await Task.yield()
        self.synchronize()
        self.synchronizeScheduled = false
      }
    }
    synchronize()
  }

  func consume(_ data: Data) {
    store.consume(data)
  }

  override func refresh() {
    // From terminal-degraded, refresh must relaunch the service: emitting a
    // command into a dead pipe is a no-op, which is why Try Again did nothing.
    if case .degraded = store.serviceState {
      store.restartService?()
      return
    }
    store.refreshAll()
  }

  override func dismissFirstRunWelcome() {
    TrayPreferences.firstRunWelcomeSeen = true
    super.dismissFirstRunWelcome()
  }

  // MARK: - Accounts and gateways

  override func detectSavedAccount(provider: String, sourceID: String?) -> Bool {
    guard let source = accountProvider(for: provider) else {
      showFeedback("No installed login source is available for \(provider).", kind: .error)
      return false
    }
    let selectedSourceID = sourceID?.trimmingCharacters(in: .whitespacesAndNewlines)
    let effectiveSourceID = selectedSourceID?.isEmpty == false ? selectedSourceID : source.sourceId
    guard
      let requestID = store.mutate(
        operation: "account-detect",
        name: "detect",
        providerId: source.providerId,
        sourceId: effectiveSourceID,
        activityLabel: "detecting \(source.label) login"
      )
    else { return false }
    pendingOperations[requestID] = "account-detect"
    operationResult = nil
    return true
  }

  override func loginSavedAccount(
    provider: String,
    name: String,
    label: String,
    methodId: String
  ) -> Bool {
    guard let source = accountProvider(for: provider) else {
      showFeedback("No browser login source is available for \(provider).", kind: .error)
      return false
    }
    guard source.loginMethods?.contains(where: { $0.id == methodId && $0.available }) == true else {
      showFeedback("That browser login method is no longer available.", kind: .error)
      return false
    }
    let method = source.loginMethods?.first { $0.id == methodId }
    let accountName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard
      let requestID = store.mutate(
        operation: "account-login",
        name: accountName.isEmpty ? nil : accountName,
        providerId: source.providerId,
        sourceId: method?.sourceID ?? source.sourceId,
        methodId: methodId,
        label: label,
        activityLabel: "signing in to \(source.label)"
      )
    else {
      // `mutate` rejects commands when the bundled service is disconnected,
      // degraded, stopped, or already handling another request. The store
      // has the precise reason, but it used to remain a toast behind this
      // sheet, making an enabled Sign In button look inert.
      let reason = store.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      showFeedback(
        !reason.isEmpty
          ? reason
          : "AnyPick could not start the browser sign-in. Try again when the service is ready.",
        kind: .error
      )
      return false
    }
    pendingOperations[requestID] = "account-login"
    operationResult = nil
    return true
  }

  override func cancelAccountLogin() {
    guard
      let requestID = pendingOperations.first(where: { $0.value == "account-login" })?.key
    else { return }
    store.cancelMutation(requestId: requestID)
  }

  /// Typed credential save for provider-declared credentials (API keys / plan keys).
  /// The secret travels in the mutation's apiKey field — the same field
  /// gateway-create already uses for profile secrets.
  override func saveCredentialInput(
    provider: String,
    name: String,
    kind: String,
    profile: String,
    secret: String
  ) -> Bool {
    guard let source = accountProvider(for: provider) else {
      showFeedback("No credential source is available for \(provider).", kind: .error)
      return false
    }
    let kinds = source.credentialKinds ?? []
    guard kinds.contains(where: { $0.kind == kind }) else {
      showFeedback("\(source.label) does not accept that credential type.", kind: .error)
      return false
    }
    let accountName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedSecret = secret.trimmingCharacters(in: .whitespacesAndNewlines)
    // A key-optional product (a local model server) saves with no key; the
    // engine's provider still decides.
    let keyOptional = kinds.first(where: { $0.kind == kind })?.secretOptional == true
    guard !accountName.isEmpty, keyOptional || !trimmedSecret.isEmpty
    else { return false }
    guard
      let requestID = store.mutate(
        operation: "account-save-input",
        name: accountName,
        providerId: source.providerId,
        apiKey: trimmedSecret.isEmpty ? nil : secret,
        kind: kind,
        profile: profile.isEmpty ? nil : profile,
        activityLabel: "saving \(source.label) account"
      )
    else { return false }
    pendingOperations[requestID] = "account-save-input"
    operationResult = nil
    return true
  }

  /// Saves a provider auth file the user pasted. The document stays in the
  /// temp file the sheet staged. `apiKey` is the one-line secret field, and
  /// a pasted document must not ride in it.
  override func savePastedAuth(
    provider: String,
    name: String?,
    path: String,
    overwrite: Bool
  ) -> Bool {
    guard let source = accountProvider(for: provider) else {
      showFeedback("No supported login source is available for \(provider).", kind: .error)
      return false
    }
    guard source.acceptsAuthPaste == true else {
      showFeedback(
        "\(source.label) does not accept pasted auth JSON. Sign in with its app, or use the API key field when that provider shows one.",
        kind: .error
      )
      return false
    }
    let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard
      let requestID = store.mutate(
        operation: "account-save-auth",
        name: trimmed.isEmpty ? nil : trimmed,
        providerId: source.providerId,
        overwrite: overwrite ? true : nil,
        path: path,
        activityLabel: "saving \(source.label) account"
      )
    else { return false }
    pendingOperations[requestID] = "account-save-auth"
    operationResult = nil
    return true
  }

  override func clearLiveLogin(provider: String) {
    guard let source = accountProvider(for: provider) else {
      showFeedback("No live login source is available for \(provider).", kind: .error)
      return
    }
    _ = store.mutate(
      operation: "account-clear",
      name: "live",
      providerId: source.providerId,
      sourceId: source.sourceId,
      activityLabel: "backing up and clearing \(source.label) login"
    )
  }

  override func testGateway(provider: String, endpoint: String, apiKey: String, profile: String? = nil) -> Bool {
    guard let gateway = gatewayProvider(for: provider) else {
      showFeedback("Unknown gateway provider \(provider).", kind: .error)
      return false
    }
    guard
      let requestID = store.mutate(
        operation: "gateway-test",
        name: "test",
        providerId: gateway.id,
        endpoint: endpoint,
        apiKey: apiKey,
        profile: profile,
        activityLabel: "testing \(gateway.label) connection"
      )
    else { return false }
    pendingOperations[requestID] = "gateway-test"
    operationResult = nil
    return true
  }

  @discardableResult
  // MARK: - Apps

  override func setRoute(appID: String, routeID: String) -> Bool {
    guard let action = store.actions.first(where: { $0.id == routeID && $0.clientId == appID })
    else {
      showFeedback("That route is no longer available. Refresh and try again.", kind: .error)
      return false
    }
    let app = apps.first { $0.id == appID }
    let from = app?.routeOptions.first { $0.id == app?.selectedRouteID }?.name ?? ""
    guard action.enabled else {
      showFeedback("That connection is no longer available. Refresh and try again.", kind: .warning)
      return false
    }
    guard let requestID = store.invoke(actionId: action.id, label: action.label) else {
      let reason = store.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      showFeedback(
        reason.isEmpty
          ? "AnyPick could not start this connection change. Try again when the service is ready."
          : reason,
        kind: .error
      )
      return false
    }
    pendingRouteRequestID = requestID
    switchPhase = .inFlight(appID: appID, from: from, to: action.label, routeID: routeID)
    return true
  }

  @discardableResult
  override func updateAppConfiguration(
    appID: String,
    routeID: String,
    fastModel: String,
    reasoningModel: String,
    useCompatibleFallback: Bool
  ) -> Bool {
    guard let app = apps.first(where: { $0.id == appID }) else { return false }
    if routeID != app.selectedRouteID {
      // Keep the model edit across the switch: stash it for
      // flushPendingModelEdits once the snapshot confirms the new route.
      guard store.busyRequestId == nil else { return false }
      pendingConfigEdits[appID] = (routeID, fastModel, reasoningModel, useCompatibleFallback)
      setRoute(appID: appID, routeID: routeID)
      guard isSwitching(appID) else {
        pendingConfigEdits.removeValue(forKey: appID)
        return false
      }
      return true
    }
    return sendConfigEdit(
      app: app,
      fastModel: fastModel,
      reasoningModel: reasoningModel,
      useCompatibleFallback: useCompatibleFallback
    )
  }

  /// Resolve role names against the current route catalog and send them.
  /// Tracked so sheets can wait for the result instead of dismissing blind.
  @discardableResult
  private func sendConfigEdit(
    app: DesignApp,
    fastModel: String,
    reasoningModel: String,
    useCompatibleFallback: Bool
  ) -> Bool {
    guard let config = store.clientModelConfigs.first(where: { $0.clientId == app.id }),
      config.editable
    else {
      showFeedback("Model roles are managed by the selected app route.", kind: .information)
      return false
    }
    var roles = [String: String]()
    func actionId(for model: String) -> String? {
      let cleaned = model.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !cleaned.isEmpty, cleaned != "auto" else { return nil }
      return config.options.first { $0.modelId == cleaned }?.actionId
    }
    let defaultModel = reasoningModel == "auto" ? fastModel : reasoningModel
    if let id = actionId(for: defaultModel) { roles["default"] = id }
    if let id = actionId(for: fastModel) { roles["haiku"] = id }
    if let id = actionId(for: reasoningModel) { roles["opus"] = id }
    guard roles["default"] != nil else {
      showFeedback("Choose a model published by the current route.", kind: .error)
      return false
    }
    guard
      let requestID = store.applyModelRoles(
        clientId: app.id, roleActionIds: roles, label: app.name)
    else { return false }
    pendingOperations[requestID] = "app-model-roles"
    operationResult = nil
    return true
  }

  @discardableResult
  override func updateAppModelRoles(
    appID: String,
    routeID: String,
    modelRoles: [String: String],
    scope: ModelRoleScope = .connection
  ) -> Bool {
    guard let app = apps.first(where: { $0.id == appID }) else { return false }
    if routeID != app.selectedRouteID {
      // Keep the model edit across the switch: stash it for
      // flushPendingModelEdits once the snapshot confirms the new route.
      guard store.busyRequestId == nil else { return false }
      pendingModelRoleEdits[appID] = (routeID, modelRoles, scope.rawValue)
      setRoute(appID: appID, routeID: routeID)
      guard isSwitching(appID) else {
        pendingModelRoleEdits.removeValue(forKey: appID)
        return false
      }
      return true
    }
    return sendModelRolesEdit(app: app, modelRoles: modelRoles, scope: scope)
  }

  /// Resolve role names against the current route catalog and send them.
  /// Tracked so sheets can wait for the result instead of dismissing blind.
  @discardableResult
  private func sendModelRolesEdit(
    app: DesignApp,
    modelRoles: [String: String],
    scope: ModelRoleScope = .connection
  ) -> Bool {
    guard let config = store.clientModelConfigs.first(where: { $0.clientId == app.id }),
      config.editable
    else {
      showFeedback("Model roles are managed by the selected app route.", kind: .information)
      return false
    }
    // Clearing sends no ids at all: the engine drops the pins and
    // re-resolves (provider default, else engine default).
    let clearing = modelRoles.values.allSatisfy(\.isEmpty)
    var actionIDs = [String: String]()
    if !clearing {
      for (roleID, modelID) in modelRoles where !modelID.isEmpty {
        if let option = config.options.first(where: { $0.modelId == modelID }) {
          actionIDs[roleID] = option.actionId
        }
      }
      guard actionIDs["default"] != nil else {
        showFeedback("Choose a default model published by the current route.", kind: .error)
        return false
      }
    }
    guard
      let requestID = store.applyModelRoles(
        clientId: app.id, roleActionIds: actionIDs, label: app.name,
        scope: scope.rawValue)
    else { return false }
    pendingOperations[requestID] = "app-model-roles"
    operationResult = nil
    return true
  }

  /// Where the app's pins came from: the engine marker, or legacy pins with
  /// no marker (all historical writes were per-connection explicit).
  override func modelRolesProvenance(appID: String) -> ModelRolesProvenance {
    guard let app = apps.first(where: { $0.id == appID }) else { return .none }
    guard
      let config = store.clientModelConfigs.first(where: { $0.clientId == app.id }),
      let source = config.modelRolesSource, !source.isEmpty
    else {
      return app.modelRoles.contains { !$0.modelID.isEmpty } ? .custom : .none
    }
    switch source {
    case "explicit": return .custom
    case "provider": return .inherited
    default: return app.modelRoles.contains { !$0.modelID.isEmpty } ? .custom : .none
    }
  }

  override func resetAppConfiguration(appID: String) {
    _ = store.mutate(
      operation: "client-reset",
      name: appID,
      providerId: appID,
      activityLabel: "disconnecting \(anypickDisplayName(appID))"
    )
  }

  override func addApp(appID: String) {
    AppPreferences.addConfiguredApp(appID)
    let effective = AppPreferences.effectiveConfiguredAppIDs(allApps: allSupportedApps)
    apps = allSupportedApps.filter { effective.contains($0.id) }
    showFeedback("Added \(anypickDisplayName(appID)) to your apps.", kind: .success)
  }

  override func saveCodexProfile(
    name: String,
    sourceID: String,
    modelID: String,
    transportPolicy: String
  ) -> Bool {
    guard validCodexProfileName(name) else {
      showFeedback("Use 1–64 letters, numbers, hyphens, or underscores for the profile name.", kind: .error)
      return false
    }
    guard store.codexProfileSources.contains(where: { $0.sourceId == sourceID }) else {
      showFeedback("That Codex route is no longer available. Refresh and try again.", kind: .error)
      return false
    }
    guard !store.codexProfiles.contains(where: { $0.name == name }) else {
      showFeedback("A Codex profile with that name already exists.", kind: .error)
      return false
    }
    guard
      let requestID = store.mutate(
        operation: "codex-profile-save",
        name: name,
        sourceId: sourceID,
        defaultModel: modelID.isEmpty ? nil : modelID,
        transportPolicy: transportPolicy,
        activityLabel: "adding Codex profile \(name)"
      )
    else { return false }
    pendingOperations[requestID] = "codex-profile-save"
    operationResult = nil
    return true
  }

  @discardableResult
  override func createMissingCodexProfiles(sourceIDs: [String]) -> Bool {
    let requested = Set(sourceIDs)
    let profiled = Set(store.codexProfiles.map(\.sourceId))
    let missing = store.codexProfileSources
      .filter { $0.kind == "account" && requested.contains($0.sourceId) && !profiled.contains($0.sourceId) }
      .map(\.sourceId)
    guard !missing.isEmpty else { return false }
    guard let requestID = store.mutate(
      operation: "codex-profile-sync",
      sourceIDs: missing,
      activityLabel: "creating \(missing.count) Codex profiles"
    ) else {
      let reason = store.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      showFeedback(
        reason.isEmpty
          ? "AnyPick could not create those Codex profiles. Try again when the service is ready."
          : reason,
        kind: .error)
      return false
    }
    pendingOperations[requestID] = "codex-profile-sync"
    operationResult = nil
    return true
  }

  override func setAutomaticCodexProfileCreation(_ enabled: Bool, baselineSourceIDs: [String]) {
    automaticallyCreateCodexProfiles = enabled
    AppPreferences.codexAutoProfilesEnabled = enabled
    if enabled {
      AppPreferences.codexAutoProfileSourceFingerprints = Set(
        baselineSourceIDs.map { AppPreferences.codexAutoProfileFingerprint(for: $0) }
      )
    }
    attemptedAutoCodexProfileFingerprints.removeAll()
  }

  override func updateCodexProfile(
    name: String,
    sourceID: String,
    modelID: String,
    transportPolicy: String
  ) -> Bool {
    guard validCodexProfileName(name) else {
      showFeedback("Use 1–64 letters, numbers, hyphens, or underscores for the profile name.", kind: .error)
      return false
    }
    guard store.codexProfileSources.contains(where: { $0.sourceId == sourceID }) else {
      showFeedback("That Codex route is no longer available. Refresh and try again.", kind: .error)
      return false
    }
    guard store.codexProfiles.contains(where: { $0.name == name }) else {
      showFeedback("That Codex profile no longer exists. Refresh and try again.", kind: .error)
      return false
    }
    guard
      let requestID = store.mutate(
        operation: "codex-profile-update",
        name: name,
        sourceId: sourceID,
        defaultModel: modelID.isEmpty ? nil : modelID,
        transportPolicy: transportPolicy,
        activityLabel: "updating Codex profile \(name)"
      )
    else { return false }
    pendingOperations[requestID] = "codex-profile-update"
    operationResult = nil
    return true
  }

  override func openCodexProfileInTerminal(name: String) {
    guard store.codexProfiles.contains(where: { $0.name == name }) else {
      showFeedback("That Codex profile no longer exists. Refresh and try again.", kind: .error)
      return
    }
    guard
      let requestID = store.mutate(
        operation: "codex-profile-terminal",
        name: name,
        activityLabel: "opening Codex profile \(name) in a terminal"
      )
    else { return }
    pendingOperations[requestID] = "codex-profile-terminal"
    operationResult = nil
  }

  override func openCodexProfileInApp(name: String) {
    guard store.codexProfiles.contains(where: { $0.name == name }) else {
      showFeedback("That Codex profile no longer exists. Refresh and try again.", kind: .error)
      return
    }
    guard
      let requestID = store.mutate(
        operation: "codex-profile-open",
        name: name,
        activityLabel: "opening Codex profile \(name) in the Codex app"
      )
    else { return }
    pendingOperations[requestID] = "codex-profile-open"
    operationResult = nil
  }

  override func removeCodexProfile(name: String) {
    guard store.codexProfiles.contains(where: { $0.name == name }) else {
      showFeedback("That Codex profile no longer exists. Refresh and try again.", kind: .error)
      return
    }
    guard
      let requestID = store.mutate(
        operation: "codex-profile-remove",
        name: name,
        activityLabel: "removing Codex profile \(name)"
      )
    else { return }
    pendingOperations[requestID] = "codex-profile-remove"
    operationResult = nil
  }

  override func removeApp(appID: String) {
    if let app = apps.first(where: { $0.id == appID }), isAppManagedByAnyPick(app) {
      guard
        let requestID = store.mutate(
          operation: "client-reset",
          name: appID,
          providerId: appID,
          activityLabel: "disconnecting \(anypickDisplayName(appID))"
        )
      else { return }
      pendingOperations[requestID] = "client-reset"
      pendingAppRemovals[requestID] = appID
      return
    }
    forgetApp(appID)
  }

  /// Drops the app from the local list. A managed app reaches this only after
  /// client-reset succeeds, so the coding client is not left on AnyPick's config.
  private func forgetApp(_ appID: String) {
    AppPreferences.removeApp(appID)
    let effective = AppPreferences.effectiveConfiguredAppIDs(allApps: allSupportedApps)
    apps = allSupportedApps.filter { effective.contains($0.id) }
    showFeedback("Removed \(anypickDisplayName(appID)) from your apps.", kind: .warning)
  }

  override func addSavedAccount(
    provider: String,
    name: String,
    label: String,
    identity: String,
    sourceID: String? = nil
  ) -> Bool {
    guard let source = accountProvider(for: provider) else {
      showFeedback("No supported login source is available for \(provider).", kind: .error)
      return false
    }
    let selectedSourceID = sourceID?.trimmingCharacters(in: .whitespacesAndNewlines)
    let effectiveSourceID = selectedSourceID?.isEmpty == false ? selectedSourceID : source.sourceId
    // Keep the sheet open until the result arrives so failures retain field
    // context.
    guard
      let requestID = store.mutate(
        operation: "account-save",
        name: name,
        providerId: source.providerId,
        sourceId: effectiveSourceID,
        label: label,
        activityLabel: "saving \(source.label) account"
      )
    else { return false }
    pendingOperations[requestID] = "account-save"
    operationResult = nil
    return true
  }

  override func saveCurrentLogin(_ login: DesignLiveLogin) -> Bool {
    guard
      store.accountProviders.contains(where: {
        $0.providerId == login.providerID
          && $0.sourceId == login.sourceID
          && $0.livePresent == true
      })
    else {
      showFeedback("That local login is no longer available. Refresh and try again.", kind: .error)
      return false
    }
    guard
      let requestID = store.mutate(
        operation: "account-save-current",
        providerId: login.providerID,
        sourceId: login.sourceID,
        activityLabel: "saving the current \(login.appName) login"
      )
    else { return false }
    pendingOperations[requestID] = "account-save-current"
    operationResult = nil
    return true
  }

  override func addGateway(
    provider: String,
    name: String,
    label: String,
    endpoint: String,
    apiKey: String,
    gatewayId: String? = nil,
    profile: String? = nil,
    defaultModel: String
  ) -> Bool {
    guard let gateway = gatewayProvider(for: provider) else {
      showFeedback("Unknown gateway provider \(provider).", kind: .error)
      return false
    }
    guard
      let requestID = store.mutate(
        operation: "gateway-create",
        name: name,
        providerId: gateway.id,
        label: label,
        endpoint: endpoint,
        apiKey: apiKey,
        gatewayId: gatewayId,
        defaultModel: defaultModel,
        profile: profile,
        activityLabel: "adding \(gateway.label)"
      )
    else { return false }
    pendingOperations[requestID] = "gateway-create"
    // Arm the post-create auto-connect only after success; accepting the
    // request is not enough to identify a created gateway.
    pendingGatewayNames[requestID] = name
    operationResult = nil
    return true
  }

  @discardableResult
  override func updateAccount(id: String, label: String) -> Bool {
    // The store refuses while another mutation is in flight. Return false so
    // the sheet only waits for a result that will actually arrive.
    if let account = store.accounts.first(where: { $0.id == id }) {
      guard
        let requestID = store.mutate(
          operation: "account-edit",
          name: account.name,
          providerId: account.providerId,
          label: label,
          activityLabel: "updating \(account.label)"
        )
      else { return false }
      pendingOperations[requestID] = "account-edit"
      operationResult = nil
      return true
    } else if let gateway = gatewaySnapshot(for: id) {
      guard
        let requestID = store.mutate(
          operation: "gateway-edit",
          name: gateway.name,
          providerId: gateway.providerId,
          label: label,
          activityLabel: "updating \(gateway.name)"
        )
      else { return false }
      pendingOperations[requestID] = "gateway-edit"
      operationResult = nil
      return true
    }
    return false
  }

  override func refreshAccount(id: String) {
    // Keep a result trail for row actions; failures surface through feedback.
    if let account = store.accounts.first(where: { $0.id == id }) {
      guard
        let requestID = store.mutate(
          operation: "account-refresh",
          name: account.name,
          providerId: account.providerId,
          activityLabel: "refreshing \(account.label)"
        )
      else { return }
      pendingOperations[requestID] = "account-refresh"
      operationResult = nil
    } else if let gateway = gatewaySnapshot(for: id) {
      guard
        let requestID = store.mutate(
          operation: "gateway-refresh",
          name: gateway.name,
          providerId: gateway.providerId,
          activityLabel: "refreshing \(gateway.name) models"
        )
      else { return }
      pendingOperations[requestID] = "gateway-refresh"
      operationResult = nil
    }
  }

  override func refreshAppModels(appID: String) {
    guard let app = apps.first(where: { $0.id == appID }),
      let action = store.actions.first(where: { $0.id == app.selectedRouteID })
    else { return }

    let sourceID = action.sourceId
    if let account = parseAccountSource(sourceID) {
      guard
        let requestID = store.mutate(
          operation: "account-refresh",
          name: account.name,
          providerId: account.provider,
          activityLabel: "refreshing \(app.name) models"
        )
      else { return }
      pendingOperations[requestID] = "account-refresh"
      operationResult = nil
      return
    }

    if let gatewayName = parseGatewaySource(sourceID) {
      // gateway-refresh resolves the stored profile by name. The snapshot
      // names that gateway in sourceId and does not carry a provider id.
      guard
        let requestID = store.mutate(
          operation: "gateway-refresh",
          name: gatewayName,
          activityLabel: "refreshing \(app.name) models"
        )
      else { return }
      pendingOperations[requestID] = "gateway-refresh"
      operationResult = nil
      return
    }

    showFeedback("Refresh the selected account or gateway from Connections.", kind: .information)
  }

  /// Re-probe a saved gateway with its stored credential. The key never
  /// leaves the engine: the frame carries only the gateway name, and
  /// handleGatewayTest resolves the profile server-side.
  override func testSavedGateway(id: String) {
    guard let gateway = gatewaySnapshot(for: id) else {
      showFeedback(
        "That gateway is no longer available. Refresh and try again.", kind: .error)
      return
    }
    guard
      let requestID = store.mutate(
        operation: "gateway-test",
        name: gateway.name,
        providerId: gateway.providerId,
        activityLabel: "testing \(gateway.name) connection"
      )
    else { return }
    pendingOperations[requestID] = "gateway-test"
    operationResult = nil
  }

  override func makeAccountCurrent(id: String) {
    guard let account = store.accounts.first(where: { $0.id == id }) else {
      showFeedback(
        "That saved account is no longer available. Refresh and try again.", kind: .error)
      return
    }
    switchingAccountID = id
    guard
      let requestID = store.invoke(
        actionId: account.switchActionId,
        label: "make \(account.label) current"
      )
    else {
      switchingAccountID = nil
      // A row action can be rejected before it reaches the Go service (for
      // example while another mutation is running or while the service is
      // reconnecting). Keep the error on the account surface instead of
      // leaving the user with a button that appears to do nothing.
      let reason = store.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      showFeedback(
        !reason.isEmpty
          ? reason
          : "AnyPick could not switch to \(account.label). Try again when the service is ready.",
        kind: .error
      )
      return
    }
    pendingOperations[requestID] = "account-switch"
    operationResult = nil
  }

  override func connectGateway(id: String, appIDs: Set<String>) {
    let changes = gatewayRouteChanges(id: id, appIDs: appIDs)
    guard !changes.isEmpty else {
      showFeedback("No app routes needed to change.", kind: .information)
      return
    }
    pendingRouteChanges = changes
    applyNextPendingRouteChange()
  }

  private func applyNextPendingRouteChange() {
    guard let next = pendingRouteChanges.first else { return }
    pendingRouteChanges.removeFirst()
    setRoute(appID: next.appID, routeID: next.routeID)
  }

  /// Apply model edits stashed across a route change once the snapshot
  /// confirms the new route. A stash whose route never confirms waits for
  /// the switch result (failure drops it above), so this never re-sends a
  /// stale edit against the wrong catalog.
  private func flushPendingModelEdits() {
    guard store.busyRequestId == nil else { return }
    for (appID, edit) in pendingModelRoleEdits {
      guard !isSwitching(appID),
        !pendingRouteChanges.contains(where: { $0.appID == appID })
      else { continue }
      guard let app = apps.first(where: { $0.id == appID }) else {
        pendingModelRoleEdits.removeValue(forKey: appID)
        continue
      }
      guard app.selectedRouteID == edit.routeID else { continue }
      pendingModelRoleEdits.removeValue(forKey: appID)
      sendModelRolesEdit(
        app: app, modelRoles: edit.roles,
        scope: ModelRoleScope(rawValue: edit.scope) ?? .connection)
    }
    for (appID, edit) in pendingConfigEdits {
      guard !isSwitching(appID),
        !pendingRouteChanges.contains(where: { $0.appID == appID })
      else { continue }
      guard let app = apps.first(where: { $0.id == appID }) else {
        pendingConfigEdits.removeValue(forKey: appID)
        continue
      }
      guard app.selectedRouteID == edit.routeID else { continue }
      pendingConfigEdits.removeValue(forKey: appID)
      sendConfigEdit(
        app: app,
        fastModel: edit.fast,
        reasoningModel: edit.reasoning,
        useCompatibleFallback: edit.fallback
      )
    }
  }

  override func removeAccount(id: String) {
    // The confirmation closes at once; result feedback reports failures.
    if let account = store.accounts.first(where: { $0.id == id }) {
      guard
        let requestID = store.mutate(
          operation: "account-remove",
          name: account.name,
          providerId: account.providerId,
          activityLabel: "removing \(account.label)"
        )
      else { return }
      pendingOperations[requestID] = "account-remove"
      operationResult = nil
    } else if let gateway = gatewaySnapshot(for: id) {
      guard
        let requestID = store.mutate(
          operation: "gateway-remove",
          name: gateway.name,
          providerId: gateway.providerId,
          activityLabel: "removing \(gateway.name)"
        )
      else { return }
      pendingOperations[requestID] = "gateway-remove"
      operationResult = nil
    }
  }

  // MARK: - Hub

  override func hubSourceShowsEnabled(_ sourceID: String) -> Bool {
    if let desired = hubSourcePending[hubSourceServiceID(sourceID)] { return desired }
    return super.hubSourceShowsEnabled(sourceID)
  }

  override func setHubSource(_ accountID: String, enabled: Bool) {
    guard let source = store.hubSources.first(where: { $0.id == accountID }) else { return }
    // The engine expects the hub name in Name and the source account in
    // SourceID.
    guard
      let requestID = store.mutate(
        operation: "hub-source-toggle",
        name: source.hub ?? "default",
        providerId: source.providerId,
        sourceId: source.name,
        enabled: enabled,
        activityLabel: "updating Proxy Hub sources"
      )
    else { return }
    // Keep the request associated with the row so progress and failures are
    // shown beside the source instead of only in generic feedback.
    let serviceID = hubSourceServiceID(accountID)
    let operation: DesignServiceOperation = enabled ? .starting : .stopping
    trackServiceOperation(operation, for: serviceID)
    serviceFailures.removeValue(forKey: serviceID)
    hubSourcePending[serviceID] = enabled
    serviceRequests[requestID] = (serviceID, operation)
  }

  override func hubStrategy(_ sourceID: String) -> String {
    if let desired = hubStrategyPending[hubSourceServiceID(sourceID)] { return desired }
    return super.hubStrategy(sourceID)
  }

  override func setHubStrategy(_ hub: String, strategy: String) {
    // `enabled` rides along so an engine that predates the named strategy
    // still reads round-robin on or off.
    guard
      let requestID = store.mutate(
        operation: "hub-rotation",
        name: hub,
        enabled: strategy == "round-robin",
        strategy: strategy,
        activityLabel: "updating Proxy Hub strategy"
      )
    else { return }
    let serviceID = hubSourceServiceID("hub/\(hub)/rotation")
    trackServiceOperation(.starting, for: serviceID)
    serviceFailures.removeValue(forKey: serviceID)
    hubStrategyPending[serviceID] = strategy
    serviceRequests[requestID] = (serviceID, .starting)
  }

  override func setHubRotation(_ hub: String, enabled: Bool) {
    guard
      let requestID = store.mutate(
        operation: "hub-rotation",
        name: hub,
        enabled: enabled,
        activityLabel: "updating Proxy Hub rotation"
      )
    else { return }
    // Same row-level progress and failure reporting as a source switch: the
    // rotation row is the switch, so its spinner and its error belong to it.
    let serviceID = hubSourceServiceID("hub/\(hub)/rotation")
    let operation: DesignServiceOperation = enabled ? .starting : .stopping
    trackServiceOperation(operation, for: serviceID)
    serviceFailures.removeValue(forKey: serviceID)
    hubSourcePending[serviceID] = enabled
    serviceRequests[requestID] = (serviceID, operation)
  }

  override func selectRoutingCandidate(actionID: String) {
    guard let requestID = store.invoke(actionId: actionID, label: "select Proxy Hub source")
    else { return }
    let conflictID = routingConflicts.first(where: {
      $0.candidates.contains(where: { $0.actionID == actionID })
    })?.id
    let serviceID = hubConflictServiceID(conflictID ?? actionID)
    trackServiceOperation(.starting, for: serviceID)
    serviceFailures.removeValue(forKey: serviceID)
    serviceRequests[requestID] = (serviceID, .starting)
  }

  // MARK: - Proxies

  override func setProxyEnabled(id: String, enabled: Bool) {
    guard let proxy = store.proxies.first(where: { $0.id == id }) else { return }
    // The published action starts when the process is down and stops when it
    // is up. It does not read this bool. Sending it for a state the process
    // is already in runs the opposite branch.
    if proxy.running == enabled { return }
    let actionId = proxy.toggleActionId
    guard
      let requestID = store.invoke(
        actionId: actionId,
        label: enabled ? "start \(proxy.label)" : "stop \(proxy.label)"
      )
    else {
      let reason = store.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      showFeedback(
        reason.isEmpty
          ? "AnyPick could not \(enabled ? "start" : "stop") \(proxy.label). Try again when the service is ready."
          : reason,
        kind: .error
      )
      return
    }
    let serviceID = designServiceID(proxy)
    let operation: DesignServiceOperation = enabled ? .starting : .stopping
    trackServiceOperation(operation, for: serviceID)
    serviceFailures.removeValue(forKey: serviceID)
    serviceRequests[requestID] = (serviceID, operation)
  }

  override func setProxyHubEnabled(_ enabled: Bool) {
    guard let hub = store.proxyHub else {
      showFeedback("Configure Proxy Hub before starting it.", kind: .warning)
      return
    }
    setProxyEnabled(id: hub.id, enabled: enabled)
  }

  override func restartProxy(id: String) {
    let proxy = id == "hub" ? store.proxyHub : store.proxies.first(where: { $0.id == id })
    guard let proxy else { return }
    guard
      let requestID = store.invoke(
        actionId: proxy.restartActionId,
        label: "restart \(proxy.label)"
      )
    else { return }
    let serviceID = designServiceID(proxy)
    trackServiceOperation(.restarting, for: serviceID)
    serviceFailures.removeValue(forKey: serviceID)
    serviceRequests[requestID] = (serviceID, .restarting)
  }

  override func copyProxyAPIKey(id: String) {
    let snapshot: ProxySnapshot?
    let copyID: String
    if id == "hub" {
      snapshot = store.proxyHub
      copyID = "hub"
    } else {
      snapshot = store.proxies.first { $0.id == id }
      copyID = id
    }
    guard let snapshot, snapshot.hasToken == true else {
      announceOnly("API key isn’t available.")
      return
    }
    let providerID = snapshot.providerId
    let prefix = providerID + "/"
    guard snapshot.id.hasPrefix(prefix) else { return }
    let name = String(snapshot.id.dropFirst(prefix.count))
    guard !name.isEmpty else { return }
    guard
      let requestID = store.mutate(
        operation: "proxy-token",
        name: name,
        providerId: providerID,
        activityLabel: "copy API key",
        silentFeedback: true
      )
    else {
      announceOnly("Couldn’t copy API key.")
      return
    }
    pendingOperations[requestID] = "proxy-token"
    pendingProxyTokenCopies[requestID] = copyID
  }

  override func rotateProxyKey(id: String) {
    let proxy = id == "hub" ? store.proxyHub : store.proxies.first(where: { $0.id == id })
    guard let proxy else { return }
    guard let rotateActionId = proxy.rotateActionId else {
      showFeedback("Rotating API key is not supported for this proxy.", kind: .warning)
      return
    }
    guard
      let requestID = store.invoke(
        actionId: rotateActionId,
        label: "rotate API key for \(proxy.label)"
      )
    else { return }
    let serviceID = designServiceID(proxy)
    trackServiceOperation(.restarting, for: serviceID)
    serviceFailures.removeValue(forKey: serviceID)
    serviceRequests[requestID] = (serviceID, .restarting)
  }

  override func restartRunningProxies() {
    store.restartProxies()
  }

  override func stopAllProxies() {
    store.stopProxies()
  }

  // MARK: - Backups

  override func createBackup(accountIDs: Set<String>) -> Bool {
    let selected = store.accounts.filter { accountIDs.contains($0.id) }
    guard !selected.isEmpty, selected.count <= BackupLimits.maxAccounts else {
      showFeedback(
        "Select between 1 and \(BackupLimits.maxAccounts) saved accounts.",
        kind: .error)
      return false
    }
    let panel = NSSavePanel()
    panel.allowedContentTypes = [anyPickBackupType]
    panel.nameFieldStringValue = "anypick-accounts.anypick-backup"
    panel.canCreateDirectories = true
    guard panel.runModal() == .OK, let path = panel.url?.path else { return false }
    guard
      let requestID = store.exportBackup(
        path: path,
        accounts: selected.map { BackupAccountRef(provider: $0.providerId, name: $0.name) },
        overwrite: true,
        activityLabel: "exporting account backup"
      )
    else {
      // A frame over 16 KiB already set store.message and returned nil.
      // The window alert reads model.feedback, so the toast alone never shows.
      let reason = store.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      showFeedback(
        reason.isEmpty
          ? "AnyPick could not export that backup. Select fewer accounts or shorten their names, then try again."
          : reason,
        kind: .error)
      return false
    }
    pendingOperations[requestID] = "account-backup-export"
    operationResult = nil
    return true
  }

  override func importBackupPackage() -> Bool {
    let panel = makeAnyPickImportPanel()
    panel.message = "Choose an AnyPick account export or backup to review."
    panel.prompt = "Choose"
    guard panel.runModal() == .OK, let path = panel.url?.path else { return false }
    importedBackupFileName = URL(fileURLWithPath: path).lastPathComponent
    return store.inspectBackup(path: path) != nil
  }

  override func restoreBackup(id: String, accountIDs: Set<String>, overwrite: Bool) {
    guard let preview = store.backupPreview,
      preview.inspectionId == id,
      let entries = preview.entries
    else {
      // Stale sheet: the review is gone (forgotten, expired, or superseded).
      showFeedback(
        "That review is no longer available. Choose the backup file again.", kind: .error)
      return
    }
    let selected = entries.filter { accountIDs.contains($0.id) }
    let dispositions = Dictionary(uniqueKeysWithValues: entries.map { ($0.id, $0.disposition) })
    let entryIds = backupImportEntryIDs(
      selectedIDs: Set(selected.map(\.id)),
      dispositions: dispositions,
      overwrite: overwrite
    )
    guard !entryIds.isEmpty else {
      showFeedback(
        "Nothing to import: every selected account is already saved. Choose Replace to overwrite.",
        kind: .information
      )
      return
    }
    guard
      let requestID = store.importBackup(
        inspectionId: id,
        entryIds: entryIds,
        overwriteConfirmed: overwrite,
        activityLabel: "importing account backup"
      )
    else { return }
    pendingOperations[requestID] = "account-backup-import"
    operationResult = nil
    backupInspectionState = .importing
    backupInspectionMessage = localized("desktop.backups.importing_accounts")
  }

  @discardableResult
  override func deleteBackup(id: String) -> Bool {
    // The staged server copy clears only after the engine confirms: the
    // forget travels on the single-flight slot, so clearing on send dropped
    // the row while the credentials stayed staged on a refusal or failure.
    guard store.backupPreview?.inspectionId == id else {
      backups.removeAll { $0.id == id }
      return true
    }
    guard let requestID = store.forgetBackup(inspectionId: id) else { return false }
    pendingOperations[requestID] = "account-backup-forget"
    pendingForgetBackupIDs[requestID] = id
    operationResult = nil
    return true
  }

  // MARK: - Activity, settings, and logs

  override func clearActivity() {
    if activityShowsLogs, let source = selectedLogSource,
      let text = store.logsBySource[source.id]
    {
      // Snapshot the cleared tail itself (not its length): rotation or a
      // restart replaces the content, which a count could never detect.
      clearedLogSnapshots[source.id] = text.split(
        separator: "\n",
        omittingEmptySubsequences: false
      ).map(String.init)
    } else {
      clearedActivityIDs.formUnion(store.activity.map(\.id))
    }
    activity = designActivity()
    showFeedback("Cleared the visible activity list. Supervisor history is unchanged.")
  }

  override var hasInstalledApp: Bool { store.hasInstalledClient }

  override var hasChosenRoute: Bool { overviewHasChosenRoute(apps: apps) }

  override var isFirstRun: Bool { store.isFirstRun }

  override func dismissOnboarding() {
    super.dismissOnboarding()
    TrayPreferences.onboardingDismissed = true
  }

  override func showGettingStartedAgain() {
    TrayPreferences.onboardingDismissed = false
    super.showGettingStartedAgain()
  }

  override func runDoctor() {
    store.requestDoctor()
  }

  override func setOpenAtLogin(_ enabled: Bool) {
    sendSetting(key: "openAtLogin", changed: store.settings.launchAtLogin != enabled) {
      store.mutate(
        operation: "setting-launch-at-login",
        name: "settings",
        enabled: enabled,
        activityLabel: "updating login settings"
      )
    }
  }

  override func setShowUsage(_ enabled: Bool) {
    sendSetting(key: "showUsage", changed: store.settings.showQuota != enabled) {
      store.mutate(
        operation: "setting-show-quota",
        name: "settings",
        enabled: enabled,
        activityLabel: "updating quota visibility"
      )
    }
  }

  override func setStartProxiesAtLaunch(_ enabled: Bool) {
    sendSetting(key: "startProxiesAtLaunch", changed: store.settings.startEnabledProxies != enabled)
    {
      store.mutate(
        operation: "setting-auto-start-proxies",
        name: "settings",
        enabled: enabled,
        activityLabel: "updating proxy auto-start"
      )
    }
  }

  override func setWarnBeforeLowUsage(_ enabled: Bool) {
    sendSetting(key: "warnBeforeLowUsage", changed: store.settings.quotaGuardEnabled != enabled) {
      store.mutate(
        operation: "setting-quota-guard",
        name: "settings",
        enabled: enabled,
        activityLabel: "updating Quota Guard"
      )
    }
  }

  override func setLanguage(_ language: String) {
    selectedLanguage = language
    resolvedLanguage = language == "auto" ? DesktopMessageCatalog.systemLanguage : language
    sendSetting(key: "language", changed: (store.settings.language ?? "auto") != language) {
      store.mutate(
        operation: "setting-language",
        name: "settings",
        language: language,
        activityLabel: "changing CLI language"
      )
    }
  }

  override func setActivityShowsLogs(_ enabled: Bool) {
    // The Events/Live Logs segmented binding already wrote the value before
    // onChange re-enters here; @Published fires on every set even when equal,
    // and each fire rebuilds the pane. Only publish on a real toggle.
    if activityShowsLogs != enabled {
      activityShowsLogs = enabled
    }
    if enabled, let source = selectedLogSource {
      store.selectLogSource(source.id)
      store.requestLogs(source)
    }
  }

  override func selectLogSource(_ id: String) {
    guard let source = store.logSources.first(where: { $0.id == id }) else { return }
    if selectedLogSourceID != id {
      selectedLogSourceID = id
    }
    store.selectLogSource(id)
    store.requestLogs(source)
  }

  override func refreshSelectedLogSource() {
    guard let source = selectedLogSource else { return }
    store.requestLogs(source)
  }

  override func setLogPolling(_ enabled: Bool) {
    guard let source = selectedLogSource else {
      store.stopLogPolling()
      return
    }
    if enabled {
      store.startLogPolling(for: source.id)
    } else {
      store.stopLogPolling()
    }
  }

  // MARK: - Snapshot sync

  private func synchronizeOnboarding() {
    guard store.snapshotReady else { return }
    if store.isFirstRun {
      if !didResetFirstRunOnboarding {
        didResetFirstRunOnboarding = true
        TrayPreferences.resetOnboardingIfEmpty(isFirstRun: true)
        setIfChanged(\.onboardingDismissed, to: false)
      }
      setIfChanged(\.showFirstRunWelcome, to: !TrayPreferences.firstRunWelcomeSeen)
      return
    }
    setIfChanged(\.showFirstRunWelcome, to: false)
    didResetFirstRunOnboarding = false
    if !showGettingStarted {
      setIfChanged(\.onboardingDismissed, to: TrayPreferences.onboardingDismissed)
    }
  }

  private func synchronizeAutomaticCodexProfiles() {
    guard AppPreferences.codexAutoProfilesEnabled, store.snapshotReady, !isBusy else { return }

    let accountSourceIDs = store.codexProfileSources
      .filter { source in
        guard source.kind == "account" else { return false }
        // Codex's own account can use Codex's default model. Other account
        // providers need a discovered model before a profile can be saved.
        // An empty cached catalog is still loading or unavailable; leave the
        // source eligible for a later snapshot instead of surfacing a launch
        // error for background work.
        if source.sourceId.hasPrefix("account/codex/") { return true }
        return source.models.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      }
      .map(\.sourceId)
    guard !accountSourceIDs.isEmpty else { return }

    let profilesBySource = Set(store.codexProfiles.map(\.sourceId))
    var known = AppPreferences.codexAutoProfileSourceFingerprints
    for sourceID in accountSourceIDs where profilesBySource.contains(sourceID) {
      known.insert(AppPreferences.codexAutoProfileFingerprint(for: sourceID))
    }
    if known != AppPreferences.codexAutoProfileSourceFingerprints {
      AppPreferences.codexAutoProfileSourceFingerprints = known
    }

    let pending = Set(pendingAutoCodexProfileFingerprints.values.reduce(into: Set<String>()) { $0.formUnion($1) })
    let candidates = accountSourceIDs.filter { sourceID in
      let fingerprint = AppPreferences.codexAutoProfileFingerprint(for: sourceID)
      return !known.contains(fingerprint) && !attemptedAutoCodexProfileFingerprints.contains(fingerprint)
        && !pending.contains(fingerprint) && !profilesBySource.contains(sourceID)
    }
    guard !candidates.isEmpty else { return }
    let batch = Array(candidates.prefix(64))
    guard let requestID = store.mutate(
      operation: "codex-profile-sync",
      sourceIDs: batch,
      activityLabel: "creating Codex profiles for new accounts",
      silentFeedback: true
    ) else { return }
    let fingerprints = Set(batch.map { AppPreferences.codexAutoProfileFingerprint(for: $0) })
    attemptedAutoCodexProfileFingerprints.formUnion(fingerprints)
    pendingAutoCodexProfileFingerprints[requestID] = fingerprints
    pendingOperations[requestID] = "codex-profile-auto-sync"
    operationResult = nil
  }

  private func setIfChanged<Value: Equatable>(
    _ keyPath: ReferenceWritableKeyPath<MacOSDesignModel, Value>,
    to value: Value
  ) {
    guard self[keyPath: keyPath] != value else { return }
    self[keyPath: keyPath] = value
  }

  private func synchronize() {
    // A degraded service with data stays on Overview: its Needs
    // Attention block names the condition. .error is only for having nothing
    // to show at all — the generic pane it renders hides that block.
    let nextPhase: DesignLoadPhase
    if case .degraded = store.serviceState {
      nextPhase = store.snapshotReady ? .ready : .error
    } else {
      nextPhase = store.snapshotReady ? .ready : .loading
    }
    setIfChanged(\.phase, to: nextPhase)
    var nextDegradedConditions = store.degradedConditions.map {
      DesignDegradedCondition(id: $0.id, kind: $0.kind, title: $0.title, detail: $0.detail)
    }
    setIfChanged(\.doctorIsRunning, to: store.doctorIsRunning)
    setIfChanged(\.doctorError, to: store.doctorError)
    if let report = store.doctorResult {
      let designReport = DesignDoctorReport(
        status: report.status,
        findings: report.findings.map {
          DesignDoctorFinding(check: $0.check, status: $0.status, detail: $0.detail)
        }
      )
      if doctorReport != designReport { doctorReport = designReport }
    }
    // A service that is gone is a degraded condition the app can see for
    // itself. Without this the app looked completely normal after the helper
    // died and only the next action failed — the pane that exists to name a
    // problem never mentioned it.
    if case .degraded(let reason) = store.serviceState {
      nextDegradedConditions.insert(
        DesignDegradedCondition(
          id: "service-connection",
          kind: "service",
          title: localized("desktop.main.service_not_running"),
          detail: reason),
        at: 0)
    }
    setIfChanged(\.degradedConditions, to: nextDegradedConditions)
    let all = store.managedAppClientIDs.compactMap(designApp).sorted(by: nativeAppOrder)
    setIfChanged(\.allSupportedApps, to: all)
    let effectiveConfigured = AppPreferences.effectiveConfiguredAppIDs(allApps: all)
    setIfChanged(\.apps, to: all.filter { effectiveConfigured.contains($0.id) })
    let nextAccounts = (store.accounts.map(designAccount) + store.gateways.map(designGateway))
      .sorted(by: nativeAccountOrder)
    setIfChanged(\.accounts, to: nextAccounts)
    var nextAccountUsage: [String: [DesignUsageWindow]] = [:]
    for account in store.accounts where account.active {
      if let usage = store.usage.first(where: {
        nativeProviderFamily($0.providerId ?? $0.client) == nativeProviderFamily(account.providerId)
          && $0.account == account.name
      }) {
        nextAccountUsage[account.id] = usage.windows.map {
          DesignUsageWindow(label: $0.label, remainingPercent: $0.remainingPercent,
            resetsAtMs: $0.resetsAtMs, limitWindowSeconds: $0.limitWindowSeconds, group: $0.group)
        }
      }
    }
    setIfChanged(\.accountUsage, to: nextAccountUsage)
    let profileSources = store.codexProfileSources.map {
      DesignCodexProfileSource(
        sourceID: $0.sourceId,
        kind: $0.kind ?? ($0.sourceId.hasPrefix("account/") ? "account" : ""),
        label: $0.label,
        detail: $0.detail,
        selected: $0.selected,
        models: $0.models
      )
    }
    if codexProfileSources != profileSources {
      codexProfileSources = profileSources
    }
    let sourceLabels = Dictionary(uniqueKeysWithValues: profileSources.map { ($0.sourceID, $0.label) })
    let profiles = store.codexProfiles.map {
      DesignCodexProfile(
        name: $0.name,
        sourceID: $0.sourceId,
        sourceLabel: sourceLabels[$0.sourceId] ?? $0.sourceLabel,
        modelID: $0.modelId,
        transportPolicy: $0.transportPolicy,
        launchCommand: $0.launchCommand,
        appOpenable: $0.appOpenable ?? false,
        terminalOpenable: $0.terminalOpenable ?? false
      )
    }
    if codexProfiles != profiles {
      codexProfiles = profiles
    }
    setIfChanged(
      \.automaticallyCreateCodexProfiles,
      to: AppPreferences.codexAutoProfilesEnabled
    )
    if let name = pendingGatewayConnectName,
      let created = accounts.first(where: {
        $0.kind == .gateway && $0.name.caseInsensitiveCompare(name) == .orderedSame
      })
    {
      pendingGatewayConnectID = created.id
      pendingGatewayConnectName = nil
    }
    // Hub is presented beside these services by the macOS view, so keep it out
    // of the per-account snapshot list to avoid rendering it twice.
    setIfChanged(
      \.proxies,
      to: store.proxies.filter { $0.providerId != "proxy-hub" }.map(designProxy)
    )
    let hubRows = store.hubSources.map(designHubSource)
    setIfChanged(\.hubSources, to: hubRows)
    // The rotation row is a hub mode, not a source: it must not make an empty
    // hub look publishable, and the empty state ("add a compatible account")
    // must still appear when nothing else is attached.
    setIfChanged(
      \.hubSourceIDs,
      to: Set(hubRows.filter { $0.enabled && !$0.rotates }.map(\.id))
    )
    setIfChanged(\.proxyHubRotates, to: hubRows.contains { $0.rotates && $0.enabled })
    // Catalogs (static policy + warmed live lists, pins merged server-side)
    // compile to counts, conflicts and published models here — one logic for
    // fixture and production. The legacy Go-computed conflicts/published
    // stay on the wire but no longer drive the pane.
    let newCatalogs = store.hubCatalogs.map {
      DesignHubCatalog(accountID: $0.accountID, catalogID: $0.catalog, models: $0.models)
    }
    if hubCatalogs != newCatalogs {
      hubCatalogs = newCatalogs
    }
    // The engine persists an explicit owner when a shared model collision is
    // resolved. Rehydrate those pins before compiling the catalog; otherwise
    // the next snapshot would show the same conflict again even though the
    // picker mutation succeeded.
    let persistedHubOwners = store.hubPublishedModels.reduce(into: [String: String]()) { owners, row in
      guard !row.needsChoice else { return }
      if let owner = normalizedHubOwnerID(row.ownerAccountId) {
        owners[row.id] = owner
      } else if !row.ownerProviderId.isEmpty {
        owners[row.id] = row.ownerProviderId
      }
    }
    replaceHubModelOwners(persistedHubOwners)
    recompileHubRouting()
    setIfChanged(\.proxyHubEnabled, to: store.proxyHub?.running == true)
    setIfChanged(
      \.proxyHubPort,
      to: servicePort(from: store.proxyHub?.address) ?? proxyHubPort
    )
    // An older helper may still put the bearer in the snapshot. Do not keep it.
    setIfChanged(\.proxyHubApiKey, to: "")
    setIfChanged(\.proxyHubHasToken, to: store.proxyHub?.hasToken == true)
    let nextLogSources = store.logSources.map {
      DesignLogSource(
        id: $0.id,
        label: $0.label,
        detail: $0.detail,
        provider: $0.providerId,
        symbol: providerSymbol($0.providerId)
      )
    }
    setIfChanged(\.logSources, to: nextLogSources)
    // The store re-emits the full snapshot on every poll. @Published fires on
    // every assignment even when unchanged, rebuilding the Activity list and
    // re-laying out the pane — the visible flicker. Only publish on change.
    // (selectLogSource sets both sides synchronously, so a plain mirror here
    // cannot fight the user's just-made choice.)
    let resolvedLogSourceID = selectedLogSource?.id ?? ""
    if selectedLogSourceID != resolvedLogSourceID {
      selectedLogSourceID = resolvedLogSourceID
    }
    synchronizeLogState()
    // In-flight settings keep their local value: rewriting the stale
    // snapshot value until the supervisor acks reads as flicker.
    if !pendingSettings.contains("openAtLogin") {
      setIfChanged(\.openAtLogin, to: store.settings.launchAtLogin)
    }
    if !pendingSettings.contains("showUsage") {
      setIfChanged(\.showUsage, to: store.settings.showQuota)
    }
    if !pendingSettings.contains("startProxiesAtLaunch") {
      setIfChanged(\.startProxiesAtLaunch, to: store.settings.startEnabledProxies)
    }
    if !pendingSettings.contains("warnBeforeLowUsage") {
      setIfChanged(\.warnBeforeLowUsage, to: store.settings.quotaGuardEnabled)
    }
    if !pendingSettings.contains("language") {
      setIfChanged(\.selectedLanguage, to: store.settings.language ?? "auto")
    }
    setIfChanged(
      \.resolvedLanguage,
      to: store.settings.resolvedLanguage ?? DesktopMessageCatalog.systemLanguage
    )
    let languageOptions = store.settings.languageOptions ?? []
    setIfChanged(
      \.languageOptions,
      to: languageOptions.isEmpty ? LanguageOptionSnapshot.defaultOptions : languageOptions
    )
    let wasBusy = isBusy
    setIfChanged(\.isBusy, to: store.busyRequestId != nil)
    let degradedService = { if case .degraded = store.serviceState { return true }; return false }()
    if wasBusy, !isBusy {
      switchingAccountID = nil
      // Backstop for pendingSettings: the loop is idle, so any setting
      // still held either applied or was dropped — sync resumes either way.
      pendingSettings.removeAll()
    }
    if !isBusy,
      let requestID = pendingRouteRequestID,
      store.lastResult?.requestId != requestID,
      case .inFlight(let appID, let from, let to, let routeID) = switchPhase
    {
      // The slot is free and this request never produced a result: the engine
      // rejected the frame, answered without an id, or died mid-action. Leaving
      // it in flight made the route sheet modal with no Cancel and no primary.
      pendingRouteRequestID = nil
      switchPhase = .recovery(appID: appID, requested: to, kept: from, routeID: routeID)
      showFeedback(
        "The connection change did not complete. Your previous connection is unchanged.",
        kind: .error)
    }
    if !isBusy,
      let requestID = pendingRouteRequestID,
      let result = store.lastResult,
      result.requestId == requestID,
      case .inFlight(let appID, let from, let to, let routeID) = switchPhase
    {
      pendingRouteRequestID = nil
      if result.status == "success" {
        switchPhase = .success(appID: appID, name: to)
        Task { @MainActor in
          try? await Task.sleep(nanoseconds: 1_600_000_000)
          if case .success = switchPhase { switchPhase = .idle }
        }
      } else {
        switchPhase = .recovery(appID: appID, requested: to, kept: from, routeID: routeID)
        // The switch failed: a model edit stashed across it no longer
        // applies — say so instead of stranding it silently.
        if pendingModelRoleEdits.removeValue(forKey: appID) != nil
          || pendingConfigEdits.removeValue(forKey: appID) != nil
        {
          showFeedback(
            "The connection change failed. Model choices were not applied.",
            kind: .warning)
        }
      }
    }
    if !isBusy, pendingRouteRequestID == nil, !pendingRouteChanges.isEmpty {
      applyNextPendingRouteChange()
    }
    // @Published fires on every set even when the value is identical; each
    // fire rebuilds the Activity list and re-lays out the pane. Only publish
    // on real change so background polls with identical tails stay quiet.
    let freshLogLines = designLogLines()
    if liveLogLines != freshLogLines {
      liveLogLines = freshLogLines
    }
    let freshActivity = designActivity()
    if activity != freshActivity {
      activity = freshActivity
    }
    synchronizeOnboarding()
    synchronizeBackupPreview()
    synchronizeBackupInspectionState()
    confirmServiceOperations()
    flushPendingModelEdits()
    // After the result block above: a result and a degraded service seen in the
    // same synchronize turn must not turn a real success into a failure.
    if degradedService { failPendingOperationsIfServiceDegraded() }

    if let result = store.lastResult, result.requestId != lastResultId {
      lastResultId = result.requestId
      var suppressResultFeedback = false
      if let service = serviceRequests.removeValue(forKey: result.requestId) {
        if result.status == "success" {
          if service.id.hasPrefix("hub-conflict/") {
            // The exception the rule above needs: a model-owner pick has no
            // snapshot state to confirm against, so the result is the whole
            // answer. Waiting for a snapshot here raised a false
            // "didn't confirm in time" on every successful pick.
            serviceFailures.removeValue(forKey: service.id)
            cancelServiceTimeout(for: service.id)
            serviceOperations.removeValue(forKey: service.id)
          } else if (service.operation == .starting || service.operation == .stopping)
            && (service.id == "hub" || store.proxies.contains(where: { $0.id == service.id }))
          {
            // A result only says the command was accepted. Announce success
            // after the same snapshot that removes the row's pending state.
            suppressResultFeedback = true
            let message = result.displayMessage ?? fallbackMessage(for: result.status)
            if confirmedServiceOperations.remove(service.id) != nil {
              serviceFailures.removeValue(forKey: service.id)
              showFeedback(message, kind: .success)
            } else if serviceOperations[service.id] != nil {
              serviceFailures.removeValue(forKey: service.id)
              pendingServiceAnnouncements[service.id] = message
            }
          } else {
            serviceFailures.removeValue(forKey: service.id)
          }
        } else {
          cancelServiceTimeout(for: service.id)
          serviceOperations.removeValue(forKey: service.id)
          hubSourcePending.removeValue(forKey: service.id)
          hubStrategyPending.removeValue(forKey: service.id)
          pendingServiceAnnouncements.removeValue(forKey: service.id)
          confirmedServiceOperations.remove(service.id)
          serviceFailures[service.id] =
            result.message ?? "The service could not complete that action."
        }
      }
      if let operation = pendingOperations.removeValue(forKey: result.requestId) {
        // Background creation has no button to answer. Success is the new
        // profile row. A failure still has to be said: the attempt is
        // remembered, so this session will not try that account again.
        if operation == "codex-profile-auto-sync", result.status == "success" {
          suppressResultFeedback = true
        }
        // Account switches are complete when the service returns the action
        // result. Do not rely on observing the busy flag transition: a fast
        // result can clear it before synchronize() sees the in-flight state,
        // which otherwise leaves the row stuck showing Switch progress.
        if operation == "account-switch" {
          switchingAccountID = nil
        }
        if operation == "client-reset",
          let appID = pendingAppRemovals.removeValue(forKey: result.requestId),
          result.status == "success"
        {
          forgetApp(appID)
          suppressResultFeedback = true
        }
        if operation == "codex-profile-auto-sync",
          let fingerprints = pendingAutoCodexProfileFingerprints.removeValue(forKey: result.requestId),
          result.status == "success"
        {
          var known = AppPreferences.codexAutoProfileSourceFingerprints
          known.formUnion(fingerprints)
          AppPreferences.codexAutoProfileSourceFingerprints = known
        }
        operationResult = DesignOperationResult(
          requestID: result.requestId,
          operation: operation,
          succeeded: result.status == "success",
          message: result.message ?? "",
          code: result.code
        )
        if operation == "account-save-auth", result.code == "ACCOUNT_EXISTS" {
          // The add sheet turns this into Replace. The error alert would
          // cover the button that answers it.
          suppressResultFeedback = true
        }
        if operation == "gateway-create" {
          // One-shot auto-connect arming: only a successful create may
          // capture the next gateway of the same name.
          let name = pendingGatewayNames.removeValue(forKey: result.requestId)
          if result.status == "success", let name {
            pendingGatewayConnectName = name
          }
        }
        if operation.hasPrefix("setting-") {
          pendingSettings.remove(String(operation.dropFirst("setting-".count)))
        }
        if operation == "account-backup-import" {
          if result.status == "success" {
            backupInspectionState = .success
            backupInspectionMessage = result.message ?? localized("desktop.backups.accounts_imported")
          } else if result.message?.localizedCaseInsensitiveContains("expired") == true {
            backupInspectionState = .expired
            backupInspectionMessage = result.message
          } else {
            backupInspectionState = .atomicFailure
            backupInspectionMessage = result.message ?? localized("desktop.backups.no_accounts_changed")
          }
        }
        if operation == "proxy-token" {
          suppressResultFeedback = true
          let copyID = pendingProxyTokenCopies.removeValue(forKey: result.requestId)
          if result.status == "success",
            let key = result.payload?.apiKey, !key.isEmpty, let copyID
          {
            if pasteString(key) {
              noteCopiedKey(id: copyID)
              announceOnly("Copied API key.")
            } else {
              announceOnly("Couldn’t copy API key.")
            }
          } else {
            showFeedback(
              result.displayMessage ?? "Couldn’t copy the API key.",
              kind: .error)
          }
        }
        if operation == "account-backup-forget" {
          // Server-confirmed forget: only now drop the staged copy and
          // the row. Failures keep both; the generic feedback below surfaces
          // the engine reason as the error alert.
          let backupID = pendingForgetBackupIDs.removeValue(forKey: result.requestId)
          if result.status == "success", let backupID {
            if store.backupPreview?.inspectionId == backupID {
              store.clearBackupPreview()
            }
            backups.removeAll { $0.id == backupID }
          }
        }
      }
      let outcome = feedbackKind(for: result.status)
      if result.code == "CLIENT_CONFIG_FOREIGN" {
        // The refusal is answerable: offer the confirmation it asked for
        // instead of leaving the user to run a CLI flag they may not have.
        pendingTakeover = DesignTakeoverOffer(id: result.requestId)
      }
      if !suppressResultFeedback {
        showFeedback(
          result.displayMessage ?? fallbackMessage(for: result.status),
          kind: outcome
        )
      }
    }
    synchronizeAutomaticCodexProfiles()
  }

  /// Re-run the action whose takeover the engine refused, now with the user's
  /// consent. The engine backs the previous file up before it replaces it.
  // MARK: - Takeover

  override func confirmPendingTakeover() {
    guard let offer = pendingTakeover else { return }
    pendingTakeover = nil
    if store.retryInvokeWithConsent(requestId: offer.id) == nil {
      showFeedback(
        "AnyPick could not retry that change. Try again when the service is ready.",
        kind: .warning
      )
    }
  }

  /// A cancelled command is not a failure. The user asked for it, so raising the
  /// error alert — which is what the old `status == "success" ? … : .error`
  /// did — told them off for their own action.
  // MARK: - Result mapping

  private func feedbackKind(for status: String) -> DesignFeedback.Kind {
    switch status {
    case "success": return .success
    case "cancelled": return .information
    default: return .error
    }
  }

  private func fallbackMessage(for status: String) -> String {
    switch status {
    case "success": return "Action completed."
    case "cancelled": return "Action cancelled."
    default: return "Action failed."
    }
  }

  override var savedAccountProviderOptions: [DesignProviderOption] {
    // Add Account is the subscription/native-login surface. Compatible
    // providers that only publish credential kinds are API gateways and must
    // stay in Add API Gateway; otherwise every API vendor is presented as a
    // misleading local account option.
    store.accountProviders.filter { source in
      source.installed || !(source.loginMethods ?? []).isEmpty
    }.map {
      let canSignIn = $0.installed || ($0.loginMethods ?? []).contains(where: \.available)
      return DesignProviderOption(
        id: $0.id,
        label: $0.label,
        detail: Self.accountProviderDetail($0),
        iconID: $0.clientId ?? $0.id,
        enabled: canSignIn,
        canClear: $0.canClear == true,
        loginMethods: ($0.loginMethods ?? []).map {
          DesignLoginMethod(
            id: $0.id,
            label: $0.label,
            detail: $0.detail ?? "Browser sign-in",
            provenance: $0.provenance,
            preferred: $0.preferred,
            available: $0.available,
            unavailableReason: $0.unavailableReason,
            sourceID: $0.sourceID,
            sourceLabel: $0.sourceLabel
          )
        },
        credentialKinds: ($0.credentialKinds ?? []).map {
          DesignCredentialKind(
            kind: $0.kind,
            label: $0.label,
            profiles: ($0.profiles ?? []).map {
              DesignCredentialProfile(id: $0.profileID, label: $0.label)
            },
            secretOptional: $0.secretOptional == true
          )
        },
        acceptsAuthPaste: $0.acceptsAuthPaste == true
      )
    }
  }

  override var gatewayProviderOptions: [DesignProviderOption] {
    store.gatewayProviders.map {
      DesignProviderOption(
        id: $0.id,
        label: $0.label,
        detail: $0.detail,
        defaultEndpoint: $0.defaultEndpoint,
        providesEndpoint: $0.providesEndpoint == true,
        requiresApiKey: $0.requiresApiKey == true,
        firstPartyClientIDs: $0.firstPartyClientIds ?? [],
        kind: $0.kind ?? "gateway",
        requiresGatewayId: $0.requiresGatewayId == true,
        requiresAccountId: $0.requiresAccountId == true
      )
    }
  }

  /// How long a service spinner may wait for snapshot confirmation before
  /// failing loudly instead of spinning forever. Must exceed the engine's own
  /// action budget (60s): a legal-but-slow action used to raise "didn't confirm
  /// in time" at 15s while the engine went on to succeed.
  private static let serviceConfirmTimeout: UInt64 = 75_000_000_000

  // MARK: - Service operations

  private func trackServiceOperation(_ operation: DesignServiceOperation, for serviceID: String) {
    pendingServiceAnnouncements.removeValue(forKey: serviceID)
    confirmedServiceOperations.remove(serviceID)
    serviceOperations[serviceID] = operation
    cancelServiceTimeout(for: serviceID)
    serviceTimeoutTasks[serviceID] = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: Self.serviceConfirmTimeout)
      guard let self, !Task.isCancelled else { return }
      guard self.serviceOperations[serviceID] != nil else { return }
      self.serviceOperations.removeValue(forKey: serviceID)
      self.pendingServiceAnnouncements.removeValue(forKey: serviceID)
      self.confirmedServiceOperations.remove(serviceID)
      self.serviceFailures[serviceID] =
        "The service didn’t confirm in time. Check Live Logs for details."
      self.showFeedback(
        "The service didn’t confirm in time. Check Live Logs for details.",
        kind: .error)
    }
  }

  private func cancelServiceTimeout(for serviceID: String) {
    serviceTimeoutTasks.removeValue(forKey: serviceID)?.cancel()
  }

  /// Clears service spinners whose target state a snapshot now confirms.
  /// Runs on every synchronize (after proxies sync), so the spinner stops
  /// on `running`, not on the faster command-accepted result.
  private func confirmServiceOperations() {
    for (serviceID, operation) in serviceOperations {
      // Conflict resolve has no snapshot state to confirm against: the engine
      // result settles it (see settleConflictRow), and a failure arrives as a
      // result error. Leaving it to this loop meant every successful pick still
      // raised "didn't confirm in time" 15 seconds later.
      if serviceID.hasPrefix("hub-conflict/") { continue }
      // A row the engine already failed must not keep its spinner either.
      if serviceFailures[serviceID] != nil {
        cancelServiceTimeout(for: serviceID)
        serviceOperations.removeValue(forKey: serviceID)
        hubSourcePending.removeValue(forKey: serviceID)
        hubStrategyPending.removeValue(forKey: serviceID)
        pendingServiceAnnouncements.removeValue(forKey: serviceID)
        confirmedServiceOperations.remove(serviceID)
        continue
      }
      // A strategy pick confirms against the snapshot's strategy name.
      if let desired = hubStrategyPending[serviceID] {
        if store.hubSources.first(where: { hubSourceServiceID($0.id) == serviceID })?
          .strategy == desired
        {
          cancelServiceTimeout(for: serviceID)
          serviceOperations.removeValue(forKey: serviceID)
          hubStrategyPending.removeValue(forKey: serviceID)
          serviceFailures.removeValue(forKey: serviceID)
        }
        continue
      }
      // Hub-source toggles confirm against the snapshot's enabled flag, not
      // the faster command-accepted result.
      if let desired = hubSourcePending[serviceID] {
        if serviceFailures[serviceID] != nil {
          hubSourcePending.removeValue(forKey: serviceID)
        } else if store.hubSources.first(where: { hubSourceServiceID($0.id) == serviceID })?
          .enabled == desired
        {
          cancelServiceTimeout(for: serviceID)
          serviceOperations.removeValue(forKey: serviceID)
          hubSourcePending.removeValue(forKey: serviceID)
          // A confirmed row is healthy again: a stale failure from an earlier
          // attempt would otherwise stay on it forever.
          serviceFailures.removeValue(forKey: serviceID)
        }
        continue
      }
      let running: Bool?
      if serviceID == "hub" {
        running = store.proxyHub?.running
      } else if let proxy = store.proxies.first(where: { $0.id == serviceID }) {
        running = proxy.running
      } else {
        running = nil
      }
      guard let running else {
        // Row vanished (account removed mid-flight): never strand a spinner.
        cancelServiceTimeout(for: serviceID)
        serviceOperations.removeValue(forKey: serviceID)
        pendingServiceAnnouncements.removeValue(forKey: serviceID)
        confirmedServiceOperations.remove(serviceID)
        continue
      }
      let confirmed =
        switch operation {
        case .starting, .restarting: running
        case .stopping: !running
        }
      if confirmed {
        cancelServiceTimeout(for: serviceID)
        serviceOperations.removeValue(forKey: serviceID)
        serviceFailures.removeValue(forKey: serviceID)
        if operation == .starting || operation == .stopping {
          if let message = pendingServiceAnnouncements.removeValue(forKey: serviceID) {
            showFeedback(message, kind: .success)
          } else {
            confirmedServiceOperations.insert(serviceID)
          }
        }
      }
    }
  }

  func providerSymbol(_ provider: String) -> String {
    DesignBrandAsset.fallbackSymbol(for: provider)
  }

}
