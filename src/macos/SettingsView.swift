import SwiftUI

/// App-wide preferences share one pane in the main sidebar.
/// Keeping one grouped Form lets macOS provide the native scrolling and control
/// rhythm used by every other destination.
struct SettingsView: View {
  @ObservedObject var model: MacOSDesignModel
  @StateObject private var updates = UpdatesModel()

  var body: some View {
    Form {
      SettingsGeneralPane(model: model)
      SettingsUsagePane(model: model)
      SettingsLanguagePane(model: model)
      SettingsUpdatesPane(updates: updates, model: model)
    }
    .formStyle(.grouped)
    .accessibilityIdentifier("settings.pane")
    .onChange(of: model.openAtLogin) { _, value in model.setOpenAtLogin(value) }
    .onChange(of: model.showUsage) { _, value in model.setShowUsage(value) }
  }
}
