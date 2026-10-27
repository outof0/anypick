import AppKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers

@MainActor
class MacOSDesignModel: ObservableObject {
  // MARK: - State

  @Published var destination: DesignDestination
  @Published var phase: DesignLoadPhase
  @Published var appearance: DesignAppearance
  @Published var activityShowsLogs: Bool
  @Published var apps: [DesignApp]
  @Published var allSupportedApps: [DesignApp] = []
  @Published var codexProfiles: [DesignCodexProfile] = []
  @Published var codexProfileSources: [DesignCodexProfileSource] = []
  @Published var automaticallyCreateCodexProfiles = AppPreferences.codexAutoProfilesEnabled
  /// Production quota is keyed by saved account, independently of installed apps.
  @Published var accountUsage: [String: [DesignUsageWindow]]?
  @Published var accounts: [DesignAccount]
  @Published var proxies: [DesignProxy]
  @Published var activity: [DesignActivity]
  @Published var liveLogLines: [String]
  @Published var logSources: [DesignLogSource]
  @Published var selectedLogSourceID: String
  @Published var logState: DesignLogState = .idle
  @Published var logStateMessage: String?
  @Published var backups: [DesignBackup]
  @Published var backupInspectionState: DesignBackupInspectionState = .idle
  @Published var backupInspectionMessage: String?
  @Published var hubSourceIDs: Set<String>
  @Published var hubSources: [DesignHubSource]
  @Published var routingConflicts: [DesignRoutingConflict] = []
  @Published var publishedModels: [DesignPublishedModel] = []
  @Published var proxyHubModelCount: Int?
  @Published var proxyHubEnabled = true
  /// Hub-wide request mode: spread each model across the accounts that can
  /// serve it, instead of pinning it to the resolved source.
  @Published var proxyHubRotates = false
  @Published var proxyHubPort = 41_401
  @Published var proxyHubApiKey = ""
  @Published var proxyHubHasToken = false
  /// Fires when a copy lands on the pasteboard. The key is not part of this value.
  @Published var copiedKey: DesignCopiedKey?
  @Published var publishModels = true
  @Published var openAtLogin = true
  @Published var showUsage = true
  @Published var startProxiesAtLaunch = true
  @Published var warnBeforeLowUsage = true
  @Published var selectedLanguage = "auto"
  @Published var resolvedLanguage = DesktopMessageCatalog.systemLanguage
  @Published var languageOptions = LanguageOptionSnapshot.defaultOptions
  @Published var lowUsageThreshold = 10
  @Published var showGettingStarted = false
  @Published var showFirstRunWelcome = false
  @Published var onboardingDismissed = false
  @Published var useTrustedProfiles = true
  @Published var feedback: DesignFeedback?
  /// Set when the engine refused a client-config takeover it cannot prove it
  /// owns. The error alert then offers the confirmation the refusal asked for;
  /// without it the message "confirm the takeover" had nothing to confirm it.
  @Published var pendingTakeover: DesignTakeoverOffer?
  @Published var pendingStartupFlow: String?
  @Published var pendingGatewayConnectID: String?
  /// Set by every "Add Login…" entry point outside Accounts (Welcome, the
  /// checklist, the tray, File → Add Login…). AccountsView consumes it and
  /// opens the Add sheet, so each one lands on the same step, not the pane.
  @Published var addLoginRequested = false
  @Published var pendingGatewayConnectName: String?
  /// Set by tray search to drill into one account once the Accounts pane shows.
  /// MainWindow consumes (pushes the detail) and clears it.
  @Published var pendingAccountDetailID: String?
  @Published var liveLogins: [DesignLiveLogin] = []
  @Published var pendingImportBackupID: String?
  @Published var isBusy = false
  @Published var switchingAccountID: String?
  @Published var operationResult: DesignOperationResult?
  @Published var trayScene: DesignTrayScene = .auto
  @Published var switchPhase: DesignSwitchPhase = .idle
  @Published var trayUseWithAppID: String?
  @Published var serviceOperations: [String: DesignServiceOperation] = [:]
  @Published var serviceFailures: [String: String] = [:]
  @Published var degradedConditions: [DesignDegradedCondition] = []
  @Published var doctorReport: DesignDoctorReport?
  @Published var doctorIsRunning = false
  @Published var doctorError: String?
  var hubCatalogs: [DesignHubCatalog] = []
  private var hubModelOwners: [String: String] = [:]
  var cachedRouteCandidates: [String: [DesignRoutingCandidate]] = [:]
  /// Provider-level model defaults, keyed like the engine buckets
  /// (account provider id, "gateway/<name>", "proxy-hub"). Fixture-local keys
  /// never cross to the engine; production resolves them server-side.
  var providerModelDefaults: [String: [String: String]] = [:]
  /// In-flight fixture simulations. Production overrides every path
  /// that uses these, so they never affect the live service.
  var feedbackDismissTask: Task<Void, Never>?
  private var logPollingTask: Task<Void, Never>?
  private var proxySimTasks = [String: Task<Void, Never>]()

  // MARK: - Derived state

  var isProduction: Bool { false }

  var currentLiveLogins: [DesignLiveLogin] { liveLogins }

  var currentLiveLogin: DesignLiveLogin? { currentLiveLogins.first }

  // MARK: - Construction

  init(
    destination: DesignDestination,
    phase: DesignLoadPhase,
    appearance: DesignAppearance,
    activityShowsLogs: Bool,
    apps: [DesignApp],
    accounts: [DesignAccount],
    proxies: [DesignProxy],
    activity: [DesignActivity],
    liveLogLines: [String] = [],
    logSources: [DesignLogSource] = [],
    selectedLogSourceID: String = "",
    backups: [DesignBackup],
    startupFlow: String? = nil
  ) {
    self.destination = destination
    self.phase = phase
    self.appearance = appearance
    self.activityShowsLogs = activityShowsLogs
    self.allSupportedApps = apps
    self.apps = Self.applyingQuickPanelPreferences(apps)
    self.accounts = accounts
    self.proxies = proxies
    self.activity = activity
    self.liveLogLines = liveLogLines
    self.logSources = logSources
    self.selectedLogSourceID =
      selectedLogSourceID.isEmpty
      ? logSources.first?.id ?? ""
      : selectedLogSourceID
    self.backups = backups
    pendingStartupFlow = startupFlow
    hubCatalogs = DesignHubRouting.catalogs(from: accounts)
    let initialHubSourceIDs = DesignHubRouting.defaultEnabledIDs(in: accounts)
    hubSourceIDs = initialHubSourceIDs
    hubSources = DesignHubRouting.sources(from: accounts, enabledIDs: initialHubSourceIDs)
    proxyHubModelCount = nil
    let compiled = DesignHubRouting.compile(
      sources: hubSources,
      catalogs: hubCatalogs,
      owners: hubModelOwners
    )
    hubSources = compiled.sources
    publishedModels = compiled.models
    routingConflicts = compiled.conflicts
    proxyHubModelCount = compiled.models.filter { !$0.needsChoice }.count
  }

  var savedAccountProviderOptions: [DesignProviderOption] {
    [
      DesignProviderOption(
        id: "Claude",
        label: "Claude",
        detail: "Local app login",
        canClear: true,
        loginMethods: [
          DesignLoginMethod(
            id: "claude-subscription",
            label: "Claude subscription",
            detail: "Claude Code browser sign-in",
            provenance: "official",
            preferred: true,
            available: true
          )
        ],
        acceptsAuthPaste: true
      ),
      DesignProviderOption(
        id: "OpenAI",
        label: "OpenAI",
        detail: "Local app login",
        canClear: true,
        loginMethods: [
          DesignLoginMethod(
            id: "chatgpt-subscription",
            label: "ChatGPT subscription",
            detail: "OpenAI Codex browser sign-in",
            provenance: "official",
            preferred: true,
            available: true
          )
        ],
        acceptsAuthPaste: true
      ),
      DesignProviderOption(
        id: "Gemini",
        label: "Gemini",
        detail: "Google subscription or API key",
        canClear: true,
        loginMethods: [
          DesignLoginMethod(
            id: "gemini-subscription",
            label: "Gemini subscription",
            detail: "Google browser sign-in for Gemini CLI",
            provenance: "official",
            preferred: true,
            available: true,
            sourceID: "gemini-cli"
          ),
          DesignLoginMethod(
            id: "antigravity-subscription",
            label: "Antigravity subscription",
            detail: "Google browser sign-in for Antigravity-compatible access",
            provenance: "official",
            preferred: false,
            available: true,
            sourceID: "antigravity"
          ),
        ],
        credentialKinds: [
          DesignCredentialKind(
            kind: "api-key",
            label: "Gemini API key",
            profiles: [
              DesignCredentialProfile(id: "global", label: "Google AI Studio")
            ]
          )
        ]
      ),
      DesignProviderOption(
        id: "Kiro",
        label: "Kiro",
        detail: "Local app login",
        canClear: true,
        loginMethods: [
          DesignLoginMethod(
            id: "builder-id",
            label: "Builder ID or social login",
            detail: "Kiro browser sign-in",
            provenance: "official",
            preferred: true,
            available: true
          )
        ]
      ),
      DesignProviderOption(
        id: "Grok",
        label: "Grok",
        detail: "Local app login",
        canClear: true,
        loginMethods: [
          DesignLoginMethod(
            id: "grok-subscription",
            label: "Grok subscription",
            detail: "Grok browser sign-in",
            provenance: "official",
            preferred: true,
            available: true
          )
        ]
      ),
      DesignProviderOption(
        id: "OpenCode",
        label: "OpenCode",
        detail: "Use the OpenCode login already on this Mac",
        canClear: true,
      ),
      DesignProviderOption(
        id: "WorkBuddy",
        label: "WorkBuddy",
        detail: "Local app login",
        canClear: true,
        // Two regions, one preferred: a token issued by one host is rejected
        // by the other, so the user picks the site they actually signed in on.
        // Community, not official — this flow is undocumented.
        loginMethods: [
          DesignLoginMethod(
            id: "workbuddy-international",
            label: "WorkBuddy international",
            detail: "Browser sign-in at www.codebuddy.ai",
            provenance: "community",
            preferred: true,
            available: true
          ),
          DesignLoginMethod(
            id: "codebuddy-china",
            label: "CodeBuddy China",
            detail: "Browser sign-in at copilot.tencent.com",
            provenance: "community",
            preferred: false,
            available: true
          ),
        ]
      ),
    ]
  }

  var gatewayProviderOptions: [DesignProviderOption] {
    [
      DesignProviderOption(
        id: "OpenRouter", label: "OpenRouter", detail: "Multi-model API gateway",
        defaultEndpoint: "https://openrouter.ai/api/v1", kind: "hosted"
      ),
      DesignProviderOption(
        id: "OpenAI", label: "OpenAI", detail: "OpenAI API",
        defaultEndpoint: "https://api.openai.com/v1", firstPartyClientIDs: ["codex"], kind: "hosted"
      ),
      DesignProviderOption(
        id: "Anthropic", label: "Anthropic", detail: "Anthropic Claude API",
        defaultEndpoint: "https://api.anthropic.com", firstPartyClientIDs: ["claude"],
        kind: "hosted"
      ),
      DesignProviderOption(
        id: "Grok", label: "xAI", detail: "xAI Grok API",
        defaultEndpoint: "https://api.x.ai/v1", kind: "hosted"
      ),
      DesignProviderOption(
        id: "Gemini", label: "Gemini", detail: "Google Gemini API",
        defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta",
        firstPartyClientIDs: ["gemini"], kind: "hosted"
      ),
      DesignProviderOption(
        id: "LiteLLM", label: "LiteLLM", detail: "Self-hosted proxy",
        defaultEndpoint: "http://127.0.0.1:4000", kind: "custom"
      ),
      DesignProviderOption(
        id: "Local", label: "Local Gateway", detail: "Local OpenAI-compatible gateway",
        defaultEndpoint: "http://127.0.0.1:8080/v1", kind: "custom"
      ),
      DesignProviderOption(
        id: "cloudflare-aigateway", label: "Cloudflare AI Gateway",
        detail: "Cloudflare AI Gateway REST API (Unified Billing)", kind: "hosted",
        requiresGatewayId: true, requiresAccountId: true
      ),
      DesignProviderOption(
        id: "Custom", label: "Custom", detail: "Custom endpoint", kind: "custom"),
    ]
  }

  static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment)
    -> MacOSDesignModel
  {
    let fixture =
      DesignLoadPhase(rawValue: environment["ANYPICK_MACOS_FIXTURE"] ?? "ready")
      ?? (environment["ANYPICK_MACOS_FIXTURE"] == "populated" ? .ready : .ready)
    let startupFlow = environment["ANYPICK_MACOS_FLOW"]
    let explicitDestination = environment["ANYPICK_MACOS_DESTINATION"].flatMap(DesignDestination.init)
    let flowDestination: DesignDestination? = switch startupFlow {
    case "add-account", "add-account-error", "add-gateway", "add-gateway-error", "remove-account": .accounts
    case "published-models": .apps
    case "inspect-model", "hub-overlap": .proxyHub
    case let flow? where flow.hasPrefix("proxy-detail"): .proxies
    case "create-backup", "restore-backup", "import-backup": .backups
    default: nil
    }
    let destination = explicitDestination ?? flowDestination ?? .overview
    let appearance =
      DesignAppearance(rawValue: environment["ANYPICK_MACOS_APPEARANCE"] ?? "system")
      ?? .system
    let showsLogs = environment["ANYPICK_MACOS_ACTIVITY_MODE"] == "logs"
    let populated = DesignFixture.populated()
    let model = MacOSDesignModel(
      destination: destination,
      phase: fixture,
      appearance: appearance,
      activityShowsLogs: showsLogs,
      apps: fixture == .empty ? [] : populated.apps,
      accounts: fixture == .empty ? [] : populated.accounts,
      proxies: fixture == .empty ? [] : populated.proxies,
      activity: fixture == .empty ? [] : populated.activity,
      liveLogLines: fixture == .empty ? [] : populated.liveLogLines,
      logSources: fixture == .empty
        ? []
        : [
          DesignLogSource(
            id: "hub",
            label: "Proxy Hub",
            detail: "Shared local endpoint",
            provider: "proxy-hub",
            symbol: "point.3.connected.trianglepath.dotted"
          ),
          DesignLogSource(
            // The stopped notice's Start button needs a source id that
            // matches a proxy row.
            id: "codex-relay",
            label: "Codex Relay",
            detail: "Personal · Codex",
            provider: "codex",
            symbol: "terminal.fill"
          ),
        ],
      selectedLogSourceID: "hub",
      backups: fixture == .empty ? [] : populated.backups,
      startupFlow: startupFlow
    )
    if fixture != .empty {
      model.codexProfileSources = [
        DesignCodexProfileSource(
          sourceID: "account/gemini/work",
          label: "Gemini · Work",
          detail: "maya@studio.example",
          selected: true,
          models: ["gemini-3.8-flash", "gemini-3.8-pro"]
        ),
        DesignCodexProfileSource(
          sourceID: "hub/default",
          kind: "proxy-hub",
          label: "Proxy Hub",
          detail: "Shared models and accounts",
          selected: false,
          models: ["gemini-3.8-flash", "gpt-5.6-codex"]
        ),
      ]
      model.codexProfiles = [
        DesignCodexProfile(
          name: "gemini-work",
          sourceID: "account/gemini/work",
          sourceLabel: "Gemini · Work",
          modelID: "gemini-3.8-flash",
          transportPolicy: "auto",
          launchCommand: "source '$HOME/.anypick/clients/codex/profiles/gemini-work.env.sh' && CODEX_HOME='$HOME/.anypick/clients/codex/profiles/gemini-work/codex-home' codex --profile 'gemini-work'"
        ),
      ]
    }
    if fixture == .empty {
      model.proxyHubEnabled = false
      model.showFirstRunWelcome = !(environment["ANYPICK_MACOS_FLOW"] ?? "").hasPrefix("tray")
    }
    model.logState = fixture == .empty ? .unavailable : (showsLogs ? .ready : .idle)
    if environment["ANYPICK_MACOS_FLOW"] == "getting-started" {
      model.showGettingStarted = true
    } else if environment["ANYPICK_MACOS_FLOW"] == "feedback-toast" {
      model.feedback = DesignFeedback(
        message: "Gateway connection verified. Models were loaded successfully.",
        kind: .success
      )
    }
    if fixture != .empty {
      model.liveLogins = [
        DesignLiveLogin(
          providerID: "claude",
          sourceID: nil,
          providerName: "Claude",
          appName: "Claude Code",
          identity: "alex@studio.example",
          symbol: "brain.head.profile"
        )
      ]
    }
    model.applyTrayScene(from: environment)
    if let accountID = environment["ANYPICK_MACOS_ACCOUNT"], !accountID.isEmpty {
      model.destination = .accounts
      model.pendingAccountDetailID = accountID
    }
    return model
  }

  func applyTrayScene(from environment: [String: String]) {
    let flow = environment["ANYPICK_MACOS_FLOW"] ?? ""
    if let explicit = DesignTrayScene(rawValue: environment["ANYPICK_MACOS_TRAY"] ?? "") {
      trayScene = explicit
    } else if flow == "tray-attention" {
      trayScene = .attention
    } else if flow == "tray-use-with" {
      trayScene = .useWith
      trayUseWithAppID = "codex"
    } else if flow == "tray-switching" {
      trayScene = .useWith
      trayUseWithAppID = "claude"
      switchPhase = .inFlight(appID: "claude", from: "Work", to: "Personal", routeID: "personal")
      isBusy = true
    } else if flow == "tray-recovery" {
      trayScene = .useWith
      trayUseWithAppID = "claude"
      switchPhase = .recovery(
        appID: "claude", requested: "Personal", kept: "Work", routeID: "personal")
    } else if flow == "tray-first-run" || phase == .empty {
      trayScene = .firstRun
    } else if flow.hasPrefix("tray") {
      trayScene = .ready
    } else {
      trayScene = isProduction ? .auto : .ready
    }
    if trayScene == .attention, let index = apps.firstIndex(where: { $0.id == "kiro" }) {
      apps[index].status = .attention
    }
  }

  // MARK: - Overview

  var hasSavedLogin: Bool { overviewHasSavedLogin(accounts: accounts) }

  var hasInstalledApp: Bool { !apps.isEmpty }

  var hasChosenRoute: Bool { overviewHasChosenRoute(apps: apps) }

  var isHubReady: Bool {
    proxyHubEnabled && !hubSourceIDs.isEmpty && routingConflicts.isEmpty
  }

  var isOnboardingCoreComplete: Bool { hasSavedLogin && hasInstalledApp && hasChosenRoute }

  var isFirstRun: Bool { accounts.isEmpty }

  var shouldShowOnboarding: Bool {
    if showGettingStarted { return true }
    if onboardingDismissed { return false }
    if isFirstRun { return true }
    return !isOnboardingCoreComplete
  }

  var attentionCount: Int {
    apps.filter { $0.status == .attention || $0.status == .unavailable }.count
      + accounts.filter { $0.status == .attention || $0.status == .unavailable }.count
      + proxies.filter { $0.status == .attention || $0.status == .unavailable }.count
  }

  var healthyAccountCount: Int {
    accounts.filter { $0.status == .ready || $0.status == .running }.count
  }

  func refresh() {
    recordActivity(
      title: "AnyPick refreshed",
      detail: "Apps, accounts, and local services are up to date.",
      symbol: "arrow.clockwise",
      status: .ready
    )
    showFeedback("Everything is up to date.", kind: .success)
  }

  // MARK: - Accounts and gateways

  func detectSavedAccount(provider: String, sourceID: String? = nil) -> Bool {
    liveLogin(for: provider) != nil
  }

  func clearLiveLogin(provider: String) {
    liveLogins.removeAll {
      $0.providerID.caseInsensitiveCompare(provider) == .orderedSame
        || $0.providerName.caseInsensitiveCompare(provider) == .orderedSame
    }
    showFeedback(
      "The live \(provider) login was backed up and cleared in this fixture.",
      kind: .warning
    )
  }

  func testGateway(provider: String, endpoint: String, apiKey: String, profile: String? = nil) -> Bool {
    !apiKey.localizedCaseInsensitiveContains("invalid")
  }

  var quickPanelApps: [DesignApp] { apps.filter(\.showInQuickPanel) }

  static func applyingQuickPanelPreferences(_ apps: [DesignApp]) -> [DesignApp] {
    apps.map { app in
      var copy = app
      if let shown = AppPreferences.quickPanelShown(for: app.id) {
        copy.showInQuickPanel = shown
      }
      return copy
    }
  }

  @discardableResult
  func setRoute(appID: String, routeID: String) -> Bool {
    guard let index = apps.firstIndex(where: { $0.id == appID }) else { return false }
    let previousRoute = apps[index].selectedRouteID
    guard previousRoute != routeID else { return true }
    let fromName = routeName(previousRoute, for: apps[index])
    let toName = routeName(routeID, for: apps[index])
    if isProduction {
      commitRoute(appID: appID, routeID: routeID)
      return true
    }
    guard !isBusy else {
      showFeedback("Another change is already in progress. Try again in a moment.", kind: .warning)
      return false
    }
    isBusy = true
    switchPhase = .inFlight(appID: appID, from: fromName, to: toName, routeID: routeID)
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 650_000_000)
      commitRoute(appID: appID, routeID: routeID)
      isBusy = false
      switchPhase = .success(appID: appID, name: toName)
      announce("\(apps[index].name) now uses \(toName)")
      try? await Task.sleep(nanoseconds: 1_600_000_000)
      if case .success = switchPhase {
        switchPhase = .idle
      }
    }
    return true
  }

  @discardableResult
  func updateAppConfiguration(
    appID: String,
    routeID: String,
    fastModel: String,
    reasoningModel: String,
    useCompatibleFallback: Bool
  ) -> Bool {
    guard let index = apps.firstIndex(where: { $0.id == appID }) else { return false }
    apps[index].selectedRouteID = routeID
    apps[index].fastModel = fastModel
    apps[index].reasoningModel = reasoningModel
    apps[index].useCompatibleFallback = useCompatibleFallback
    apps[index].status = routeID.hasPrefix("native-") ? .attention : .ready
    recordActivity(
      title: "\(apps[index].name) settings applied",
      detail: "Account choice and model roles were updated together.",
      symbol: "slider.horizontal.3",
      status: apps[index].status
    )
    showFeedback("Applied settings for \(apps[index].name).", kind: .success)
    return true
  }

  @discardableResult
  /// Fixture key mirroring the engine bucket shape (account provider,
  /// per-gateway name, single hub). Local only; production resolves keys
  /// server-side and never calls this.
  func modelRolesScopeKey(appID: String, route: DesignRoute?) -> String? {
    guard let route else { return nil }
    switch route.kind {
    case .gateway:
      return route.name.isEmpty ? nil : "gateway/" + route.name
    case .hub:
      return "proxy-hub"
    default:
      if let provider = route.providerID, !provider.isEmpty { return provider }
      let resolved = providerID(forRoute: route)
      return resolved.isEmpty ? nil : resolved
    }
  }

  /// Where the app's current values come from: per-connection pins, the
  /// provider default, or nothing yet.
  func modelRolesProvenance(appID: String) -> ModelRolesProvenance {
    guard let app = apps.first(where: { $0.id == appID }) else { return .none }
    let pinned = app.modelRoles.contains { !$0.modelID.isEmpty }
    if pinned { return .custom }
    if let route = app.routeOptions.first(where: { $0.id == app.selectedRouteID }),
      let key = modelRolesScopeKey(appID: appID, route: route),
      let defaults = providerModelDefaults[key],
      defaults.values.contains(where: { !$0.isEmpty })
    {
      return .inherited
    }
    return .none
  }

  /// Whether the connection flow should nudge into the model picker: an
  /// app with an effective default (pinned or inherited) must not be forced
  /// through it to finish.
  func appRouteNeedsModelChoice(appID: String) -> Bool {
    guard let app = apps.first(where: { $0.id == appID }),
      appRouteOffersModelStep(app)
    else { return false }
    return (effectiveModelRoles(appID: appID)["default"] ?? "").isEmpty
  }

  /// Effective values for pickers: explicit pins, else the provider default.
  func effectiveModelRoles(appID: String) -> [String: String] {
    guard let app = apps.first(where: { $0.id == appID }) else { return [:] }
    var out = Dictionary(
      uniqueKeysWithValues: app.modelRoles.map { ($0.id, $0.modelID) })
    if out.values.allSatisfy(\.isEmpty),
      let route = app.routeOptions.first(where: { $0.id == app.selectedRouteID }),
      let key = modelRolesScopeKey(appID: appID, route: route),
      let defaults = providerModelDefaults[key]
    {
      for (role, model) in defaults where !model.isEmpty {
        out[role] = model
      }
    }
    return out
  }

  func updateAppModelRoles(
    appID: String,
    routeID: String,
    modelRoles: [String: String],
    scope: ModelRoleScope = .connection
  ) -> Bool {
    guard let index = apps.firstIndex(where: { $0.id == appID }) else { return false }
    apps[index].selectedRouteID = routeID
    let cleaned = Dictionary(
      uniqueKeysWithValues: modelRoles.compactMap { key, value in
        value.isEmpty ? nil : (key, value)
      })
    switch scope {
    case .connection:
      for roleIndex in apps[index].modelRoles.indices {
        let roleID = apps[index].modelRoles[roleIndex].id
        apps[index].modelRoles[roleIndex].modelID = cleaned[roleID] ?? ""
      }
    case .provider:
      guard
        let route = apps[index].routeOptions.first(where: { $0.id == routeID }),
        let key = modelRolesScopeKey(appID: appID, route: route)
      else { return false }
      // Provider scope replaces the default and drops per-connection pins,
      // so the new default takes effect visibly everywhere at once. The
      // engine keeps pins+marker instead; both shapes read identically
      // through provenance and effective values.
      if cleaned.isEmpty {
        providerModelDefaults.removeValue(forKey: key)
      } else {
        providerModelDefaults[key] = cleaned
      }
      for roleIndex in apps[index].modelRoles.indices {
        apps[index].modelRoles[roleIndex].modelID = ""
      }
    }
    showFeedback("Applied model roles for \(apps[index].name).", kind: .success)
    return true
  }

  func resetAppConfiguration(appID: String) {
    guard let index = apps.firstIndex(where: { $0.id == appID }) else { return }
    apps[index].selectedRouteID = "native-\(appID)"
    apps[index].fastModel = ""
    apps[index].reasoningModel = ""
    apps[index].useCompatibleFallback = true
    apps[index].status = .attention
    recordActivity(
      title: "\(apps[index].name) reset",
      detail: "AnyPick-managed account and model overrides were removed.",
      symbol: "arrow.counterclockwise.circle",
      status: .attention
    )
    showFeedback("Reset \(apps[index].name) to its native login.", kind: .warning)
  }

  var availableAppsToAdd: [DesignApp] {
    allSupportedApps.filter { supported in
      !apps.contains(where: { $0.id == supported.id })
    }
  }

  func addApp(appID: String) {
    AppPreferences.addConfiguredApp(appID)
    guard let candidate = allSupportedApps.first(where: { $0.id == appID }) else { return }
    if !apps.contains(where: { $0.id == appID }) {
      apps.append(candidate)
      apps.sort(by: { $0.name.localizedStandardCompare($1.name) == .orderedAscending })
    }
    recordActivity(
      title: "\(candidate.name) added",
      detail: "Added to your managed apps.",
      symbol: "plus.circle",
      status: .ready
    )
    showFeedback("Added \(candidate.name) to your apps.", kind: .success)
  }

  @discardableResult
  func createMissingCodexProfiles(sourceIDs: [String]) -> Bool {
    let profiledSourceIDs = Set(codexProfiles.map(\.sourceID))
    let targets = codexProfileSources.filter {
      $0.kind == "account" && sourceIDs.contains($0.sourceID)
        && !profiledSourceIDs.contains($0.sourceID)
    }
    guard !targets.isEmpty else { return false }

    var created = 0
    for source in targets {
      let sourceParts = source.sourceID.split(separator: "/").suffix(2)
      let rawName = sourceParts.joined(separator: "-").lowercased()
      var name = rawName.unicodeScalars.map { scalar -> String in
        let value = scalar.value
        return (97...122).contains(value) || (48...57).contains(value) ? String(scalar) : "-"
      }.joined()
      name = name.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
      if name.isEmpty { name = "account" }
      var candidate = String(name.prefix(64))
      var suffix = 2
      while codexProfiles.contains(where: { $0.name == candidate }) {
        let tail = "-\(suffix)"
        candidate = String(name.prefix(64 - tail.count)) + tail
        suffix += 1
      }
      if saveCodexProfile(
        name: candidate,
        sourceID: source.sourceID,
        modelID: source.models.first ?? "",
        transportPolicy: "auto"
      ) {
        created += 1
      }
    }
    return created > 0
  }

  func setAutomaticCodexProfileCreation(_ enabled: Bool, baselineSourceIDs: [String]) {
    automaticallyCreateCodexProfiles = enabled
    if enabled {
      showFeedback("Automatic Codex profiles are enabled for new accounts.", kind: .success)
    } else {
      showFeedback("Automatic Codex profile creation is turned off.", kind: .information)
    }
  }

  @discardableResult
  func saveCodexProfile(
    name: String,
    sourceID: String,
    modelID: String,
    transportPolicy: String
  ) -> Bool {
    let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard validCodexProfileName(normalizedName) else {
      showFeedback("Use 1–64 letters, numbers, hyphens, or underscores for the profile name.", kind: .error)
      return false
    }
    guard !codexProfiles.contains(where: { $0.name == normalizedName }) else {
      showFeedback("A Codex profile with that name already exists.", kind: .error)
      return false
    }
    guard let source = codexProfileSources.first(where: { $0.sourceID == sourceID }) else {
      showFeedback("Choose an available Codex account or route.", kind: .error)
      return false
    }
    let needsProxyEnvironment = !sourceID.hasPrefix("account/codex/") || transportPolicy == "proxy"
    let envFile = "\(NSHomeDirectory())/.anypick/clients/codex/profiles/\(normalizedName).env.sh"
    let profileHome = "\(NSHomeDirectory())/.anypick/clients/codex/profiles/\(normalizedName)/codex-home"
    let prefix = needsProxyEnvironment ? "source '\(envFile)' && " : ""
    let command = "\(prefix)CODEX_HOME='\(profileHome)' codex --profile '\(normalizedName)'"
    codexProfiles.append(
      DesignCodexProfile(
        name: normalizedName,
        sourceID: sourceID,
        sourceLabel: source.label,
        modelID: modelID,
        transportPolicy: transportPolicy,
        launchCommand: command
      )
    )
    recordActivity(
      title: "Codex profile \(normalizedName) added",
      detail: "Saved \(source.label) as an isolated Codex profile.",
      symbol: "person.crop.circle.badge.checkmark",
      status: .ready
    )
    showFeedback("Added Codex profile \(normalizedName).", kind: .success)
    return true
  }

  func removeCodexProfile(name: String) {
    guard let index = codexProfiles.firstIndex(where: { $0.name == name }) else { return }
    codexProfiles.remove(at: index)
    recordActivity(
      title: "Codex profile \(name) removed",
      detail: "The profile was removed from AnyPick.",
      symbol: "trash",
      status: .stopped
    )
    showFeedback("Removed Codex profile \(name).", kind: .warning)
  }

  @discardableResult
  func updateCodexProfile(
    name: String,
    sourceID: String,
    modelID: String,
    transportPolicy: String
  ) -> Bool {
    guard validCodexProfileName(name) else {
      showFeedback("Use 1–64 letters, numbers, hyphens, or underscores for the profile name.", kind: .error)
      return false
    }
    guard let index = codexProfiles.firstIndex(where: { $0.name == name }) else {
      showFeedback("That Codex profile no longer exists. Refresh and try again.", kind: .error)
      return false
    }
    guard let source = codexProfileSources.first(where: { $0.sourceID == sourceID }) else {
      showFeedback("Choose an available Codex account or route.", kind: .error)
      return false
    }
    let needsProxyEnvironment = !sourceID.hasPrefix("account/codex/") || transportPolicy == "proxy"
    let envFile = "\(NSHomeDirectory())/.anypick/clients/codex/profiles/\(name).env.sh"
    let profileHome = "\(NSHomeDirectory())/.anypick/clients/codex/profiles/\(name)/codex-home"
    let prefix = needsProxyEnvironment ? "source '\(envFile)' && " : ""
    let command = "\(prefix)CODEX_HOME='\(profileHome)' codex --profile '\(name)'"
    codexProfiles[index] = DesignCodexProfile(
      name: name,
      sourceID: sourceID,
      sourceLabel: source.label,
      modelID: modelID,
      transportPolicy: transportPolicy,
      launchCommand: command
    )
    recordActivity(
      title: "Codex profile \(name) updated",
      detail: "Updated its account, model, or transport settings.",
      symbol: "checkmark.circle",
      status: .ready
    )
    showFeedback("Updated Codex profile \(name).", kind: .success)
    return true
  }

  @discardableResult
  func copyCodexProfileLaunchCommand(name: String) -> Bool {
    guard let profile = codexProfiles.first(where: { $0.name == name }),
      !profile.launchCommand.isEmpty
    else { return false }
    guard pasteString(profile.launchCommand) else {
      announceOnly("Couldn’t copy launch command.")
      return false
    }
    showFeedback("Launch command copied. Paste it into Terminal to start this Codex profile.", kind: .success)
    return true
  }

  func removeApp(appID: String) {
    guard let index = apps.firstIndex(where: { $0.id == appID }) else { return }
    let removed = apps[index]
    if isAppManagedByAnyPick(removed) {
      resetAppConfiguration(appID: appID)
    }
    AppPreferences.removeApp(appID)
    apps.remove(at: index)
    recordActivity(
      title: "\(removed.name) removed",
      detail: "Removed from your managed apps.",
      symbol: "trash",
      status: .stopped
    )
    showFeedback("Removed \(removed.name) from your apps.", kind: .warning)
  }

  func addSavedAccount(
    provider: String,
    name: String,
    label: String,
    identity: String,
    sourceID: String? = nil
  ) -> Bool {
    let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedName.isEmpty else { return false }
    guard
      !accounts.contains(where: {
        $0.provider.caseInsensitiveCompare(provider) == .orderedSame
          && $0.name.caseInsensitiveCompare(normalizedName) == .orderedSame
      })
    else {
      showFeedback(
        "An account named \(normalizedName) already exists for \(provider).", kind: .error)
      return false
    }
    let account = DesignAccount(
      id: "\(provider.lowercased())-\(normalizedName.lowercased())-\(UUID().uuidString.prefix(6))",
      name: label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? normalizedName : label,
      detail: identity,
      provider: provider,
      symbol: symbol(for: provider),
      kind: .saved,
      status: .ready,
      lastUsed: "Saved now"
    )
    accounts.append(account)
    if DesignHubRouting.isEligible(account) {
      hubSourceIDs.insert(account.id)
    }
    rebuildHubSources()
    phase = .ready
    // A saved account ends first run, as the production tray's .auto scene does.
    if trayScene == .firstRun { trayScene = .ready }
    recordActivity(
      title: "\(account.name) saved",
      detail: "\(provider) login is now available to supported apps.",
      symbol: "person.crop.circle.badge.checkmark",
      status: .ready
    )
    showFeedback("Saved \(account.name).", kind: .success)
    return true
  }

  func saveCurrentLogin(_ login: DesignLiveLogin) -> Bool {
    let existing = accounts.filter {
      $0.kind == .saved && $0.provider.caseInsensitiveCompare(login.providerName) == .orderedSame
    }.map(\.name)
    guard
      addSavedAccount(
        provider: login.providerName,
        name: unusedAccountName(existing: existing),
        label: "",
        identity: login.identity ?? "Current login"
      )
    else { return false }
    trayScene = .ready
    return true
  }

  func loginSavedAccount(
    provider: String,
    name: String,
    label: String,
    methodId: String
  ) -> Bool {
    let identity = liveLogin(for: provider)?.identity ?? "Signed in with \(methodId)"
    let requestedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let fallbackName = "subscription-\(accounts.filter { $0.provider == provider }.count + 1)"
    return addSavedAccount(
      provider: provider,
      name: requestedName.isEmpty ? fallbackName : requestedName,
      label: label,
      identity: identity
    )
  }

  /// Fixture twin of account-save-auth. A same name reports ACCOUNT_EXISTS
  /// and leaves the account list unchanged until the caller passes overwrite.
  func savePastedAuth(provider: String, name: String?, path _: String, overwrite: Bool) -> Bool {
    let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let resolved = trimmed.isEmpty ? "pasted" : trimmed
    let sameName: (DesignAccount) -> Bool = {
      $0.provider.caseInsensitiveCompare(provider) == .orderedSame
        && $0.name.caseInsensitiveCompare(resolved) == .orderedSame
    }
    if accounts.contains(where: sameName), !overwrite {
      operationResult = DesignOperationResult(
        requestID: UUID().uuidString,
        operation: "account-save-auth",
        succeeded: false,
        message: "An account named \(resolved) already exists for \(provider).",
        code: "ACCOUNT_EXISTS"
      )
      return false
    }
    if overwrite {
      accounts.removeAll(where: sameName)
    }
    let saved = addSavedAccount(
      provider: provider,
      name: resolved,
      label: "",
      identity: "Pasted auth"
    )
    operationResult = DesignOperationResult(
      requestID: UUID().uuidString,
      operation: "account-save-auth",
      succeeded: saved,
      message: saved ? "Saved \(resolved)." : (feedback?.message ?? "Couldn’t save that account.")
    )
    return saved
  }

  /// Fixture twin of the account-save-input engine path: stores a typed
  /// credential (API key / plan key) without a live login behind it.
  func saveCredentialInput(
    provider: String,
    name: String,
    kind: String,
    profile: String,
    secret: String
  ) -> Bool {
    let trimmedSecret = secret.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSecret.isEmpty else { return false }
    return addSavedAccount(
      provider: provider,
      name: name,
      label: "",
      identity: "API key"
    )
  }

  func cancelAccountLogin() {}

  func addGateway(
    provider: String,
    name: String,
    label: String,
    endpoint: String,
    apiKey: String,
    gatewayId: String? = nil,
    profile: String? = nil,
    defaultModel: String
  ) -> Bool {
    let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedName.isEmpty else { return false }
    guard
      !accounts.contains(where: { $0.name.caseInsensitiveCompare(normalizedName) == .orderedSame })
    else {
      showFeedback("A connection named \(normalizedName) already exists.", kind: .error)
      return false
    }
    let detail = [endpoint.trimmingCharacters(in: .whitespacesAndNewlines), defaultModel]
      .filter { !$0.isEmpty }
      .joined(separator: " · ")
    let gateway = DesignAccount(
      id: "gateway-\(normalizedName.lowercased())-\(UUID().uuidString.prefix(6))",
      name: label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? normalizedName : label,
      detail: detail.isEmpty ? "Default endpoint" : detail,
      provider: provider,
      symbol: symbol(for: provider),
      kind: .gateway,
      status: .ready,
      lastUsed: "Created now"
    )
    accounts.append(gateway)
    recordActivity(
      title: "\(gateway.name) gateway added",
      detail: "\(provider) is ready as an app route.",
      symbol: "network.badge.shield.half.filled",
      status: .ready
    )
    showFeedback("Added \(gateway.name).", kind: .success)
    pendingGatewayConnectID = gateway.id
    return true
  }

  @discardableResult
  func updateAccount(id: String, label: String) -> Bool {
    guard let index = accounts.firstIndex(where: { $0.id == id }) else { return false }
    let cleaned = label.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleaned.isEmpty else { return false }
    accounts[index].name = cleaned
    accounts[index].lastUsed = "Updated now"
    recordActivity(
      title: "\(cleaned) updated",
      detail: "The connection label was changed.",
      symbol: "pencil.circle",
      status: .ready
    )
    showFeedback("Updated \(cleaned).", kind: .success)
    return true
  }

  func refreshAccount(id: String) {
    guard let index = accounts.firstIndex(where: { $0.id == id }) else { return }
    accounts[index].status = .ready
    accounts[index].lastUsed = "Refreshed now"
    recordActivity(
      title: "\(accounts[index].name) refreshed",
      detail: "The saved credential and model availability were checked.",
      symbol: "arrow.clockwise.circle",
      status: .ready
    )
    showFeedback("\(accounts[index].name) is ready.", kind: .success)
  }

  /// Refreshes the model catalog for the route selected in Apps. The live
  /// model sends the provider-specific account/gateway request; the fixture
  /// keeps the same user-visible affordance without pretending to make a
  /// network call.
  func refreshAppModels(appID: String) {
    guard let app = apps.first(where: { $0.id == appID }) else { return }
    showFeedback("Refreshing models for \(app.name)…", kind: .information)
  }

  /// Re-probe a saved gateway with its stored credential.
  func testSavedGateway(id: String) {
    guard let index = accounts.firstIndex(where: { $0.id == id && $0.kind == .gateway }) else {
      return
    }
    accounts[index].status = .ready
    accounts[index].lastUsed = "Tested now"
    recordActivity(
      title: "\(accounts[index].name) tested",
      detail: "The gateway answered with the saved credential.",
      symbol: "checkmark.circle",
      status: .ready
    )
    showFeedback("\(accounts[index].name) is ready.", kind: .success)
  }

  func connectGateway(id: String, appIDs: Set<String>) {
    guard let gateway = accounts.first(where: { $0.id == id && $0.kind == .gateway }) else {
      return
    }
    let changes = gatewayRouteChanges(id: id, appIDs: appIDs)
    if changes.isEmpty {
      showFeedback("No app routes needed to change.", kind: .information)
      return
    }
    for change in changes {
      applyRoute(appID: change.appID, routeID: change.routeID)
    }
    let names = apps.filter { appIDs.contains($0.id) }.map(\.name)
    let detail =
      names.isEmpty
      ? "No apps use \(gateway.name)."
      : "\(names.joined(separator: ", ")) now use \(gateway.name)."
    recordActivity(
      title: "\(gateway.name) connected",
      detail: detail,
      symbol: "network",
      status: .ready
    )
    showFeedback(detail, kind: .success)
  }

  func makeAccountCurrent(id: String) {
    guard let account = accounts.first(where: { $0.id == id }) else { return }
    guard !isCurrentAccount(account) else { return }
    if isProduction {
      applyMakeCurrent(id: id)
      return
    }
    isBusy = true
    switchingAccountID = id
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 650_000_000)
      applyMakeCurrent(id: id)
      isBusy = false
      switchingAccountID = nil
    }
  }

  func removeAccount(id: String) {
    guard let index = accounts.firstIndex(where: { $0.id == id }) else { return }
    let removed = accounts.remove(at: index)
    hubSourceIDs.remove(id)
    rebuildHubSources()
    recordActivity(
      title: "\(removed.name) removed",
      detail: "The saved \(removed.provider) connection was removed from AnyPick.",
      symbol: "trash",
      status: .attention
    )
    showFeedback("Removed \(removed.name).", kind: .warning)
  }

  /// What a hub-source switch displays.
  ///
  /// The base model has no engine to wait for, so the switch is the stored
  /// state. Production overrides this to keep the user's choice while the
  /// engine confirms it — reading only the snapshot made the switch bounce back
  /// to its old value until the next snapshot arrived, which reads as the
  /// control fighting the click.
  ///
  /// Rotation is a hub mode, not a source: it is stored on its row and kept out
  /// of hubSourceIDs, so "does this hub have sources?" keeps meaning sources.
  // MARK: - Hub

  func hubSourceShowsEnabled(_ sourceID: String) -> Bool {
    if let row = hubSources.first(where: { $0.id == sourceID }), row.rotates {
      return row.enabled
    }
    return hubSourceIDs.contains(sourceID)
  }

  /// The hub-wide request mode as a name: "failover", "round-robin" or
  /// "soonest-reset". An older engine sends only the round-robin flag.
  func hubStrategy(_ sourceID: String) -> String {
    guard let row = hubSources.first(where: { $0.id == sourceID }) else { return "failover" }
    if !row.strategy.isEmpty { return row.strategy }
    return row.enabled ? "round-robin" : "failover"
  }

  /// Sets the hub-wide request mode by name (ADR-0035). The base model has no
  /// engine, so the stored row is the whole truth.
  func setHubStrategy(_ hub: String, strategy: String) {
    proxyHubRotates = strategy == "round-robin"
    if let index = hubSources.firstIndex(where: { $0.rotates && ($0.hub ?? "default") == hub }) {
      hubSources[index].strategy = strategy
      hubSources[index].enabled = strategy == "round-robin"
    }
  }

  /// The hub-wide request mode. The base model has no engine, so the stored
  /// strategy is the whole truth; Production sends the mutation and waits for
  /// the snapshot like every other switch.
  func setHubRotation(_ hub: String, enabled: Bool) {
    proxyHubRotates = enabled
    if let index = hubSources.firstIndex(where: { $0.rotates && ($0.hub ?? "default") == hub }) {
      hubSources[index].enabled = enabled
    }
    recordActivity(
      title: enabled ? "Proxy Hub rotation on" : "Proxy Hub rotation off",
      detail: enabled
        ? "Each model is spread across the accounts that can serve it."
        : "Each model is served by one account again.",
      symbol: "arrow.triangle.2.circlepath",
      status: enabled ? .ready : .attention
    )
  }

  func setHubSource(_ accountID: String, enabled: Bool) {
    if enabled { hubSourceIDs.insert(accountID) } else { hubSourceIDs.remove(accountID) }
    if let index = hubSources.firstIndex(where: { $0.id == accountID }) {
      hubSources[index].enabled = enabled
    }
    if hubSourceIDs.isEmpty { proxyHubEnabled = false }
    if enabled { proxyHubEnabled = true }
    recompileHubRouting()
    let name =
      hubSources.first(where: { $0.id == accountID })?.name
      ?? accounts.first(where: { $0.id == accountID })?.name
    guard let name else { return }
    recordActivity(
      title: "Proxy Hub sources updated",
      detail: "\(name) was \(enabled ? "included in" : "removed from") Proxy Hub.",
      symbol: "point.3.connected.trianglepath.dotted",
      status: enabled ? .ready : .attention
    )
  }

  func selectRoutingCandidate(actionID: String) {
    if actionID.hasPrefix("model-route:") {
      let parts = actionID.split(separator: ":", maxSplits: 2)
      if parts.count == 3 {
        let modelID = String(parts[1])
        let candidateID = String(parts[2])
        let ownerID: String
        if candidateID.hasPrefix("provider/") {
          let pid = String(candidateID.dropFirst(9)).lowercased()
          ownerID = hubSources.first(where: {
            $0.provider.lowercased() == pid ||
            $0.providerID.lowercased() == pid
          })?.id ?? candidateID
        } else {
          ownerID = candidateID
        }
        hubModelOwners[modelID] = ownerID
        recompileHubRouting()
        return
      }
    }

    guard
      let conflict = routingConflicts.first(where: {
        $0.candidates.contains(where: { $0.actionID == actionID })
      }),
      let candidate = conflict.candidates.first(where: { $0.actionID == actionID })
    else { return }
    // A provider choice resolves to the provider's first source in this
    // conflict — the fixture mirror of the engine pinning the provider id
    // to its first attached source.
    let ownerID: String
    if candidate.providerChoice {
      if let first = hubSources.first(where: {
        $0.provider.lowercased() == candidate.provider.lowercased() ||
        $0.providerID.lowercased() == candidate.provider.lowercased()
      }) {
        ownerID = first.id
      } else {
        ownerID = candidate.id
      }
    } else {
      ownerID = candidate.id
    }
    for model in conflict.models {
      hubModelOwners[model] = ownerID
    }
    recompileHubRouting()
  }

  func recompileHubRouting() {
    let compiled = DesignHubRouting.compile(
      sources: hubSources,
      catalogs: hubCatalogs,
      owners: hubModelOwners
    )
    if hubSources != compiled.sources {
      hubSources = compiled.sources
    }
    if publishedModels != compiled.models {
      publishedModels = compiled.models
    }
    if routingConflicts != compiled.conflicts {
      routingConflicts = compiled.conflicts
    }
    let newCount = compiled.models.filter { !$0.needsChoice }.count
    if proxyHubModelCount != newCount {
      proxyHubModelCount = newCount
    }
    cachedRouteCandidates = DesignHubRouting.allRouteCandidates(
      catalogs: hubCatalogs,
      sources: hubSources
    )
  }

  /// Production restores these persisted pins from the engine snapshot before
  /// compiling the catalog. Fixture interactions keep using the local map.
  func replaceHubModelOwners(_ owners: [String: String]) {
    if hubModelOwners != owners {
      hubModelOwners = owners
    }
  }

  func routeCandidates(for modelID: String) -> [DesignRoutingCandidate] {
    if let cached = cachedRouteCandidates[modelID], !cached.isEmpty {
      return cached
    }
    let fromCatalogs = DesignHubRouting.routeCandidates(
      for: modelID,
      catalogs: hubCatalogs,
      sources: hubSources
    )
    if !fromCatalogs.isEmpty {
      return fromCatalogs
    }
    if let conflict = routingConflicts.first(where: { $0.models.contains(modelID) }) {
      let providerCandidates = conflict.candidates.filter(\.providerChoice)
      if providerCandidates.count > 1 {
        return providerCandidates
      }
    }
    return []
  }

  private func rebuildHubSources() {
    hubCatalogs = DesignHubRouting.catalogs(from: accounts)
    hubSourceIDs = hubSourceIDs.intersection(Set(accounts.map(\.id)))
    hubSources = DesignHubRouting.sources(from: accounts, enabledIDs: hubSourceIDs)
    recompileHubRouting()
  }

  // MARK: - Proxies

  func setProxyEnabled(id: String, enabled: Bool) {
    guard let index = proxies.firstIndex(where: { $0.id == id }) else { return }
    let previousEnabled = proxies[index].enabled
    guard previousEnabled != enabled else { return }
    // Brief progress mirrors production, so
    // the row spinners and failure slots are exercisable without the engine.
    proxySimTasks[id]?.cancel()
    let operation: DesignServiceOperation = enabled ? .starting : .stopping
    serviceOperations[id] = operation
    serviceFailures.removeValue(forKey: id)
    let name = proxies[index].name
    proxySimTasks[id] = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 600_000_000)
      guard let self, !Task.isCancelled else { return }
      self.proxySimTasks.removeValue(forKey: id)
      self.serviceOperations.removeValue(forKey: id)
      guard let index = self.proxies.firstIndex(where: { $0.id == id }) else { return }
      self.proxies[index].enabled = enabled
      self.proxies[index].status = enabled ? .running : .stopped
      if id == "hub" { self.proxyHubEnabled = enabled }
      self.recordActivity(
        title: "\(name) \(enabled ? "started" : "stopped")",
        detail: "Local service on port \(self.proxies[index].port).",
        symbol: enabled ? "play.circle.fill" : "stop.circle",
        status: enabled ? .running : .stopped
      )
      self.showFeedback("\(name) \(enabled ? "started" : "stopped").")
    }
  }

  func setProxyHubEnabled(_ enabled: Bool) {
    proxySimTasks["hub"]?.cancel()
    let operation: DesignServiceOperation = enabled ? .starting : .stopping
    serviceOperations["hub"] = operation
    serviceFailures.removeValue(forKey: "hub")
    proxySimTasks["hub"] = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 600_000_000)
      guard let self, !Task.isCancelled else { return }
      self.proxySimTasks.removeValue(forKey: "hub")
      self.serviceOperations.removeValue(forKey: "hub")
      self.proxyHubEnabled = enabled
      self.recordActivity(
        title: "Proxy Hub \(enabled ? "started" : "stopped")",
        detail: enabled ? "Listening on localhost:\(self.proxyHubPort)." : "Proxy Hub is stopped.",
        symbol: enabled ? "play.circle.fill" : "stop.circle",
        status: enabled ? .running : .stopped
      )
      self.showFeedback("Proxy Hub \(enabled ? "started" : "stopped").")
    }
  }

  func restartProxy(id: String) {
    if id == "hub" {
      setProxyHubEnabled(true)
      return
    }
    guard let index = proxies.firstIndex(where: { $0.id == id }) else { return }
    let name = proxies[index].name
    let port = proxies[index].port
    proxySimTasks[id]?.cancel()
    serviceOperations[id] = .restarting
    serviceFailures.removeValue(forKey: id)
    proxySimTasks[id] = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 600_000_000)
      guard let self, !Task.isCancelled else { return }
      self.proxySimTasks.removeValue(forKey: id)
      self.serviceOperations.removeValue(forKey: id)
      guard let index = self.proxies.firstIndex(where: { $0.id == id }) else { return }
      self.proxies[index].enabled = true
      self.proxies[index].status = .running
      self.recordActivity(
        title: "\(name) restarted",
        detail: "Listening on localhost:\(port).",
        symbol: "arrow.clockwise.circle.fill",
        status: .running
      )
      self.showFeedback("Restarted \(name).", kind: .success)
    }
  }

  func rotateProxyKey(id: String) {
    if id == "hub" {
      proxyHubApiKey = "aph_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
      proxyHubHasToken = true
      showFeedback("Proxy Hub API key rotated.", kind: .success)
      return
    }
    guard let index = proxies.firstIndex(where: { $0.id == id }) else { return }
    let newKey = "ap_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    proxies[index].apiKey = newKey
    proxies[index].hasToken = true
    showFeedback("Rotated \(proxies[index].name) API key.", kind: .success)
  }

  func proxyCanCopyAPIKey(_ proxy: DesignProxy) -> Bool {
    proxy.hasToken || !proxy.apiKey.isEmpty
  }

  var proxyHubCanCopyAPIKey: Bool {
    proxyHubHasToken || !proxyHubApiKey.isEmpty
  }

  /// Fixture copy. Production replaces this with a service fetch so the
  /// snapshot never has to carry the bearer.
  func copyProxyAPIKey(id: String) {
    let key: String
    if id == "hub" {
      key = proxyHubApiKey
    } else if let proxy = proxies.first(where: { $0.id == id }) {
      key = proxy.apiKey
    } else {
      return
    }
    guard !key.isEmpty else {
      announceOnly("API key isn’t available.")
      return
    }
    guard pasteString(key) else {
      announceOnly("Couldn’t copy API key.")
      return
    }
    noteCopiedKey(id: id)
    announceOnly("Copied API key.")
  }

  func pasteString(_ value: String) -> Bool {
    NSPasteboard.general.clearContents() != 0
      && NSPasteboard.general.setString(value, forType: .string)
  }

  func noteCopiedKey(id: String) {
    let nonce = (copiedKey?.nonce ?? 0) + 1
    copiedKey = DesignCopiedKey(id: id, nonce: nonce)
  }

  func restartRunningProxies() {
    let runningIDs = proxies.filter(\.enabled).map(\.id)
    for id in runningIDs { restartProxy(id: id) }
    if runningIDs.isEmpty {
      showFeedback("There are no running proxies to restart.", kind: .information)
    } else {
      showFeedback(
        "Restarted \(runningIDs.count) running \(runningIDs.count == 1 ? "proxy" : "proxies").",
        kind: .success)
    }
  }

  func stopAllProxies() {
    for index in proxies.indices {
      proxies[index].enabled = false
      proxies[index].status = .stopped
    }
    recordActivity(
      title: "All local proxies stopped",
      detail: "Apps using direct native logins were not changed.",
      symbol: "stop.circle",
      status: .stopped
    )
    showFeedback("Stopped all local proxies.", kind: .warning)
  }

  @discardableResult
  // MARK: - Backups

  func createBackup(accountIDs: Set<String>) -> Bool {
    let selected = accounts.filter { accountIDs.contains($0.id) && $0.kind == .saved }
    guard !selected.isEmpty, selected.count <= BackupLimits.maxAccounts else {
      showFeedback(
        "Select between 1 and \(BackupLimits.maxAccounts) saved accounts.",
        kind: .error)
      return false
    }
    let formatter = DateFormatter()
    formatter.dateFormat = "MMM d 'at' HH:mm"
    let backup = DesignBackup(
      id: "backup-\(UUID().uuidString)",
      createdAt: formatter.string(from: Date()),
      accountCount: selected.count,
      size: "\(max(8, selected.count * 7)) KB",
      location: "AnyPick Backups",
      accounts: selected
    )
    backups.insert(backup, at: 0)
    recordActivity(
      title: "Account backup created",
      detail: "\(selected.count) saved \(selected.count == 1 ? "account" : "accounts") included.",
      symbol: "externaldrive.badge.checkmark",
      status: .ready
    )
    showFeedback(
      "Created a backup with \(selected.count) \(selected.count == 1 ? "account" : "accounts").",
      kind: .success)
    return true
  }

  @discardableResult
  func importBackupPackage() -> Bool {
    if pendingStartupFlow == "import-backup" {
      pendingStartupFlow = nil
      return presentImportedBackup(fileName: "AnyPick Accounts.anypick-backup")
    }
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    panel.allowedContentTypes = [UTType(filenameExtension: "anypick-backup") ?? .data]
    panel.message = "Choose an AnyPick account backup."
    panel.prompt = "Choose"
    guard panel.runModal() == .OK, let url = panel.url else { return false }
    return presentImportedBackup(fileName: url.lastPathComponent)
  }

  @discardableResult
  func presentImportedBackup(fileName: String) -> Bool {
    guard var package = backups.first(where: { $0.id == "backup-import" }) ?? backups.last else {
      showFeedback("That file isn’t an AnyPick backup.", kind: .error)
      return false
    }
    package.location = fileName
    if let index = backups.firstIndex(where: { $0.id == package.id }) {
      backups[index] = package
    }
    pendingImportBackupID = package.id
    return true
  }

  // MARK: - Settings and activity

  func runDoctor() {
    doctorIsRunning = false
    doctorError = nil
    doctorReport = DesignDoctorReport(
      status: "ok",
      findings: []
    )
  }

  func setOpenAtLogin(_ enabled: Bool) {
    showFeedback(enabled ? "AnyPick will open at login." : "Open at Login disabled.")
  }

  func setShowUsage(_ enabled: Bool) {
    showFeedback(enabled ? "Usage remaining is visible." : "Usage remaining is hidden.")
  }

  func setStartProxiesAtLaunch(_ enabled: Bool) {
    startProxiesAtLaunch = enabled
    showFeedback(
      enabled
        ? "Enabled local proxies will start at launch."
        : "Local proxies will only start when an app needs one."
    )
  }

  func setWarnBeforeLowUsage(_ enabled: Bool) {
    warnBeforeLowUsage = enabled
    showFeedback(enabled ? "Low-usage warnings are on." : "Low-usage warnings are off.")
  }

  func setLanguage(_ language: String) {
    selectedLanguage = language
    resolvedLanguage = language == "auto" ? DesktopMessageCatalog.systemLanguage : language
    showFeedback(localized("desktop.settings.language_saved"))
  }

  func dismissOnboarding() {
    onboardingDismissed = true
    showGettingStarted = false
  }

  /// Opens Accounts with the Add Login sheet up.
  func requestAddLogin() {
    addLoginRequested = true
    destination = .accounts
  }

  /// Welcome's primary action: leave Welcome and go straight to adding a login.
  func addLoginFromWelcome() {
    dismissFirstRunWelcome()
    requestAddLogin()
  }

  func dismissFirstRunWelcome() {
    // The sheet's isPresented binding calls this again as it closes; a second
    // call must not send an Add Login request back to Overview.
    guard showFirstRunWelcome else { return }
    showFirstRunWelcome = false
    // Don't pin showGettingStarted here: the checklist derives from real
    // state (isFirstRun / core complete), and pinning it defeated the
    // auto-dismiss in OverviewView. Settings can still pin it explicitly via
    // showGettingStartedAgain.
    destination = .overview
  }

  func showGettingStartedAgain() {
    onboardingDismissed = false
    showGettingStarted = true
    destination = .overview
  }

  func setActivityShowsLogs(_ enabled: Bool) {
    activityShowsLogs = enabled
    if enabled, logState == .idle {
      logState = logSources.isEmpty ? .unavailable : (liveLogLines.isEmpty ? .empty : .ready)
    }
  }

  func selectLogSource(_ id: String) {
    guard logSources.contains(where: { $0.id == id }) else { return }
    selectedLogSourceID = id
    // A stopped service shows its Start action rather than an empty log.
    if logSources.first(where: { $0.id == id })?.provider == "proxy-hub" {
      logState = proxyHubEnabled ? (liveLogLines.isEmpty ? .empty : .ready) : .stopped
    } else if let proxy = proxies.first(where: { $0.id == id }), !proxy.enabled {
      logState = .stopped
    } else {
      logState = liveLogLines.isEmpty ? .empty : .ready
    }
    logStateMessage = nil
  }

  func refreshSelectedLogSource() {
    guard !selectedLogSourceID.isEmpty else { return }
    selectLogSource(selectedLogSourceID)
  }

  /// Fixture polling simulation: Loading → settled, so the notice rows
  /// and Live badge are exercisable without the engine. Stopped sources stay
  /// stopped — polling must not clobber the Start action. Production
  /// overrides this with real polling.
  func setLogPolling(_ enabled: Bool) {
    logPollingTask?.cancel()
    logPollingTask = nil
    guard enabled, logState != .stopped else { return }
    // Cached tails stay put; only
    // the first load flashes Loading.
    guard liveLogLines.isEmpty else { return }
    logState = .loading
    logStateMessage = "Loading logs…"
    logPollingTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 500_000_000)
      guard let self, !Task.isCancelled else { return }
      self.logPollingTask = nil
      self.logState = self.liveLogLines.isEmpty ? .empty : .ready
      self.logStateMessage = nil
    }
  }

  // MARK: - Backup restore

  func restoreBackup(id: String, accountIDs: Set<String>, overwrite: Bool) {
    guard let backup = backups.first(where: { $0.id == id }) else { return }
    let selected = backup.accounts.filter { accountIDs.contains($0.id) }
    guard !selected.isEmpty else {
      showFeedback("Select at least one account to import.", kind: .information)
      return
    }
    // Match the engine rule: without overwrite, already-saved accounts
    // are skipped — an all-skipped selection warns instead of reporting
    // a hollow "0 Accounts Imported" success.
    let skipped = selected.filter { alreadySavedAccount($0) }.count
    guard overwrite || skipped < selected.count else {
      showFeedback(
        "Nothing to import: every selected account is already saved. Choose Replace to overwrite.",
        kind: .information
      )
      return
    }
    var restored = 0
    for account in selected {
      if let index = accounts.firstIndex(where: {
        $0.provider == account.provider && $0.name == account.name
      }) {
        if !overwrite { continue }
        accounts[index] = account
      } else {
        accounts.append(account)
      }
      if DesignHubRouting.isEligible(account) {
        hubSourceIDs.insert(account.id)
      }
      restored += 1
    }
    rebuildHubSources()
    backupInspectionState = .success
    backupInspectionMessage = "\(restored) \(restored == 1 ? "Account" : "Accounts") Imported"
    recordActivity(
      title: "Account backup restored",
      detail: "\(restored) saved \(restored == 1 ? "account" : "accounts") imported.",
      symbol: "arrow.down.doc.fill",
      status: .ready
    )
    showFeedback("Imported \(restored) \(restored == 1 ? "account" : "accounts").", kind: .success)
  }

  @discardableResult
  func deleteBackup(id: String) -> Bool {
    guard let index = backups.firstIndex(where: { $0.id == id }) else { return false }
    let removed = backups.remove(at: index)
    showFeedback("Deleted backup from \(removed.createdAt).", kind: .warning)
    return true
  }

  func clearActivity() {
    activity.removeAll()
    liveLogLines.removeAll()
    showFeedback("Activity history cleared.", kind: .information)
  }

  /// Confirm the takeover the engine asked for. The base (fixture) model has no
  /// engine to re-run, so it only clears the offer; ProductionDesignModel
  /// overrides it.
  // MARK: - Feedback and identity

  func confirmPendingTakeover() {
    pendingTakeover = nil
  }

  func recordActivity(
    title: String,
    detail: String,
    symbol: String,
    status: DesignStatus
  ) {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm"
    activity.insert(
      DesignActivity(
        id: UUID().uuidString,
        time: formatter.string(from: Date()),
        title: DesktopMessageCatalog.text(
          source: title, preference: selectedLanguage, resolved: resolvedLanguage),
        detail: DesktopMessageCatalog.text(
          source: detail, preference: selectedLanguage, resolved: resolvedLanguage),
        symbol: symbol,
        status: status
      ),
      at: 0
    )
  }

}

enum DesktopMessageCatalog {
  private static let locales = ["en", "zh-CN", "es", "fr", "de", "ja", "ko", "pt-BR", "vi"]
  private static let catalogs: [String: [String: [String: String]]] = loadCatalogs()
  private static let sourcePatterns: [(key: String, source: String)] = {
    guard let english = catalogs["en"] else { return [] }
    return english.keys.sorted().compactMap { key in
      guard let source = english[key]?["other"], !source.isEmpty else { return nil }
      return (key, source)
    }.sorted { left, right in
      let leftSpecificity = left.source.filter { $0 != "{" && $0 != "}" }.count
      let rightSpecificity = right.source.filter { $0 != "{" && $0 != "}" }.count
      return leftSpecificity > rightSpecificity
    }
  }()

  static var systemLanguage: String {
    for candidate in Locale.preferredLanguages {
      if let resolved = supportedCatalogID(candidate) { return resolved }
    }
    return "en"
  }

  static func text(
    _ key: String,
    preference: String,
    resolved: String,
    plural: String = "other"
  ) -> String {
    let locale = preference == "auto" ? catalogID(resolved) : catalogID(preference)
    let messages = catalogs[locale]?[key] ?? catalogs["en"]?[key]
    return messages?[plural] ?? messages?["other"] ?? key
  }

  /// Translate legacy user-facing copy by resolving it to its keyed English
  /// catalog entry. New UI should call `text(_ key:)` directly; this adapter
  /// keeps feedback and activity strings on the same catalogs while older
  /// model actions are migrated incrementally.
  static func text(source: String, preference: String, resolved: String) -> String {
    for entry in sourcePatterns {
      guard let captures = sourceCaptures(entry.source, from: source) else { continue }
      var translated = text(entry.key, preference: preference, resolved: resolved)
      for (name, value) in captures {
        translated = translated.replacingOccurrences(of: "{\(name)}", with: value)
      }
      return translated
    }
    return source
  }

  private static func sourceCaptures(_ template: String, from source: String) -> [(String, String)]? {
    let nsTemplate = template as NSString
    let placeholderRegex = try! NSRegularExpression(pattern: #"\{([A-Za-z0-9_]+)\}"#)
    let matches = placeholderRegex.matches(
      in: template,
      range: NSRange(location: 0, length: nsTemplate.length)
    )
    guard !matches.isEmpty else {
      return template == source ? [] : nil
    }
    var expression = "^"
    var names: [String] = []
    var cursor = 0
    for match in matches {
      let literalRange = NSRange(location: cursor, length: match.range.location - cursor)
      expression += NSRegularExpression.escapedPattern(for: nsTemplate.substring(with: literalRange))
      expression += "(.+?)"
      names.append(nsTemplate.substring(with: match.range(at: 1)))
      cursor = NSMaxRange(match.range)
    }
    let suffixRange = NSRange(location: cursor, length: nsTemplate.length - cursor)
    expression += NSRegularExpression.escapedPattern(for: nsTemplate.substring(with: suffixRange)) + "$"
    guard let regex = try? NSRegularExpression(pattern: expression),
      let match = regex.firstMatch(
        in: source,
        range: NSRange(location: 0, length: (source as NSString).length)
      )
    else { return nil }
    let nsSource = source as NSString
    return names.enumerated().compactMap { index, name in
      let range = match.range(at: index + 1)
      guard range.location != NSNotFound else { return nil }
      return (name, nsSource.substring(with: range))
    }
  }

  static func catalogID(_ raw: String) -> String {
    supportedCatalogID(raw) ?? "en"
  }

  private static func supportedCatalogID(_ raw: String) -> String? {
    let locale = raw.replacingOccurrences(of: "_", with: "-").lowercased()
    if locale.hasPrefix("zh-hant") || locale.hasPrefix("zh-tw") || locale.hasPrefix("zh-hk")
      || locale.hasPrefix("zh-mo")
    {
      return nil
    }
    for candidate in locales.reversed() {
      if locale == candidate.lowercased() || locale.hasPrefix(candidate.lowercased() + "-") {
        return candidate
      }
    }
    if locale.hasPrefix("zh") { return "zh-CN" }
    if locale.hasPrefix("pt") { return "pt-BR" }
    return nil
  }

  private static func loadCatalogs() -> [String: [String: [String: String]]] {
    let bundles = [Bundle.main, Bundle(for: AnyPickAppDelegate.self)]
    return Dictionary(uniqueKeysWithValues: locales.compactMap { locale in
      guard let url = catalogURL(locale, bundles: bundles),
        let data = try? Data(contentsOf: url),
        let raw = try? JSONSerialization.jsonObject(with: data) as? [String: [String: String]]
      else { return nil }
      return (locale, raw)
    })
  }

  private static func catalogURL(_ locale: String, bundles: [Bundle]) -> URL? {
    let filename = "messages.\(locale).json"
    var roots = bundles.compactMap(\.resourceURL)
    for bundle in bundles {
      roots.append(
        bundle.bundleURL.deletingLastPathComponent()
          .appendingPathComponent("AnyPick.app/Contents/Resources", isDirectory: true)
      )
      var ancestor = bundle.bundleURL
      for _ in 0..<5 {
        roots.append(ancestor)
        ancestor = ancestor.deletingLastPathComponent()
      }
    }
    for root in roots {
      for candidate in [root.appendingPathComponent("i18n/\(filename)"),
        root.appendingPathComponent("Resources/i18n/\(filename)")]
      {
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
      }
    }
    return nil
  }
}

extension MacOSDesignModel {
  func localized(_ key: String) -> String {
    DesktopMessageCatalog.text(key, preference: selectedLanguage, resolved: resolvedLanguage)
  }

  func localizedSource(_ source: String) -> String {
    DesktopMessageCatalog.text(
      source: source, preference: selectedLanguage, resolved: resolvedLanguage)
  }

  func localized(_ key: String, replacing values: [String: String]) -> String {
    values.reduce(localized(key)) { result, entry in
      result.replacingOccurrences(of: "{\(entry.key)}", with: entry.value)
    }
  }

  func localized(_ key: String, count: Int, replacing values: [String: String] = [:]) -> String {
    let plural = count == 1 ? "one" : "other"
    let template = DesktopMessageCatalog.text(
      key, preference: selectedLanguage, resolved: resolvedLanguage, plural: plural)
    return values.reduce(template) { result, entry in
      result.replacingOccurrences(of: "{\(entry.key)}", with: entry.value)
    }
  }
}
