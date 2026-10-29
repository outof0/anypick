import AppKit
import Foundation
import SwiftUI


struct RouteSnapshot: Decodable {
  let clientId: String
  let client: String
  let source: String?
  let model: String?
  let status: String
  let attentionReason: String?
}

struct ActionSnapshot: Decodable, Identifiable {
  let id: String
  let clientId: String
  let sourceId: String
  let client: String
  let label: String
  let detail: String?
  let kind: String
  let presentation: String
  let selected: Bool
  let enabled: Bool
  let disabledReason: String?
  let routeKind: String?
  let modelId: String?
  let upstreamProviderId: String?
  let upstreamSourceLabel: String?
}

struct ProxySnapshot: Decodable, Identifiable {
  let id: String
  let providerId: String
  let label: String
  let detail: String
  let address: String?
  let running: Bool
  let enabled: Bool
  let logsAvailable: Bool?
  let sourceCount: Int?
  let modelCount: Int?
  let clientCount: Int?
  let conflictCount: Int?
  let toggleActionId: String
  let restartActionId: String
  let testActionId: String?
  let rotateActionId: String?
  let apiKey: String?
  /// True when a copy can ask the service for the bearer. Absent on a helper
  /// that still puts the secret in apiKey; production ignores that secret.
  let hasToken: Bool?
}

struct ManagedAccountSnapshot: Decodable, Identifiable {
  let id: String
  let providerId: String
  let sourceId: String?
  let name: String
  let label: String
  let detail: String
  let active: Bool
  let canRefresh: Bool
  let switchActionId: String
}

struct HubSourceSnapshot: Decodable, Identifiable {
  let id: String
  let providerId: String
  let name: String
  let label: String
  let detail: String
  let enabled: Bool
  /// Hub owning this source row ("default" when unset by older helpers).
  /// Sent back as Name on hub-source-toggle so the engine touches the right hub.
  let hub: String?
  let status: String?
  let modelCount: Int?
  let warning: String?
  /// Rotation row: this source value ("pool:<provider>") is served by the
  /// provider's account ring instead of a single account.
  let rotates: Bool?
  let accountCount: Int?
  /// Rotation row: the hub-wide request mode ("failover", "round-robin",
  /// "soonest-reset"). Absent from an engine that predates it.
  let strategy: String?
  /// True when the source value is a pool ("pool:<provider>"): the row carries
  /// its own label and detail, because there is no account to resolve.
  let poolSource: Bool?
}

struct HubConflictCandidateSnapshot: Decodable, Identifiable {
  let id: String
  let providerId: String
  let label: String
  let detail: String
  let actionId: String
}

struct HubConflictSnapshot: Decodable, Identifiable {
  let id: String
  let kind: String?
  let title: String?
  let models: [String]
  let candidates: [HubConflictCandidateSnapshot]
}

struct HubPublishedModelSnapshot: Decodable, Identifiable {
  let id: String
  let ownerAccountId: String?
  let ownerLabel: String
  let ownerProviderId: String
  let needsChoice: Bool
}

/// One account's publishable models, by hub source id. Model ids only.
struct HubCatalogSnapshot: Decodable {
  let accountID: String
  let catalog: String
  let models: [String]
}

struct LogSourceSnapshot: Decodable, Identifiable, Equatable {
  let id: String
  let label: String
  let detail: String
  let providerId: String
  let name: String
}

struct ClientModelRoleSnapshot: Decodable, Identifiable {
  let id: String
  let label: String
}

struct ClientModelOptionSnapshot: Decodable, Identifiable {
  var id: String { actionId }
  let actionId: String
  let modelId: String
  let providerId: String
  let sourceLabel: String
}

struct ClientModelConfigSnapshot: Decodable, Identifiable {
  var id: String { clientId }
  let clientId: String
  let client: String
  let sourceLabel: String?
  let editable: Bool
  let unavailableReason: String?
  let roles: [ClientModelRoleSnapshot]
  let defaultModel: String?
  let modelRoles: [String: String]
  /// Where the pins came from: "explicit" (this connection), "provider"
  /// (inherited default), or absent (engine default / legacy explicit pins).
  let modelRolesSource: String?
  let options: [ClientModelOptionSnapshot]
}

struct CodexProfileSourceSnapshot: Decodable, Identifiable, Equatable {
  var id: String { sourceId }
  let sourceId: String
  let kind: String?
  let label: String
  let detail: String
  let selected: Bool
  let models: [String]
}

struct CodexProfileSnapshot: Decodable, Identifiable, Equatable {
  var id: String { name }
  let name: String
  let sourceId: String
  let sourceLabel: String
  let modelId: String
  let transportPolicy: String
  let launchCommand: String
  /// Absent from engines that predate codex-profile-open.
  let appOpenable: Bool?
  /// Absent from engines that predate codex-profile-terminal.
  let terminalOpenable: Bool?
}

struct GatewaySnapshot: Decodable, Identifiable {
  let id: String
  let providerId: String
  let name: String
  let detail: String
  let ready: Bool
  let defaultModel: String?
}

struct ProviderLoginMethodSnapshot: Decodable, Identifiable {
  let id: String
  let label: String
  let detail: String?
  let provenance: String
  let preferred: Bool
  let available: Bool
  let unavailableReason: String?
  let sourceID: String?
  let sourceLabel: String?

  private enum CodingKeys: String, CodingKey {
    case id
    case label
    case detail
    case provenance
    case preferred
    case available
    case unavailableReason
    case sourceID = "sourceId"
    case sourceLabel
  }
}

struct AccountProviderSnapshot: Decodable, Identifiable {
  let id: String
  let providerId: String
  let clientId: String?
  let sourceId: String?
  let label: String
  let detail: String
  let installed: Bool
  let livePresent: Bool?
  let liveIdentity: String?
  let loginMethods: [ProviderLoginMethodSnapshot]?
  /// Provider can wipe the live app login so a second account can sign in.
  let canClear: Bool?
  /// Typed credential products (API keys / plan keys) this provider accepts
  /// through account-save-input. Native providers may expose these alongside
  /// their local-login path.
  let credentialKinds: [ProviderCredentialKindSnapshot]?
  /// The provider can save its own auth file from pasted JSON.
  /// `var` with a default: a `let` default is skipped by synthesized Decodable,
  /// so a snapshot that sends the flag would otherwise always read as absent.
  var acceptsAuthPaste: Bool? = nil
}

struct ProviderCredentialKindSnapshot: Decodable, Identifiable {
  var id: String { kind }
  let kind: String
  let label: String
  let profiles: [ProviderCredentialProfileSnapshot]?
  /// The product works without a key (a local model server).
  let secretOptional: Bool?
}

struct ProviderCredentialProfileSnapshot: Decodable, Identifiable {
  var id: String { profileID }
  let profileID: String
  let label: String

  private enum CodingKeys: String, CodingKey {
    case profileID = "id"
    case label
  }
}

struct GatewayProviderSnapshot: Decodable, Identifiable {
  let id: String
  let label: String
  let detail: String
  let providesEndpoint: Bool?
  let requiresApiKey: Bool?
  let defaultEndpoint: String?
  let firstPartyClientIds: [String]?
  let kind: String?
  let requiresGatewayId: Bool?
  let requiresAccountId: Bool?
}

struct TraySettingsSnapshot: Decodable {
  let launchAtLogin: Bool
  let startEnabledProxies: Bool
  let showQuota: Bool
  let quotaGuardEnabled: Bool
  let language: String?
  let resolvedLanguage: String?
  let languageOptions: [LanguageOptionSnapshot]?
}

struct LanguageOptionSnapshot: Decodable, Identifiable, Equatable {
  let value: String
  let label: String

  var id: String { value }

  static let defaultOptions = [
    LanguageOptionSnapshot(value: "auto", label: "Auto Detect"),
    LanguageOptionSnapshot(value: "en", label: "English"),
    LanguageOptionSnapshot(value: "zh-CN", label: "简体中文"),
    LanguageOptionSnapshot(value: "es", label: "Español"),
    LanguageOptionSnapshot(value: "fr", label: "Français"),
    LanguageOptionSnapshot(value: "de", label: "Deutsch"),
    LanguageOptionSnapshot(value: "ja", label: "日本語"),
    LanguageOptionSnapshot(value: "ko", label: "한국어"),
    LanguageOptionSnapshot(value: "pt-BR", label: "Português (Brasil)"),
    LanguageOptionSnapshot(value: "vi", label: "Tiếng Việt"),
  ]
}

struct ActivityEvent: Decodable, Identifiable, Equatable {
  let id: String
  let createdAt: String
  let message: String
  let isError: Bool
  let kind: String
  /// Brand identity derived from affected resources; nil when the row carries
  /// no provider reference.
  let provider: String?

  var date: Date {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: createdAt) ?? Date.distantPast
  }
}

struct UsageWindow: Decodable {
  let label: String
  let remainingPercent: Int
  let resetsAtMs: Double?
  /// Vendor window cadence in seconds (e.g. 18000 for a 5-hour Codex
  /// window). Answers "which limit" from data, never inferred.
  let limitWindowSeconds: Int?
  /// Optional vendor section title (Antigravity quota summary group).
  let group: String?
}

struct UsageSnapshot: Decodable, Identifiable {
  let providerId: String?
  var id: String { "\(client):\(account)" }
  let client: String
  let account: String
  let windows: [UsageWindow]
}

struct DegradedConditionSnapshot: Decodable, Identifiable {
  let id: String
  let kind: String
  let title: String
  let detail: String
}

struct TraySnapshot: Decodable {
  let revision: Int
  let proxyCount: Int
  let routes: [RouteSnapshot]
  let actions: [ActionSnapshot]
  let usage: [UsageSnapshot]
  let proxies: [ProxySnapshot]
  let accounts: [ManagedAccountSnapshot]
  let hubSources: [HubSourceSnapshot]?
  let hubConflicts: [HubConflictSnapshot]?
  let hubPublishedModels: [HubPublishedModelSnapshot]?
  let hubCatalogs: [HubCatalogSnapshot]?
  let logSources: [LogSourceSnapshot]?
  let clientModelConfigs: [ClientModelConfigSnapshot]?
  let codexProfiles: [CodexProfileSnapshot]?
  let codexProfileSources: [CodexProfileSourceSnapshot]?
  let gateways: [GatewaySnapshot]
  let accountProviders: [AccountProviderSnapshot]
  let gatewayProviders: [GatewayProviderSnapshot]
  let settings: TraySettingsSnapshot
  let activity: [ActivityEvent]
  let degradedConditions: [DegradedConditionSnapshot]?
}

struct AppServiceSnapshotEvent: Decodable {
  let protocolVersion: Int
  let revision: Int
  let reason: String
  let snapshot: TraySnapshot
}

struct AppServiceUsageEvent: Decodable {
  let protocolVersion: Int
  let revision: Int
  let usage: [UsageSnapshot]
}

struct AppServiceErrorFrame: Decodable {
  let protocolVersion: Int
  let code: String
  let message: String
  /// Present when the engine could name the command that died. The host uses
  /// it to settle that row instead of waiting out its confirm timeout.
  let requestId: String?
}

struct Invocation: Encodable {
  let version = 1
  let requestId: String
  let revision: Int
  let actionId: String
  /// The user's answer to a refused takeover. Omitted unless they confirmed,
  /// so an unconfirmed take-over cannot be expressed on the wire at all.
  var allowForeignConfig: Bool?
}

struct ModelRolesCommand: Encodable {
  let version = 1
  let requestId: String
  let revision: Int
  let clientId: String
  let roleActionIds: [String: String]
  /// "connection" (default) pins this connection; "provider" stores the
  /// provider default; empty roles on connection scope clear the pins.
  /// Encoded always: the engine defaults absent to connection.
  let scope: String
}

struct Mutation: Encodable {
  let version = 1
  let requestId: String
  let operation: String
  let providerId: String?
  let sourceId: String?
  let methodId: String?
  let name: String?
  let path: String?
  let label: String?
  let endpoint: String?
  let apiKey: String?
  let gatewayId: String?
  let defaultModel: String?
  let overwrite: Bool?
  let enabled: Bool?
  let language: String?
  /// account-save-input: the credential product kind (e.g. api-key).
  let kind: String?
  /// account-save-input: the endpoint profile id within the kind.
  let profile: String?
  let transportPolicy: String?
  var sourceIds: [String]? = nil
  /// hub-rotation: the hub-wide request mode. Nil leaves only `enabled`.
  var strategy: String? = nil
}

struct CancellationRequest: Encodable {
  let version = 1
  let requestId: String
}

struct ProxyLogsRequest: Encodable {
  let version = 1
  let requestId: String
  let providerId: String
  let name: String
  let lines: Int
}

struct DoctorRequest: Encodable {
  let version = 1
  let requestId: String
}

struct DoctorFindingSnapshot: Decodable, Identifiable, Equatable {
  let check: String
  let status: String
  let detail: String?

  var id: String { "\(check):\(detail ?? status)" }
}

struct DoctorResult: Decodable, Equatable {
  let version: Int
  let requestId: String
  let status: String
  let findings: [DoctorFindingSnapshot]
}

struct BackupInspectRequest: Encodable {
  let version = 1
  let requestId: String
  let path: String
}

struct BackupAccountRef: Encodable {
  let provider: String
  let name: String
}

struct BackupExportMutation: Encodable {
  let version = 1
  let requestId: String
  let operation = "account-backup-export"
  let path: String
  let accounts: [BackupAccountRef]
  let overwrite: Bool
}

struct BackupImportMutation: Encodable {
  let version = 1
  let requestId: String
  let operation = "account-backup-import"
  let inspectionId: String
  let entryIds: [String]
  let overwriteConfirmed: Bool
}

struct BackupForgetMutation: Encodable {
  let version = 1
  let requestId: String
  let operation = "account-backup-forget"
  let inspectionId: String
}

struct BackupPreviewEntry: Decodable, Identifiable {
  let id: String
  let providerId: String
  let name: String
  let label: String
  let disposition: String
  let reason: String?
}

struct BackupPreviewResult: Decodable {
  let version: Int
  let requestId: String
  let status: String
  let inspectionId: String?
  let createdAt: String?
  let entries: [BackupPreviewEntry]?
  let error: String?
  let code: String?
  let reason: String?
  let message: String?
}

struct CommandResult: Decodable {
  let version: Int
  let requestId: String
  let status: String
  let message: String?
  /// Stable machine code for the failure (`INVALID_USAGE`, `PROXY_START_FAILED`, …).
  let code: String?
  /// Up to three hints the engine already prints in the CLI.
  let suggestions: [String]?
  /// The engine may have written before it failed; the user has to be told.
  let mutated: Bool?
  /// Command-specific object. Launch-at-login and proxy-token both land here;
  /// unknown keys are ignored, and a missing apiKey stays nil.
  /// var: a let with a default is skipped by synthesized Decodable, so the
  /// proxy-token payload would stay nil and Copy would never see the key.
  var payload: CommandPayload? = nil

  /// Everything the user should read, in the order they should read it.
  ///
  /// The engine sends structure, not prose: a failure carries a code, hints
  /// and a partial-change warning. Rendering only `message` threw the rest
  /// away and left every failure looking like the same dead end.
  var displayMessage: String? {
    var lines: [String] = []
    if let head = Self.oneLine(message, limit: 200) { lines.append(head) }
    if mutated == true {
      lines.append("State may have been partially changed — run `anypick doctor`.")
    }
    for suggestion in (suggestions ?? []).prefix(3) {
      if let hint = Self.oneLine(suggestion, limit: 120) { lines.append("→ " + hint) }
    }
    return lines.isEmpty ? nil : lines.joined(separator: "\n")
  }

  private static func oneLine(_ value: String?, limit: Int) -> String? {
    let compact = value?
      .replacingOccurrences(of: "\n", with: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !compact.isEmpty else { return nil }
    return String(compact.prefix(limit))
  }
}

struct CommandPayload: Decodable {
  let apiKey: String?
}

struct ProxyLogsResult: Decodable {
  let version: Int
  let requestId: String
  let proxyId: String
  let text: String
  let state: String?
}
