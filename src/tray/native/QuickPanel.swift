import AppKit
import Foundation
import SwiftUI

// Module: QuickPanel.swift — MenuBarExtra quick panel shell

// MARK: - Quick panel

private enum QuickPanelSection: String, CaseIterable, Identifiable {
  case accounts = "Apps"
  case proxies = "Proxies"
  /// Matches main-window sidebar vocabulary (detail stream still reads as activity).
  case logs = "Logs"
  var id: String { rawValue }

  static var restored: QuickPanelSection {
    if let raw = TrayPreferences.quickSectionRaw,
       let section = QuickPanelSection(rawValue: raw) {
      return section
    }
    return .accounts
  }
}

struct NativeQuickPanel: View {
  @ObservedObject var store: TrayStore
  let openMainWindow: (NativeTrayTab, String?) -> Void
  @State private var section: QuickPanelSection = QuickPanelSection.restored
  @AppStorage(TrayPreferences.Key.onboardingDismissed) private var onboardingDismissed = false

  private var visibleClients: [String] {
    Array(store.appRouteClients.prefix(8))
  }

  private var showOnboarding: Bool {
    trayShouldShowOnboarding(store: store, dismissed: onboardingDismissed)
  }

  private var statusText: String {
    if store.attentionCount > 0 {
      return store.attentionCount == 1
        ? "1 item needs attention"
        : "\(store.attentionCount) items need attention"
    }
    if store.proxyHub?.running == true { return "Proxy Hub running" }
    if store.proxyCount == 1 { return "1 proxy running" }
    if store.proxyCount > 1 { return "\(store.proxyCount) proxies running" }
    return "Ready"
  }

  private var statusIsAttention: Bool { store.attentionCount > 0 }

  var body: some View {
    // MenuBarExtra .window — HIG: compact, transient, menu material, glanceable.
    VStack(spacing: 0) {
      header
      tabBar
        .padding(.horizontal, TraySpacing.outer)
        .padding(.bottom, 8)

      ScrollView {
        VStack(alignment: .leading, spacing: TraySpacing.groupGap) {
          if !store.snapshotReady {
            NativeSnapshotLoading(compact: true)
          } else {
            switch section {
            case .accounts: accountsPanel
            case .proxies: proxiesPanel
            case .logs: logsPanel
            }
          }
        }
        .padding(.horizontal, TraySpacing.outer)
        .padding(.bottom, TraySpacing.outer)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .id(store.snapshotReady ? section.rawValue : "loading")
        .transition(TrayMotion.panelTransition)
      }
      .frame(maxHeight: trayQuickPanelMaxHeight())
      .animation(TrayMotion.standard, value: section)
      .animation(TrayMotion.standard, value: store.snapshotReady)

      if let message = store.message {
        messageBar(message)
          .transition(TrayMotion.messageTransition)
      }

      footer
    }
    .frame(width: TraySpacing.quickPanelWidth)
    .frame(minHeight: 300)
    // HIG menu-bar panel: thin material keeps Liquid Glass / vibrancy readable.
    .background(.ultraThinMaterial)
    .animation(TrayMotion.message, value: store.message)
    .onChange(of: section) { _, next in
      TrayPreferences.quickSectionRaw = next.rawValue
    }
  }

  // MARK: Header

  private var header: some View {
    HStack(spacing: 10) {
      AnyPickBrandMark()
      .frame(width: 26, height: 26)
      .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 1) {
        Text("AnyPick")
          .font(.headline)
        Text(statusText)
          .font(.caption)
          .foregroundStyle(statusIsAttention ? (store.routingIssueCount > 0 ? anypickAmber : Color.accentColor) : .secondary)
          .lineLimit(1)
      }
      .accessibilityElement(children: .combine)

      Spacer(minLength: 8)
      AnyPickBusyIndicator(isBusy: store.showsBusy)

      Button("Open") {
        openMainWindow(.accounts, nil)
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .keyboardShortcut("o", modifiers: .command)
      .help("Open AnyPick window")
      .accessibilityLabel("Open AnyPick")

      Menu {
        Button("Refresh", action: store.refreshAll)
          .keyboardShortcut("r", modifiers: .command)
        Button("Restart Proxies", action: store.restartProxies)
          .keyboardShortcut("r", modifiers: [.command, .shift])
        Button("Stop Proxies", action: store.stopProxies)
          .disabled(store.proxyCount == 0)
        Divider()
        Button("Add Account…") { openMainWindow(.manage, nil) }
          .keyboardShortcut("n", modifiers: .command)
        Button("Settings…") { openMainWindow(.settings, nil) }
          .keyboardShortcut(",", modifiers: .command)
        Divider()
        Button("Quit AnyPick", role: .destructive, action: store.quitAnyPick)
          .keyboardShortcut("q", modifiers: .command)
      } label: {
        TrayOverflowMenuLabel()
      }
      .trayMenuLabel()
      .menuStyle(.borderlessButton)
      .help("AnyPick menu")
      .accessibilityLabel("AnyPick menu")
    }
    .padding(.horizontal, TraySpacing.outer)
    .padding(.top, TraySpacing.outer)
    .padding(.bottom, 8)
  }

  // MARK: Tabs

  private var tabBar: some View {
    TraySegmentedControl(
      selection: $section,
      options: QuickPanelSection.allCases,
      title: { $0.rawValue }
    )
  }

  // MARK: Accounts

  private var accountsPanel: some View {
    // System Settings: section label → inset grouped list (icon | title+subtitle | value | control).
    VStack(alignment: .leading, spacing: TraySpacing.groupGap) {
      if showOnboarding {
        NativeOnboardingChecklist(
          store: store,
          openAccounts: { openMainWindow(.manage, nil) },
          openHub: { openMainWindow(.hubSetup, nil) },
          compact: true
        )
        .transition(TrayMotion.panelTransition)
      }

      if !visibleClients.isEmpty {
        VStack(alignment: .leading, spacing: TraySpacing.sectionGap) {
          TraySectionHeader(title: "Apps", actionTitle: "Accounts…") {
            openMainWindow(.manage, nil)
          }
          TrayGroup {
            ForEach(Array(visibleClients.enumerated()), id: \.element) { index, client in
              NativeQuickRouteRow(
                client: client,
                route: store.route(client),
                actions: store.appActions(client),
                config: store.modelConfig(client),
                usage: usageFor(client: client),
                store: store,
                openRouteBrowser: { openMainWindow(.accounts, nil) },
                openModels: {
                  let clientId = store.modelConfig(client)?.clientId
                    ?? store.route(client)?.clientId
                    ?? client
                  openMainWindow(.clientModels, clientId)
                }
              )
              if index < visibleClients.count - 1 {
                Divider().padding(.leading, TraySpacing.dividerLeading)
              }
            }
            if store.appRouteClients.count > visibleClients.count {
              Divider().padding(.leading, TraySpacing.dividerLeading)
              Button {
                openMainWindow(.accounts, nil)
              } label: {
                Text("\(store.appRouteClients.count - visibleClients.count) more…")
                  .font(.body)
                  .foregroundStyle(Color.accentColor)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .padding(.horizontal, TraySpacing.rowPadding)
                  .padding(.vertical, 10)
              }
              .buttonStyle(.plain)
            }
          }
        }
      }

      if let hub = store.proxyHub, !store.isFirstRun {
        VStack(alignment: .leading, spacing: TraySpacing.sectionGap) {
          TraySectionHeader(title: "Proxy Hub", actionTitle: "Sources…") {
            openMainWindow(.modelAccounts, nil)
          }
          TrayGroup {
            NativeQuickHubRow(hub: hub, store: store) { destination in
              openMainWindow(destination, nil)
            }
          }
        }
      }

      if !store.nativeAccountClients.isEmpty {
        VStack(alignment: .leading, spacing: TraySpacing.sectionGap) {
          TraySectionHeader(title: "Other CLIs")
          TrayGroup {
            let visible = Array(store.nativeAccountClients.prefix(4))
            ForEach(Array(visible.enumerated()), id: \.element) { index, client in
              NativeQuickNativeProviderRow(
                client: client,
                actions: store.nativeActions(client),
                usage: usageFor(client: client),
                store: store,
                openAll: { openMainWindow(.accounts, nil) }
              )
              if index < visible.count - 1 {
                Divider().padding(.leading, TraySpacing.dividerLeading)
              }
            }
            if store.nativeAccountClients.count > visible.count {
              Divider().padding(.leading, TraySpacing.dividerLeading)
              Button {
                openMainWindow(.accounts, nil)
              } label: {
                Text("\(store.nativeAccountClients.count - visible.count) more…")
                  .font(.body)
                  .foregroundStyle(Color.accentColor)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .padding(.horizontal, TraySpacing.rowPadding)
                  .padding(.vertical, 10)
              }
              .buttonStyle(.plain)
            }
          }
        }
      }
    }
  }

  // MARK: Proxies

  private var proxiesPanel: some View {
    VStack(alignment: .leading, spacing: TraySpacing.sectionGap) {
      TraySectionHeader(title: "Proxies")
      if store.proxies.isEmpty {
        TrayGroup {
          Text("No proxy services configured.")
            .font(.callout)
            .foregroundStyle(.secondary)
            .padding(TraySpacing.rowPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      } else {
        TrayGroup {
          ForEach(Array(store.proxies.enumerated()), id: \.element.id) { index, proxy in
            NativeQuickProxyServiceRow(
              proxy: proxy,
              store: store,
              openSources: {
                openMainWindow(proxy.providerId == "proxy-hub" ? .modelAccounts : .proxy, nil)
              },
              openLogs: {
                store.selectLogSource(proxy.id)
                store.requestLogs(proxy)
                openMainWindow(.monitor, nil)
              },
              openHubSetup: { openMainWindow(.hubSetup, nil) }
            )
            if index < store.proxies.count - 1 {
              Divider().padding(.leading, TraySpacing.dividerLeading)
            }
          }
        }
      }
    }
  }

  // MARK: Logs

  private var logsPanel: some View {
    VStack(alignment: .leading, spacing: TraySpacing.sectionGap) {
      TraySectionHeader(title: "Recent activity", actionTitle: "Open…") {
        openMainWindow(.monitor, nil)
      }
      if store.activity.isEmpty {
        TrayGroup {
          Text("No recent activity.")
            .font(.callout)
            .foregroundStyle(.secondary)
            .padding(TraySpacing.rowPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      } else {
        TrayGroup {
          ForEach(Array(store.activity.prefix(8).enumerated()), id: \.element.id) { index, event in
            NativeQuickActivityRow(event: event)
            if index < min(7, store.activity.count - 1) {
              Divider().padding(.leading, TraySpacing.dividerLeading)
            }
          }
        }
      }
    }
  }

  // MARK: Footer

  private var footer: some View {
    // HIG menu-bar panel: one primary path; status lives only in the header.
    HStack(spacing: 10) {
      Button {
        openMainWindow(.manage, nil)
      } label: {
        Label("Add Account", systemImage: "plus")
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .keyboardShortcut("n", modifiers: [.command])

      Spacer(minLength: 0)

      if store.attentionCount > 0 {
        Button {
          openMainWindow(
            store.routingIssueCount > 0 || store.routingChoiceCount > 0
              ? .routingIssues
              : .proxy,
            nil
          )
        } label: {
          Label {
            Text(
              store.attentionCount == 1
                ? "1 needs attention"
                : "\(store.attentionCount) need attention"
            )
          } icon: {
            Image(systemName: store.routingIssueCount > 0
              ? "exclamationmark.triangle.fill"
              : "circle.badge.exclamationmark")
          }
          .font(.caption.weight(.semibold))
          .foregroundStyle(store.routingIssueCount > 0 ? anypickAmber : Color.accentColor)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
        }
        .buttonStyle(.plain)
        .help("Review routing attention items")
        .accessibilityLabel("\(store.attentionCount) items need attention")
      } else {
        TimelineView(.periodic(from: .now, by: 10)) { context in
          if let freshness = store.snapshotFreshnessText(now: context.date) {
            Text(freshness)
              .font(.caption2)
              .foregroundStyle(.tertiary)
              .lineLimit(1)
              .accessibilityLabel(freshness)
          }
        }
      }
    }
    .padding(.horizontal, TraySpacing.outer)
    .padding(.vertical, 10)
    .overlay(alignment: .top) { Divider() }
  }

  private func messageBar(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: store.messageIsError ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
        .foregroundStyle(store.messageIsError ? anypickRed : anypickSuccess)
        .symbolRenderingMode(.hierarchical)
      Text(message)
        .font(.callout)
        .foregroundStyle(.primary)
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button {
        store.dismissMessage()
      } label: {
        Image(systemName: "xmark")
          .font(.caption.weight(.bold))
          .frame(width: 20, height: 20)
          .contentShape(Rectangle())
      }
      .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
      .help("Dismiss")
      .accessibilityLabel("Dismiss message")
    }
    .padding(.leading, 14)
    .padding(.trailing, 10)
    .padding(.vertical, 10)
    .background {
      ZStack(alignment: .leading) {
        Rectangle().fill(.ultraThinMaterial)
        Rectangle()
          .fill(store.messageIsError ? anypickRed : anypickSuccess)
          .frame(width: 3)
      }
    }
    .overlay(alignment: .top) { Divider() }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      store.messageIsError ? "Error: \(message)" : "Success: \(message)"
    )
  }

  private func usageFor(client: String) -> UsageSnapshot? {
    store.usage(for: client)
  }
}
