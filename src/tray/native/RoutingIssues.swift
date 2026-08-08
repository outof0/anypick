import AppKit
import Foundation
import SwiftUI

// Module: RoutingIssues.swift — routing issues and conflict rows

struct NativeRoutingIssuesPanel: View {
  @ObservedObject var store: TrayStore
  let openModelAccounts: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if store.hubConflicts.isEmpty && store.unavailableHubSources.isEmpty {
        NativeEmptyState(
          title: "Routing looks good",
          systemImage: "checkmark.circle.fill",
          description: "Every published model has one available account."
        )
        .nativeGroup()
      } else {
        Text("Each card is a decision. Pick one option to resolve it, or open Hub sources to refresh/disable an account.")
          .font(.callout)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      if !store.hubConflicts.isEmpty {
        NativeSectionHeader(
          title: store.hubConflicts.contains(where: { $0.kind == "source-choice" })
            ? "Choose a source"
            : "Routing choices",
          detail: "Tap one option — AnyPick updates the Hub route immediately"
        )
        VStack(spacing: 0) {
          ForEach(Array(store.hubConflicts.enumerated()), id: \.element.id) { index, conflict in
            NativeHubConflictRow(conflict: conflict, store: store)
            if index < store.hubConflicts.count - 1 {
              Divider().padding(.leading, 12)
            }
          }
        }
        .nativeGroup()
      }

      if !store.unavailableHubSources.isEmpty {
        NativeSectionHeader(
          title: "Unavailable sources",
          detail: "Refresh the login or disable the source under Hub sources",
          action: openModelAccounts
        ) {
          Text("Open sources…")
        }
        VStack(spacing: 0) {
          ForEach(Array(store.unavailableHubSources.enumerated()), id: \.element.id) {
            index,
            source in
            HStack(alignment: .top, spacing: 10) {
              NativeProviderBadge(id: source.providerId, size: 30)
              VStack(alignment: .leading, spacing: 3) {
                Text(source.label)
                  .font(.callout.weight(.semibold))
                Text(source.warning ?? source.status ?? "This account is not available for routing.")
                  .font(.caption)
                  .foregroundStyle(anypickAmber)
                  .fixedSize(horizontal: false, vertical: true)
                Text("Refresh the saved login, or turn the source off so other accounts can cover its models.")
                  .font(.caption2)
                  .foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
              Spacer(minLength: 8)
              Button("Sources…", action: openModelAccounts)
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            .padding(12)
            if index < store.unavailableHubSources.count - 1 {
              Divider().padding(.leading, 52)
            }
          }
        }
        .nativeGroup()
      }
    }
  }
}

struct NativeHubConflictRow: View {
  let conflict: HubConflictSnapshot
  @ObservedObject var store: TrayStore

  private var modelSample: String {
    let sample = conflict.models.prefix(3).joined(separator: ", ")
    let remaining = max(0, conflict.models.count - 3)
    return remaining > 0 ? "\(sample) · +\(remaining) more" : sample
  }

  private var isSourceChoice: Bool { conflict.kind == "source-choice" }

  private var heading: String {
    if let title = conflict.title, !title.isEmpty { return title }
    if isSourceChoice { return "Choose one account" }
    return "Choose a provider for \(conflict.models.count) overlapping \(conflict.models.count == 1 ? "model" : "models")"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 3) {
        Text(heading)
          .font(.callout.weight(.semibold))
        Text(isSourceChoice ? "Applies to \(modelSample)" : modelSample)
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
      VStack(spacing: 6) {
        ForEach(Array(conflict.candidates.prefix(3))) { candidate in
          Button {
            invokeCandidate(candidate)
          } label: {
            HStack(spacing: 10) {
              NativeProviderBadge(id: candidate.providerId, size: 26)
              VStack(alignment: .leading, spacing: 2) {
                Text(candidate.label)
                  .font(.callout.weight(.medium))
                  .lineLimit(1)
                Text(candidate.detail)
                  .font(.caption)
                  .foregroundStyle(.secondary)
                  .lineLimit(1)
              }
              Spacer()
              Text(isSourceChoice ? "Use account" : "Use provider")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.accentColor)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.primary.opacity(0.04))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(nativeStroke.opacity(0.6), lineWidth: 0.5)
            )
          }
          // Own fill already drawn — press opacity only, no muddy hover wash.
          .trayCalloutButton(cornerRadius: 8)
          .disabled(store.busyRequestId != nil)
        }
        if conflict.candidates.count > 3 {
          Menu {
            ForEach(Array(conflict.candidates.dropFirst(3))) { candidate in
              Button("\(candidate.label) · \(candidate.detail)") {
                invokeCandidate(candidate)
              }
            }
          } label: {
            Text(
              "Choose from \(conflict.candidates.count) \(isSourceChoice ? "accounts" : "providers")"
            )
            .font(.callout.weight(.semibold))
            .foregroundStyle(Color.accentColor)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.accentColor.opacity(0.08))
            )
          }
          .trayMenuLabel()
          .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 8, drawsFill: false))
          .disabled(store.busyRequestId != nil)
        }
      }
    }
    .padding(14)
  }

  private func invokeCandidate(_ candidate: HubConflictCandidateSnapshot) {
    store.invoke(
      actionId: candidate.actionId,
      label: isSourceChoice
        ? "use \(candidate.label) as the hub source"
        : "use \(candidate.label) for overlapping models"
    )
  }
}

struct NativeAppRouteRow: View {
  let client: String
  let route: RouteSnapshot?
  let actions: [ActionSnapshot]
  let config: ClientModelConfigSnapshot?
  let usage: UsageSnapshot?
  @ObservedObject var store: TrayStore
  let customize: (String) -> Void

  private var selectedAction: ActionSnapshot? { actions.first(where: \.selected) }
  private var hubActions: [ActionSnapshot] {
    actions.filter { $0.routeKind == "hub" && $0.enabled }
  }
  private var isOnHub: Bool { selectedAction?.routeKind == "hub" }
  private var canUseHub: Bool { !hubActions.isEmpty && !isOnHub }

  var body: some View {
    // Fixed trailing: Usage | Switch (Models lives inside the picker menu).
    HStack(alignment: .center, spacing: 12) {
      NativeProviderBadge(id: route?.clientId ?? actions.first?.clientId ?? client, size: 30)

      VStack(alignment: .leading, spacing: 2) {
        Text(anypickDisplayName(client))
          .font(.body.weight(.semibold))
          .lineLimit(1)
        Text(routeDetail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .help(routeDetail)
        if isOnHub {
          Text("Routed via Proxy Hub")
            .font(.caption2)
            .foregroundStyle(anypickSuccess)
            .lineLimit(1)
        } else if !roleSummary.isEmpty {
          Text(roleSummary)
            .font(.caption2)
            .foregroundStyle(config?.editable == false ? anypickAmber : Color.secondary)
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      TrayUsageMeter(usage: usage, compact: false, barWidth: 72)
        .frame(width: 96, alignment: .trailing)

      VStack(alignment: .trailing, spacing: 4) {
        NativeRoutePicker(
          actions: actions,
          customRoleCount: customRoleCount,
          store: store,
          onConfigureModels: (config?.editable == true && (config?.roles.count ?? 0) >= 1)
            ? { if let id = config?.clientId { customize(id) } }
            : nil
        )
      }
      .frame(minWidth: 72, alignment: .trailing)
    }
    .padding(.horizontal, TraySpacing.rowPadding)
    .padding(.vertical, 10)
  }

  private var routeDetail: String {
    let selected = selectedAction
    if selected?.routeKind == "hub" {
      return "Proxy Hub"
    }
    // Full label so Codex/Claude show the active account (email / workspace).
    if let label = selected?.label, !label.isEmpty { return label }
    if let detail = selected?.detail, !detail.isEmpty { return detail }
    return route?.source ?? "Choose a source"
  }

  private var roleSummary: String {
    guard let config else {
      if let model = route?.model, !model.isEmpty { return model }
      return ""
    }
    if !config.editable, let reason = config.unavailableReason, !reason.isEmpty { return reason }
    guard let defaultModel = configuredDefault, !defaultModel.isEmpty else {
      return config.unavailableReason ?? "Choose a default model"
    }
    let overrides = customRoleCount
    return overrides == 0
      ? "Default \(defaultModel)"
      : "Default \(defaultModel) · \(overrides) override\(overrides == 1 ? "" : "s")"
  }

  private var configuredDefault: String? {
    config?.modelRoles["default"] ?? config?.defaultModel ?? route?.model
  }

  private var customRoleCount: Int {
    guard let config, let defaultModel = configuredDefault else { return 0 }
    return config.roles.filter { role in
      guard role.id != "default",
            let value = config.modelRoles[role.id], !value.isEmpty else { return false }
      return value != defaultModel
    }.count
  }
}
