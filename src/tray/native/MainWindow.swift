import AppKit
import Foundation
import SwiftUI

// Module: MainWindow.swift — NavigationSplitView shell (System Settings-like).

struct NativeMainWindow: View {
  @ObservedObject var store: TrayStore
  @ObservedObject var navigation: NativeNavigationModel

  private var sidebarSelection: Binding<NativeTrayTab?> {
    Binding(
      get: { navigation.sidebarTab },
      set: { destination in
        if let destination { navigation.show(destination) }
      }
    )
  }

  private var detailTitle: String {
    if navigation.tab == .clientModels,
       let config = navigation.selectedClientModelId.flatMap({ store.modelConfig($0) }) {
      return "\(anypickDisplayName(config.client)) Model Settings"
    }
    return navigation.tab.rawValue
  }

  private var backDestination: (NativeTrayTab, String)? {
    switch navigation.tab {
    case .clientModels: return (.accounts, "Apps")
    case .modelAccounts, .routingIssues, .hubSetup: return (.proxy, "Proxies")
    // Accounts is a top-level sidebar item — no nested back affordance.
    default: return nil
    }
  }

  private var attentionCount: Int { store.attentionCount }

  var body: some View {
    NavigationSplitView {
      VStack(spacing: 0) {
        List(selection: sidebarSelection) {
          Section {
            Label("Apps", systemImage: "app.badge.checkmark")
              .tag(NativeTrayTab.accounts)

            Label("Accounts", systemImage: "person.crop.circle")
              .tag(NativeTrayTab.manage)

            HStack {
              Label("Proxies", systemImage: "point.3.connected.trianglepath.dotted")
              Spacer()
              if attentionCount > 0 {
                // HIG-style sidebar badge (count capsule).
                Text("\(attentionCount)")
                  .font(.caption2.weight(.semibold))
                  .foregroundStyle(.white)
                  .padding(.horizontal, 6)
                  .padding(.vertical, 1)
                  .background(
                    Capsule().fill(store.routingIssueCount > 0 ? Color.orange : Color.accentColor)
                  )
                  .accessibilityLabel("\(attentionCount) items need attention")
              }
            }
            .tag(NativeTrayTab.proxy)

            Label("Logs", systemImage: "doc.text.magnifyingglass")
              .tag(NativeTrayTab.monitor)
          }

          Section {
            Label("Settings", systemImage: "gearshape")
              .tag(NativeTrayTab.settings)
          }
        }
        .listStyle(.sidebar)

        Divider()
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 6) {
            Circle()
              .fill(store.proxyCount > 0 ? anypickSuccess : Color.secondary.opacity(0.4))
              .frame(width: 7, height: 7)
              .accessibilityHidden(true)
            Text(
              store.proxyCount == 0
                ? "No proxies running"
                : "\(store.proxyCount) active \(store.proxyCount == 1 ? "proxy" : "proxies")"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            Spacer(minLength: 0)
          }
          TimelineView(.periodic(from: .now, by: 10)) { context in
            if let freshness = store.snapshotFreshnessText(now: context.date) {
              Text(freshness)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
            }
          }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
      }
      .navigationSplitViewColumnWidth(min: 170, ideal: 200, max: 260)
    } detail: {
      VStack(spacing: 0) {
        if let message = store.message {
          NativeMessageBar(message: message, isError: store.messageIsError) {
            store.dismissMessage()
          }
          .transition(TrayMotion.messageTransition)
        }

        Group {
          if !store.snapshotReady {
            NativeSnapshotLoading()
              .frame(maxWidth: .infinity, maxHeight: .infinity)
          } else if usesFormLayout {
            detailPanel
              .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          } else if usesFullBleedLayout {
            // Logs need the full detail column — no content-width cap.
            detailPanel
              .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
              .padding(.horizontal, 16)
              .padding(.vertical, 14)
          } else {
            ScrollView {
              detailPanel
                .frame(maxWidth: 680, alignment: .topLeading)
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
          }
        }
        .id(navigation.tab)
        .transition(TrayMotion.panelTransition)
        .animation(TrayMotion.standard, value: navigation.tab)
        .animation(TrayMotion.message, value: store.message)
      }
      .background(nativeWindowFill)
      .navigationTitle(detailTitle)
    }
    // Ideal size only — actual window is resizable (see AppEntry).
    .frame(minWidth: 720, idealWidth: 840, minHeight: 480, idealHeight: 640)
    .navigationSplitViewStyle(.balanced)
    .toolbar {
      ToolbarItem(placement: .navigation) {
        if let backDestination {
          Button {
            navigation.show(backDestination.0)
          } label: {
            // Icon-only toolbar item — Label(title+symbol) double-renders in unified toolbars.
            Image(systemName: "chevron.left")
          }
          .help("Back to \(backDestination.1)")
          .accessibilityLabel("Back to \(backDestination.1)")
        }
      }
      ToolbarItemGroup(placement: .primaryAction) {
        if store.showsBusy {
          ProgressView()
            .controlSize(.small)
            .accessibilityLabel(store.busyLabel.map { "Working on \($0)" } ?? "Working")
        }
        Button {
          store.refreshAll()
        } label: {
          Label("Refresh", systemImage: "arrow.clockwise")
        }
        .labelStyle(.iconOnly)
        .help("Refresh (⌘R)")
        .accessibilityLabel("Refresh")
        .disabled(store.busyRequestId != nil)
      }
    }
  }

  private var usesFormLayout: Bool {
    switch navigation.tab {
    case .settings: return true
    default: return false
    }
  }

  /// Full-width detail (no 680pt card column). Used by Logs so the viewer can breathe.
  private var usesFullBleedLayout: Bool {
    switch navigation.tab {
    case .monitor: return true
    default: return false
    }
  }

  @ViewBuilder
  private var detailPanel: some View {
    switch navigation.tab {
    case .accounts:
      NativeAccountsPanel(
        store: store,
        openManage: { navigation.show(.manage) },
        openModelAccounts: { navigation.show(.modelAccounts) },
        openRoutingIssues: { navigation.show(.routingIssues) },
        openClientModels: { navigation.show(.clientModels, clientId: $0) },
        openHubSetup: { navigation.show(.hubSetup) }
      )
    case .manage:
      NativeManagePanel(store: store)
    case .modelAccounts:
      NativeModelAccountsPanel(store: store, openManage: { navigation.show(.manage) })
    case .clientModels:
      if let config = navigation.selectedClientModelId.flatMap({ store.modelConfig($0) }) {
        NativeClientModelsPanel(
          config: config,
          store: store,
          cancel: { navigation.show(.accounts) }
        )
      } else {
        NativeAppModelsOverviewPanel(store: store) {
          navigation.show(.clientModels, clientId: $0)
        }
      }
    case .routingIssues:
      NativeRoutingIssuesPanel(
        store: store,
        openModelAccounts: { navigation.show(.modelAccounts) }
      )
    case .hubSetup:
      NativeHubSetupPanel(
        store: store,
        openSources: { navigation.show(.modelAccounts) },
        openRouting: { navigation.show(.routingIssues) },
        openAccounts: { navigation.show(.accounts) },
        openManage: { navigation.show(.manage) }
      )
    case .proxy:
      NativeProxyPanel(
        store: store,
        openManage: { navigation.show(.manage) },
        openMonitor: { navigation.show(.monitor) },
        openHubSetup: { navigation.show(.hubSetup) },
        openModelAccounts: { navigation.show(.modelAccounts) }
      )
    case .monitor:
      NativeMonitorPanel(store: store)
    case .settings:
      NativeSettingsPanel(store: store)
    }
  }
}

struct NativeMessageBar: View {
  let message: String
  let isError: Bool
  let dismiss: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: isError ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
        .foregroundStyle(isError ? anypickRed : anypickSuccess)
        .symbolRenderingMode(.hierarchical)
        .imageScale(.medium)
      Text(message)
        .font(.callout)
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button(action: dismiss) {
        Image(systemName: "xmark")
          .font(.caption.weight(.semibold))
          .frame(width: 20, height: 20)
          .contentShape(Rectangle())
      }
      .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
      .help("Dismiss")
      .accessibilityLabel("Dismiss message")
      .keyboardShortcut(.cancelAction)
    }
    .padding(.leading, 14)
    .padding(.trailing, 10)
    .padding(.vertical, 9)
    .background {
      ZStack(alignment: .leading) {
        Rectangle().fill(.ultraThinMaterial)
        // Leading status stripe (HIG banner pattern).
        Rectangle()
          .fill(isError ? anypickRed : anypickSuccess)
          .frame(width: 3)
      }
    }
    .overlay(alignment: .bottom) { Divider() }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(isError ? "Error: \(message)" : "Success: \(message)")
  }
}
