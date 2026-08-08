import AppKit
import Foundation
import SwiftUI

// Module: QuickServiceRows.swift — hub, native, proxy service rows

// MARK: - Hub block

struct NativeQuickHubRow: View {
  let hub: ProxySnapshot
  @ObservedObject var store: TrayStore
  let open: (NativeTrayTab) -> Void
  @State private var optimisticRunning: Bool?

  private var enabledSourceCount: Int {
    store.hubSources.filter(\.enabled).count
  }

  private var attentionCount: Int {
    store.routingIssueCount + store.routingChoiceCount
  }

  private var appsOnHub: Int {
    store.actions.filter { $0.selected && $0.routeKind == "hub" }
      .reduce(into: Set<String>()) { $0.insert($1.client) }
      .count
  }

  private var displayedRunning: Bool { optimisticRunning ?? hub.running }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        NativeProviderBadge(id: "proxy-hub", size: 24)

        VStack(alignment: .leading, spacing: 2) {
          Text("Proxy Hub")
            .font(.body.weight(.medium))
          Text(
            "\(enabledSourceCount) sources · \(hub.modelCount ?? 0) models · \(appsOnHub) app\(appsOnHub == 1 ? "" : "s")"
          )
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        }

        Spacer(minLength: 6)

        if enabledSourceCount == 0 {
          Button("Set up") { open(.hubSetup) }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        } else {
          AnyPickSwitch(
            title: "Enable Proxy Hub",
            isOn: Binding(
              get: { displayedRunning },
              set: { enabled in
                guard enabled != displayedRunning else { return }
                optimisticRunning = enabled
                if store.invoke(actionId: hub.toggleActionId, label: hub.label) == nil {
                  optimisticRunning = nil
                }
              }
            ),
            isEnabled: store.busyRequestId == nil
          )
        }
      }
      .padding(.horizontal, TraySpacing.rowPadding)
      .padding(.vertical, 10)
      .onChange(of: hub.running) { _, _ in optimisticRunning = nil }
      .onChange(of: store.busyRequestId) { _, requestId in
        if requestId == nil { optimisticRunning = nil }
      }
      .onChange(of: store.lastResult?.requestId) { _, _ in
        if store.lastResult?.status == "error" { optimisticRunning = nil }
      }

      if enabledSourceCount == 0 {
        TrayAttentionCallout(
          kind: .info,
          title: "Enable hub sources, then assign apps",
          actionTitle: "Set up"
        ) {
          open(.hubSetup)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 12)
      } else if attentionCount > 0 {
        TrayAttentionCallout(
          kind: store.routingIssueCount > 0 ? .warning : .info,
          title: store.routingIssueCount > 0
            ? "\(store.routingIssueCount) routing issue\(store.routingIssueCount == 1 ? "" : "s") — pick a source or fix unavailable accounts"
            : "Choose \(store.routingChoiceCount) hub source\(store.routingChoiceCount == 1 ? "" : "s") for overlapping models",
          actionTitle: "Fix"
        ) {
          open(.routingIssues)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 12)
      }
    }
  }
}
// MARK: - Native provider

struct NativeQuickNativeProviderRow: View {
  let client: String
  let actions: [ActionSnapshot]
  let usage: UsageSnapshot?
  @ObservedObject var store: TrayStore
  let openAll: () -> Void

  private var selected: ActionSnapshot? { actions.first(where: \.selected) }

  private var accountLine: String {
    guard let selected else { return "Not set" }
    return selected.label
  }

  private var canSwitch: Bool { routeHasAlternates(actions) }

  private var chipActions: [ActionSnapshot] {
    guard canSwitch else { return [] }
    var result: [ActionSnapshot] = []
    if let selected { result.append(selected) }
    for action in actions where !action.selected {
      if result.count >= 3 { break }
      result.append(action)
    }
    return result
  }

  @State private var showingRoutePicker = false
  @ScaledMetric(relativeTo: .body) private var badgeSize: CGFloat = 30

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 10) {
        NativeProviderBadge(id: actions.first?.clientId ?? client, size: badgeSize)
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
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(anypickDisplayName(client))
        .accessibilityValue(accountLine)

        HStack(alignment: .center, spacing: 8) {
          TrayUsageMeter(usage: usage, compact: true)
          NativeRoutePicker(
            actions: actions,
            customRoleCount: 0,
            store: store,
            onOpenApp: openAll,
            isPresented: $showingRoutePicker
          )
        }
        .layoutPriority(1)
      }

      if chipActions.count > 1 {
        TrayChipStrip {
          ForEach(chipActions) { action in
            TrayRouteChip(
              providerId: trayRouteProviderId(action),
              title: shortAccount(action.label),
              selected: action.selected,
              disabled: !action.enabled || store.busyRequestId != nil
            ) {
              if !action.selected { store.invoke(action) }
            }
          }
        }
      }
    }
    .padding(.horizontal, TraySpacing.rowPadding)
    .padding(.vertical, 10)
  }

  private func shortAccount(_ label: String) -> String {
    let parts = label.components(separatedBy: " · ")
    let account = parts.count > 1 ? parts.dropFirst().joined(separator: " · ") : label
    if let at = account.firstIndex(of: "@") {
      return String(account[..<at])
    }
    return account
  }
}

// MARK: - Proxy service

struct NativeQuickProxyServiceRow: View {
  let proxy: ProxySnapshot
  @ObservedObject var store: TrayStore
  let openSources: () -> Void
  let openLogs: () -> Void
  let openHubSetup: () -> Void
  @State private var optimisticRunning: Bool?

  private var displayedRunning: Bool { optimisticRunning ?? proxy.running }

  var body: some View {
    // Same list anatomy as Apps: badge | title+subtitle | ⋯ | switch
    HStack(spacing: 10) {
      NativeProviderBadge(id: proxy.providerId, size: 28)

      VStack(alignment: .leading, spacing: 2) {
        Text(proxy.label)
          .font(.body.weight(.medium))
          .lineLimit(1)
        HStack(spacing: 6) {
          NativeStatusDot(
            kind: displayedRunning ? .on : .off,
            title: displayedRunning ? "Running" : "Stopped"
          )
          Text(proxy.address ?? proxy.detail)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .textSelection(.enabled)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      Menu {
        if proxy.providerId == "proxy-hub" {
          Button("Hub sources…", action: openSources)
          if !displayedRunning {
            Button("Set up…", action: openHubSetup)
          }
        }
        if displayedRunning {
          Button("Restart") {
            store.invoke(actionId: proxy.restartActionId, label: "Restart \(proxy.label)")
          }
          .disabled(store.busyRequestId != nil)
        }
        if proxy.logsAvailable == true {
          Button("View logs", action: openLogs)
        }
        Divider()
        Button(displayedRunning ? "Stop" : "Start") {
          optimisticRunning = !displayedRunning
          if store.invoke(actionId: proxy.toggleActionId, label: proxy.label) == nil {
            optimisticRunning = nil
          }
        }
        .disabled(store.busyRequestId != nil)
      } label: {
        TrayOverflowMenuLabel()
      }
      .trayMenuLabel()
      .help("\(proxy.label) actions")
      .accessibilityLabel("\(proxy.label) actions")

      AnyPickSwitch(
        title: "Enable \(proxy.label)",
        isOn: Binding(
          get: { displayedRunning },
          set: { enabled in
            guard enabled != displayedRunning else { return }
            optimisticRunning = enabled
            if store.invoke(actionId: proxy.toggleActionId, label: proxy.label) == nil {
              optimisticRunning = nil
            }
          }
        ),
        isEnabled: store.busyRequestId == nil
      )
    }
    .padding(.horizontal, TraySpacing.rowPadding)
    .padding(.vertical, 10)
    .onChange(of: proxy.running) { _, _ in optimisticRunning = nil }
    .onChange(of: store.busyRequestId) { _, requestId in
      if requestId == nil { optimisticRunning = nil }
    }
    .onChange(of: store.lastResult?.requestId) { _, _ in
      if store.lastResult?.status == "error" { optimisticRunning = nil }
    }
  }
}
