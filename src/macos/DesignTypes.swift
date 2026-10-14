import SwiftUI

// MARK: - Navigation (System Settings–style destinations)

enum DesignDestination: String, CaseIterable, Identifiable, Hashable {
  case overview
  case apps
  case accounts
  case proxyHub
  case proxies
  case activity
  case backups
  case settings

  var id: String { rawValue }

  var title: String {
    switch self {
    case .overview: "Overview"
    case .apps: "Apps"
    case .accounts: "Accounts & APIs"
    case .proxyHub: "Proxy Hub"
    case .proxies: "Proxies"
    case .activity: "Activity"
    case .backups: "Backups"
    case .settings: "Settings"
    }
  }

  /// Toolbar / back label — keep the sidebar title, shorten the chrome.
  var shortTitle: String {
    switch self {
    case .accounts: "Accounts"
    case .proxyHub: "Proxy Hub"
    case .proxies: "Proxies"
    case .backups: "Backups"
    case .settings: "Settings"
    default: title
    }
  }

  var symbol: String {
    switch self {
    case .overview: "square.grid.2x2"
    case .apps: "app.badge"
    case .accounts: "person.2"
    case .proxyHub: "point.3.connected.trianglepath.dotted"
    case .proxies: "server.rack"
    case .activity: "list.bullet"
    case .backups: "externaldrive.fill.badge.timemachine"
    case .settings: "gearshape"
    }
  }

  /// Destinations the Quick Panel can search. Settings stays in the main
  /// sidebar and Go menu; the tray keeps its own compact navigation surface.
  static var trayCases: [DesignDestination] {
    allCases.filter { $0 != .settings }
  }

}

// MARK: - Status

enum DesignStatus: String, CaseIterable {
  case ready = "Ready"
  case running = "Running"
  case attention = "Isn’t working"
  case unavailable = "Not available"
  case stopped = "Stopped"

  var symbol: String {
    switch self {
    case .ready, .running: "checkmark.circle.fill"
    case .attention: "exclamationmark.triangle.fill"
    case .unavailable: "xmark.circle.fill"
    case .stopped: "stop.circle"
    }
  }

  var color: Color {
    switch self {
    case .ready, .running: .green
    case .attention: .orange
    case .unavailable: .red
    case .stopped: .secondary
    }
  }
}

enum DesignLoadPhase: String {
  case ready, loading, empty, error
}

enum DesignLogState: String {
  case idle, loading, ready, empty, stopped, error, unavailable
}

enum DesignBackupInspectionState: String {
  case idle, reading, ready, damaged, newerVersion, permissionDenied, missing, expired
  case importing, success, atomicFailure
}

enum DesignServiceOperation: String {
  case starting, stopping, restarting

  var label: String {
    switch self {
    case .starting: "Starting…"
    case .stopping: "Stopping…"
    case .restarting: "Restarting…"
    }
  }
}

/// Fixture/render override only — product UI follows system appearance.
enum DesignAppearance: String {
  case system, light, dark

  var colorScheme: ColorScheme? {
    switch self {
    case .system: nil
    case .light: .light
    case .dark: .dark
    }
  }
}

// MARK: - Domain rows

enum DesignRouteKind: String, Hashable {
  case account
  case native
  case hub
  case gateway
}

struct DesignRoute: Identifiable, Hashable {
  let id: String
  var name: String
  var detail: String
  var symbol: String
  var badge: String? = nil
  var kind: DesignRouteKind = .account
  var providerID: String? = nil
  /// Engine source (`account/claude/work`). Empty on fixture rows that
  /// predate it; dedupe falls back to the display key for those.
  var sourceID: String = ""
}

/// Fixture/render override. Production uses `.auto`.
enum DesignTrayScene: String {
  case auto
  case ready
  case attention
  case useWith = "use-with"
  case firstRun = "first-run"
}

enum DesignSwitchPhase: Equatable {
  case idle
  /// `to`/`requested`/`kept` are display names for toasts; `routeID` is the
  /// identity switch marks match on — names collide across providers.
  case inFlight(appID: String, from: String, to: String, routeID: String)
  case success(appID: String, name: String)
  case recovery(appID: String, requested: String, kept: String, routeID: String)
}

struct DesignModelRole: Identifiable, Hashable {
  let id: String
  var label: String
  var modelID: String
}

struct DesignLoginMethod: Identifiable, Hashable {
  let id: String
  var label: String
  var detail: String
  var provenance: String
  var preferred: Bool
  var available: Bool
  var unavailableReason: String? = nil
  var sourceID: String? = nil
  var sourceLabel: String? = nil
}

struct DesignProviderOption: Identifiable, Hashable {
  let id: String
  var label: String
  var detail: String
  /// Optional presentation owner for hybrid providers. Z.ai's subscription
  /// account is presented with ZCode's app mark while its API gateway keeps
  /// the Z.ai provider id and mark.
  var iconID: String? = nil
  var defaultEndpoint: String? = nil
  var providesEndpoint: Bool = false
  var requiresApiKey: Bool = true
  var firstPartyClientIDs: [String] = []
  var enabled: Bool = true
  var canClear: Bool = false
  var loginMethods: [DesignLoginMethod] = []
  var kind: String = "gateway"
  var requiresGatewayId: Bool = false
  var requiresAccountId: Bool = false
  var regions: [String] = []
  var defaultRegion: String? = nil
  /// Typed credential products (API keys / plan keys) accepted through
  /// account-save-input. Native providers may publish these alongside their
  /// local-login path.
  var credentialKinds: [DesignCredentialKind] = []
  /// The provider can save its own auth file from pasted JSON.
  var acceptsAuthPaste: Bool = false
}

struct DesignCredentialKind: Identifiable, Hashable {
  var id: String { kind }
  let kind: String
  var label: String
  var profiles: [DesignCredentialProfile] = []
}

struct DesignCredentialProfile: Identifiable, Hashable {
  let id: String
  var label: String
}

struct DesignHubSource: Identifiable, Hashable {
  let id: String
  var name: String
  var detail: String
  var provider: String
  /// Raw engine provider id ("codex") for provider-level choices. Display
  /// keeps using `provider`; never show this raw value.
  var providerID: String = ""
  var symbol: String
  var enabled: Bool
  var warning: String? = nil
  var modelCount: Int = 0
  /// True for the hub-wide "rotate across accounts" row: one per hub, toggled
  /// as a hub mode rather than as a source.
  var rotates: Bool = false
  var rotatesAccountCount: Int = 0
  /// True for a row whose label and detail come from the engine because its
  /// account value is not an account at all ("pool:<provider>").
  var poolSource: Bool = false

  /// Rows that name themselves instead of resolving an account identity.
  var describesItself: Bool { rotates || poolSource }
  /// Hub owning this row; sent back as Name on hub mutations.
  var hub: String = ""
}

struct DesignHubCatalog: Hashable {
  var accountID: String
  var catalogID: String
  var models: [String]
}

struct DesignPublishedModel: Identifiable, Hashable {
  var id: String { modelID }
  var modelID: String
  var ownerAccountID: String?
  var ownerName: String
  var ownerProvider: String
  var needsChoice: Bool
}

enum DesignRoutingConflictKind: String, Hashable {
  case sourceChoice = "source-choice"
  case modelOverlap = "model-overlap"
}

struct DesignRoutingCandidate: Identifiable, Hashable {
  let id: String
  var label: String
  var detail: String
  var provider: String
  var actionID: String
  /// Whole-provider choice ("OpenAI") instead of one account. Rendered from
  /// `provider` via nativeProviderName; the engine resolves it to the first
  /// attached source.
  var providerChoice: Bool = false
}

struct DesignRoutingConflict: Identifiable, Hashable {
  let id: String
  var kind: DesignRoutingConflictKind
  var title: String
  var detail: String
  var models: [String]
  var needsAttention: Bool
  var candidates: [DesignRoutingCandidate]
  var selectedCandidateID: String? = nil
}

struct DesignOperationResult: Equatable {
  let requestID: String
  let operation: String
  let succeeded: Bool
  let message: String
  /// Engine code (`ACCOUNT_EXISTS`, `ACCOUNT_SNAPSHOT_EXISTS`, …). Absent on
  /// a result that has no machine code to report.
  let code: String?

  /// A defaulted stored `let` is left out of the memberwise initializer, so
  /// `code:` cannot be passed unless this init exists. Call sites without an
  /// engine code omit it.
  init(
    requestID: String,
    operation: String,
    succeeded: Bool,
    message: String,
    code: String? = nil
  ) {
    self.requestID = requestID
    self.operation = operation
    self.succeeded = succeeded
    self.message = message
    self.code = code
  }
}

/// A refused client-config takeover the user can still confirm.
///
/// The engine fails closed when a client's config holds values it does not own
/// (CLIENT_CONFIG_FOREIGN) so it never overwrites a login the user pointed
/// elsewhere. Without this offer the refusal was a dead end: the message told
/// the user to confirm the takeover, and no surface offered one.
struct DesignTakeoverOffer: Equatable, Identifiable {
  /// The requestId of the refused attempt, so two offers cannot collide.
  let id: String
}

struct DesignDegradedCondition: Identifiable, Hashable {
  let id: String
  var kind: String
  var title: String
  var detail: String
}

struct DesignDoctorFinding: Identifiable, Equatable {
  let check: String
  let status: String
  let detail: String?

  var id: String { "\(check):\(detail ?? status)" }
}

struct DesignDoctorReport: Equatable {
  let status: String
  let findings: [DesignDoctorFinding]
}

struct DesignApp: Identifiable, Hashable {
  let id: String
  var name: String
  var detail: String
  var symbol: String
  var status: DesignStatus
  var showInQuickPanel: Bool = true
  var accountCount: Int
  var selectedRouteID: String
  var routeOptions: [DesignRoute]
  var fastModel: String
  var reasoningModel: String
  var useCompatibleFallback: Bool
  var modelRoles: [DesignModelRole] = []
  var modelOptions: [String] = []
  var modelEditingAvailable: Bool = true
  var modelUnavailableReason: String? = nil
  var usageWindows: [DesignUsageWindow] = []
  var usageRemaining: String? = nil
  var attentionMessage: String? = nil
}

struct DesignCodexProfileSource: Identifiable, Hashable {
  var id: String { sourceID }
  let sourceID: String
  var kind: String = "account"
  var label: String
  var detail: String
  var selected: Bool
  var models: [String]
}

struct DesignCodexProfile: Identifiable, Hashable {
  var id: String { name }
  let name: String
  var sourceID: String
  var sourceLabel: String
  var modelID: String
  var transportPolicy: String
  var launchCommand: String
}

func validCodexProfileName(_ value: String) -> Bool {
  let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
  return !value.isEmpty && value.count <= 64
    && value.trimmingCharacters(in: .whitespacesAndNewlines) == value
    && value.unicodeScalars.allSatisfy(allowed.contains)
}

struct DesignUsageWindow: Identifiable, Hashable {
  var label: String
  var remainingPercent: Int
  var resetsAtMs: Double? = nil
  var limitWindowSeconds: Int? = nil
  /// Vendor section title from retrieveUserQuotaSummary (e.g. "Gemini Models").
  var group: String? = nil

  var id: String { "\(group ?? ""):\(label):\(resetsAtMs ?? -1)" }
}

enum DesignAccountKind: String, CaseIterable {
  case saved = "Saved Account"
  case gateway = "API Gateway"
  case native = "Direct Account"
}

struct DesignAccount: Identifiable, Hashable {
  let id: String
  var name: String
  var detail: String
  var provider: String
  var symbol: String
  var kind: DesignAccountKind
  var status: DesignStatus
  var lastUsed: String
  /// Engine provider / client id ("codex", "gemini"). Quota is reported per
  /// live login, so the account row needs this to find its app's usage rows
  /// without guessing from the display name.
  var providerID: String = ""
  /// Engine answer for a reviewed backup entry: true when importing it
  /// would replace a saved account. Nil on rows that are not an import
  /// review, which still match by provider and name.
  var importReplacesSaved: Bool? = nil
}

struct DesignLiveLogin: Identifiable, Equatable {
  let providerID: String
  let sourceID: String?
  let providerName: String
  let appName: String
  let identity: String?
  let symbol: String

  var id: String { "\(providerID):\(sourceID ?? "default")" }
}

struct DesignCopiedKey: Equatable {
  var id: String
  var nonce: Int
}

struct DesignProxy: Identifiable, Hashable {
  let id: String
  var name: String
  var detail: String
  var symbol: String
  var provider: String
  var status: DesignStatus
  var port: Int
  var enabled: Bool
  var apiKey: String = ""
  /// The service can reveal a key on copy. The key itself is not stored here
  /// unless this row is fixture data.
  var hasToken: Bool = false
}

struct DesignLogSource: Identifiable, Hashable {
  let id: String
  var label: String
  var detail: String
  var provider: String
  var symbol: String
}

struct DesignActivity: Identifiable, Hashable {
  let id: String
  /// Section-header label for the event list ("Today", "Yesterday", …);
  /// distinct from `time`, which is the row's clock stamp.
  var day: String = "Today"
  var time: String
  var title: String
  var detail: String
  var symbol: String
  var status: DesignStatus
  /// Provider identity for the row's brand mark; nil when the event isn't
  /// tied to one (e.g. Proxy Hub lifecycle events).
  var provider: String? = nil
}

func nativeFirstRoutes(_ routes: [DesignRoute]) -> [DesignRoute] {
  routes.sorted { lhs, rhs in
    let lhsPriority = lhs.kind == .native ? 0 : 1
    let rhsPriority = rhs.kind == .native ? 0 : 1
    if lhsPriority != rhsPriority { return lhsPriority < rhsPriority }
    return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
  }
}

func nativeProviderPriority(_ provider: String) -> Int {
  let value = provider.lowercased()
  if value.contains("claude") { return 0 }
  if value.contains("codex") || value.contains("openai") { return 1 }
  if value.contains("gemini") || value.contains("google") { return 2 }
  if value.contains("kiro") { return 3 }
  if value.contains("grok") { return 4 }
  if value.contains("opencode") { return 5 }
  if value.contains("workbuddy") || value.contains("codebuddy") { return 6 }
  return 7
}

struct DesignBackup: Identifiable, Hashable {
  let id: String
  var createdAt: String
  var accountCount: Int
  var size: String
  var location: String
  var accounts: [DesignAccount]
}

struct DesignFeedback: Identifiable, Equatable {
  enum Kind: Equatable { case success, information, warning, error }

  let id = UUID()
  var title: String?
  var message: String
  var kind: Kind

  init(title: String? = nil, message: String, kind: Kind = .information) {
    self.title = title
    self.message = message
    self.kind = kind
  }
}
