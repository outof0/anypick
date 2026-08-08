import AppKit
import Foundation
import SwiftUI

// Module: Models.swift — split from AnyPickTray.swift for maintainability.

struct RouteSnapshot: Decodable {
  let clientId: String
  let client: String
  let source: String?
  let model: String?
  let status: String
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
}

struct HubSourceSnapshot: Decodable, Identifiable {
  let id: String
  let providerId: String
  let name: String
  let label: String
  let detail: String
  let enabled: Bool
  let status: String?
  let modelCount: Int?
  let warning: String?
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

struct LogSourceSnapshot: Decodable, Identifiable {
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
  let options: [ClientModelOptionSnapshot]
}

struct GatewaySnapshot: Decodable, Identifiable {
  let id: String
  let providerId: String
  let name: String
  let detail: String
  let ready: Bool
  let defaultModel: String?
}

struct AccountProviderSnapshot: Decodable, Identifiable {
  let id: String
  let providerId: String
  let clientId: String?
  let sourceId: String?
  let label: String
  let detail: String
  let installed: Bool
  /// Provider can wipe the live app login so a second account can sign in.
  let canClear: Bool?
}

struct GatewayProviderSnapshot: Decodable, Identifiable {
  let id: String
  let label: String
  let detail: String
  let kind: String?
  let regions: [String]?
  let regionDefault: String?
}

struct TraySettingsSnapshot: Decodable {
  let launchAtLogin: Bool
  let startEnabledProxies: Bool
  let showQuota: Bool
  let quotaGuardEnabled: Bool
}

struct ActivityEvent: Decodable, Identifiable {
  let id: String
  let createdAt: String
  let message: String
  let isError: Bool
  let kind: String

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
}

struct UsageSnapshot: Decodable, Identifiable {
  var id: String { "\(client):\(account)" }
  let client: String
  let account: String
  let windows: [UsageWindow]
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
  let logSources: [LogSourceSnapshot]?
  let clientModelConfigs: [ClientModelConfigSnapshot]?
  let gateways: [GatewaySnapshot]
  let accountProviders: [AccountProviderSnapshot]
  let gatewayProviders: [GatewayProviderSnapshot]
  let settings: TraySettingsSnapshot
  let activity: [ActivityEvent]
}

struct Invocation: Encodable {
  let version = 1
  let requestId: String
  let revision: Int
  let actionId: String
}

struct ModelRolesCommand: Encodable {
  let version = 1
  let requestId: String
  let revision: Int
  let clientId: String
  let roleActionIds: [String: String]
}

struct Mutation: Encodable {
  let version = 1
  let requestId: String
  let operation: String
  let providerId: String?
  let sourceId: String?
  let name: String
  let label: String?
  let endpoint: String?
  let apiKey: String?
  let region: String?
  let defaultModel: String?
  let overwrite: Bool?
  let enabled: Bool?
}

struct ProxyLogsRequest: Encodable {
  let version = 1
  let requestId: String
  let providerId: String
  let name: String
  let lines: Int
}

struct CommandResult: Decodable {
  let version: Int
  let requestId: String
  let status: String
  let message: String?
}

struct ProxyLogsResult: Decodable {
  let version: Int
  let requestId: String
  let proxyId: String
  let text: String
  let state: String?
}
