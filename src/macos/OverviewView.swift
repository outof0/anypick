import SwiftUI

struct FirstRunWelcomeSheet: View {
  @ObservedObject var model: MacOSDesignModel

  var body: some View {
    DesignSheetHost(
      model: model,
      title: model.localized("desktop.overview.welcome_title"),
      width: 480,
      primaryTitle: model.localized("desktop.overview.add_login_action"),
      cancelTitle: model.localized("desktop.overview.not_now"),
      onCancel: model.dismissFirstRunWelcome,
      onPrimary: model.addLoginFromWelcome
    ) {
      Form {
        Section {
          Text(model.localized("desktop.overview.welcome_detail"))
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }

        Section {
          welcomeRow(
            title: model.localized("desktop.overview.local_default"),
            detail: model.localized("desktop.overview.credentials_local"),
            symbol: "lock.laptopcomputer"
          )
          welcomeRow(
            title: model.localized("desktop.overview.flexible_connections"),
            detail: model.localized("desktop.overview.providers_gateways"),
            symbol: "arrow.triangle.branch"
          )
        } footer: {
          Text(model.localized("desktop.overview.connections_anytime"))
        }
      }
    }
    .interactiveDismissDisabled()
  }

  private func welcomeRow(title: String, detail: String, symbol: String) -> some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.body.weight(.medium))
        Text(detail)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
    } icon: {
      Image(systemName: symbol)
        .font(.title3)
        .foregroundStyle(Color.accentColor)
        .frame(width: 28, height: 28)
    }
    .padding(.vertical, 2)
  }
}

struct OverviewView: View {
  @ObservedObject var model: MacOSDesignModel

  var body: some View {
    DesignGroupedPane {
      if !model.degradedConditions.isEmpty {
        Section(model.localized("desktop.overview.needs_attention")) {
          ForEach(model.degradedConditions) { condition in
            Label {
              VStack(alignment: .leading, spacing: 2) {
                Text(model.localizedSource(condition.title))
                  .fontWeight(.medium)
                Text(model.localizedSource(condition.detail))
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }
            } icon: {
              DesignWarningSymbol(scale: .medium)
            }
          }
        }
        .accessibilityIdentifier("overview.degraded-conditions")
      }

      if let attention = primaryAttention {
        Section {
          LabeledContent {
            Button(attention.actionTitle, action: attention.action)
              .buttonStyle(.bordered)
              .controlSize(.small)
              .help(attention.message)
          } label: {
            Label {
              VStack(alignment: .leading, spacing: 2) {
                Text(model.localizedSource(attention.title))
                  .fontWeight(.medium)
                Text(model.localizedSource(attention.message))
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }
            } icon: {
              DesignWarningSymbol(scale: .medium)
            }
          }
        }
        .accessibilityIdentifier("overview.review-attention")
      }

      Section {
        LabeledContent {
          Button(
            model.localized(
              model.doctorIsRunning ? "desktop.overview.checking" : "desktop.overview.run_doctor"
            )
          ) {
            model.runDoctor()
          }
          .buttonStyle(.bordered)
          .controlSize(.small)
          .disabled(model.isBusy || model.doctorIsRunning)
          .accessibilityIdentifier("overview.run-doctor")
        } label: {
          VStack(alignment: .leading, spacing: 2) {
            Text(model.localized("desktop.overview.check_installation"))
              .fontWeight(.medium)
            Text(
              model.doctorReport.map {
                model.localized("desktop.overview.doctor_last_check")
                  .replacingOccurrences(of: "{status}", with: doctorReportStatusLabel($0.status))
              } ?? model.localized("desktop.overview.doctor_help")
            )
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }

        if let error = model.doctorError {
          Label(error, systemImage: "exclamationmark.triangle.fill")
            .foregroundStyle(.red)
            .font(.subheadline)
            .accessibilityIdentifier("overview.doctor-error")
        }

        if let report = model.doctorReport {
          if report.findings.isEmpty {
            Label(model.localized("desktop.overview.all_checks_passed"), systemImage: "checkmark.circle.fill")
              .foregroundStyle(.secondary)
              .accessibilityIdentifier("overview.doctor-summary")
          } else {
            ForEach(report.findings) { finding in
              LabeledContent {
                Text(doctorStatusLabel(finding.status))
                  .font(.subheadline)
                  .foregroundStyle(doctorColor(finding.status))
              } label: {
                VStack(alignment: .leading, spacing: 2) {
                  Text(doctorCheckLabel(finding.check))
                    .fontWeight(.medium)
                  if let detail = finding.detail, !detail.isEmpty {
                    Text(detail)
                      .font(.subheadline)
                      .foregroundStyle(.secondary)
                  }
                }
              }
              .accessibilityIdentifier("overview.doctor-finding.\(finding.check)")
            }
          }
        }
      } header: {
        Text(model.localized("desktop.overview.installation_health"))
          .accessibilityIdentifier("overview.doctor")
      } footer: {
        Text(model.localized("desktop.overview.doctor_footer"))
      }

      if model.shouldShowOnboarding {
        Section {
          setupRow(
            done: model.hasSavedLogin,
            title: model.localized("desktop.overview.add_login"),
            detail: model.hasSavedLogin
              ? model.localized("desktop.overview.login_saved")
              : model.localized("desktop.overview.use_existing_login"),
            actionTitle: model.localized("desktop.overview.add_login_action"),
            identifier: "overview.onboarding.save-login"
          ) {
            model.requestAddLogin()
          }
          setupRow(
            done: model.hasInstalledApp,
            title: model.localized("desktop.overview.use_app"),
            detail: model.hasInstalledApp
              ? model.localized("desktop.overview.app_available")
              : model.localized("desktop.overview.install_clients"),
            actionTitle: model.localized("desktop.overview.refresh"),
            identifier: "overview.onboarding.use-app"
          ) {
            model.refresh()
          }
          setupRow(
            done: model.hasChosenRoute,
            title: model.localized("desktop.overview.point_app"),
            detail: model.hasChosenRoute
              ? model.localized("desktop.overview.app_using_login")
              : model.localized("desktop.overview.point_client"),
            actionTitle: model.localized("desktop.overview.choose"),
            identifier: "overview.onboarding.choose-route"
          ) {
            model.destination = .apps
          }
          setupRow(
            done: model.isHubReady,
            title: model.localized("desktop.overview.hub_optional"),
            detail: model.isHubReady
              ? model.localized("desktop.overview.hub_sources_ready")
              : model.localized("desktop.overview.hub_endpoint_detail"),
            actionTitle: model.localized("desktop.overview.set_up"),
            identifier: "overview.onboarding.proxy-hub"
          ) {
            model.destination = .proxyHub
          }
          Button(model.localized("desktop.overview.hide_getting_started")) {
            model.dismissOnboarding()
          }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .help(model.localized("desktop.overview.hide_getting_started_help"))
            .accessibilityIdentifier("overview.hide-onboarding")
        } header: {
          // Identify the header only: an identifier on the Section would
          // overwrite every row's own overview.onboarding.* identifier.
          Text(model.localized("desktop.overview.get_started"))
            .accessibilityIdentifier("overview.get-started")
        } footer: {
          Text(onboardingFooter)
        }
      }

      // Avoid an empty section above the checklist on first run.
      if !overviewApps.isEmpty {
        Section {
          ForEach(overviewApps) { app in
            NavigationLink(value: DesignRouteID.app(app.id)) {
              DesignIdentityRow(
                title: app.name,
                detail: connectionSummary(app),
                issue: appIssue(app)
              ) {
                DesignProviderIcon(provider: app.id, fallbackSymbol: app.symbol)
              } trailing: {
                HStack(spacing: 6) {
                  if !isAppRouteConfigured(app) {
                    Image(systemName: "circle.fill")
                      .font(.system(size: 7))
                      .foregroundStyle(.orange)
                  }
                  Text(transportLabel(app))
                    .font(.subheadline)
                    .foregroundStyle(isAppRouteConfigured(app) ? Color.secondary : Color.orange)
                }
              }
            }
            .accessibilityIdentifier("overview.app.\(app.id)")
            .accessibilityLabel(model.localized("desktop.overview.app_accessibility", replacing: [
              "app": app.name,
              "connection": connectionSummary(app),
              "transport": transportLabel(app),
            ]))
          }

          if model.apps.count > overviewApps.count {
            Button {
              model.destination = .apps
            } label: {
              HStack {
                Text(
                  model.localized("desktop.overview.all_apps")
                    .replacingOccurrences(of: "{count}", with: String(model.apps.count))
                )
                  .foregroundStyle(Color.accentColor)
                Spacer()
                Image(systemName: "chevron.right")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(.tertiary)
              }
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("overview.apps.see-all")
          }
        } header: {
          Text(
            model.localized(
              hasActiveOverviewApps ? "desktop.overview.active_apps" : "desktop.overview.apps"
            )
          )
        } footer: {
          if model.apps.contains(where: { !isAppRouteConfigured($0) }) {
            Text(model.localized("desktop.overview.choose_login_each_app"))
          }
        }
            .help(model.localized("desktop.overview.open_apps_help"))
      }

      Section {
        DesignIdentityRow(
          title: model.localized("desktop.overview.proxies"),
          detail: servicesSummary
        ) {
          Image(systemName: DesignDestination.proxies.symbol)
            .font(.title3)
            .foregroundStyle(runningServiceNames.isEmpty ? Color.secondary : Color.accentColor)
        } trailing: {
          HStack(spacing: 6) {
            if !runningServiceNames.isEmpty {
              Image(systemName: "circle.fill")
                .font(.system(size: 7))
                .foregroundStyle(.green)
            }
            Text(serviceStatusText)
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .monospacedDigit()
          }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("overview.services-summary")
      } header: {
        Text(model.localized("desktop.overview.services"))
      }

      // While the checklist is visible, defer an empty activity section until
      // onboarding is complete.
      if !model.activity.isEmpty || !model.shouldShowOnboarding {
        Section {
          if model.activity.isEmpty {
            DesignEmptyRow(text: model.localized("desktop.overview.recent_empty"))
          } else {
            ForEach(model.activity.prefix(3)) { item in
              let title = item.localizedTitle(using: model)
              let detail = item.localizedDetail(using: model)
              HStack(alignment: .center, spacing: 12) {
                if let provider = item.provider {
                  DesignProviderIcon(provider: provider, fallbackSymbol: item.symbol, size: 18)
                } else {
                  Image(
                    systemName: item.status == .ready || item.status == .running
                      ? item.symbol : item.status.symbol
                  )
                  .font(.system(size: 14))
                  .foregroundStyle(item.status.color)
                  .frame(width: 18)
                }
                VStack(alignment: .leading, spacing: 2) {
                  Text(title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                  if !detail.isEmpty {
                    Text(detail)
                      .font(.caption)
                      .foregroundStyle(.secondary)
                      .lineLimit(1)
                  }
                }
                Spacer(minLength: 8)
                Text(item.time)
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
                  .monospacedDigit()
              }
              .padding(.vertical, 2)
              .accessibilityElement(children: .combine)
              .accessibilityIdentifier("overview.activity.\(item.id)")
            }
          }
        } header: {
          Text(model.localized("desktop.overview.recent_activity"))
        }
      }
    }
    .onChange(of: model.isOnboardingCoreComplete) { _, done in
      // A checklist explicitly reopened from Settings stays visible even when
      // the core steps are complete; the user chose to see it again.
      if done && !model.showGettingStarted {
        model.dismissOnboarding()
      }
    }
  }

  private var onboardingFooter: String {
    if model.isOnboardingCoreComplete {
      return model.localized("desktop.overview.footer_complete")
    }
    return model.localized("desktop.overview.footer_incomplete")
  }

  private func doctorColor(_ status: String) -> Color {
    switch status {
    case "fail": .red
    case "warn": .orange
    default: .secondary
    }
  }

  private func doctorStatusLabel(_ status: String) -> String {
    switch status.lowercased() {
    case "ok", "pass", "passed": model.localized("desktop.overview.status_ok")
    case "warn", "warning": model.localized("desktop.overview.status_warn")
    case "fail", "failed", "error": model.localized("desktop.overview.status_fail")
    default: status.capitalized
    }
  }

  private func doctorCheckLabel(_ check: String) -> String {
    let key: String
    switch check {
    case "client": key = "check_client"
    case "route": key = "check_route"
    case "proxy": key = "check_proxy"
    case "proxy-environment": key = "check_proxy_environment"
    case "database": key = "check_database"
    case "permissions": key = "check_permissions"
    case "active-binding": key = "check_active_binding"
    case "duplicate-snapshot": key = "check_duplicate_snapshot"
    case "named-profile": key = "check_named_profile"
    case "plugin-host": key = "check_plugin_host"
    default:
      if check.hasPrefix("plugin:") {
        return model.localized("desktop.overview.check_plugin")
          .replacingOccurrences(of: "{name}", with: String(check.dropFirst("plugin:".count)))
      }
      return check.replacingOccurrences(of: "-", with: " ").capitalized
    }
    return model.localized("desktop.overview.\(key)")
  }

  private func doctorReportStatusLabel(_ status: String) -> String {
    switch status.lowercased() {
    case "ok": model.localized("desktop.overview.status_ok")
    case "degraded": model.localized("desktop.overview.status_warn")
    case "unhealthy": model.localized("desktop.overview.status_fail")
    case "not-set": model.localized("desktop.overview.status_not_set")
    default: status
    }
  }

  private func connectionSummary(_ app: DesignApp) -> String {
    if let selected = app.routeOptions.first(where: { $0.id == app.selectedRouteID }) {
      return model.localized("desktop.overview.uses_account")
        .replacingOccurrences(of: "{name}", with: selected.name)
    }
    return app.detail.isEmpty ? model.localized("desktop.overview.no_login_chosen") : app.detail
  }

  private func transportLabel(_ app: DesignApp) -> String {
    guard let selected = app.routeOptions.first(where: { $0.id == app.selectedRouteID }) else {
      return model.localized("desktop.overview.not_configured")
    }
    let key: String
    switch selected.kind {
    case .gateway: key = "desktop.overview.gateway"
    case .hub: key = "desktop.overview.hub_transport"
    case .account: key = "desktop.overview.anypick_proxy"
    case .native: key = "desktop.overview.direct"
    }
    return model.localized(key)
  }

  private var hasActiveOverviewApps: Bool {
    model.apps.contains { app in
      isAppManagedByAnyPick(app) || app.status == .attention || app.status == .unavailable
    }
  }

  private var overviewApps: [DesignApp] {
    let active = model.apps.filter { app in
      isAppManagedByAnyPick(app) || app.status == .attention || app.status == .unavailable
    }
    if !active.isEmpty {
      return Array(active.prefix(3))
    }
    return Array(model.apps.prefix(3))
  }

  private var runningServiceNames: [String] {
    var names: [String] = []
    if model.proxyHubEnabled { names.append("Proxy Hub") }
    names.append(contentsOf: model.proxies.filter { $0.status == .running }.map(\.name))
    return names
  }

  private var servicesSummary: String {
    let names = runningServiceNames
    guard !names.isEmpty else { return model.localized("desktop.overview.services_stopped") }
    return names.joined(separator: " · ")
  }

  private var serviceStatusText: String {
    let running = runningServiceNames.count
    let total = overviewServiceTotal(
      proxyCount: model.proxies.count,
      hubSourcesEmpty: model.hubSources.isEmpty,
      hubEnabled: model.proxyHubEnabled
    )
    return model.localized("desktop.overview.services_ratio")
      .replacingOccurrences(of: "{running}", with: String(running))
      .replacingOccurrences(of: "{total}", with: String(total))
  }

  @ViewBuilder
  private func setupRow(
    done: Bool,
    title: String,
    detail: String,
    actionTitle: String,
    identifier: String,
    action: @escaping () -> Void
  ) -> some View {
    LabeledContent {
      if done {
        Label(model.localized("desktop.overview.done"), systemImage: "checkmark")
          .labelStyle(.titleAndIcon)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      } else {
        Button(actionTitle, action: action)
          .buttonStyle(.bordered)
          .controlSize(.small)
          .help(detail)
      }
    } label: {
      Label {
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.body.weight(.medium))
          Text(detail)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
      } icon: {
        Image(systemName: done ? "checkmark.circle.fill" : "circle")
          .font(.system(size: 14))
          .foregroundStyle(done ? Color.green : Color.secondary)
      }
    }
    .padding(.vertical, 1)
    .accessibilityIdentifier(identifier)
    .accessibilityValue(
      model.localized(done ? "desktop.overview.done" : "desktop.overview.not_done")
    )
  }

  private func appIssue(_ app: DesignApp) -> String? {
    if !isAppRouteConfigured(app) {
      return model.localized("desktop.overview.no_login_chosen")
    }
    return app.issue(using: model)
  }

  private var actionableRoutingConflicts: [DesignRoutingConflict] {
    model.routingConflicts.filter { conflict in
      let providers = Set(conflict.candidates.map { hubProviderDisplayName($0.provider) }.filter { !$0.isEmpty })
      return providers.count > 1
    }
  }

  private var primaryAttention:
    (title: String, message: String, actionTitle: String, action: () -> Void)?
  {
    // Keep priority in the shared helper so fixture and production render the
    // same recovery destination.
    guard
      let target = overviewAttentionTarget(
        proxies: model.proxies,
        apps: model.apps,
        accounts: model.accounts,
        conflicts: actionableRoutingConflicts
      )
    else { return nil }
    switch target {
    case .proxy(let id):
      guard let proxy = model.proxies.first(where: { $0.id == id }) else { return nil }
      return (
        model.localized("desktop.overview.attention_proxy_title")
          .replacingOccurrences(of: "{name}", with: proxy.name),
        model.localized("desktop.overview.attention_proxy_detail")
          .replacingOccurrences(of: "{name}", with: proxy.name),
        model.localized("desktop.overview.open_proxies"),
        { model.destination = .proxies }
      )
    case .app(let id):
      guard let app = model.apps.first(where: { $0.id == id }) else { return nil }
      return (
        model.localized("desktop.overview.attention_app_title")
          .replacingOccurrences(of: "{name}", with: app.name),
        model.localized("desktop.overview.attention_app_detail"),
        model.localized("desktop.overview.open_apps"),
        { model.destination = .apps }
      )
    case .account(let id):
      guard let account = model.accounts.first(where: { $0.id == id }) else { return nil }
      return (
        model.localized("desktop.overview.attention_account_title")
          .replacingOccurrences(of: "{name}", with: account.name),
        model.localized("desktop.overview.attention_account_detail"),
        model.localized("desktop.overview.open_accounts"),
        { model.destination = .accounts }
      )
    case .conflict(let kind):
      guard let conflict = actionableRoutingConflicts.first(where: { $0.kind == kind }) ?? actionableRoutingConflicts.first else {
        return nil
      }
      let (infoTitle, _) = hubConflictDisplayInfo(conflict, using: model)
      return (
        model.localized("desktop.overview.attention_conflict_title")
          .replacingOccurrences(of: "{name}", with: infoTitle),
        model.localized("desktop.overview.attention_conflict_detail"),
        model.localized("desktop.overview.open_proxy_hub"),
        { model.destination = .proxyHub }
      )
    }
  }
}
