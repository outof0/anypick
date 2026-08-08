import AppKit
import Foundation
import SwiftUI

// Module: SharedUI.swift — section headers, provider badges, list helpers.

struct NativeSectionHeader<ActionLabel: View>: View {
  let title: String
  let detail: String
  var action: (() -> Void)? = nil
  @ViewBuilder var actionLabel: () -> ActionLabel

  init(
    title: String,
    detail: String,
    action: (() -> Void)? = nil,
    @ViewBuilder actionLabel: @escaping () -> ActionLabel
  ) {
    self.title = title
    self.detail = detail
    self.action = action
    self.actionLabel = actionLabel
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(title)
          .font(.headline)
        Spacer(minLength: 8)
        if let action {
          Button(action: action) {
            actionLabel()
              .font(.caption.weight(.semibold))
              .foregroundStyle(Color.accentColor)
              .padding(.horizontal, 6)
              .padding(.vertical, 3)
          }
          .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
        }
      }
      if !detail.isEmpty {
        Text(detail)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.horizontal, 2)
  }
}

extension NativeSectionHeader where ActionLabel == EmptyView {
  init(title: String, detail: String) {
    self.init(title: title, detail: detail, action: nil) { EmptyView() }
  }
}

/// Fixed-size provider/app badge. Never stretches workspace icons into ovals.
struct NativeProviderBadge: View {
  let id: String
  var size: CGFloat = 32

  private var corner: CGFloat { size * 0.24 }

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: corner, style: .continuous)
        .fill(badgeColor)
      if let image = resolvedImage {
        Image(nsImage: image)
          .resizable()
          .interpolation(.high)
          .aspectRatio(contentMode: .fit)
          .frame(width: size * glyphScale, height: size * glyphScale)
      } else {
        Image(systemName: fallbackSymbol)
          .font(.system(size: size * 0.38, weight: .semibold))
          .foregroundStyle(.white)
          .symbolRenderingMode(.monochrome)
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: corner, style: .continuous)
        .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
    )
    .accessibilityHidden(true)
  }

  private var normalized: String {
    id.lowercased()
      .split(whereSeparator: { $0 == "/" || $0 == ":" })
      .first
      .map(String.init) ?? id.lowercased()
  }

  private var family: String { nativeProviderFamily(normalized) }

  private var resolvedImage: NSImage? {
    if let brand = bundledBrandImage { return brand }
    if let app = installedAppImage { return app }
    return nil
  }

  private var glyphScale: CGFloat {
    installedAppImage != nil && bundledBrandImage == nil ? 0.78 : 0.58
  }

  private var installedAppImage: NSImage? {
    let paths: [String: [String]] = [
      "claude": ["/Applications/Claude.app"],
      "openai": ["/Applications/Codex.app", "/Applications/ChatGPT.app"],
      "gemini": [
        "/Applications/Google Gemini.app",
        "/Applications/Antigravity.app",
        "/Applications/Antigravity IDE.app",
      ],
      "kiro": ["/Applications/Kiro.app", "/Applications/Kiro CLI.app"],
    ]
    guard
      let path = paths[family]?.first(where: { FileManager.default.fileExists(atPath: $0) })
    else { return nil }
    let icon = NSWorkspace.shared.icon(forFile: path)
    let px = max(64, Int(size * 2))
    let square = NSImage(size: NSSize(width: px, height: px))
    square.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high
    icon.draw(
      in: NSRect(x: 0, y: 0, width: px, height: px),
      from: .zero,
      operation: .sourceOver,
      fraction: 1
    )
    square.unlockFocus()
    return square
  }

  private var bundledBrandImage: NSImage? {
    let assetNames: [String: String] = [
      "claude": "claude.svg",
      "openai": "openai.svg",
      "gemini": "googlegemini.svg",
      "opencode": "opencode.svg",
      "openrouter": "openrouter.svg",
      "kiro": "kiro.svg",
      "grok": "grok.svg",
    ]
    guard let name = assetNames[family] else { return nil }
    for url in Self.iconSearchURLs(name: name) {
      if let image = NSImage(contentsOf: url) {
        let px = max(64, Int(size * 2))
        image.size = NSSize(width: px, height: px)
        return image
      }
    }
    return nil
  }

  private static func iconSearchURLs(name: String) -> [URL] {
    var urls: [URL] = []
    // Production first: app bundle Resources (HIG: ship assets with the helper).
    if let resource = Bundle.main.resourceURL {
      urls.append(resource.appendingPathComponent("icons/\(name)"))
      urls.append(resource.appendingPathComponent(name))
    }
    if let resourcePath = Bundle.main.resourcePath {
      urls.append(URL(fileURLWithPath: resourcePath).appendingPathComponent("icons/\(name)"))
    }
    if let exeDir = Bundle.main.executableURL?.deletingLastPathComponent() {
      // Contents/MacOS → sibling Resources/icons (AnyPick.app layout).
      let resources = exeDir.deletingLastPathComponent().appendingPathComponent("Resources")
      urls.append(resources.appendingPathComponent("icons/\(name)"))
      urls.append(exeDir.appendingPathComponent("icons/\(name)"))
      urls.append(exeDir.appendingPathComponent(name))
    }
    if let iconDirectory = ProcessInfo.processInfo.environment["ANYPICK_TRAY_ICON_DIR"] {
      urls.append(URL(fileURLWithPath: iconDirectory).appendingPathComponent(name))
    }
    // Runtime stage used by the Node supervisor when launching the helper.
    let home = FileManager.default.homeDirectoryForCurrentUser
    let runtime = home.appendingPathComponent(".anypick/runtime", isDirectory: true)
    if let enumerator = FileManager.default.enumerator(
      at: runtime,
      includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles]
    ) {
      var checked = 0
      for case let url as URL in enumerator {
        checked += 1
        if checked > 40 { break }
        if url.lastPathComponent == "icons" {
          urls.append(url.appendingPathComponent(name))
        }
      }
    }
    #if DEBUG
    // Dev-only fallbacks — never relied on in release builds.
    urls.append(URL(fileURLWithPath: "/private/tmp/icons/\(name)"))
    urls.append(URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
      .appendingPathComponent("src/tray/icons/\(name)"))
    #endif
    return urls
  }

  private var badgeColor: Color {
    switch family {
    case "proxy-hub", "hub": return anypickViolet
    // Claude brand coral.
    case "claude": return Color(red: 0.85, green: 0.47, blue: 0.34)
    // OpenAI / Codex wordmark is black on light; dark plate for white glyph.
    case "openai": return Color(red: 0.10, green: 0.10, blue: 0.11)
    // Gemini blue (multi-color mark simplified for monochrome glyph).
    case "gemini": return Color(red: 0.26, green: 0.52, blue: 0.96)
    // OpenCode brand is near-black charcoal.
    case "opencode": return Color(red: 0.13, green: 0.12, blue: 0.12)
    // OpenRouter indigo.
    case "openrouter": return Color(red: 0.40, green: 0.40, blue: 0.95)
    // Kiro (AWS) violet.
    case "kiro": return Color(red: 0.49, green: 0.35, blue: 0.85)
    // Grok / xAI black plate.
    case "grok": return Color(red: 0.08, green: 0.08, blue: 0.09)
    default: return Color(nsColor: .tertiaryLabelColor).opacity(0.35)
    }
  }

  private var fallbackSymbol: String {
    switch family {
    case "proxy-hub", "hub": return "point.3.connected.trianglepath.dotted"
    case "claude": return "sun.max.fill"
    case "openai": return "circle.grid.cross.fill"
    case "gemini": return "sparkles"
    case "opencode": return "terminal.fill"
    case "openrouter": return "arrow.triangle.branch"
    case "kiro": return "cube.fill"
    case "grok": return "xmark"
    default: return "app.fill"
    }
  }
}

/// Settings-like inset group — translucent material so glass/vibrancy stays alive.
extension View {
  func nativeGroup() -> some View {
    background(
      nativeGroupMaterial,
      in: RoundedRectangle(cornerRadius: TraySpacing.groupRadius, style: .continuous)
    )
    .clipShape(RoundedRectangle(cornerRadius: TraySpacing.groupRadius, style: .continuous))
  }
}

/// Amber/accent attention strip used for hub warnings and routing prompts.
/// Uses press-only button chrome so hover does not muddy the tinted fill.
struct TrayAttentionCallout: View {
  enum Kind {
    case warning
    case info
  }

  let kind: Kind
  let title: String
  var actionTitle: String = "Review"
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .center, spacing: 10) {
        Image(systemName: symbol)
          .font(.callout.weight(.semibold))
          .foregroundStyle(accent)
          .frame(width: 18, alignment: .center)
        Text(title)
          .font(.callout.weight(.medium))
          .foregroundStyle(Color.primary)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 8)
        Text(actionTitle)
          .font(.callout.weight(.semibold))
          .foregroundStyle(Color.accentColor)
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(fill)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(accent.opacity(0.22), lineWidth: 0.5)
      )
    }
    .trayCalloutButton(cornerRadius: 8)
    .accessibilityHint(actionTitle)
  }

  private var symbol: String {
    switch kind {
    case .warning: return "exclamationmark.triangle.fill"
    case .info: return "person.crop.circle.badge.questionmark"
    }
  }

  private var accent: Color {
    switch kind {
    case .warning: return anypickAmber
    case .info: return Color.accentColor
    }
  }

  private var fill: Color {
    switch kind {
    case .warning: return anypickAmber.opacity(0.12)
    case .info: return Color.accentColor.opacity(0.08)
    }
  }
}

/// Standard empty state — ContentUnavailableView when available.
struct NativeEmptyState: View {
  let title: String
  let systemImage: String
  let description: String
  var actionTitle: String? = nil
  var action: (() -> Void)? = nil

  var body: some View {
    VStack(spacing: 10) {
      if #available(macOS 14.0, *) {
        ContentUnavailableView(
          title,
          systemImage: systemImage,
          description: Text(description)
        )
      } else {
        Image(systemName: systemImage)
          .font(.system(size: 28, weight: .regular))
          .foregroundStyle(.secondary)
          .symbolRenderingMode(.hierarchical)
        Text(title)
          .font(.headline)
        Text(description)
          .font(.callout)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 320)
      }
      if let actionTitle, let action {
        Button(actionTitle, action: action)
          .buttonStyle(.borderedProminent)
          .controlSize(.regular)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 40)
  }
}

/// Placeholder while waiting for the first supervisor snapshot (HIG: no empty-flash).
struct NativeSnapshotLoading: View {
  var compact: Bool = false

  var body: some View {
    VStack(spacing: compact ? 8 : 12) {
      ProgressView()
        .controlSize(compact ? .small : .regular)
      Text("Loading AnyPick…")
        .font(compact ? .caption : .callout)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, compact ? 28 : 48)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Loading AnyPick")
  }
}

/// Whether the setup checklist should appear for the current store + prefs.
@MainActor
func trayShouldShowOnboarding(store: TrayStore, dismissed: Bool) -> Bool {
  guard store.snapshotReady else { return false }
  // Empty install: always guide (resetOnboardingIfEmpty clears a prior dismiss).
  if store.isFirstRun { return true }
  if dismissed { return false }
  return !trayOnboardingCoreComplete(store: store)
}

@MainActor
func trayOnboardingCoreComplete(store: TrayStore) -> Bool {
  let hasAccount = !store.accounts.isEmpty || !store.gateways.isEmpty
  let hasApp = store.hasInstalledClient
  let hasRoute = store.routes.contains { ($0.source?.isEmpty == false) }
    || store.actions.contains(where: \.selected)
  return hasAccount && hasApp && hasRoute
}

/// Guided first-run checklist (System Settings–style tip cards).
struct NativeOnboardingChecklist: View {
  let store: TrayStore
  let openAccounts: () -> Void
  let openHub: (() -> Void)?
  var compact: Bool = false
  @AppStorage(TrayPreferences.Key.onboardingDismissed) private var onboardingDismissed = false

  private var hasAccount: Bool { !store.accounts.isEmpty || !store.gateways.isEmpty }
  private var hasApp: Bool { store.hasInstalledClient }
  private var hasRoute: Bool {
    store.routes.contains { ($0.source?.isEmpty == false) }
      || store.actions.contains(where: \.selected)
  }
  private var hubReady: Bool {
    guard let hub = store.proxyHub else { return true }
    return (hub.sourceCount ?? 0) > 0
  }

  private var coreComplete: Bool { hasAccount && hasApp && hasRoute }

  var body: some View {
    VStack(alignment: .leading, spacing: compact ? 10 : 14) {
      HStack(alignment: .top, spacing: 10) {
        AnyPickBrandMark()
        .frame(width: compact ? 28 : 32, height: compact ? 28 : 32)
        .accessibilityHidden(true)

        VStack(alignment: .leading, spacing: 2) {
          Text(store.isFirstRun ? "Welcome to AnyPick" : "Finish setup")
            .font(compact ? .callout.weight(.semibold) : .headline)
          Text(
            compact
              ? (store.isFirstRun
                ? "Save a login, then pick a route."
                : "A few steps left.")
              : (store.isFirstRun
                ? "Save a login, then route Claude Code or Codex."
                : "A few steps left so apps can use your accounts.")
          )
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        }

        Spacer(minLength: 4)

        Button {
          dismiss()
        } label: {
          Image(systemName: "xmark")
            .font(.caption.weight(.bold))
            .foregroundStyle(.secondary)
            .frame(width: 22, height: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
        .help("Dismiss setup tips")
        .accessibilityLabel("Dismiss setup tips")
      }

      VStack(spacing: 0) {
        onboardingStep(
          done: hasAccount,
          title: compact ? "Save account" : "Save an account",
          detail: compact
            ? "Detect a login already on this Mac."
            : "Capture a login already signed in on this Mac.",
          actionTitle: hasAccount ? nil : "Add Account",
          action: hasAccount ? nil : openAccounts
        )
        Divider().padding(.leading, 36)
        onboardingStep(
          done: hasApp,
          title: compact ? "Installed app" : "Use an installed app",
          detail: hasApp
            ? (compact ? "Client available." : "Claude Code, Codex, or another supported client is available.")
            : (compact
              ? "Install Claude Code or Codex, then refresh."
              : "Install Claude Code or Codex, sign in, then refresh."),
          actionTitle: hasApp ? nil : "Refresh",
          action: hasApp ? nil : { store.refreshAll() }
        )
        Divider().padding(.leading, 36)
        onboardingStep(
          done: hasRoute,
          title: compact ? "Pick route" : "Pick a route",
          detail: compact
            ? "Switch each app to an account or hub."
            : "Switch each app to a saved account, proxy, or Proxy Hub.",
          actionTitle: nil,
          action: nil
        )
        // Hub step only in the main window — keeps the menu-bar panel scannable.
        if !compact, store.proxyHub != nil, let openHub {
          Divider().padding(.leading, 36)
          onboardingStep(
            done: hubReady,
            title: "Optional · Proxy Hub",
            detail: hubReady
              ? "Hub sources are ready for multi-model routing."
              : "Enable hub sources when you want one local endpoint for many models.",
            actionTitle: hubReady ? nil : "Set Up Hub",
            action: hubReady ? nil : openHub
          )
        }
      }
      .nativeGroup()

      HStack(spacing: 10) {
        Button("Not Now", action: dismiss)
          .buttonStyle(.bordered)
          .controlSize(.small)
        Spacer(minLength: 0)
        Text(progressLabel)
          .font(.caption2.weight(.medium).monospacedDigit())
          .foregroundStyle(.tertiary)
          .accessibilityLabel("Setup progress \(progressLabel)")
      }
      .padding(.horizontal, 2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, compact ? 4 : 8)
    .onAppear {
      TrayPreferences.resetOnboardingIfEmpty(isFirstRun: store.isFirstRun)
      if store.isFirstRun { onboardingDismissed = false }
    }
    .onChange(of: store.isFirstRun) { _, isFirst in
      if isFirst { onboardingDismissed = false }
    }
    .onChange(of: coreComplete) { _, done in
      // Hide tips as soon as the three core steps succeed (Hub remains optional).
      if done { dismiss() }
    }
  }

  private var progressLabel: String {
    let done = [hasAccount, hasApp, hasRoute].filter(\.self).count
    return "\(done) of 3"
  }

  private func dismiss() {
    withAnimation(TrayMotion.standard) {
      onboardingDismissed = true
    }
  }

  @ViewBuilder
  private func onboardingStep(
    done: Bool,
    title: String,
    detail: String,
    actionTitle: String?,
    action: (() -> Void)?
  ) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: done ? "checkmark.circle.fill" : "circle")
        .font(.body.weight(.semibold))
        .foregroundStyle(done ? anypickSuccess : Color.secondary.opacity(0.55))
        .frame(width: 22, height: 22)
        .symbolRenderingMode(.hierarchical)
        .accessibilityLabel(done ? "Completed" : "Not completed")

      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.callout.weight(.semibold))
          .strikethrough(done, color: .secondary)
          .foregroundStyle(done ? .secondary : .primary)
        Text(detail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        if let actionTitle, let action {
          Button(actionTitle, action: action)
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .padding(.top, 4)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, TraySpacing.rowPadding)
    .padding(.vertical, compact ? 8 : 10)
    .accessibilityElement(children: .combine)
  }
}

/// Search field chrome matching system rounded fields (NSSearchField density).
struct NativeSearchField: View {
  let placeholder: String
  @Binding var text: String
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "magnifyingglass")
        .font(.body.weight(.medium))
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
      TextField(placeholder, text: $text)
        .textFieldStyle(.plain)
        .focused($focused)
        .submitLabel(.search)
      if !text.isEmpty {
        Button {
          text = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(.secondary)
            .frame(width: 18, height: 18)
            .contentShape(Rectangle())
        }
        .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
        .help("Clear search")
        .accessibilityLabel("Clear search")
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(Color(nsColor: .controlBackgroundColor).opacity(0.55))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(
          focused ? Color.accentColor.opacity(0.55) : nativeStroke.opacity(0.7),
          lineWidth: focused ? 1.5 : 0.5
        )
    )
    .animation(.easeOut(duration: 0.12), value: focused)
    .accessibilityElement(children: .contain)
  }
}

func nativeProviderName(_ providerId: String) -> String {
  switch nativeProviderFamily(providerId) {
  case "claude": return "Claude"
  case "openai": return "OpenAI"
  case "gemini": return "Google Gemini"
  case "kiro": return "Kiro"
  case "openrouter": return "OpenRouter"
  case "opencode": return "OpenCode"
  case "grok": return "Grok"
  case "proxy-hub": return "Proxy Hub"
  default:
    return providerId
      .split(separator: "-")
      .map { $0.prefix(1).uppercased() + $0.dropFirst() }
      .joined(separator: " ")
  }
}

func nativeProviderFamily(_ providerId: String) -> String {
  let normalized = providerId.lowercased()
    .split(whereSeparator: { $0 == "/" || $0 == ":" })
    .first
    .map(String.init) ?? providerId.lowercased()
  switch normalized {
  case "anthropic", "claude", "claude-code": return "claude"
  case "codex", "openai": return "openai"
  case "gemini", "gemini-cli", "antigravity": return "gemini"
  case "grok", "xai", "x-ai": return "grok"
  case "proxy-hub", "hub": return "proxy-hub"
  default: return normalized
  }
}

func nativeProviderRank(_ providerId: String) -> Int {
  switch nativeProviderFamily(providerId) {
  case "openai": return 0
  case "claude": return 1
  case "gemini": return 2
  case "kiro": return 3
  case "grok": return 4
  case "opencode": return 5
  case "openrouter": return 6
  default: return 10
  }
}
