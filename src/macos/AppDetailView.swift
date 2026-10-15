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
          title: model.localized("desktop.app_detail.disconnect_anypick"),
          enabled: !model.isBusy,
          destructive: true,
          identifier: "app.reset"
        ) { requestReset() }
      }
      DesignSheetButton(
        title: model.localized("desktop.app_detail.remove_app"),
        enabled: !model.isBusy,
        destructive: true,
        identifier: "app.remove"
      ) { requestRemoval() }
    }
  }

  private func requestReset() {
    confirmation = DesignConfirmation(
      id: "disconnect-app",
      title: model.localized("desktop.app_detail.disconnect_title", replacing: ["app": app?.name ?? model.localized("desktop.app_detail.app")]),
      message:
        model.localized("desktop.app_detail.disconnect_message"),
      action: .confirm(model.localized("desktop.app_detail.disconnect")) { model.resetAppConfiguration(appID: appID) }
    )
  }

  private func requestRemoval() {
    confirmation = DesignConfirmation(
      id: "remove-app",
      title: model.localized("desktop.app_detail.remove_title", replacing: ["app": app?.name ?? model.localized("desktop.app_detail.app")]),
      message:
        model.localized("desktop.app_detail.remove_message", replacing: ["app": app?.name ?? model.localized("desktop.app_detail.the_app")]),
      action: .confirm(model.localized("desktop.app_detail.remove_app")) {
        model.removeApp(appID: appID)
        dismiss()
      }
    )
  }

  private func requestProfileRemoval(_ name: String) {
    confirmation = DesignConfirmation(
      id: "remove-codex-profile",
      title: model.localized("desktop.app_detail.remove_profile_title", replacing: ["name": name]),
      message:
        model.localized("desktop.app_detail.remove_profile_message"),
      action: .confirm(model.localized("desktop.common.remove")) { model.removeCodexProfile(name: name) }
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

        if let issue = app.issue(using: model) {
          Section {
            Label {
              VStack(alignment: .leading, spacing: 2) {
                Text(model.localized("desktop.common.needs_attention"))
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
          LabeledContent(model.localized("desktop.app_detail.uses"), value: selectedName(app))
          if let identity = resolvedIdentity(app), !identity.isEmpty {
            LabeledContent(model.localized("desktop.account_detail.identity"), value: identity)
          }
          LabeledContent(model.localized("desktop.app_detail.transport"), value: transportDisplayName(for: app, using: model))
          LabeledContent(model.localized("desktop.app_detail.connection")) {
            HStack(spacing: 8) {
              Button(model.localized(isAppRouteConfigured(app) ? "desktop.app_detail.change" : "desktop.app_detail.connect")) { showingRoutes = true }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help(model.localized(isAppRouteConfigured(app) ? "desktop.app_detail.change_help" : "desktop.app_detail.connect_help"))
                .disabled(model.isBusy || app.routeOptions.isEmpty)
              if isAppManagedByAnyPick(app) {
                Button(model.localized("desktop.app_detail.disconnect_action"), role: .destructive) { requestReset() }
                  .buttonStyle(.bordered)
                  .controlSize(.small)
                  .help(model.localized("desktop.app_detail.disconnect_help"))
                  .disabled(model.isBusy)
                  .accessibilityIdentifier("app.connection.disconnect")
              }
            }
          }
          .accessibilityIdentifier("app.connection.change")
        } header: {
          Text(model.localized("desktop.app_detail.connection"))
        }

        Section {
          Toggle(model.localized("desktop.app_detail.show_quick_panel"), isOn: quickPanelBinding(app))
            .disabled(model.isBusy)
        } footer: {
          Text(model.localized("desktop.app_detail.quick_panel_help"))
        }

        if showsModelConfiguration {
          Section {
            LabeledContent(model.localized("desktop.app_detail.default"), value: defaultModel(app))
            LabeledContent(model.localized("desktop.app_detail.overrides"), value: overrideSummary(app))
            LabeledContent(model.localized("desktop.app_detail.manage_models")) {
              Button(model.localized("desktop.app_detail.manage")) { showingModels = true }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help(model.localized("desktop.app_detail.manage_models_help"))
                .disabled(!app.modelEditingAvailable || model.isBusy)
            }
            .accessibilityIdentifier("app.models.manage")
          } header: {
            Text(model.localized("desktop.app_detail.models"))
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
                  ? model.localized("desktop.app_detail.add_source_for_profile")
                  : model.localized("desktop.app_detail.no_profiles")
              )
                .foregroundStyle(.secondary)
            } else {
              ForEach(model.codexProfiles) { profile in
                codexProfileRow(profile)
              }
            }
          } header: {
            Text(model.localized("desktop.app_detail.codex_profiles"))
          } footer: {
            Text(model.localized("desktop.app_detail.profile_detail"))
          }

          Section {
            Toggle(
              model.localized("desktop.app_detail.create_profiles_automatically"),
              isOn: automaticCodexProfileCreationBinding
            )
            .disabled(model.isBusy)
            if !missingCodexProfileSources.isEmpty {
              Button(model.localized("desktop.app_detail.create_missing_profiles"), systemImage: "person.crop.circle.badge.plus") {
                _ = model.createMissingCodexProfiles(
                  sourceIDs: missingCodexProfileSources.map(\.sourceID))
              }
              .help(model.localized("desktop.app_detail.create_missing_profiles_help"))
              .disabled(model.isBusy)
              .accessibilityIdentifier("codex-profile.create-missing")
            }
          } header: {
            Text(model.localized("desktop.app_detail.automation"))
          } footer: {
            Text(model.localized("desktop.app_detail.automation_help"))
          }
        }

        if model.showUsage, !app.usageWindows.isEmpty {
          ForEach(groupUsageWindows(app.usageWindows)) { group in
            Section {
              ForEach(group.windows) { window in
                usageRow(window, grouped: group.title != nil)
              }
            } header: {
              Text(group.title ?? model.localized("desktop.settings.usage"))
            }
          }
        } else if model.showUsage, isAppRouteConfigured(app) {
          Section {
            Text(model.localized("desktop.app_detail.login_no_usage"))
              .foregroundStyle(.secondary)
          } header: {
            Text(model.localized("desktop.settings.usage"))
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
          Button(model.localized("desktop.app_detail.add_profile"), systemImage: "plus", action: addCodexProfile)
            .help(model.localized("desktop.app_detail.add_profile_help"))
            .disabled(model.isBusy || model.codexProfileSources.isEmpty)
            .accessibilityIdentifier("codex-profile.add")
        }
      }
    }
    .onDisappear { copyFeedbackTask?.cancel() }
    .navigationTitle(app?.name ?? model.localized("desktop.app_detail.app"))
    .designConfirmation($confirmation, model: model)
  }

  private func codexProfileSummary(_ profile: DesignCodexProfile) -> String {
    let modelName = profile.modelID.isEmpty ? model.localized("desktop.app_detail.source_default") : cleanModelDisplayName(profile.modelID)
    let transport = switch profile.transportPolicy {
    case "direct": model.localized("desktop.app_detail.direct")
    case "proxy": model.localized("desktop.app_detail.proxy")
    default: model.localized("desktop.app_detail.automatic")
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
        label: model.localized("desktop.app_detail.copy_launch_command", replacing: ["name": profile.name]),
        copiedLabel: model.localized("desktop.common.copied_to_clipboard"),
        identifier: "codex-profile.copy.\(profile.name)"
      ) {
        copyCodexProfileCommand(profile)
      }
      .disabled(model.isBusy || profile.launchCommand.isEmpty)

      DesignMoreActionsMenu(
        label: model.localized("desktop.app_detail.actions_for", replacing: ["name": profile.name]),
        identifier: "codex-profile.more.\(profile.name)",
        isDisabled: model.isBusy
      ) {
        Button(model.localized("desktop.app_detail.edit_profile"), systemImage: "slider.horizontal.3") {
          editingCodexProfile = profile
          showingCodexProfileSheet = true
        }
        .help(model.localized("desktop.app_detail.edit_profile_help"))
        Button(model.localized("desktop.app_detail.remove_profile"), systemImage: "trash", role: .destructive) {
          requestProfileRemoval(profile.name)
        }
        .help(model.localized("desktop.app_detail.remove_profile_help"))
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
      return "\(model.localized("desktop.nav.proxy_hub")) · \(app.status.localizedLabel(using: model))"
    }
    let provider = selectedRoute?.providerID.map(nativeProviderName) ?? nativeProviderName(app.id)
    let kind = selectedRoute?.kind == .gateway ? model.localized("desktop.account_detail.api_gateway") : model.localized("desktop.account_detail.account")
    return "\(provider) \(kind) · \(app.status.localizedLabel(using: model))"
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
      return model.localized("desktop.app_detail.direct_login")
    }
    if app.detail.hasPrefix("Uses ") {
      let rest = String(app.detail.dropFirst("Uses ".count))
      if let atIndex = rest.range(of: " · ") {
        return String(rest[..<atIndex.lowerBound])
      }
      return rest
    }
    if app.detail == "Current login" || isAppRouteConfigured(app) || app.status == .ready {
      return model.localized("desktop.app_detail.current_login")
    }
    return model.localized("desktop.app_detail.not_selected")
  }

  private func defaultModel(_ app: DesignApp) -> String {
    let raw = app.modelRoles.first(where: { $0.id == "default" })?.modelID ?? app.reasoningModel
    return cleanModelDisplayName(raw)
  }

  private func overrideSummary(_ app: DesignApp) -> String {
    let roles = app.modelRoles.filter { $0.id != "default" }
    guard !roles.isEmpty else { return model.localized("desktop.app_detail.same_as_default") }
    return roles.map { role in
      let clean = role.modelID.isEmpty ? model.localized("desktop.app_detail.same_as_default") : cleanModelDisplayName(role.modelID)
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
        DesignQuotaView(model: model, window: window, showsLimitCard: true)
      } else {
        LabeledContent(localizedQuotaWindowLabel(window, using: model)) {
          DesignQuotaView(model: model, window: window, isCompact: false, showsLabel: false)
        }
      }
    }
    .accessibilityIdentifier("app.usage.\(window.id)")
  }
}
