import SwiftUI

struct AppDetailView: View {
  @ObservedObject var model: MacOSDesignModel
  let appID: String
  @Environment(\.dismiss) private var dismiss
  @State private var showingRoutes = false
  @State private var showingModels = false
  @State private var showingCodexProfileSheet = false
  @State private var editingCodexProfile: DesignCodexProfile?
  @State private var copiedCodexProfileID: String?
  @State private var copyFeedbackTask: Task<Void, Never>?
  @State private var confirmation: DesignConfirmation?

  private var app: DesignApp? { model.apps.first { $0.id == appID } }

  private var selectedRoute: DesignRoute? {
    app?.routeOptions.first { $0.id == app?.selectedRouteID }
  }

  private var supportsManagedRouting: Bool {
    app?.routeOptions.contains { $0.kind != .native } == true
  }

  private var codexAccountProfileSources: [DesignCodexProfileSource] {
    model.codexProfileSources.filter { $0.kind == "account" }
  }

  private var missingCodexProfileSources: [DesignCodexProfileSource] {
    let existingSourceIDs = Set(model.codexProfiles.map(\.sourceID))
    return codexAccountProfileSources.filter { !existingSourceIDs.contains($0.sourceID) }
  }

  private var automaticCodexProfileCreationBinding: Binding<Bool> {
    Binding(
      get: { model.automaticallyCreateCodexProfiles },
      set: { enabled in
        if enabled {
          let existingSourceIDs = Set(model.codexProfiles.map(\.sourceID))
          let alreadyProfiled = codexAccountProfileSources
            .filter { existingSourceIDs.contains($0.sourceID) }
            .map(\.sourceID)
          model.setAutomaticCodexProfileCreation(true, baselineSourceIDs: alreadyProfiled)
        } else {
          model.setAutomaticCodexProfileCreation(false, baselineSourceIDs: [])
        }
      }
    )
  }

  @ViewBuilder
  private var appActions: some View {
    DesignPaneActions {
      if supportsManagedRouting {
        DesignSheetButton(
          title: "Disconnect AnyPick",
          enabled: !model.isBusy,
          destructive: true,
          identifier: "app.reset"
        ) { requestReset() }
      }
      DesignSheetButton(
        title: "Remove App",
        enabled: !model.isBusy,
        destructive: true,
        identifier: "app.remove"
      ) { requestRemoval() }
    }
  }

  private func requestReset() {
    confirmation = DesignConfirmation(
      id: "disconnect-app",
      title: "Disconnect \(app?.name ?? "app") from AnyPick?",
      message:
        "The official direct login will be restored. AnyPick proxy routing and model overrides will be removed.",
      action: .confirm("Disconnect") { model.resetAppConfiguration(appID: appID) }
    )
  }

  private func requestRemoval() {
    confirmation = DesignConfirmation(
      id: "remove-app",
      title: "Remove \(app?.name ?? "app") from AnyPick?",
      message:
        "This removes \(app?.name ?? "the app") from your configured apps list. If it was connected, AnyPick will disconnect and restore its official login.",
      action: .confirm("Remove App") {
        model.removeApp(appID: appID)
        dismiss()
      }
    )
  }

  private func requestProfileRemoval(_ name: String) {
    confirmation = DesignConfirmation(
      id: "remove-codex-profile",
      title: "Remove Codex profile \(name)?",
      message:
        "AnyPick will remove this profile’s managed route, authentication copy, and proxy settings. Codex’s main login is kept.",
      action: .confirm("Remove") { model.removeCodexProfile(name: name) }
    )
  }

  private var showsModelConfiguration: Bool {
    guard let selectedRoute, selectedRoute.kind != .native else { return false }
    return app?.modelRoles.isEmpty == false
  }

  var body: some View {
    DesignGroupedPane(actions: { appActions }) {
      if let app {
        Section {
          Label {
            VStack(alignment: .leading, spacing: 2) {
              Text(app.name)
                .font(.headline)
              Text(headerSubtitle(app))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
          } icon: {
            DesignProviderIcon(provider: app.id, fallbackSymbol: app.symbol, size: 28)
          }
        }

        if let issue = app.issue {
          Section {
            Label {
              VStack(alignment: .leading, spacing: 2) {
                Text("Needs Attention")
                Text(issue)
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }
            } icon: {
              DesignWarningSymbol()
            }
          }
        }

        Section {
          LabeledContent("Uses", value: selectedName(app))
          if let identity = resolvedIdentity(app), !identity.isEmpty {
            LabeledContent("Identity", value: identity)
          }
          LabeledContent("Transport", value: transportDisplayName(for: app))
          LabeledContent("Connection") {
            HStack(spacing: 8) {
              Button(isAppRouteConfigured(app) ? "Change…" : "Connect…") { showingRoutes = true }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help(isAppRouteConfigured(app) ? "Choose a different saved account or route for this app." : "Choose a saved login or gateway for this app.")
                .disabled(model.isBusy || app.routeOptions.isEmpty)
              if isAppManagedByAnyPick(app) {
                Button("Disconnect…", role: .destructive) { requestReset() }
                  .buttonStyle(.bordered)
                  .controlSize(.small)
                  .help("Stop managing this app with AnyPick and restore its previous connection.")
                  .disabled(model.isBusy)
                  .accessibilityIdentifier("app.connection.disconnect")
              }
            }
          }
          .accessibilityIdentifier("app.connection.change")
        } header: {
          Text("Connection")
        }

        Section {
          Toggle("Show in Quick Panel", isOn: quickPanelBinding(app))
            .disabled(model.isBusy)
        } footer: {
          Text("When enabled, this app appears in the menu bar Quick Panel for quick switching.")
        }

        if showsModelConfiguration {
          Section {
            LabeledContent("Default", value: defaultModel(app))
            LabeledContent("Overrides", value: overrideSummary(app))
            LabeledContent("Manage Models") {
              Button("Manage…") { showingModels = true }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Choose the models this app uses for each role.")
                .disabled(!app.modelEditingAvailable || model.isBusy)
            }
            .accessibilityIdentifier("app.models.manage")
          } header: {
            Text("Models")
          } footer: {
            VStack(alignment: .leading) {
              if !app.modelEditingAvailable, let reason = app.modelUnavailableReason,
                !reason.isEmpty
              {
                Text(reason)
              }
            }
          }
        }

        if app.id == "codex" {
          Section {
            if model.codexProfiles.isEmpty {
              Text(
                model.codexProfileSources.isEmpty
                  ? "Add a compatible account or route to create a Codex CLI profile."
                  : "No profiles yet. Add one to use a separate AnyPick connection in Codex CLI."
              )
                .foregroundStyle(.secondary)
            } else {
              ForEach(model.codexProfiles) { profile in
                codexProfileRow(profile)
              }
            }
          } header: {
            Text("Codex Profiles")
          } footer: {
            Text("Each profile has separate Codex CLI credentials and settings. Copy its command to launch it.")
          }

          Section {
            Toggle(
              "Create profiles automatically",
              isOn: automaticCodexProfileCreationBinding
            )
            .disabled(model.isBusy)
            if !missingCodexProfileSources.isEmpty {
              Button("Create Missing Profiles…", systemImage: "person.crop.circle.badge.plus") {
                _ = model.createMissingCodexProfiles(
                  sourceIDs: missingCodexProfileSources.map(\.sourceID))
              }
              .help("Create a separate Codex CLI profile for each compatible saved account.")
              .disabled(model.isBusy)
              .accessibilityIdentifier("codex-profile.create-missing")
            }
          } header: {
            Text("Automation")
          } footer: {
            Text("Automatically create a profile when you add a compatible saved account. Create Missing Profiles also backfills existing accounts.")
          }
        }

        if model.showUsage, !app.usageWindows.isEmpty {
          ForEach(groupUsageWindows(app.usageWindows)) { group in
            Section {
              ForEach(group.windows) { window in
                usageRow(window, grouped: group.title != nil)
              }
            } header: {
              Text(group.title ?? "Usage")
            }
          }
        } else if model.showUsage, isAppRouteConfigured(app) {
          Section {
            Text("This login doesn’t report usage.")
              .foregroundStyle(.secondary)
          } header: {
            Text("Usage")
          }
        }
      }
    }
    .sheet(isPresented: $showingRoutes) {
      AppRouteSheet(model: model, appID: appID)
    }
    .sheet(isPresented: $showingModels) {
      AppModelsSheet(model: model, appID: appID)
    }
    .sheet(isPresented: $showingCodexProfileSheet) {
      CodexProfileSheet(model: model, profile: editingCodexProfile)
        // SwiftUI can evaluate sheet content before the selected profile has
        // arrived, leaving its @State fields initialized with the Add defaults.
        .id(editingCodexProfile.map { "edit:\($0.name)" } ?? "add")
        .onDisappear { editingCodexProfile = nil }
    }
    .toolbar {
      if appID == "codex" {
        ToolbarItem(placement: .primaryAction) {
          Button("Add Profile", systemImage: "plus", action: addCodexProfile)
            .help("Create a named Codex CLI profile with separate model settings.")
            .disabled(model.isBusy || model.codexProfileSources.isEmpty)
            .accessibilityIdentifier("codex-profile.add")
        }
      }
    }
    .onDisappear { copyFeedbackTask?.cancel() }
    .navigationTitle(app?.name ?? "App")
    .designConfirmation($confirmation)
  }

  private func codexProfileSummary(_ profile: DesignCodexProfile) -> String {
    let modelName = profile.modelID.isEmpty ? "Source default" : cleanModelDisplayName(profile.modelID)
    let transport = switch profile.transportPolicy {
    case "direct": "Direct"
    case "proxy": "Proxy"
    default: "Automatic"
    }
    return "\(profile.sourceLabel) · \(modelName) · \(transport)"
  }

  private func codexProfileRow(_ profile: DesignCodexProfile) -> some View {
    HStack(spacing: 10) {
      codexProfileIcon(profile)
        .frame(width: 24, height: 24)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(profile.name)
        Text(codexProfileSummary(profile))
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      DesignCopyButton(
        copied: copiedCodexProfileID == profile.id,
        label: "Copy launch command for \(profile.name)",
        identifier: "codex-profile.copy.\(profile.name)"
      ) {
        copyCodexProfileCommand(profile)
      }
      .disabled(model.isBusy || profile.launchCommand.isEmpty)

      DesignMoreActionsMenu(
        label: "Actions for \(profile.name)",
        identifier: "codex-profile.more.\(profile.name)",
        isDisabled: model.isBusy
      ) {
        Button("Edit Profile…", systemImage: "slider.horizontal.3") {
          editingCodexProfile = profile
          showingCodexProfileSheet = true
        }
        .help("Change this profile’s name, account, or model settings.")
        Button("Remove Profile…", systemImage: "trash", role: .destructive) {
          requestProfileRemoval(profile.name)
        }
        .help("Remove this Codex CLI profile from AnyPick.")
      }
    }
    .accessibilityIdentifier("codex-profile.row.\(profile.name)")
  }

  @ViewBuilder
  private func codexProfileIcon(_ profile: DesignCodexProfile) -> some View {
    if let source = model.codexProfileSources.first(where: { $0.sourceID == profile.sourceID }),
      source.kind == "proxy-hub"
    {
      Image(systemName: DesignDestination.proxyHub.symbol)
        .foregroundStyle(.secondary)
    } else if let provider = profile.sourceID.split(separator: "/", omittingEmptySubsequences: true)
      .dropFirst()
      .first, profile.sourceID.hasPrefix("account/")
    {
      DesignProviderIcon(provider: String(provider), fallbackSymbol: "person.crop.circle", size: 24)
    } else {
      Image(systemName: "terminal")
        .foregroundStyle(.secondary)
    }
  }

  private func addCodexProfile() {
    editingCodexProfile = nil
    showingCodexProfileSheet = true
  }

  private func copyCodexProfileCommand(_ profile: DesignCodexProfile) {
    guard !profile.launchCommand.isEmpty else { return }
    guard model.copyCodexProfileLaunchCommand(name: profile.name) else { return }
    copiedCodexProfileID = profile.id
    copyFeedbackTask?.cancel()
    copyFeedbackTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      guard !Task.isCancelled, copiedCodexProfileID == profile.id else { return }
      copiedCodexProfileID = nil
    }
  }

  /// "Claude account · Ready": the provider kind reads from the selected
  /// route, so a gateway or hub route never poses as an account.
  private func headerSubtitle(_ app: DesignApp) -> String {
// Without this a hub route reads as "<App> account" — the wrong transport.
    if selectedRoute?.kind == .hub {
      return "Proxy Hub · \(app.status.rawValue)"
    }
    let provider = selectedRoute?.providerID.map(nativeProviderName) ?? nativeProviderName(app.id)
    let kind = selectedRoute?.kind == .gateway ? "gateway" : "account"
    return "\(provider) \(kind) · \(app.status.rawValue)"
  }

  private func resolvedIdentity(_ app: DesignApp) -> String? {
    if let detail = selectedRoute?.detail, !detail.isEmpty,
      !detail.hasPrefix("Login managed"), !detail.hasPrefix("Direct")
    {
      return detail
    }
    if app.detail.hasPrefix("Signed in as ") {
      return String(app.detail.dropFirst("Signed in as ".count))
    }
    if app.detail.hasPrefix("Uses ") {
      let rest = String(app.detail.dropFirst("Uses ".count))
      if let atIndex = rest.range(of: " · ") {
        return String(rest[atIndex.upperBound...])
      }
    }
    return nil
  }

  private func selectedName(_ app: DesignApp) -> String {
    if let selected = app.routeOptions.first(where: { $0.id == app.selectedRouteID })?.name {
      return selected
    }
    if app.detail.hasPrefix("Signed in as ") {
      return "Direct Login"
    }
    if app.detail.hasPrefix("Uses ") {
      let rest = String(app.detail.dropFirst("Uses ".count))
      if let atIndex = rest.range(of: " · ") {
        return String(rest[..<atIndex.lowerBound])
      }
      return rest
    }
    if app.detail == "Current login" || isAppRouteConfigured(app) || app.status == .ready {
      return "Current login"
    }
    return "Not selected"
  }

  private func defaultModel(_ app: DesignApp) -> String {
    let raw = app.modelRoles.first(where: { $0.id == "default" })?.modelID ?? app.reasoningModel
    return cleanModelDisplayName(raw)
  }

  private func overrideSummary(_ app: DesignApp) -> String {
    let roles = app.modelRoles.filter { $0.id != "default" }
    guard !roles.isEmpty else { return "Same as Default" }
    return roles.map { role in
      let clean = role.modelID.isEmpty ? "Same as Default" : cleanModelDisplayName(role.modelID)
      return "\(role.label): \(clean)"
    }.joined(separator: " · ")
  }

  private func quickPanelBinding(_ app: DesignApp) -> Binding<Bool> {
    Binding(
      get: { model.apps.first(where: { $0.id == app.id })?.showInQuickPanel ?? true },
      set: { model.setQuickPanelShown(appID: app.id, shows: $0) }
    )
  }

  private func usageRow(_ window: DesignUsageWindow, grouped: Bool) -> some View {
    Group {
      if grouped {
        DesignQuotaView(window: window, showsLimitCard: true)
      } else {
        LabeledContent(quotaWindowLabel(window)) {
          DesignQuotaView(window: window, isCompact: false, showsLabel: false)
        }
      }
    }
    .accessibilityIdentifier("app.usage.\(window.id)")
  }
}
