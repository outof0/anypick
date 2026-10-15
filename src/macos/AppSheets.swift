import SwiftUI

/// Where a model save lands: this connection's pins, or the provider default
/// shared by every account of the provider.
enum ModelRoleScope: String, CaseIterable, Identifiable {
  case connection
  case provider

  var id: String { rawValue }

}

enum ModelRolesProvenance {
  /// Per-connection pins (or legacy pins without a marker).
  case custom
  /// The provider default (no pins of its own).
  case inherited
  /// Nothing pinned anywhere; the engine default applies.
  case none
}

/// Provider display for the scope picker, or nil when the current route
/// names no family (then the sheet stays connection-scoped like before).
func modelScopeProviderName(app: DesignApp?, model: MacOSDesignModel) -> String? {
  guard let app,
    let route = app.routeOptions.first(where: { $0.id == app.selectedRouteID })
  else { return nil }
  switch route.kind {
  case .hub:
    return "Proxy Hub"
  case .gateway:
    return route.name.isEmpty ? nil : route.name
  default:
    guard let provider = route.providerID, !provider.isEmpty else { return nil }
    return nativeProviderName(provider)
  }
}

@MainActor
func modelProvenanceCaption(
  provenance: ModelRolesProvenance,
  providerName: String?,
  model: MacOSDesignModel
) -> String {
  switch provenance {
  case .custom:
    return model.localized("desktop.models.custom_for_connection")
  case .inherited:
    if let providerName {
      return model.localized("desktop.models.using_provider_default", replacing: ["provider": providerName])
    }
    return model.localized("desktop.models.using_shared_default")
  case .none:
    return model.localized("desktop.models.none_pinned")
  }
}

/// Scope picker shared by the Models sheet and the connection-flow model
/// step. The provider row names the account family the default covers.
struct ModelScopePicker: View {
  @Binding var scope: ModelRoleScope
  var providerName: String
  @ObservedObject var model: MacOSDesignModel

  var body: some View {
    Picker(model.localized("desktop.models.applies_to"), selection: $scope) {
      Text(model.localized("desktop.models.this_connection")).tag(ModelRoleScope.connection)
      Text(model.localized("desktop.models.all_provider_accounts", replacing: ["provider": providerName])).tag(ModelRoleScope.provider)
    }
    .pickerStyle(.segmented)
    .labelsHidden()
    .accessibilityIdentifier("models.scope")
  }
}

/// Model options are published per connection, so the connection sheet can
/// only offer a picker for the route that is live right now — never for one
/// the user has merely selected. Without options, or without roles to fill,
/// a picker would be a dead control.
func appRouteOffersModelStep(_ app: DesignApp) -> Bool {
  app.modelEditingAvailable && !app.modelOptions.isEmpty && !app.modelRoles.isEmpty
}

/// Whether the sheet should nudge the user into the picker: an app that
/// already has a default model pinned must not be forced through it to
/// finish.


struct AppRouteSheet: View {
  private enum Stage {
    case connection
    case models
    case review
    case applying
    case success
    case recovery
  }

  @ObservedObject var model: MacOSDesignModel
  let appID: String
  @Environment(\.dismiss) private var dismiss
  @State private var routeID = ""
  @State private var routeSearch = ""
  @State private var stage: Stage = .connection
  @State private var modelValues: [String: String] = [:]
  @State private var modelScope: ModelRoleScope = .connection
  @State private var modelSaveError: String?
  @State private var awaitingModelSave = false

  private var app: DesignApp? { model.apps.first { $0.id == appID } }

  private var showsModelStep: Bool { app.map(appRouteOffersModelStep) ?? false }

  private var needsModelChoice: Bool {
    model.appRouteNeedsModelChoice(appID: appID)
  }

  private var accountRoutes: [DesignRoute] {
    guard let app else { return [] }
    return compatibleAccountRoutes(in: app)
  }

  private var hubRoute: DesignRoute? {
    app?.routeOptions.first { $0.kind == .hub }
  }

  private var gatewayRoutes: [DesignRoute] {
    app?.routeOptions.filter { $0.kind == .gateway } ?? []
  }

  private var connectionRoutes: [DesignRoute] {
    accountRoutes + [hubRoute].compactMap { $0 } + gatewayRoutes
  }

  private var showsConnectionSearch: Bool {
    connectionRoutes.count > 6
  }

  private var normalizedRouteSearch: String {
    routeSearch.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func matchesRouteSearch(_ route: DesignRoute) -> Bool {
    let query = normalizedRouteSearch
    guard !query.isEmpty else { return true }
    return [route.name, route.detail, route.providerID ?? ""]
      .contains { $0.localizedCaseInsensitiveContains(query) }
  }

  private var filteredAccountRoutes: [DesignRoute] {
    accountRoutes.filter { $0.id != currentRoute?.id && matchesRouteSearch($0) }
  }

  private var filteredHubRoute: DesignRoute? {
    guard let hubRoute, hubRoute.id != currentRoute?.id, matchesRouteSearch(hubRoute) else {
      return nil
    }
    return hubRoute
  }

  private var filteredGatewayRoutes: [DesignRoute] {
    gatewayRoutes.filter { $0.id != currentRoute?.id && matchesRouteSearch($0) }
  }

  private var hasMatchingConnection: Bool {
    !filteredAccountRoutes.isEmpty || filteredHubRoute != nil || !filteredGatewayRoutes.isEmpty
  }

  private var selectedRoute: DesignRoute? {
    app?.routeOptions.first { $0.id == routeID }
  }

  private var currentRoute: DesignRoute? {
    app?.routeOptions.first { $0.id == app?.selectedRouteID }
  }

  private var routeApplyError: String? {
    guard stage == .review, model.feedback?.kind == .error else { return nil }
    return model.feedback?.message
  }

  private var primaryTitle: String {
    switch stage {
    case .connection: model.localized("desktop.app_route.review_change")
    case .models: model.localized("desktop.app_route.save_models")
    case .review: model.localized("desktop.app_route.apply_changes")
    case .applying: model.localized("desktop.app_route.applying")
    case .success: needsModelChoice ? model.localized("desktop.app_route.choose_models") : model.localized("desktop.app_route.done")
    case .recovery: model.localized("desktop.common.try_again")
    }
  }

  var body: some View {
    DesignSheetHost(
      model: model,
      title: app.map { model.localized("desktop.app_route.change_title", replacing: ["app": $0.name]) } ?? model.localized("desktop.app_route.choose_connection"),
      width: 480,
      primaryTitle: primaryTitle,
      primaryDisabled: routeID.isEmpty
        || (stage == .connection && routeID == app?.selectedRouteID)
        || model.isBusy || stage == .applying || awaitingModelSave,
      primaryIdentifier: "app-route.primary.\(stageIdentifier)",
      showsCancel: stage != .applying && stage != .success,
      onCancel: { dismiss() },
      onPrimary: advance
    ) {
      Form {
        switch stage {
        case .connection:
          connectionForm
        case .models:
          modelForm
        case .review:
          reviewForm
        case .applying:
          applyingForm
        case .success:
          resultForm(succeeded: true)
        case .recovery:
          resultForm(succeeded: false)
        }
      }
      .accessibilityIdentifier("app-route.stage.\(stageIdentifier)")
      .onAppear {
        routeID = app?.selectedRouteID ?? ""
        routeSearch = ""
      }
      .onChange(of: model.switchPhase) { _, phase in
        switch phase {
        case .success(let id, _) where id == appID:
          stage = .success
        case .recovery(let id, _, _, _) where id == appID:
          stage = .recovery
        default:
          break
        }
      }
      .onChange(of: model.operationResult) { _, result in
        guard awaitingModelSave, result?.operation == "app-model-roles" else { return }
        awaitingModelSave = false
        if result?.succeeded == true {
          dismiss()
        } else if let message = result?.message, !message.isEmpty {
          modelSaveError = message
        } else {
          modelSaveError = model.localized("desktop.models.save_error")
        }
      }
    }
  }

  @ViewBuilder
  private var connectionForm: some View {
    if showsConnectionSearch {
      Section {
        TextField(model.localized("desktop.app_route.search_connections"), text: $routeSearch)
          .accessibilityIdentifier("app-route.search")
      }
    }

    if let currentRoute {
      Section {
        connectionOptionRow(currentRoute, isCurrent: true)
      } header: {
        Text(model.localized("desktop.app_route.current_connection"))
      } footer: {
        Text(model.localized("desktop.app_route.choose_source_help"))
      }
    }

    if !filteredAccountRoutes.isEmpty {
      Section {
        ForEach(filteredAccountRoutes) { route in
          connectionOptionRow(route)
        }
      } header: {
        Text(model.localized("desktop.nav.accounts"))
      }
    }

    if let hub = filteredHubRoute {
      Section {
        connectionOptionRow(hub)
      } header: {
        Text(model.localized("desktop.nav.proxy_hub"))
      }
    }

    if !filteredGatewayRoutes.isEmpty {
      Section {
        ForEach(filteredGatewayRoutes) { route in
          connectionOptionRow(route)
        }
      } header: {
        Text(model.localized("desktop.accounts.api_gateways"))
      }
    }

    if !hasMatchingConnection {
      Section {
        Text(connectionRoutes.isEmpty
          ? model.localized("desktop.app_route.no_compatible_connections")
          : normalizedRouteSearch.isEmpty
            ? model.localized("desktop.app_route.no_other_connections")
            : model.localized("desktop.app_route.no_matching_connections", replacing: ["query": normalizedRouteSearch]))
          .foregroundStyle(.secondary)
      }
    }
  }

  private func connectionOptionRow(_ route: DesignRoute, isCurrent: Bool = false) -> some View {
    let isSelected = route.id == routeID
    let spokenState = [
      isCurrent ? model.localized("desktop.app_route.current_connection") : "",
      isSelected ? model.localized("desktop.app_route.selected") : "",
    ].filter { !$0.isEmpty }.joined(separator: ", ")

    return Button {
      routeID = route.id
    } label: {
      HStack(spacing: 10) {
        connectionIcon(for: route)
          .frame(width: 22, height: 22)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(route.name)
            .foregroundStyle(.primary)
          if !route.detail.isEmpty {
            Text(route.detail)
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .lineLimit(1)
              .truncationMode(.middle)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if isCurrent {
          Text(model.localized("desktop.common.current"))
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize()
        }
        if isSelected {
          Image(systemName: "checkmark")
            .font(.body.weight(.semibold))
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }
      }
      .contentShape(Rectangle())
    }
    .help(isCurrent ? model.localized("desktop.app_route.keep_current_help") : model.localized("desktop.app_route.use_connection_help", replacing: ["route": route.name]))
    .buttonStyle(.plain)
    .disabled(model.isBusy)
    .accessibilityLabel(route.detail.isEmpty ? route.name : "\(route.name), \(route.detail)")
    .accessibilityValue(spokenState)
    .accessibilityHint(isCurrent ? model.localized("desktop.app_route.current_hint") : model.localized("desktop.app_route.select_hint"))
    .accessibilityIdentifier("app-route.option.\(route.id)")
  }

  @ViewBuilder
  private func connectionIcon(for route: DesignRoute) -> some View {
    if route.kind == .hub {
      Image(systemName: route.symbol.isEmpty ? DesignDestination.proxyHub.symbol : route.symbol)
        .foregroundStyle(.secondary)
    } else {
      DesignProviderIcon(
        provider: model.providerID(forRoute: route),
        fallbackSymbol: route.symbol,
        size: 20
      )
    }
  }

  /// The editable model step. It runs after the connection is live because
  /// the catalog is per-connection: options published for the previous route
  /// would let the user pick a model the new one cannot serve.
  @ViewBuilder
  private var modelForm: some View {
    if let app {
      Section {
        if let providerName = modelScopeProviderName(app: app, model: model) {
          ModelScopePicker(scope: $modelScope, providerName: providerName, model: model)
        }
        ForEach(app.modelRoles) { role in
          Picker(
            role.label,
            selection: Binding(
              get: { modelValues[role.id] ?? role.modelID },
              set: { modelValues[role.id] = $0 }
            )
          ) {
            if role.id != "default" { Text(model.localized("desktop.app_detail.same_as_default")).tag("") }
            ForEach(app.modelOptions, id: \.self) { Text(cleanModelDisplayName($0)).tag($0) }
          }
        }
      } header: {
        Text(model.localized("desktop.app_detail.models"))
      } footer: {
        Text(
          model.localized("desktop.app_route.models_published_by", replacing: ["route": selectedRoute?.name ?? model.localized("desktop.app_route.current_connection")]) + " " +
            modelProvenanceCaption(
              provenance: model.modelRolesProvenance(appID: appID),
              providerName: modelScopeProviderName(app: app, model: model),
              model: model)
        )
      }
    }
    if let modelSaveError {
      Section {
        Label {
          Text(modelSaveError)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        } icon: {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(.orange)
        }
        .accessibilityIdentifier("app-route.models.error")
      }
    }
  }

  @ViewBuilder
  private var reviewForm: some View {
    Section(model.localized("desktop.app_detail.connection")) {
      LabeledContent(model.localized("desktop.app_route.from"), value: currentRoute?.name ?? model.localized("desktop.app_detail.not_selected"))
      LabeledContent(model.localized("desktop.app_route.to"), value: selectedRoute?.name ?? model.localized("desktop.app_detail.not_selected"))
    }
    Section(model.localized("desktop.app_route.anypick_will")) {
      Label(model.localized("desktop.app_route.backup_settings"), systemImage: "externaldrive.badge.timemachine")
        .symbolRenderingMode(.hierarchical)
      Label(model.localized("desktop.app_route.start_proxy"), systemImage: "server.rack")
        .symbolRenderingMode(.hierarchical)
      Label(model.localized("desktop.app_route.write_settings"), systemImage: "checkmark.shield")
        .symbolRenderingMode(.hierarchical)
    }
    Section {
      Text(model.localized("desktop.app_route.models_preserved"))
        .foregroundStyle(.secondary)
    }
    if let routeApplyError {
      Section {
        Label {
          Text(routeApplyError)
        } icon: {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(.orange)
        }
      }
      .accessibilityIdentifier("app-route.apply-error")
    }
  }

  @ViewBuilder
  private var applyingForm: some View {
    Section {
      HStack(spacing: 12) {
        ProgressView()
          .controlSize(.small)
        VStack(alignment: .leading, spacing: 2) {
          Text(model.localized("desktop.app_route.applying"))
          Text(model.localized("desktop.app_route.keep_open_help"))
            .foregroundStyle(.secondary)
        }
      }
    }
  }

  @ViewBuilder
  private func resultForm(succeeded: Bool) -> some View {
    Section {
      Label {
        VStack(alignment: .leading, spacing: 2) {
          Text(model.localized(succeeded ? "desktop.app_route.connection_updated" : "desktop.app_route.previous_settings_restored"))
          Text(
            succeeded
              ? model.localized("desktop.app_route.now_uses", replacing: ["app": app?.name ?? model.localized("desktop.app_detail.app"), "route": selectedRoute?.name ?? model.localized("desktop.app_route.selected_connection")])
              : model.localized("desktop.app_route.apply_failed", replacing: ["route": currentRoute?.name ?? model.localized("desktop.app_route.previous_connection")])
          )
          .foregroundStyle(.secondary)
        }
      } icon: {
        Image(systemName: succeeded ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
          .foregroundStyle(succeeded ? Color.green : Color.orange)
      }
    }
    if !succeeded {
      Section {
        Text(model.localized("desktop.app_route.recovery_help"))
          .foregroundStyle(.secondary)
      }
    }
  }

  private var stageIdentifier: String {
    switch stage {
    case .connection: "connection"
    case .models: "models"
    case .review: "review"
    case .applying: "applying"
    case .success: "success"
    case .recovery: "recovery"
    }
  }

  private func advance() {
    switch stage {
    case .connection:
      stage = .review
    case .review:
      guard routeID != app?.selectedRouteID else {
        // Nothing to switch: this is a "change the model on the current
        // connection" run, so go straight to the picker when it exists.
        if showsModelStep {
          seedModelValues()
          stage = .models
        } else {
          dismiss()
        }
        return
      }
      guard model.setRoute(appID: appID, routeID: routeID) else { return }
      stage = .applying
    case .success:
      if showsModelStep {
        seedModelValues()
        stage = .models
      } else {
        dismiss()
      }
    case .models:
      saveModels()
    case .applying:
      break
    case .recovery:
      stage = .review
    }
  }

  private func seedModelValues() {
    modelSaveError = nil
    modelValues = model.effectiveModelRoles(appID: appID)
    modelScope = model.modelRolesProvenance(appID: appID) == .custom
      || modelScopeProviderName(app: app, model: model) == nil
      ? .connection : .provider
  }

  private func saveModels() {
    guard let app else { return }
    guard !model.isBusy else {
          modelSaveError = model.localized("desktop.models.change_in_progress")
      return
    }
    modelSaveError = nil
    if model.updateAppModelRoles(
      appID: appID,
      routeID: app.selectedRouteID,
      modelRoles: modelValues,
      scope: modelScope
    ) {
      if model.isProduction {
        awaitingModelSave = true
      } else {
        dismiss()
      }
    } else {
      modelSaveError = model.localized("desktop.models.change_in_progress")
    }
  }
}

struct AppModelsSheet: View {
  @ObservedObject var model: MacOSDesignModel
  let appID: String
  @Environment(\.dismiss) private var dismiss
  @State private var values = [String: String]()
  @State private var scope: ModelRoleScope = .connection
  /// Production save waits for the engine result instead of dismissing on
  /// accept: failures keep field context with the error inline.
  @State private var awaitingSaveResult = false
  @State private var saveError: String?

  private var app: DesignApp? { model.apps.first { $0.id == appID } }

  private var provenance: ModelRolesProvenance { model.modelRolesProvenance(appID: appID) }

  private var providerName: String? { modelScopeProviderName(app: app, model: model) }

  var body: some View {
    DesignSheetHost(
      model: model,
      title: app.map { model.localized("desktop.models.title_for_app", replacing: ["app": $0.name]) } ?? model.localized("desktop.app_detail.models"),
      width: 480,
      primaryTitle: model.localized("desktop.common.save"),
      primaryDisabled: values["default", default: ""].isEmpty || model.isBusy
        || awaitingSaveResult,
      onCancel: { dismiss() },
      onPrimary: save
    ) {
      Form {
        if let app {
          Section {
            if providerName != nil {
              ModelScopePicker(scope: $scope, providerName: providerName ?? "", model: model)
            }
            ForEach(app.modelRoles) { role in
              Picker(
                role.id == "default" ? model.localized("desktop.app_detail.default") : role.label,
                selection: Binding(
                  get: { values[role.id] ?? role.modelID },
                  set: { values[role.id] = $0 }
                )
              ) {
                if role.id != "default" { Text(model.localized("desktop.app_detail.same_as_default")).tag("") }
                ForEach(app.modelOptions, id: \.self) { Text(cleanModelDisplayName($0)).tag($0) }
              }
            }
            LabeledContent(model.localized("desktop.models.available")) {
              Button(model.localized("desktop.common.refresh")) { model.refreshAppModels(appID: appID) }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(model.isBusy)
                .help(model.localized("desktop.models.refresh_help"))
                .accessibilityIdentifier("app.models.refresh")
            }
            if provenance == .custom, let providerName {
              LabeledContent(model.localized("desktop.models.customization")) {
                Button(model.localized("desktop.models.use_provider_default", replacing: ["provider": providerName]), role: .destructive) { reset() }
                  .buttonStyle(.bordered)
                  .controlSize(.small)
                  .disabled(model.isBusy || awaitingSaveResult)
                  .help(model.localized("desktop.models.reset_help"))
                  .accessibilityIdentifier("app.models.reset")
              }
            }
          } header: {
            Text(model.localized("desktop.app_detail.models"))
          } footer: {
            Text(
              model.localized("desktop.models.changing_does_not_switch") + " " +
                modelProvenanceCaption(provenance: provenance, providerName: providerName, model: model)
            )
          }
        }
        if let saveError {
          Section {
            Label {
              Text(saveError)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            } icon: {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            }
            .accessibilityIdentifier("app-models.error")
          }
        }
      }
      .onAppear(perform: hydrate)
      .onChange(of: model.operationResult) { _, result in
        guard awaitingSaveResult, result?.operation == "app-model-roles" else { return }
        awaitingSaveResult = false
        if result?.succeeded == true {
          dismiss()
        } else if let message = result?.message, !message.isEmpty {
          saveError = message
        } else {
          saveError = model.localized("desktop.models.save_error")
        }
      }
    }
  }

  private func hydrate() {
    values = model.effectiveModelRoles(appID: appID)
    // Customized connections keep editing their own pins; otherwise the
    // sheet edits the shared default (provider known) or the connection.
    scope = model.modelRolesProvenance(appID: appID) == .custom || providerName == nil
      ? .connection : .provider
  }

  private func save() {
    saveRoles(values, scope: scope)
  }

  private func reset() {
    saveRoles([:], scope: .connection)
  }

  private func saveRoles(_ roles: [String: String], scope: ModelRoleScope) {
    guard let app else { return }
    saveError = nil
    // applyModelRoles refuses while another mutation is in flight and the
    // void return cannot say so — the disabled primary covers the steady
    // state, this covers the race.
    guard !model.isBusy else { return }
    if model.isProduction {
      // Dismissal waits for the engine result; the fixture answers
      // synchronously and dismisses at once below.
      if model.updateAppModelRoles(
        appID: appID,
        routeID: app.selectedRouteID,
        modelRoles: roles,
        scope: scope
      ) {
        awaitingSaveResult = true
      } else {
        saveError = model.localized("desktop.models.change_in_progress")
      }
      return
    }
    if model.updateAppModelRoles(
      appID: appID,
      routeID: app.selectedRouteID,
      modelRoles: roles,
      scope: scope
    ) {
      dismiss()
    }
  }
}

struct AddAppSheet: View {
  @ObservedObject var model: MacOSDesignModel
  @Environment(\.dismiss) private var dismiss
  @State private var selectedAppID = ""

  private var availableApps: [DesignApp] {
    model.availableAppsToAdd
  }

  var body: some View {
    DesignSheetHost(
      model: model,
      title: model.localized("desktop.apps.add_coding_app"),
      width: 480,
      primaryTitle: model.localized("desktop.apps.add_app"),
      primaryDisabled: selectedAppID.isEmpty,
      primaryIdentifier: "app.add.primary",
      showsCancel: true,
      onCancel: { dismiss() },
      onPrimary: {
        guard !selectedAppID.isEmpty else { return }
        model.addApp(appID: selectedAppID)
        dismiss()
      }
    ) {
      Form {
        if availableApps.isEmpty {
          Section {
            Text(model.localized("desktop.apps.all_supported_added"))
              .foregroundStyle(.secondary)
          }
        } else {
          Section {
            Picker(model.localized("desktop.apps.coding_app"), selection: $selectedAppID) {
              ForEach(availableApps) { app in
                Label {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(app.name)
                      .font(.body)
                    Text(appShortDescription(app.id, using: model))
                      .font(.caption)
                      .foregroundStyle(.secondary)
                  }
                } icon: {
                  DesignProviderIcon(
                    provider: app.id,
                    fallbackSymbol: app.symbol,
                    size: 20
                  )
                }
                .tag(app.id)
              }
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()
            .accessibilityIdentifier("app.add.picker")
          } header: {
            Text(model.localized("desktop.apps.supported_tools"))
          } footer: {
            Text(model.localized("desktop.apps.add_app_help"))
          }
        }
      }
      .onAppear {
        if let first = availableApps.first {
          selectedAppID = first.id
        }
      }
    }
  }
}

struct CodexProfileSheet: View {
  @ObservedObject var model: MacOSDesignModel
  let profile: DesignCodexProfile?
  @Environment(\.dismiss) private var dismiss
  @State private var name: String
  @State private var sourceID: String
  @State private var modelID: String
  @State private var transportPolicy: String
  @State private var awaitingSave = false
  @State private var saveError: String?

  init(model: MacOSDesignModel, profile: DesignCodexProfile? = nil) {
    self.model = model
    self.profile = profile
    _name = State(initialValue: profile?.name ?? "")
    _sourceID = State(initialValue: profile?.sourceID ?? "")
    _modelID = State(initialValue: profile?.modelID ?? "")
    _transportPolicy = State(initialValue: profile?.transportPolicy ?? "auto")
  }

  private var selectedSource: DesignCodexProfileSource? {
    model.codexProfileSources.first { $0.sourceID == sourceID }
  }

  private var nameAlreadyExists: Bool {
    model.codexProfiles.contains { $0.name == name && $0.name != profile?.name }
  }

  private var invalidName: Bool {
    !name.isEmpty && !validCodexProfileName(name)
  }

  private var canSave: Bool {
    validCodexProfileName(name)
      && selectedSource != nil
      && !nameAlreadyExists
      && !model.isBusy
      && !awaitingSave
  }

  var body: some View {
    DesignSheetHost(
      model: model,
      title: model.localized(profile == nil ? "desktop.codex_profile.add_title" : "desktop.codex_profile.edit_title"),
      width: 480,
      primaryTitle: model.localized(awaitingSave ? "desktop.codex_profile.saving" : (profile == nil ? "desktop.app_detail.add_profile" : "desktop.codex_profile.save_changes")),
      primaryDisabled: !canSave,
      primaryIdentifier: "codex-profile.save",
      onCancel: { dismiss() },
      onPrimary: save
    ) {
      Form {
        Section {
          if profile == nil {
            TextField(model.localized("desktop.account_detail.name"), text: $name)
              .autocorrectionDisabled()
              .accessibilityIdentifier("codex-profile.name")
            Text(model.localized("desktop.codex_profile.name_rules"))
              .font(.footnote)
              .foregroundStyle(.secondary)
            if invalidName {
              Label(
                model.localized("desktop.codex_profile.name_rules"),
                systemImage: "exclamationmark.triangle"
              )
              .font(.footnote)
              .foregroundStyle(.red)
            } else if nameAlreadyExists {
              Label(model.localized("desktop.codex_profile.name_exists"), systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.red)
            }
          } else {
            LabeledContent(model.localized("desktop.account_detail.name"), value: name)
          }
        } header: {
          Text(model.localized("desktop.codex_profile.profile"))
        } footer: {
          if profile != nil {
            Text(model.localized("desktop.codex_profile.name_immutable"))
          }
        }

        Section {
          Picker(model.localized("desktop.codex_profile.account_or_route"), selection: $sourceID) {
            ForEach(model.codexProfileSources) { source in
              VStack(alignment: .leading, spacing: 2) {
                Text(source.label)
                if !source.detail.isEmpty {
                  Text(source.detail).foregroundStyle(.secondary)
                }
              }
              .tag(source.sourceID)
            }
          }
          .accessibilityIdentifier("codex-profile.source")
        } header: {
          Text(model.localized("desktop.app_detail.connection"))
        }

        Section {
          Picker(model.localized("desktop.app_detail.models"), selection: $modelID) {
            Text(model.localized("desktop.app_detail.source_default")).tag("")
            ForEach(selectedSource?.models ?? [], id: \.self) { model in
              Text(cleanModelDisplayName(model))
                .tag(model)
                .help(model)
            }
          }
          .accessibilityIdentifier("codex-profile.model")
          Picker(model.localized("desktop.codex_profile.transport"), selection: $transportPolicy) {
            Text(model.localized("desktop.app_detail.automatic")).tag("auto")
            Text(model.localized("desktop.app_detail.direct")).tag("direct")
            Text(model.localized("desktop.app_detail.proxy")).tag("proxy")
          }
          .accessibilityIdentifier("codex-profile.transport")
        } footer: {
          Text(model.localized("desktop.codex_profile.profile_settings_help"))
        }

        if let saveError, !saveError.isEmpty {
          Section {
            Label(saveError, systemImage: "exclamationmark.triangle")
              .foregroundStyle(.red)
          }
        }
      }
      .onAppear(perform: selectInitialSource)
      .onChange(of: sourceID) { _, _ in modelID = "" }
      .onChange(of: model.operationResult) { _, result in
        guard awaitingSave,
          result?.operation == "codex-profile-save" || result?.operation == "codex-profile-update"
        else { return }
        awaitingSave = false
        if result?.succeeded == true {
          dismiss()
        } else {
          saveError = result?.message ?? model.localized("desktop.codex_profile.save_error")
        }
      }
    }
  }

  private func selectInitialSource() {
    if sourceID.isEmpty {
      sourceID = model.codexProfileSources.first(where: \.selected)?.sourceID
        ?? model.codexProfileSources.first?.sourceID ?? ""
    }
  }

  private func save() {
    guard canSave else { return }
    saveError = nil
    let accepted: Bool
    if profile == nil {
      accepted = model.saveCodexProfile(
        name: name,
        sourceID: sourceID,
        modelID: modelID,
        transportPolicy: transportPolicy
      )
    } else {
      accepted = model.updateCodexProfile(
        name: name,
        sourceID: sourceID,
        modelID: modelID,
        transportPolicy: transportPolicy
      )
    }
    awaitingSave = accepted
    if !awaitingSave {
      saveError = model.feedback?.message
    }
  }
}
