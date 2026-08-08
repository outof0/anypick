import AppKit
import Foundation
import SwiftUI

// Module: ProxyPanel.swift — proxy services + hub setup.

struct NativeProxyPanel: View {
  @ObservedObject var store: TrayStore
  let openManage: () -> Void
  let openMonitor: () -> Void
  var openHubSetup: () -> Void = {}
  var openModelAccounts: () -> Void = {}

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      NativeSectionHeader(
        title: "Proxy services",
        detail: "\(store.proxies.filter(\.running).count) active · loopback only"
      )

      if store.proxies.isEmpty {
        NativeEmptyState(
          title: "No proxy services configured",
          systemImage: "network.slash",
          description: "Add a proxy-capable native account from Accounts.",
          actionTitle: "Accounts",
          action: openManage
        )
        .nativeGroup()
      } else {
        VStack(spacing: 0) {
          ForEach(Array(store.proxies.enumerated()), id: \.element.id) { index, proxy in
            NativeProxyRow(
              proxy: proxy,
              store: store,
              openMonitor: openMonitor,
              openHubSetup: openHubSetup,
              openModelAccounts: openModelAccounts
            )
            if index < store.proxies.count - 1 {
              Divider().padding(.leading, TraySpacing.dividerLeading)
            }
          }
        }
        .nativeGroup()
      }
    }
  }
}

struct NativeProxyRow: View {
  let proxy: ProxySnapshot
  @ObservedObject var store: TrayStore
  let openMonitor: () -> Void
  var openHubSetup: () -> Void = {}
  var openModelAccounts: () -> Void = {}
  @State private var optimisticRunning: Bool?

  private var isHub: Bool { proxy.providerId == "proxy-hub" }
  private var displayedRunning: Bool { optimisticRunning ?? proxy.running }

  var body: some View {
    // Settings list: badge | title+detail | ⋯ | switch
    HStack(alignment: .center, spacing: 10) {
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
          if let address = proxy.address {
            Text(address)
              .font(.caption.monospaced())
              .foregroundStyle(.secondary)
              .lineLimit(1)
              .textSelection(.enabled)
          } else {
            Text(proxy.detail)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if let address = proxy.address {
        Button {
          store.copyAddress(address)
        } label: {
          Image(systemName: "doc.on.doc")
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .frame(width: 28, height: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
        .help("Copy proxy address")
        .accessibilityLabel("Copy proxy address")
      }

      Menu {
        if isHub {
          Button("Set up…", action: openHubSetup)
          Button("Hub sources…", action: openModelAccounts)
        }
        if displayedRunning {
          Button("Restart") {
            store.invoke(actionId: proxy.restartActionId, label: "Restart \(proxy.label)")
          }
          .disabled(store.busyRequestId != nil)
        }
        if proxy.logsAvailable != false {
          Button("View logs") {
            store.selectLogSource(proxy.id)
            store.requestLogs(proxy)
            openMonitor()
          }
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

/// Numbered Hub DX: sources → listener → assign apps (detail under Proxies).
struct NativeHubSetupPanel: View {
  @ObservedObject var store: TrayStore
  let openSources: () -> Void
  let openRouting: () -> Void
  let openAccounts: () -> Void
  let openManage: () -> Void

  private var hub: ProxySnapshot? { store.proxyHub }
  private var enabledSources: Int { store.hubSources.filter(\.enabled).count }
  private var totalSources: Int { store.hubSources.count }
  private var appsOffHub: [String] {
    store.appRouteClients.filter { client in
      !(store.appActions(client).first(where: \.selected)?.routeKind == "hub")
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      NativeSectionHeader(
        title: "Configure Proxy Hub",
        detail: "Sources → start listener → point apps at the Hub"
      )

      VStack(spacing: 0) {
        hubStep(
          number: "1",
          done: enabledSources > 0,
          title: "Enable hub sources",
          detail: totalSources == 0
            ? "Add OpenCode, Gemini, or Grok accounts first."
            : "\(enabledSources) of \(totalSources) enabled · choose which accounts contribute models."
        ) {
          if totalSources == 0 {
            Button("Add Account", action: openManage)
              .buttonStyle(.borderedProminent)
              .controlSize(.small)
          } else {
            Button("Edit sources…", action: openSources)
              .buttonStyle(.bordered)
              .controlSize(.small)
          }
        }
        Divider().padding(.leading, 44)
        hubStep(
          number: "2",
          done: hub?.running == true,
          title: "Start the listener",
          detail: hub?.address.map { "Loopback OpenAI-compatible endpoint · \($0)" }
            ?? "One local endpoint for all enabled Hub models."
        ) {
          if let hub {
            NativeHubListenerSwitch(hub: hub, store: store, isEnabled: enabledSources > 0)
          }
        }
        Divider().padding(.leading, 44)
        hubStep(
          number: "3",
          done: !store.appRouteClients.isEmpty && appsOffHub.isEmpty,
          title: "Point apps at the Hub",
          detail: appsOffHub.isEmpty
            ? (store.appRouteClients.isEmpty
              ? "No switchable apps detected yet."
              : "All apps are already routed via Proxy Hub.")
            : "Per-app route · not automatic. \(appsOffHub.count) app\(appsOffHub.count == 1 ? "" : "s") still on a direct account or gateway."
        ) {
          Button("Apps", action: openAccounts)
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
      }
      .nativeGroup()

      if store.routingIssueCount + store.routingChoiceCount > 0 {
        NativeSectionHeader(
          title: "Routing health",
          detail: "Resolve before every model ID is usable"
        )
        TrayAttentionCallout(
          kind: store.routingIssueCount > 0 ? .warning : .info,
          title: store.routingIssueCount > 0
            ? "\(store.routingIssueCount) routing issue\(store.routingIssueCount == 1 ? "" : "s") — pick a source or fix unavailable accounts"
            : "Choose \(store.routingChoiceCount) hub source\(store.routingChoiceCount == 1 ? "" : "s") for overlapping models",
          actionTitle: "Fix"
        ) {
          openRouting()
        }
      }
    }
  }

  @ViewBuilder
  private func hubStep<Actions: View>(
    number: String,
    done: Bool,
    title: String,
    detail: String,
    @ViewBuilder actions: () -> Actions
  ) -> some View {
    HStack(alignment: .top, spacing: 12) {
      ZStack {
        Circle()
          .fill(done ? anypickSuccess.opacity(0.15) : Color.primary.opacity(0.06))
          .frame(width: 26, height: 26)
        if done {
          Image(systemName: "checkmark")
            .font(.caption.weight(.bold))
            .foregroundStyle(anypickSuccess)
        } else {
          Text(number)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
        }
      }
      VStack(alignment: .leading, spacing: 8) {
        Text(title)
          .font(.body.weight(.semibold))
        Text(detail)
          .font(.callout)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        actions()
      }
      Spacer(minLength: 0)
    }
    .padding(14)
  }
}

private struct NativeHubListenerSwitch: View {
  let hub: ProxySnapshot
  @ObservedObject var store: TrayStore
  var isEnabled: Bool
  @State private var optimisticRunning: Bool?

  private var displayedRunning: Bool { optimisticRunning ?? hub.running }

  var body: some View {
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
      isEnabled: store.busyRequestId == nil && isEnabled
    )
    .onChange(of: hub.running) { _, _ in optimisticRunning = nil }
    .onChange(of: store.busyRequestId) { _, requestId in
      if requestId == nil { optimisticRunning = nil }
    }
    .onChange(of: store.lastResult?.requestId) { _, _ in
      if store.lastResult?.status == "error" { optimisticRunning = nil }
    }
  }
}
