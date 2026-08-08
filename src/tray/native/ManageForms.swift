import AppKit
import Foundation
import SwiftUI

// Module: ManageForms.swift — account/gateway forms and form chrome

struct NativeAccountForm: View {
  @ObservedObject var store: TrayStore
  let accountId: String?
  let onBack: () -> Void
  @State private var providerId: String?
  @State private var name = ""
  @State private var label = ""
  @State private var submittedRequestId: String?
  @State private var detectingRequestId: String?
  @State private var clearingRequestId: String?
  @State private var detected = false
  @State private var confirmClear = false

  private var account: ManagedAccountSnapshot? { store.accounts.first { $0.id == accountId } }
  private var detecting: Bool { detectingRequestId != nil }
  private var clearing: Bool { clearingRequestId != nil }
  private var editing: Bool { accountId != nil }
  private var provider: AccountProviderSnapshot? {
    store.accountProviders.first { $0.id == providerId }
  }
  private var canClearLive: Bool { provider?.canClear == true }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      NativeFormHeader(
        title: editing ? "Edit Account" : "Add Account",
        detail: editing
          ? "Update the friendly label shown in the tray"
          : "Capture a login already active on this Mac",
        onBack: onBack
      )

      if !editing {
        NativeFormField(label: "Provider", required: true) {
          NativeAccountProviderPicker(
            providers: store.accountProviders,
            selectedId: $providerId
          )
        }
        if store.accountProviders.isEmpty {
          NativeFormUnavailable(
            symbol: "shippingbox",
            title: "No providers available",
            detail: "Install a supported AI client, sign in, then refresh AnyPick."
          )
        } else if !store.accountProviders.contains(where: \.installed) {
          NativeFormUnavailable(
            symbol: "exclamationmark.triangle",
            title: "No signed-in login found",
            detail: "Sign in with Claude, Codex, Gemini, Antigravity, Kiro, Grok, or OpenCode, then refresh."
          )
        }
      } else if let account {
        NativeReadOnlyProvider(id: account.providerId, text: account.detail)
      }

      // Name = stable id (CLI). Label = what the tray list shows.
      NativeFormField(
        label: "Name",
        required: true,
        hint: editing
          ? "Internal id — locked after save (e.g. work)."
          : "Required short id, e.g. work or personal. Used in CLI; cannot rename later."
      ) {
        TextField("e.g. work", text: $name)
          .textFieldStyle(.plain)
          .disabled(editing)
      }
      NativeFormField(
        label: "Label",
        hint: "Optional. Nickname in the tray list. Leave empty to show the name."
      ) {
        TextField("e.g. Work laptop", text: $label)
          .textFieldStyle(.plain)
      }

      if !editing, let provider {
        VStack(alignment: .leading, spacing: 10) {
          Label(
            provider.installed
              ? "Detect only reads the current login. Nothing is saved until you confirm."
              : "\(provider.label) is not installed on this Mac.",
            systemImage: provider.installed ? "lock.shield" : "exclamationmark.triangle"
          )
          .font(.caption)
          .foregroundStyle(provider.installed ? .secondary : anypickAmber)

          HStack(spacing: 8) {
            Button(detected ? "Detected" : "Detect Login") { detectLogin() }
              .buttonStyle(.bordered)
              .disabled(!provider.installed || store.busyRequestId != nil || detected || clearing)
            if canClearLive {
              Button("Clear Live Login…") { confirmClear = true }
                .buttonStyle(.bordered)
                .disabled(store.busyRequestId != nil || detecting)
            }
            if detecting {
              ProgressView().controlSize(.small)
              Text("Checking \(provider.label)…")
                .font(.caption)
                .foregroundStyle(.secondary)
            } else if clearing {
              ProgressView().controlSize(.small)
              Text("Clearing live login…")
                .font(.caption)
                .foregroundStyle(.secondary)
            } else if detected {
              Label("Login found. Ready to save.", systemImage: "checkmark.circle.fill")
                .font(.caption.weight(.medium))
                .foregroundStyle(anypickSuccess)
            }
          }
          .controlSize(.small)

          if canClearLive {
            Text(
              "Clear wipes the local app login (after an auto-backup when possible) so you can sign in as another account in the official app, then Detect again. It is not a remote logout, and it does not remove saved AnyPick accounts."
            )
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .fixedSize(horizontal: false, vertical: true)
          }
        }
      }

      HStack {
        Button("Cancel", action: onBack)
          .buttonStyle(.bordered)
          .keyboardShortcut(.cancelAction)
        Spacer()
        Button(editing ? "Save Changes" : "Save Current Login") { submit() }
          .buttonStyle(.borderedProminent)
          .disabled(!canSubmit || (!editing && !detected) || store.busyRequestId != nil)
          .keyboardShortcut(.defaultAction)
      }
      .controlSize(.regular)
    }
    .onAppear(perform: populate)
    .onChange(of: store.accountProviders.map(\.id)) { _, _ in selectDefaultProvider() }
    .onChange(of: providerId) { _, _ in
      if detectingRequestId == nil { detected = false }
    }
    .onChange(of: store.lastResult?.requestId) { _, requestId in
      guard let requestId else { return }
      if requestId == detectingRequestId {
        detectingRequestId = nil
        detected = store.lastResult?.status == "success"
        return
      }
      if requestId == clearingRequestId {
        clearingRequestId = nil
        // Live auth is gone (or never was); force a fresh Detect before save.
        if store.lastResult?.status == "success" { detected = false }
        return
      }
      if requestId == submittedRequestId {
        let succeeded = store.lastResult?.status == "success"
        submittedRequestId = nil
        if succeeded { onBack() }
      }
    }
    .confirmationDialog(
      "Clear live \(provider?.label ?? "app") login?",
      isPresented: $confirmClear,
      titleVisibility: .visible
    ) {
      Button("Clear Live Login", role: .destructive) { clearLiveLogin() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "AnyPick backs up the live login into a saved account when it can, then removes only the local app credential so you can sign in as someone else. The official app is not remotely logged out."
      )
    }
  }

  private var canSubmit: Bool {
    guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    if editing { return account != nil }
    return provider?.installed == true
  }

  private func populate() {
    if let account {
      providerId = account.sourceId ?? account.providerId
      name = account.name
      label = account.label
    } else {
      selectDefaultProvider()
    }
  }

  private func selectDefaultProvider() {
    guard providerId == nil else { return }
    providerId = store.accountProviders.first(where: \.installed)?.id
  }

  private func detectLogin() {
    guard let provider, provider.installed else { return }
    detected = false
    detectingRequestId = store.mutate(
      operation: "account-detect",
      name: "detect",
      providerId: provider.providerId,
      sourceId: provider.sourceId,
      activityLabel: "detecting the current \(provider.label) login"
    )
  }

  private func clearLiveLogin() {
    guard let provider, canClearLive else { return }
    detected = false
    clearingRequestId = store.mutate(
      operation: "account-clear",
      name: "clear",
      providerId: provider.providerId,
      sourceId: provider.sourceId,
      activityLabel: "clearing the live \(provider.label) login"
    )
  }

  private func submit() {
    guard let account = editing ? account : nil else {
      guard let provider else { return }
      submittedRequestId = store.mutate(
        operation: "account-save",
        name: name,
        providerId: provider.providerId,
        sourceId: provider.sourceId,
        label: label,
        activityLabel: "saving \(name)"
      )
      return
    }
    submittedRequestId = store.mutate(
      operation: "account-edit",
      name: account.name,
      providerId: account.providerId,
      label: label,
      activityLabel: "updating \(account.label)"
    )
  }
}
struct NativeGatewayForm: View {
  @ObservedObject var store: TrayStore
  let gatewayId: String?
  let onBack: () -> Void
  @State private var providerId: String?
  @State private var name = ""
  @State private var endpoint = ""
  @State private var apiKey = ""
  @State private var region: String?
  @State private var defaultModel = ""
  @State private var showAdvanced = false
  @State private var submittedRequestId: String?

  private var gateway: GatewaySnapshot? { store.gateways.first { $0.id == gatewayId } }
  private var editing: Bool { gatewayId != nil }
  private var selectedProvider: GatewayProviderSnapshot? {
    store.gatewayProviders.first { $0.id == providerId }
  }
  /// A proxy-only account provider (Kiro) saves through account-save with an
  /// api-key credential, not gateway-create. Only in the create flow.
  private var isApiKeyAccount: Bool {
    !editing && selectedProvider?.kind == "account-api-key"
  }

  private var regionChoices: [String] {
    selectedProvider?.regions ?? []
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      NativeFormHeader(
        title: editing ? "Edit Gateway" : isApiKeyAccount ? "Add API Key Account" : "Add Gateway",
        detail: isApiKeyAccount
          ? "Typed API key · saved as a proxy-only account (e.g. Kiro)"
          : "HTTP gateway profiles · Claude Code and Codex only",
        onBack: onBack
      )

      if editing, let gateway {
        NativeReadOnlyProvider(id: gateway.providerId, text: gateway.providerId)
      } else {
        NativeFormField(
          label: "Provider",
          required: true,
          hint: isApiKeyAccount
            ? "API key accounts (Kiro) are listed above OpenRouter-style gateways."
            : nil
        ) {
          NativeGatewayProviderPicker(providers: store.gatewayProviders, selectedId: $providerId)
        }
        if store.gatewayProviders.isEmpty {
          NativeFormUnavailable(
            symbol: "network.slash",
            title: "No gateway providers available",
            detail: "Refresh AnyPick and try again. No gateway can be saved yet."
          )
        }
      }
      NativeFormField(
        label: "Name",
        required: true,
        hint: editing
          ? "Internal id — locked after save."
          : "Required short id, e.g. work. Used in CLI; cannot rename later."
      ) {
        TextField("e.g. work", text: $name)
          .textFieldStyle(.plain)
          .disabled(editing)
      }
      // On create the key is required; on edit blank keeps the stored key.
      NativeFormField(
        label: editing ? "New API Key" : "API Key",
        required: !editing,
        hint: editing ? "Leave blank to keep the current key." : nil
      ) {
        SecureField(editing ? "Leave blank to keep current" : "Paste key", text: $apiKey)
          .textFieldStyle(.plain)
      }

      // Region is required for api-key accounts that declare choices (Kiro).
      // Bound as non-optional when choices exist so the menu always has a selection.
      if isApiKeyAccount, !regionChoices.isEmpty {
        NativeFormField(
          label: "Region",
          required: true,
          hint: "Kiro data plane, e.g. us-east-1 → runtime.us-east-1.kiro.dev."
        ) {
          Picker("Region", selection: regionBinding) {
            ForEach(regionChoices, id: \.self) { choice in
              Text(choice).tag(choice)
            }
          }
          .labelsHidden()
          .pickerStyle(.menu)
        }
      }

      if !isApiKeyAccount {
        NativeFormField(label: "Default Model", hint: "Optional.") {
          TextField("Model id", text: $defaultModel)
            .textFieldStyle(.plain)
        }

        DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
          NativeFormField(label: "Endpoint", hint: "Optional custom base URL.") {
            TextField("Provider default if empty", text: $endpoint)
              .textFieldStyle(.plain)
          }
          .padding(.top, 8)
        }
        .font(.callout.weight(.medium))
      }

      Label(
        isApiKeyAccount
          ? "The API key is sent directly to AnyPick and stored with the saved account."
          : "The API key is sent directly to AnyPick and stored in macOS Keychain.",
        systemImage: "lock.shield"
      )
      .font(.caption)
      .foregroundStyle(.secondary)

      HStack {
        Button("Cancel", action: onBack)
          .buttonStyle(.bordered)
          .keyboardShortcut(.cancelAction)
        Spacer()
        Button(saveButtonTitle) { submit() }
          .buttonStyle(.borderedProminent)
          .disabled(!canSubmit || store.busyRequestId != nil)
          .keyboardShortcut(.defaultAction)
      }
      .controlSize(.regular)
    }
    .onAppear(perform: populate)
    .onChange(of: store.gatewayProviders.map(\.id)) { _, _ in selectDefaultProvider() }
    .onChange(of: providerId) { _, _ in
      if !editing { endpoint = "" }
      syncRegionDefault()
    }
    .onChange(of: store.lastResult?.requestId) { _, requestId in
      guard let submittedRequestId, requestId == submittedRequestId else { return }
      let succeeded = store.lastResult?.status == "success"
      self.submittedRequestId = nil
      if !succeeded { return }
      apiKey = ""
      onBack()
    }
  }

  /// Keeps the menu selection in the known choices list (never nil while choices exist).
  private var regionBinding: Binding<String> {
    Binding(
      get: {
        if let region, regionChoices.contains(region) { return region }
        return selectedProvider?.regionDefault ?? regionChoices.first ?? ""
      },
      set: { region = $0 }
    )
  }

  private var saveButtonTitle: String {
    if editing { return "Save Changes" }
    return isApiKeyAccount ? "Save Account" : "Save Gateway"
  }

  private var canSubmit: Bool {
    guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    if editing { return gateway != nil }
    return providerId != nil && !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func populate() {
    if let gateway {
      providerId = gateway.providerId
      name = gateway.name
      defaultModel = gateway.defaultModel ?? ""
    } else {
      selectDefaultProvider()
    }
  }

  private func selectDefaultProvider() {
    guard providerId == nil else { return }
    providerId = store.gatewayProviders.first?.id
    syncRegionDefault()
  }

  private func syncRegionDefault() {
    guard let provider = selectedProvider, provider.kind == "account-api-key" else {
      region = nil
      return
    }
    region = provider.regionDefault ?? provider.regions?.first
  }

  private func submit() {
    guard let providerId else { return }
    if isApiKeyAccount {
      submittedRequestId = store.mutate(
        operation: "account-save",
        name: name,
        providerId: providerId,
        apiKey: apiKey,
        region: region,
        activityLabel: "saving \(name)"
      )
      apiKey = ""
      return
    }
    submittedRequestId = store.mutate(
      operation: editing ? "gateway-edit" : "gateway-create",
      name: name,
      providerId: editing ? nil : providerId,
      endpoint: endpoint,
      apiKey: apiKey,
      defaultModel: defaultModel,
      activityLabel: "saving \(name)"
    )
    // Clear the field so a failed retry does not re-send a key the user thinks is gone.
    // Keychain write only happens server-side on success.
    apiKey = ""
  }
}
