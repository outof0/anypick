import AppKit
import Foundation
import SwiftUI

// Module: AppEntry.swift — split from AnyPickTray.swift for maintainability.

@MainActor
final class AnyPickAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  let store = TrayStore(
    initialCount: CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 0 : 0
  )
  let navigation = NativeNavigationModel()
  private var mainWindowController: NSWindowController?
  /// True while the main window is open as a normal app (Dock + click-outside safe).
  private var mainWindowPromoted = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Menu-bar only until the user opens the full window.
    NSApp.setActivationPolicy(.accessory)
    if ProcessInfo.processInfo.environment["ANYPICK_TRAY_PROTOCOL_SELF_TEST"] == "1" {
      store.invoke(ActionSnapshot(
        id: "self-test",
        clientId: "codex",
        sourceId: "codex",
        client: "Codex",
        label: "self-test",
        detail: nil,
        kind: "native",
        presentation: "app-route",
        selected: false,
        enabled: true,
        disabledReason: nil,
        routeKind: "direct-account",
        modelId: nil,
        upstreamProviderId: nil,
        upstreamSourceLabel: nil
      ))
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { NSApp.terminate(nil) }
      return
    }
    FileHandle.standardInput.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else {
        handle.readabilityHandler = nil
        DispatchQueue.main.async { NSApp.terminate(nil) }
        return
      }
      DispatchQueue.main.async { self?.store.consume(data) }
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag {
      openMainWindow()
    }
    return true
  }

  func openMainWindow(tab: NativeTrayTab = .accounts, clientId: String? = nil) {
    navigation.show(tab, clientId: clientId)
    promoteMainWindow()

    if let window = mainWindowController?.window {
      if !window.isVisible { window.setIsVisible(true) }
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }

    let rootView = NativeMainWindow(store: store, navigation: navigation)
    let window = NSWindow(contentViewController: NSHostingController(rootView: rootView))
    window.title = "AnyPick"
    // Settings-like utility: resizable (HIG accessibility / logs), with a sensible minimum.
    window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    window.toolbarStyle = .unified
    window.tabbingMode = .disallowed
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.setFrameAutosaveName("AnyPickMainWindow")
    let minSize = NSSize(width: 720, height: 480)
    let defaultSize = NSSize(width: 840, height: 640)
    window.contentMinSize = minSize
    // Prefer the user’s last size; first launch gets the default utility size.
    if !window.setFrameUsingName("AnyPickMainWindow") {
      window.setContentSize(defaultSize)
      window.center()
    }

    let controller = NSWindowController(window: window)
    mainWindowController = controller
    controller.showWindow(nil)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  /// Full window behaves like a normal Mac app (survives click-outside, Dock icon).
  private func promoteMainWindow() {
    guard !mainWindowPromoted else { return }
    mainWindowPromoted = true
    AnyPickAppIcon.applyToApp()
    NSApp.setActivationPolicy(.regular)
  }

  /// Closing the last main window returns to menu-bar-only accessory mode.
  private func demoteIfNoMainWindow() {
    guard mainWindowPromoted else { return }
    let mainVisible = mainWindowController?.window?.isVisible == true
    guard !mainVisible else { return }
    mainWindowPromoted = false
    NSApp.setActivationPolicy(.accessory)
  }

  func windowWillClose(_ notification: Notification) {
    guard let window = notification.object as? NSWindow,
          window === mainWindowController?.window else { return }
    // Defer: isVisible is still true during willClose.
    DispatchQueue.main.async { [weak self] in
      self?.demoteIfNoMainWindow()
    }
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    // Hide instead of destroy so frame autosave + state survive; still demotes policy.
    if sender === mainWindowController?.window {
      sender.orderOut(nil)
      demoteIfNoMainWindow()
      return false
    }
    return true
  }

  /// HIG ⌘W — hide the utility window (same as the close button).
  func closeMainWindow() {
    guard let window = mainWindowController?.window, window.isVisible else { return }
    window.performClose(nil)
  }
}
@main
struct AnyPickTrayApp: App {
  @NSApplicationDelegateAdaptor(AnyPickAppDelegate.self) private var delegate

  var body: some Scene {
    MenuBarExtra {
      NativeQuickPanel(store: delegate.store) { tab, clientId in
        delegate.openMainWindow(tab: tab, clientId: clientId)
      }
    } label: {
      StatusLabel(store: delegate.store)
    }
    .menuBarExtraStyle(.window)
    .commands {
      // Standard macOS app commands while the main window is promoted.
      CommandGroup(replacing: .appSettings) {
        Button("Settings…") {
          delegate.openMainWindow(tab: .settings)
        }
        .keyboardShortcut(",", modifiers: .command)
      }
      CommandGroup(after: .newItem) {
        Button("Add Account…") {
          delegate.openMainWindow(tab: .manage)
        }
        .keyboardShortcut("n", modifiers: .command)
      }
      CommandGroup(after: .toolbar) {
        Button("Refresh") {
          delegate.store.refreshAll()
        }
        .keyboardShortcut("r", modifiers: .command)
        Button("Restart Proxies") {
          delegate.store.restartProxies()
        }
        .keyboardShortcut("r", modifiers: [.command, .shift])
      }
      CommandGroup(replacing: .saveItem) {
        Button("Close") {
          delegate.closeMainWindow()
        }
        .keyboardShortcut("w", modifiers: .command)
      }
      CommandMenu("Go") {
        Button("Apps") { delegate.openMainWindow(tab: .accounts) }
          .keyboardShortcut("1", modifiers: .command)
        Button("Accounts") { delegate.openMainWindow(tab: .manage) }
          .keyboardShortcut("2", modifiers: .command)
        Button("Proxies") { delegate.openMainWindow(tab: .proxy) }
          .keyboardShortcut("3", modifiers: .command)
        Button("Logs") { delegate.openMainWindow(tab: .monitor) }
          .keyboardShortcut("4", modifiers: .command)
        Button("Settings") { delegate.openMainWindow(tab: .settings) }
          .keyboardShortcut("5", modifiers: .command)
      }
    }
  }
}

/// Menu-bar glyph — template monochrome; attention uses a small status mark (HIG).
struct StatusLabel: View {
  @ObservedObject var store: TrayStore

  private var attentionCount: Int { store.attentionCount }
  private var hasIssues: Bool { store.routingIssueCount > 0 }

  var body: some View {
    // Template base stays monochrome; colored badge is the only non-template element.
    ZStack(alignment: .topTrailing) {
      Image(nsImage: AnyPickTrayIcon.image)
        .renderingMode(.template)
      if attentionCount > 0 {
        Circle()
          .fill(hasIssues ? Color.orange : Color.accentColor)
          .frame(width: 6, height: 6)
          // Hairline ring so the badge stays readable on light/dark menu bars.
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
        ? "AnyPick, \(attentionCount) \(attentionCount == 1 ? "item needs" : "items need") attention"
        : "AnyPick"
    )
    .accessibilityHint(attentionCount > 0 ? "Open AnyPick to review routing" : "")
  }
}
