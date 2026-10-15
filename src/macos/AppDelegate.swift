import AppKit
import Darwin
import Foundation
import SwiftUI

@MainActor
final class AnyPickAppDelegate: NSObject, NSApplicationDelegate {
  private static weak var instance: AnyPickAppDelegate?
  static weak var registeredMainWindow: NSWindow?
  static var openMainWindowAction: (() -> Void)?
  /// A fixture render of the main window (`ANYPICK_MACOS_RENDER_PATH`, not a
  /// tray flow). The app never activates, the window is parked off every
  /// display and only its own pixels are read, so a render on a Mac someone is
  /// using neither takes focus nor captures anything else on screen.
  static let rendersOffscreen: Bool = {
    let environment = ProcessInfo.processInfo.environment
    let fixture = environment["ANYPICK_MACOS_FIXTURE"] != nil
      || environment["ANYPICK_MACOS_DESIGN"] == "1"
    return fixture && environment["ANYPICK_MACOS_RENDER_PATH"] != nil
      && environment["ANYPICK_MACOS_FLOW"]?.hasPrefix("tray") != true
  }()

  let isFixture: Bool
  let store: TrayStore?
  let designModel: MacOSDesignModel
  private var serviceProcess: GoServiceProcess?
  private var terminationPending = false
  private var trayRightClickMonitor: Any?
  /// Tray Quit (and `quitAnyPick`) set this so Dock/⌘Q can hide to the
  /// menu bar instead of killing the process.
  private var allowTerminate = false

  override init() {
    let environment = ProcessInfo.processInfo.environment
    let fixture = environment["ANYPICK_MACOS_FIXTURE"] != nil
      || environment["ANYPICK_MACOS_DESIGN"] == "1"
    isFixture = fixture
    if fixture {
      store = nil
      designModel = MacOSDesignModel.fromEnvironment(environment)
    } else {
      let created = TrayStore(
        initialCount: CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 0 : 0
      )
      created.quitHandler = { AnyPickAppDelegate.requestQuit() }
      store = created
      designModel = ProductionDesignModel(store: created)
    }
    super.init()
    Self.instance = self
  }

  /// Only the menu-bar Quit button should kill the process.
  static func requestQuit() {
    guard let instance else {
      NSApp.terminate(nil)
      return
    }
    instance.allowTerminate = true
    NSApp.terminate(nil)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    AnyPickAppIcon.applyToApp()
    installTrayRightClickMonitor()
    let serviceSmoke = ProcessInfo.processInfo.environment["ANYPICK_APP_SERVICE_SMOKE_PATH"] != nil
    if serviceSmoke {
      // The installed-app smoke exercises the real bundled helper without
      // entering AppKit's interactive window/menu tracking loops.
      NSApp.setActivationPolicy(.accessory)
      for window in NSApp.windows { window.orderOut(nil) }
    } else if Self.rendersOffscreen {
      NSApp.setActivationPolicy(.accessory)
      parkWindowsForRender()
      DispatchQueue.main.async { [weak self] in self?.parkWindowsForRender() }
    } else {
      NSApp.setActivationPolicy(.regular)
      NSApp.activate(ignoringOtherApps: true)
      retainMainWindows()
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(windowDidBecomeKey(_:)),
        name: NSWindow.didBecomeKeyNotification,
        object: nil
      )
      DispatchQueue.main.async { [weak self] in self?.presentMainWindow() }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
        self?.presentMainWindow()
      }
    }

    if isFixture {
      if ProcessInfo.processInfo.environment["ANYPICK_MACOS_RENDER_PATH"] != nil {
        // Settle delay for layout-accurate captures (slow first paint would
        // otherwise freeze a half-laid-out window into the PNG).
        let delayMs: UInt64
        if let raw = ProcessInfo.processInfo.environment["ANYPICK_MACOS_RENDER_DELAY_MS"],
          let parsed = UInt64(raw)
        {
          delayMs = parsed
        } else {
          delayMs = 2_200
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(delayMs))) {
          self.captureIfRequested(attemptsRemaining: 60)
        }
      }
      return
    }

    startBundledService()
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let trayRightClickMonitor {
      NSEvent.removeMonitor(trayRightClickMonitor)
      self.trayRightClickMonitor = nil
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    // Dock Quit / ⌘Q / File → Quit: leave the Dock, keep the menu-bar extra
    // and the helper. Only tray Quit sets `allowTerminate`.
    if !allowTerminate {
      withdrawToTray()
      return .terminateCancel
    }
    guard !isFixture, let serviceProcess else { return .terminateNow }
    if terminationPending { return .terminateLater }
    terminationPending = true
    Task {
      await serviceProcess.stop()
      await MainActor.run { sender.reply(toApplicationShouldTerminate: true) }
    }
    return .terminateLater
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    presentMainWindow()
    sender.activate(ignoringOtherApps: true)
    return true
  }

  private func installTrayRightClickMonitor() {
    guard trayRightClickMonitor == nil else { return }
    trayRightClickMonitor = NSEvent.addLocalMonitorForEvents(matching: .rightMouseDown) {
      [weak self] event in
      guard
        let self,
        let window = event.window,
        Self.isStatusItemWindow(window)
      else {
        return event
      }
      self.presentTrayContextMenu(in: window, at: event.locationInWindow)
      return nil
    }
  }

  private func presentTrayContextMenu(in window: NSWindow, at point: NSPoint) {
    let menu = NSMenu()
    menu.autoenablesItems = false

    let open = NSMenuItem(
      title: designModel.localized("desktop.menu_bar.open_anypick"),
      action: #selector(openAnyPickFromTray(_:)),
      keyEquivalent: ""
    )
    open.target = self
    menu.addItem(open)

    let settings = NSMenuItem(
      title: designModel.localized("desktop.nav.settings"),
      action: #selector(openSettingsFromTray(_:)),
      keyEquivalent: ""
    )
    settings.target = self
    menu.addItem(settings)

    menu.addItem(.separator())

    let quit = NSMenuItem(
      title: designModel.localized("desktop.menu_bar.quit"),
      action: #selector(quitAnyPickFromTray(_:)),
      keyEquivalent: "q"
    )
    quit.target = self
    menu.addItem(quit)

    guard let contentView = window.contentView else { return }
    let contentPoint = contentView.convert(point, from: nil)
    menu.popUp(positioning: nil, at: contentPoint, in: contentView)
  }

  @objc private func openAnyPickFromTray(_ sender: NSMenuItem) {
    presentMainWindow()
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func openSettingsFromTray(_ sender: NSMenuItem) {
    showSettingsPane()
  }

  private func showSettingsPane() {
    designModel.destination = .settings
    if NSApp.activationPolicy() != .regular {
      NSApp.setActivationPolicy(.regular)
    }
    presentMainWindow()
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func quitAnyPickFromTray(_ sender: NSMenuItem) {
    Self.requestQuit()
  }

  /// Hide windows and drop the Dock tile. Menu-bar extra stays.
  private func withdrawToTray() {
    for window in NSApp.windows where !Self.isStatusItemWindow(window) {
      window.orderOut(nil)
    }
    NSApp.setActivationPolicy(.accessory)
  }

  @objc private func windowDidBecomeKey(_ notification: Notification) {
    guard let window = notification.object as? NSWindow else { return }
    retainIfMainWindow(window)
  }

  private func retainMainWindows() {
    for window in NSApp.windows { retainIfMainWindow(window) }
  }

  private func retainIfMainWindow(_ window: NSWindow) {
    guard isMainWindow(window) else { return }
    // Keep the SwiftUI Window alive after the close button so Dock / tray
    // can order it front instead of trying to recreate a torn-down scene.
    window.isReleasedWhenClosed = false
  }

  func presentMainWindow() {
    if Self.rendersOffscreen {
      parkWindowsForRender()
      return
    }
    if NSApp.activationPolicy() != .regular {
      NSApp.setActivationPolicy(.regular)
    }
    NSApp.activate(ignoringOtherApps: true)
    AnyPickAppIcon.applyToApp()
    for window in NSApp.windows where !Self.isStatusItemWindow(window) {
      retainIfMainWindow(window)
      if window.title.isEmpty, window.frame.width > 180 {
        window.title = "AnyPick"
      }
    }
    let prefersTray = isFixture
      && ProcessInfo.processInfo.environment["ANYPICK_MACOS_FLOW"]?.hasPrefix("tray") == true
    let tray = NSApp.windows.first { $0.title == "Menu Bar" }
    let main = Self.registeredMainWindow ?? NSApp.windows.first(where: isMainWindow)
    if prefersTray {
      tray?.makeKeyAndOrderFront(nil)
    } else if let main {
      main.makeKeyAndOrderFront(nil)
      main.orderFrontRegardless()
    } else {
      Self.openMainWindowAction?()
    }
  }

  private func startBundledService() {
    guard let store else { return }
#if DEBUG
    // Debug helpers intentionally keep the Go build version at `(devel)`;
    // release helpers receive the marketing version from the bundle script.
    // Keep both sides of the handshake on the same development identity so a
    // locally installed Debug app can actually start its bundled service.
    let appVersion = "(devel)"
#else
    let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
      as? String ?? "(devel)"
#endif
    let service = GoServiceProcess(
      appVersion: appVersion,
      launchAtLogin: MacOSHostEffects.launchAtLoginEnabled,
      onFrame: { [weak store] data in store?.consume(data) },
      onState: { [weak store] state in store?.updateServiceState(state) }
    )
    serviceProcess = service
    store.attachCommandSink { [weak service] command in
      guard let service else { return }
      Task { await service.send(command) }
    }
    store.restartService = { [weak service] in
      guard let service else { return }
      Task { await service.restart() }
    }
    Task { await service.start() }
    runServiceSmokeIfRequested(store: store)
  }

  private func runServiceSmokeIfRequested(store: TrayStore) {
    guard let marker = ProcessInfo.processInfo.environment["ANYPICK_APP_SERVICE_SMOKE_PATH"],
          !marker.isEmpty else { return }
    Task { @MainActor in
      for _ in 0..<200 {
        if store.snapshotReady, store.serviceState == .ready {
          await serviceProcess?.stop()
          try? Data("ready\n".utf8).write(to: URL(fileURLWithPath: marker), options: .atomic)
          Darwin.exit(EXIT_SUCCESS)
        }
        if case .degraded(let reason) = store.serviceState {
          await serviceProcess?.stop()
          try? Data("degraded: \(reason)\n".utf8)
            .write(to: URL(fileURLWithPath: marker), options: .atomic)
          Darwin.exit(EXIT_FAILURE)
        }
        try? await Task.sleep(nanoseconds: 50_000_000)
      }
      await serviceProcess?.stop()
      try? Data("timeout\n".utf8).write(to: URL(fileURLWithPath: marker), options: .atomic)
      Darwin.exit(EXIT_FAILURE)
    }
  }

  private func isMainWindow(_ window: NSWindow) -> Bool {
    if Self.isStatusItemWindow(window) { return false }
    if window is NSPanel { return false }
    if window.identifier?.rawValue == "main" { return true }
    // The custom Menu Bar preview is not the main application window.
    if window.title == "Menu Bar" { return false }
    return window.canBecomeMain && window.frame.width > 500
  }

  private static func isStatusItemWindow(_ window: NSWindow) -> Bool {
    if window.title == "Item-0" { return true }
    let name = String(describing: type(of: window))
    return name.contains("StatusBar") || name.contains("MenuBar") || name.contains("StatusItem")
  }

  /// Keeps the main window ordered in, so SwiftUI keeps painting it, but off
  /// every display, click-through, and never key.
  private func parkWindowsForRender() {
    let mains = NSApp.windows.filter { !Self.isStatusItemWindow($0) && isMainWindow($0) }
    if mains.isEmpty {
      Self.openMainWindowAction?()
      return
    }
    let size = Self.renderContentSize()
    for window in mains {
      retainIfMainWindow(window)
      if let size, window.contentRect(forFrameRect: window.frame).size != size {
        window.setContentSize(size)
      }
      window.ignoresMouseEvents = true
      window.setFrameOrigin(NSPoint(x: -32_000, y: -32_000))
      window.orderFrontRegardless()
    }
  }

  /// `ANYPICK_MACOS_RENDER_SIZE=980x680` pins the content size in points, so a
  /// render does not depend on the window frame a previous session saved.
  private static func renderContentSize() -> NSSize? {
    guard let raw = ProcessInfo.processInfo.environment["ANYPICK_MACOS_RENDER_SIZE"] else {
      return nil
    }
    let parts = raw.lowercased().split(separator: "x").compactMap { Double($0) }
    guard parts.count == 2, parts[0] >= 400, parts[1] >= 300 else {
      fputs("[macOS] Ignoring ANYPICK_MACOS_RENDER_SIZE=\(raw); expected WIDTHxHEIGHT.\n", stderr)
      return nil
    }
    return NSSize(width: parts[0], height: parts[1])
  }

  private func captureIfRequested(attemptsRemaining: Int) {
    guard let renderPath = ProcessInfo.processInfo.environment["ANYPICK_MACOS_RENDER_PATH"] else {
      return
    }
    presentMainWindow()
    let visible = NSApp.windows.filter {
      $0.contentView != nil && $0.frame.width > 80 && $0.frame.height > 40
    }
    let prefersTray = ProcessInfo.processInfo.environment["ANYPICK_MACOS_FLOW"]?.hasPrefix("tray")
      == true
    let tray = visible.first { $0.title == "Menu Bar" }
    let main = visible.first(where: isMainWindow) ?? visible.first
    let host = prefersTray ? (tray ?? main) : main
    guard let host, let contentView = host.contentView, !contentView.bounds.isEmpty else {
      retryCapture(renderPath: renderPath, attemptsRemaining: attemptsRemaining)
      return
    }
    contentView.layoutSubtreeIfNeeded()
    host.displayIfNeeded()
    host.attachedSheet?.displayIfNeeded()
    // SwiftUI paints asynchronously: an early attempt freezes a half-painted
    // window, so only the last attempt writes.
    guard attemptsRemaining <= 1 else {
      retryCapture(renderPath: renderPath, attemptsRemaining: attemptsRemaining)
      return
    }
    // Prefer the main window (README framing). If a sheet is attached, composite
    // it centered so Add Login reads in-window — not a detached sheet crop.
    let image: CGImage?
    if !prefersTray, let sheet = host.attachedSheet,
      let composed = RenderCapture.mainWithSheetImage(main: host, sheet: sheet)
    {
      image = composed
    } else {
      image = RenderCapture.ownWindowImage(host) ?? RenderCapture.cachedDisplay(contentView)
    }
    guard let image else {
      fputs("[macOS] Render produced no image.\n", stderr)
      exit(EXIT_FAILURE)
    }
    if RenderCapture.isBlank(image) {
      fputs("[macOS] Render is a single flat color; not writing \(renderPath).\n", stderr)
      exit(EXIT_FAILURE)
    }
    guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]),
      (try? data.write(to: URL(fileURLWithPath: renderPath), options: .atomic)) != nil
    else {
      fputs("[macOS] Could not write \(renderPath).\n", stderr)
      exit(EXIT_FAILURE)
    }
    exit(EXIT_SUCCESS)
  }

  private func retryCapture(renderPath: String, attemptsRemaining: Int) {
    if attemptsRemaining > 1 {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
        self.captureIfRequested(attemptsRemaining: attemptsRemaining - 1)
      }
      return
    }
    fputs("[macOS] Could not capture a visible window.\n", stderr)
    exit(EXIT_FAILURE)
  }
}

/// Reads pixels of AnyPick's own windows for fixture renders. Nothing here can
/// see another app's window or the desktop.
enum RenderCapture {
  private typealias WindowListCreateImage = @convention(c) (
    CGRect, UInt32, UInt32, UInt32
  ) -> Unmanaged<CGImage>?

  /// `CGWindowListCreateImage` for one window this process owns, looked up at
  /// run time because the macOS 15 SDK marks it obsoleted. Reading your own
  /// window needs no Screen Recording grant. Returns nil if the symbol is gone.
  static func ownWindowImage(_ window: NSWindow) -> CGImage? {
    guard window.windowNumber > 0,
      let handle = dlopen(
        "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY),
      let symbol = dlsym(handle, "CGWindowListCreateImage")
    else { return nil }
    let create = unsafeBitCast(symbol, to: WindowListCreateImage.self)
    let includingWindow: UInt32 = 1 << 3  // kCGWindowListOptionIncludingWindow
    let ignoreFramingBestResolution: UInt32 = (1 << 0) | (1 << 3)
    return create(.null, includingWindow, UInt32(window.windowNumber), ignoreFramingBestResolution)?
      .takeRetainedValue()
  }

  /// Main window plus its attached sheet, for README “in-window” sheet shots.
  static func mainWithSheetImage(main: NSWindow, sheet: NSWindow) -> CGImage? {
    guard let base = ownWindowImage(main), let overlay = ownWindowImage(sheet) else { return nil }
    let width = base.width
    let height = base.height
    guard
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    context.draw(base, in: CGRect(x: 0, y: 0, width: width, height: height))
    let scaleX = CGFloat(width) / main.frame.width
    let scaleY = CGFloat(height) / main.frame.height
    let sheetSize = CGSize(
      width: sheet.frame.width * scaleX, height: sheet.frame.height * scaleY)
    let origin = CGPoint(
      x: (CGFloat(width) - sheetSize.width) / 2,
      y: (CGFloat(height) - sheetSize.height) / 2)
    context.draw(overlay, in: CGRect(origin: origin, size: sheetSize))
    return context.makeImage()
  }

  static func cachedDisplay(_ view: NSView) -> CGImage? {
    guard let representation = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
      return nil
    }
    view.cacheDisplay(in: view.bounds, to: representation)
    return representation.cgImage
  }

  /// True when every pixel of a 32×32 downsample is within a few levels of the
  /// first: the white or transparent frame a failed render leaves behind.
  static func isBlank(_ image: CGImage) -> Bool {
    let side = 32
    var pixels = [UInt8](repeating: 0, count: side * side * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8,
          bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
      return true
    }
    guard drawn else { return true }
    let first = Array(pixels[0..<4])
    for index in stride(from: 0, to: pixels.count, by: 4) {
      for channel in 0..<4 where abs(Int(pixels[index + channel]) - Int(first[channel])) > 3 {
        return false
      }
    }
    return true
  }
}
