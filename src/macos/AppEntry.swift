import AppKit
import SwiftUI

private enum AppVersion {
  static var marketing: String {
    let value = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    return value.flatMap { $0.isEmpty ? nil : $0 } ?? "(devel)"
  }
}

struct AnyPickMenuBarScene: Scene {
  @ObservedObject var model: MacOSDesignModel
  @Environment(\.openWindow) private var openWindow

  var body: some Scene {
    // A main-window render stays out of the menu bar too.
    MenuBarExtra(isInserted: .constant(!AnyPickAppDelegate.rendersOffscreen)) {
      MenuBarMenu(model: model)
        .onAppear {
          AnyPickAppDelegate.openMainWindowAction = {
            openWindow(id: "main")
          }
        }
    } label: {
      AnyPickMenuBarLabel(model: model)
    }
    .menuBarExtraStyle(.window)
  }
}

struct AnyPickMenuBarLabel: View {
  @ObservedObject var model: MacOSDesignModel

  private var attentionCount: Int { trayAttentionItems(from: model).count }

  var body: some View {
    ZStack(alignment: .topTrailing) {
      Image(nsImage: AnyPickAppIcon.menuBarImage())
      if attentionCount > 0 {
        Circle()
          .fill(Color.orange)
          .frame(width: 6, height: 6)
          .overlay(
            Circle()
              .strokeBorder(Color.primary.opacity(0.35), lineWidth: 0.5)
          )
          .offset(x: 1, y: -1)
          .accessibilityHidden(true)
      }
    }
    .accessibilityLabel(
      attentionCount > 0
        ? model.localized(
          "desktop.menu_bar.attention_accessibility",
          count: attentionCount,
          replacing: ["count": String(attentionCount)]
        )
        : "AnyPick"
    )
    .accessibilityHint(attentionCount > 0 ? model.localized("desktop.menu_bar.review_routing_hint") : "")
  }
}

struct AppCommands: Commands {
  @ObservedObject var model: MacOSDesignModel
  @Environment(\.openWindow) private var openWindow

  var body: some Commands {
    // The standard panel appends CFBundleVersion as "(1)"; an empty `.version`
    // keeps the panel focused on the marketing version.
    CommandGroup(replacing: .appInfo) {
      Button(model.localized("desktop.app_commands.about")) {
        NSApp.orderFrontStandardAboutPanel(options: [
          .applicationVersion: AppVersion.marketing,
          .version: "",
        ])
        NSApp.activate(ignoringOtherApps: true)
      }
      .help(model.localized("desktop.app_commands.about_help"))
    }
    CommandGroup(after: .appInfo) {
      Button(model.localized("desktop.nav.settings")) { open(.settings) }
        .keyboardShortcut(",", modifiers: .command)
        .help(model.localized("desktop.app_commands.settings_help"))
    }
    CommandGroup(after: .newItem) {
      Button(model.localized("desktop.menu_bar.add_login_action")) {
        model.requestAddLogin()
        open(.accounts)
      }
        .keyboardShortcut("n", modifiers: .command)
        .help(model.localized("desktop.app_commands.add_login_help"))
    }
    // No Edit → Undo: mutations apply server-side with no compensation
    // path, so a local undo would be reverted by the next snapshot.
    CommandGroup(replacing: .undoRedo) {}
    CommandGroup(after: .toolbar) {
      Button(model.localized("desktop.common.refresh")) { model.refresh() }
        .keyboardShortcut("r", modifiers: .command)
        .help(model.localized("desktop.app_commands.refresh_help"))
      Button(model.localized("desktop.app_commands.restart_proxies")) { model.restartRunningProxies() }
        .keyboardShortcut("r", modifiers: [.command, .shift])
        .help(model.localized("desktop.app_commands.restart_proxies_help"))
    }
    CommandMenu(model.localized("desktop.app_commands.go")) {
      ForEach(Array(DesignDestination.allCases.enumerated()), id: \.element.id) {
        index, destination in
        Button(model.localized(destination.messageKey)) { open(destination) }
          .help(model.localized("desktop.app_commands.open_destination", replacing: [
            "destination": model.localized(destination.messageKey),
          ]))
          .keyboardShortcut(
            KeyEquivalent(Character("\(index + 1)")),
            modifiers: .command
          )
      }
    }
  }

  private func open(_ destination: DesignDestination) {
    model.destination = destination
    NSApp.setActivationPolicy(.regular)
    openWindow(id: "main")
    NSApp.activate(ignoringOtherApps: true)
  }
}

@main
struct AnyPickApp: App {
  @NSApplicationDelegateAdaptor(AnyPickAppDelegate.self) private var delegate

  var body: some Scene {
    Window("AnyPick", id: "main") {
      MainWindow(model: delegate.designModel)
        .followingDesignAppearance(delegate.designModel.appearance)
    }
    .defaultSize(width: 920, height: 640)
    .windowResizability(.automatic)
    .commands {
      AppCommands(model: delegate.designModel)
      SidebarCommands()
    }

#if DEBUG
    Window("Menu Bar", id: "tray") {
      MenuBarPreview(model: delegate.designModel)
    }
    .defaultSize(width: 360, height: 480)
    .windowStyle(.hiddenTitleBar)
    .windowResizability(.contentSize)
#endif

    AnyPickMenuBarScene(model: delegate.designModel)
  }
}
