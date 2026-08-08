import AppKit
import Foundation
import SwiftUI

// Module: SettingsPanel.swift — System Settings-style Form.

struct NativeSettingsPanel: View {
  @ObservedObject var store: TrayStore
  @State private var resetClient: String?
  @AppStorage(TrayPreferences.Key.onboardingDismissed) private var onboardingDismissed = false

  var body: some View {
    Form {
      Section {
        Toggle(
          "Open at Login",
          isOn: Binding(
            get: { store.settings.launchAtLogin },
            set: {
              store.mutate(
                operation: "setting-launch-at-login",
                name: "settings",
                enabled: $0,
                activityLabel: "updating login settings"
              )
            }
          )
        )
        .disabled(store.busyRequestId != nil)
        .anypickHandCursor(enabled: store.busyRequestId == nil)
      } header: {
        Text("General")
      } footer: {
        Text("Launch the menu-bar tray when you sign in to this Mac.")
      }

      Section {
        Toggle(
          "Quota Guard",
          isOn: Binding(
            get: { store.settings.quotaGuardEnabled },
            set: {
              store.mutate(
                operation: "setting-quota-guard",
                name: "settings",
                enabled: $0,
                activityLabel: "updating quota guard"
              )
            }
          )
        )
        .disabled(store.busyRequestId != nil)
        .anypickHandCursor(enabled: store.busyRequestId == nil)

        Toggle(
          "Show account quota",
          isOn: Binding(
            get: { store.settings.showQuota },
            set: {
              store.mutate(
                operation: "setting-show-quota",
                name: "settings",
                enabled: $0,
                activityLabel: "updating quota visibility"
              )
            }
          )
        )
        .disabled(store.busyRequestId != nil)
        .anypickHandCursor(enabled: store.busyRequestId == nil)
      } header: {
        Text("Quota")
      } footer: {
        Text(
          "Quota Guard only switches pooled proxy accounts after a confirmed limit. Quota display fetches remaining usage for Apps."
        )
      }

      Section {
        Toggle(
          "Start enabled proxies",
          isOn: Binding(
            get: { store.settings.startEnabledProxies },
            set: {
              store.mutate(
                operation: "setting-auto-start-proxies",
                name: "settings",
                enabled: $0,
                activityLabel: "updating proxy auto-start"
              )
            }
          )
        )
        .disabled(store.busyRequestId != nil)
        .anypickHandCursor(enabled: store.busyRequestId == nil)
      } header: {
        Text("Proxies")
      } footer: {
        Text("When the tray launches, start every proxy that was left enabled.")
      }

      Section {
        HStack {
          Button("Refresh Now", action: store.refreshAll)
            .keyboardShortcut("r", modifiers: .command)
          Button("Restart Proxies", action: store.restartProxies)
            .keyboardShortcut("r", modifiers: [.command, .shift])
        }
        .buttonStyle(.bordered)
        .controlSize(.regular)
        .disabled(store.busyRequestId != nil)

        Button("Show Setup Tips Again") {
          withAnimation(TrayMotion.standard) {
            onboardingDismissed = false
          }
        }
        .buttonStyle(.bordered)
        .controlSize(.regular)
        .disabled(!onboardingDismissed && !trayOnboardingCoreComplete(store: store))
        .help("Bring back the first-run checklist on Apps")
      } header: {
        Text("Maintenance")
      } footer: {
        Text("⌘R refreshes snapshot state. ⌘⇧R restarts enabled proxies. Setup tips reappear on the Apps screen.")
      }

      Section {
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text("Claude Code")
            Text("Clear managed endpoint, token, models, and global route")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Spacer()
          Button("Reset…") { resetClient = "claude" }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .disabled(store.busyRequestId != nil)

        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text("Codex")
            Text("Clear managed provider profile, catalog, and global route")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Spacer()
          Button("Reset…") { resetClient = "codex" }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .disabled(store.busyRequestId != nil)
      } header: {
        Text("Client defaults")
      } footer: {
        Text("Your native login is kept. Only AnyPick-managed config and the global route are removed.")
      }

      Section {
        LabeledContent {
          Image(systemName: "lock.shield.fill")
            .foregroundStyle(.secondary)
            .accessibilityLabel("Always enforced")
        } label: {
          VStack(alignment: .leading, spacing: 2) {
            Text("Secrets in macOS Keychain")
            Text("Gateway API keys never enter the tray snapshot")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }

        LabeledContent {
          Image(systemName: "lock.shield.fill")
            .foregroundStyle(.secondary)
            .accessibilityLabel("Always enforced")
        } label: {
          VStack(alignment: .leading, spacing: 2) {
            Text("Loopback-only proxies")
            Text("Proxy services accept local authenticated traffic only")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      } header: {
        Text("Security")
      } footer: {
        Text("These protections are always on and cannot be disabled.")
      }
    }
    .formStyle(.grouped)
    .confirmationDialog(
      "Reset \(resetClient == "claude" ? "Claude Code" : "Codex") defaults?",
      isPresented: Binding(
        get: { resetClient != nil },
        set: { if !$0 { resetClient = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Reset AnyPick overrides", role: .destructive) {
        guard let client = resetClient else { return }
        resetClient = nil
        store.mutate(
          operation: "client-reset",
          name: client,
          activityLabel: "resetting \(client == "claude" ? "Claude Code" : "Codex") defaults"
        )
      }
      Button("Cancel", role: .cancel) { resetClient = nil }
    } message: {
      Text("Your native login is kept. Only AnyPick-managed config and the global route are removed.")
    }
  }
}

enum NativeManagePage: Equatable {
  case list
  case addAccount
  case editAccount
  case addGateway
  case editGateway
}
