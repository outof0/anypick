import AppKit
import Foundation
import SwiftUI

// Module: TrayControls.swift — hover, buttons, switches, menus

// MARK: - Interaction helpers
//
// MenuBarExtra often drops SwiftUI `.onHover` and ignores default button cursors.
// Hover + pointing-hand are driven by a non-hit-testing NSTrackingArea probe.
// Hover chrome is always drawn as an *overlay* so it sits above opaque row fills.

/// Transparent NSView that reports mouse enter/exit and sets the hand cursor.
struct TrayHoverProbe: NSViewRepresentable {
  @Binding var isHovering: Bool
  var showsPointer: Bool

  func makeNSView(context: Context) -> TrayHoverNSView {
    let view = TrayHoverNSView()
    view.showsPointer = showsPointer
    view.onHoverChange = { hovering in
      DispatchQueue.main.async {
        if isHovering != hovering { isHovering = hovering }
      }
    }
    return view
  }

  func updateNSView(_ nsView: TrayHoverNSView, context: Context) {
    nsView.showsPointer = showsPointer
    nsView.onHoverChange = { hovering in
      DispatchQueue.main.async {
        if isHovering != hovering { isHovering = hovering }
      }
    }
    // Leaving a disabled surface must drop the hand immediately.
    if !showsPointer, nsView.isHovering {
      nsView.forceExit()
    }
  }
}
final class TrayHoverNSView: NSView {
  var onHoverChange: ((Bool) -> Void)?
  var showsPointer = true
  private(set) var isHovering = false
  private var tracking: NSTrackingArea?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /// Probe must not steal clicks from the SwiftUI button underneath.
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    // mouseMoved keeps the hand cursor alive: hitTest-nil probes lose
    // cursorUpdate races against the real hit-tested AppKit view.
    let area = NSTrackingArea(
      rect: bounds,
      options: [
        .mouseEnteredAndExited,
        .mouseMoved,
        .activeAlways,
        .inVisibleRect,
      ],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    tracking = area
  }

  override func mouseEntered(with event: NSEvent) {
    isHovering = true
    onHoverChange?(true)
    applyCursor()
  }

  override func mouseExited(with event: NSEvent) {
    forceExit()
  }

  override func mouseMoved(with event: NSEvent) {
    if isHovering { applyCursor() }
  }

  func forceExit() {
    guard isHovering else { return }
    isHovering = false
    onHoverChange?(false)
    // `.set()` (not push/pop) — nested probes must not corrupt a cursor stack.
    NSCursor.arrow.set()
  }

  private func applyCursor() {
    guard showsPointer else { return }
    NSCursor.pointingHand.set()
  }

  deinit {
    if isHovering { NSCursor.arrow.set() }
  }
}

extension View {
  /// AppKit-backed hover (MenuBarExtra-safe). Prefer over bare `.onHover`.
  func trayHovering(_ isHovering: Binding<Bool>, showsPointer: Bool = true) -> some View {
    background(TrayHoverProbe(isHovering: isHovering, showsPointer: showsPointer))
  }

  /// Hide system Menu pull-down chevron so custom labels don't double-glyph.
  @ViewBuilder
  func trayMenuIndicatorHidden() -> some View {
    if #available(macOS 14.0, *) {
      self.menuIndicator(.hidden)
    } else {
      self
    }
  }

  /// Shared Menu chrome: no system indicator, no bordered chrome.
  func trayMenuLabel() -> some View {
    self
      .menuStyle(.borderlessButton)
      .trayMenuIndicatorHidden()
      .fixedSize()
  }

  /// Soft hover overlay + pointing hand for non-Button interactive surfaces.
  func anypickInteractive(
    highlight: Bool = true,
    cornerRadius: CGFloat = 8,
    showsPointer: Bool = true
  ) -> some View {
    modifier(
      AnyPickHoverModifier(
        cornerRadius: cornerRadius,
        enabled: highlight,
        showsPointer: showsPointer
      )
    )
    .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
  }

  /// Tinted callout row (amber/accent) — press opacity only, no second hover wash.
  func trayCalloutButton(cornerRadius: CGFloat = 8) -> some View {
    self
      .buttonStyle(
        AnyPickPlainButtonStyle(
          cornerRadius: cornerRadius,
          drawsFill: false
        )
      )
      .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
  }

  /// Pointing-hand only — for system controls (Toggle/switch) that already draw their own chrome.
  func anypickHandCursor(enabled: Bool = true) -> some View {
    modifier(AnyPickHandCursorModifier(enabled: enabled))
  }
}

/// Cursor-only probe; no hover fill.
private struct AnyPickHandCursorModifier: ViewModifier {
  var enabled: Bool
  @State private var hovering = false

  func body(content: Content) -> some View {
    content.trayHovering($hovering, showsPointer: enabled)
  }
}

/// System switch with a pointing-hand cursor in MenuBarExtra / custom panels.
struct AnyPickSwitch: View {
  let title: String
  @Binding var isOn: Bool
  var isEnabled: Bool = true

  var body: some View {
    Toggle(title, isOn: $isOn)
      .labelsHidden()
      .toggleStyle(.switch)
      .controlSize(.small)
      .disabled(!isEnabled)
      .anypickHandCursor(enabled: isEnabled)
      .accessibilityLabel(title)
  }
}

/// Segmented tabs with real hover + pointing-hand (system `Picker`/`NSSegmentedControl` won't).
/// Visually mirrors `NSSegmentedControl` on a vibrancy surface (HIG: selected pill on track).
struct TraySegmentedControl<Value: Hashable>: View {
  @Binding var selection: Value
  let options: [Value]
  var title: (Value) -> String

  var body: some View {
    HStack(spacing: 1) {
      ForEach(Array(options.enumerated()), id: \.offset) { _, option in
        let selected = selection == option
        Button {
          selection = option
        } label: {
          Text(title(option))
            .font(.callout.weight(selected ? .semibold : .regular))
            .foregroundStyle(selected ? Color.primary : Color.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 5)
            .background {
              if selected {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                  .fill(.background.opacity(0.9))
                  .shadow(color: .black.opacity(0.06), radius: 0.5, y: 0.5)
              }
            }
            .contentShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel(title(option))
        .accessibilityAddTraits(.isButton)
      }
    }
    .padding(2)
    .background(
      RoundedRectangle(cornerRadius: 7, style: .continuous)
        .fill(Color.primary.opacity(0.06))
    )
    .accessibilityElement(children: .contain)
  }
}

/// Hover overlay for non-Button rows (Menus, tappable stacks).
struct AnyPickHoverModifier: ViewModifier {
  var cornerRadius: CGFloat
  var enabled: Bool
  var showsPointer: Bool
  @State private var hovering = false

  func body(content: Content) -> some View {
    content
      // Overlay (not background): sits above opaque fills already on the row.
      // Hit-testing off so the fill never steals clicks from the control.
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .fill(enabled && hovering ? nativeHoverFill : .clear)
          .allowsHitTesting(false)
      )
      .trayHovering($hovering, showsPointer: enabled && showsPointer)
      .animation(TrayMotion.snappy, value: hovering)
  }
}

/// Plain button style with visible hover/press overlay and pointing-hand cursor.
/// Use instead of `.buttonStyle(.plain)` / `.borderless` on custom chrome.
struct AnyPickPlainButtonStyle: ButtonStyle {
  enum Chrome {
    case rounded(CGFloat)
    case capsule
  }

  var chrome: Chrome = .rounded(8)
  var showsPointer: Bool = true
  /// When false, only press opacity + cursor (caller owns the fill, e.g. chips).
  var drawsFill: Bool = true

  init(
    cornerRadius: CGFloat = 8,
    showsPointer: Bool = true,
    drawsFill: Bool = true
  ) {
    self.chrome = .rounded(cornerRadius)
    self.showsPointer = showsPointer
    self.drawsFill = drawsFill
  }

  init(
    chrome: Chrome,
    showsPointer: Bool = true,
    drawsFill: Bool = true
  ) {
    self.chrome = chrome
    self.showsPointer = showsPointer
    self.drawsFill = drawsFill
  }

  func makeBody(configuration: Configuration) -> some View {
    AnyPickPlainButtonBody(
      configuration: configuration,
      chrome: chrome,
      showsPointer: showsPointer,
      drawsFill: drawsFill
    )
  }
}

private struct AnyPickPlainButtonBody: View {
  let configuration: ButtonStyle.Configuration
  var chrome: AnyPickPlainButtonStyle.Chrome
  var showsPointer: Bool
  var drawsFill: Bool
  @Environment(\.isEnabled) private var isEnabled
  @State private var hovering = false

  var body: some View {
    configuration.label
      .contentShape(shape)
      // Overlay so hover wins over label backgrounds (chips, tinted rows, etc.).
      .overlay(fillOverlay)
      .opacity(pressOpacity)
      .trayHovering(
        $hovering,
        showsPointer: isEnabled && showsPointer
      )
      .animation(TrayMotion.snappy, value: hovering)
      .animation(TrayMotion.snappy, value: configuration.isPressed)
  }

  @ViewBuilder
  private var fillOverlay: some View {
    if drawsFill {
      shape
        .fill(fillColor)
        .allowsHitTesting(false)
    }
  }

  private var shape: AnyShape {
    switch chrome {
    case .rounded(let radius):
      AnyShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    case .capsule:
      AnyShape(Capsule(style: .continuous))
    }
  }

  private var fillColor: Color {
    guard isEnabled else { return .clear }
    if configuration.isPressed { return nativePressFill }
    if hovering { return nativeHoverFill }
    return .clear
  }

  private var pressOpacity: Double {
    guard isEnabled else { return 1 }
    if configuration.isPressed { return drawsFill ? 0.96 : 0.84 }
    return 1
  }
}

/// Type-erased Shape for contentShape / overlay switching.
private struct AnyShape: Shape, @unchecked Sendable {
  private let pathBuilder: @Sendable (CGRect) -> Path

  init<S: Shape>(_ shape: S) {
    pathBuilder = { rect in shape.path(in: rect) }
  }

  func path(in rect: CGRect) -> Path { pathBuilder(rect) }
}

// MARK: - Shared menu affordances (macOS Settings vocabulary)
//
// Three glyphs only — never mix them:
//   • overflow of secondary actions  →  ellipsis.circle  (⋯)
//   • choose one value / open menu   →  chevron.down
//   • navigate into a child screen   →  chevron.right
// System Menu pull-down indicators are always hidden via `.trayMenuLabel()`.

/// Overflow control for secondary actions (⋯). No text, no system chevron.
struct TrayOverflowMenuLabel: View {
  var body: some View {
    Image(systemName: "ellipsis.circle")
      .font(.body.weight(.medium))
      .foregroundStyle(.secondary)
      .frame(width: 28, height: 28)
      .contentShape(Rectangle())
  }
}

/// HIG pop-up button face: **current value** + chevron.down (no capsule chrome).
/// Title must be the selected value (or "Choose" when empty) — never a verb like "Change".
struct TrayPopupMenuLabel: View {
  var title: String
  var compact: Bool = false

  var body: some View {
    HStack(spacing: 3) {
      Text(title)
        .font((compact ? Font.caption : Font.callout).weight(.medium))
        .foregroundStyle(.primary)
        .lineLimit(1)
      Image(systemName: "chevron.up.chevron.down")
        .font(.system(size: 8, weight: .semibold))
        .foregroundStyle(.secondary)
    }
    .contentShape(Rectangle())
  }
}

/// Route/account switcher. `bordered` matches the product mock (small push-button face).
struct TraySwitchMenu<Content: View>: View {
  var title: String = "Switch"
  var help: String? = nil
  var isEnabled: Bool = true
  var compact: Bool = true
  /// Bordered control for tray rows; borderless for dense pop-up value faces.
  var bordered: Bool = false
  @ViewBuilder var content: () -> Content

  var body: some View {
    Menu(content: content) {
      if bordered {
        HStack(spacing: 3) {
          Text(title)
            .font(.caption.weight(.semibold))
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 2)
      } else {
        TrayPopupMenuLabel(title: title, compact: compact)
      }
    }
    .trayMenuIndicatorHidden()
    .disabled(!isEnabled)
    .help(help ?? title)
    .accessibilityLabel(help ?? title)
    .modifier(TraySwitchMenuChrome(bordered: bordered))
  }
}

private struct TraySwitchMenuChrome: ViewModifier {
  var bordered: Bool

  func body(content: Content) -> some View {
    if bordered {
      content
        .menuStyle(.borderlessButton)
        .buttonStyle(.bordered)
        .controlSize(.small)
        .fixedSize()
    } else {
      content
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
  }
}

/// Navigation disclosure — chevron.right only (HIG: navigate into child).
struct TrayNavigateLabel: View {
  var title: String
  var compact: Bool = false

  var body: some View {
    HStack(spacing: 3) {
      Text(title)
        .font((compact ? Font.caption : Font.callout).weight(.medium))
        .foregroundStyle(.secondary)
        .lineLimit(1)
      Image(systemName: "chevron.right")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.tertiary)
    }
    .contentShape(Rectangle())
  }
}
