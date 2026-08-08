import AppKit
import Foundation
import SwiftUI

// Module: QuickRouteRow.swift — app route row

// MARK: - App route row
// Source-first chips + same popover chrome as Codex model switch (NativeRoutePicker).

struct NativeQuickRouteRow: View {
  let client: String
  let route: RouteSnapshot?
  let actions: [ActionSnapshot]
  let config: ClientModelConfigSnapshot?
  let usage: UsageSnapshot?
  @ObservedObject var store: TrayStore
  let openRouteBrowser: () -> Void
  let openModels: () -> Void
  @State private var pendingAction: ActionSnapshot?
  @State private var showingRoutePicker = false

  private var selectedAction: ActionSnapshot? {
    actions.first(where: \.selected)
  }

  /// Full identity line — never hide the active account (mock: email under title).
  private var accountLine: String {
    guard let selectedAction else {
      return route?.source ?? "Not configured"
    }
    if selectedAction.routeKind == "hub" {
      return "Proxy Hub"
    }
    if !selectedAction.label.isEmpty { return selectedAction.label }
    if let detail = selectedAction.detail, !detail.isEmpty { return detail }
    return route?.source ?? "Not configured"
  }

  private var modelLine: String? {
    if let model = route?.model, !model.isEmpty { return model }
    if let defaultModel = config?.modelRoles["default"] ?? config?.defaultModel, !defaultModel.isEmpty {
      return defaultModel
    }
    return selectedAction?.modelId
  }

  private var canSwitch: Bool { routeHasAlternates(actions) }

  /// Chips only when there is something to switch to (selected + alternates).
  private var chipActions: [ActionSnapshot] {
    guard canSwitch else { return [] }
    var result: [ActionSnapshot] = []
    if let selectedAction { result.append(selectedAction) }
    for action in actions where !action.selected {
      if result.count >= 4 { break }
      if action.routeKind == "hub", result.contains(where: { $0.routeKind == "hub" }) {
        continue
      }
      result.append(action)
    }
    return result
  }

  private var customRoleCount: Int {
    guard let config else { return 0 }
    let defaultModel = config.modelRoles["default"] ?? config.defaultModel ?? route?.model
    guard let defaultModel else { return 0 }
    return config.roles.filter { role in
      guard role.id != "default", let value = config.modelRoles[role.id] else { return false }
      return !value.isEmpty && value != defaultModel
    }.count
  }

  @ScaledMetric(relativeTo: .body) private var badgeSize: CGFloat = 30
  @ScaledMetric(relativeTo: .body) private var rowPadY: CGFloat = 10

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 10) {
        NativeProviderBadge(
          id: route?.clientId ?? actions.first?.clientId ?? client,
          size: badgeSize
        )

        VStack(alignment: .leading, spacing: 2) {
          Text(anypickDisplayName(client))
            .font(.body.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.85)
          Text(accountLine)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .help(accountLine)
          if let modelLine, !accountLine.contains(modelLine) {
            Text(modelLine)
              .font(.caption2)
              .foregroundStyle(.tertiary)
              .lineLimit(1)
              .minimumScaleFactor(0.85)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(anypickDisplayName(client))
        .accessibilityValue([accountLine, modelLine].compactMap { $0 }.joined(separator: ", "))

        HStack(alignment: .center, spacing: 8) {
          TrayUsageMeter(usage: usage, compact: true)
          // Same face + popover as Codex model switch (not system Menu).
          // Shared binding: chips “More…” opens this popover (no nested popovers).
          NativeRoutePicker(
            actions: actions,
            customRoleCount: customRoleCount,
            store: store,
            onConfigureModels: openModels,
            onOpenApp: openRouteBrowser,
            isPresented: $showingRoutePicker
          )
        }
        .layoutPriority(1)
      }

      if !chipActions.isEmpty {
        // Cap kept on chipActions; strip scrolls when chips overflow the row width.
        TrayChipStrip {
          ForEach(chipActions) { action in
            TrayRouteChip(
              providerId: trayRouteProviderId(action),
              title: routeFaceTitle(action),
              selected: action.selected,
              disabled: !action.enabled || store.busyRequestId != nil
            ) {
              if !action.selected { choose(action) }
            }
            .accessibilityLabel(routeFaceTitle(action))
            .accessibilityAddTraits(action.selected ? .isSelected : [])
            .accessibilityHint(action.selected ? "Current source" : "Switch to this source")
          }
          if actions.count > chipActions.count {
            // Opens the *same* Switch popover — never a second nested popover.
            Button("More…") { showingRoutePicker = true }
              .buttonStyle(.borderless)
              .controlSize(.mini)
              .foregroundStyle(Color.accentColor)
              .disabled(store.busyRequestId != nil)
              .help("Show all sources for \(anypickDisplayName(client))")
              .accessibilityLabel("More sources for \(anypickDisplayName(client))")
              .fixedSize()
          }
        }
      }
    }
    .padding(.horizontal, TraySpacing.rowPadding)
    .padding(.vertical, rowPadY)
    .accessibilityElement(children: .contain)
    .confirmationDialog(
      "Switch source and reset model overrides?",
      isPresented: Binding(
        get: { pendingAction != nil },
        set: { if !$0 { pendingAction = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Switch and Reset") {
        if let pendingAction { store.invoke(pendingAction) }
        pendingAction = nil
      }
      Button("Cancel", role: .cancel) { pendingAction = nil }
    } message: {
      Text(
        trayRouteResetMessage(
          client: client,
          overrideCount: customRoleCount,
          destination: pendingAction.map(routeActionTitle) ?? "the selected source"
        )
      )
    }
  }

  private func choose(_ action: ActionSnapshot) {
    if customRoleCount > 0 {
      pendingAction = action
    } else {
      store.invoke(action)
    }
  }
}
