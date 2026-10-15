import SwiftUI

struct SettingsGeneralPane: View {
  @ObservedObject var model: MacOSDesignModel

  @ViewBuilder
  var body: some View {
    Section {
      Toggle(model.localized("desktop.settings.open_at_login"), isOn: $model.openAtLogin)
        .help(model.localized("desktop.settings.open_at_login_help"))
        .disabled(model.isBusy)
        .accessibilityIdentifier("settings.open-at-login")

      Toggle(
        model.localized("desktop.settings.start_enabled_proxies"),
        isOn: Binding(
          get: { model.startProxiesAtLaunch },
          set: model.setStartProxiesAtLaunch
        )
      )
      .help(model.localized("desktop.settings.start_enabled_proxies_help"))
      .disabled(model.isBusy)
      .accessibilityIdentifier("settings.start-enabled-proxies")
    } header: {
      Text(model.localized("desktop.settings.startup"))
    }

    Section {
      LabeledContent(model.localized("desktop.settings.setup_checklist")) {
        Button(model.localized("desktop.settings.show"), action: model.showGettingStartedAgain)
          .accessibilityIdentifier("settings.show-getting-started")
      }
    } header: {
      Text(model.localized("desktop.settings.getting_started"))
    } footer: {
      Text(model.localized("desktop.settings.setup_checklist_help"))
    }
  }
}

struct SettingsUsagePane: View {
  @ObservedObject var model: MacOSDesignModel

  @ViewBuilder
  var body: some View {
    Section {
      Toggle(model.localized("desktop.settings.show_usage"), isOn: $model.showUsage)
        .help(model.localized("desktop.settings.show_usage_help"))
        .disabled(model.isBusy)
        .accessibilityIdentifier("settings.show-usage")

      Toggle(
        model.localized("desktop.settings.quota_guard"),
        isOn: Binding(
          get: { model.warnBeforeLowUsage },
          set: model.setWarnBeforeLowUsage
        )
      )
      .disabled(model.isBusy)
      .help(model.localized("desktop.settings.quota_guard_help"))
      .accessibilityIdentifier("settings.quota-guard")
    } header: {
      Text(model.localized("desktop.settings.usage"))
    }
  }
}

struct SettingsLanguagePane: View {
  @ObservedObject var model: MacOSDesignModel

  var body: some View {
    Section {
      Picker(
        model.localized("desktop.settings.language"),
        selection: Binding(get: { model.selectedLanguage }, set: model.setLanguage)
      ) {
        ForEach(model.languageOptions) { option in
          Text(option.value == "auto" ? model.localized("desktop.language.auto") : option.label)
            .tag(option.value)
        }
      }
      .pickerStyle(.menu)
      .disabled(model.isBusy)
      .accessibilityIdentifier("settings.language")
    } header: {
      Text(model.localized("desktop.settings.language"))
    } footer: {
      Text(model.localized("desktop.settings.language_detail"))
    }
  }
}
