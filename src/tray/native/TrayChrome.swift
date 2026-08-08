import AppKit
import Foundation
import SwiftUI

// Module: TrayChrome.swift — chips, icons, status LEDs, groups, usage meter

// MARK: - Compact route chip (Quick Panel density)

/// Small selectable chip for quick route switching in the menu-bar panel.
/// Leading mark is the provider brand badge (not account initials) so mixed
/// account lists stay scannable at a glance.
struct TrayRouteChip: View {
  let providerId: String
  let title: String
  var selected: Bool
  var disabled: Bool = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        NativeProviderBadge(id: providerId, size: 16)
        Text(title)
          .font(.caption.weight(.semibold))
          .lineLimit(1)
          .fixedSize(horizontal: true, vertical: false)
        if selected {
          Image(systemName: "checkmark")
            .font(.caption2.weight(.bold))
            .foregroundStyle(anypickSuccess)
        }
      }
      .foregroundStyle(selected ? Color.primary : Color.secondary)
      .padding(.leading, 6)
      .padding(.trailing, 9)
      .frame(height: 26)
      .background(
        Capsule(style: .continuous)
          .fill(selected ? Color.accentColor.opacity(0.16) : nativeChipFill)
      )
      .contentShape(Capsule())
    }
    // Style owns hover overlay + pointer — no second trayHovering.
    .buttonStyle(AnyPickPlainButtonStyle(chrome: .capsule, drawsFill: true))
    .disabled(disabled)
    .opacity(disabled ? 0.45 : 1)
    .scaleEffect(selected ? 1.0 : 0.98)
    .animation(TrayMotion.snappy, value: selected)
    // Keep intrinsic width so a chip strip can overflow and scroll.
    .fixedSize(horizontal: true, vertical: true)
  }
}

/// Horizontal chip strip that scrolls inside the quick-panel vertical ScrollView.
/// Uses AppKit: SwiftUI nested ScrollView routinely compresses content and
/// never overflows, and vertical parents steal trackpad pans.
struct TrayChipStrip<Content: View>: View {
  var leadingInset: CGFloat = 40
  @ViewBuilder var content: () -> Content

  var body: some View {
    HorizontalChipScrollView {
      HStack(spacing: 6) {
        content()
      }
      .padding(.leading, leadingInset)
      .padding(.trailing, 8)
      // Force intrinsic width — without this the hosting view reports clip width.
      .fixedSize(horizontal: true, vertical: false)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    // Room for overlay scroller when chips overflow (HIG: show affordance).
    .frame(height: 34)
  }
}

/// AppKit horizontal scroller sized with `sizeThatFits` (not `fittingSize`).
private struct HorizontalChipScrollView<Content: View>: NSViewRepresentable {
  @ViewBuilder var content: () -> Content

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  func makeNSView(context: Context) -> ChipStripNSScrollView {
    let scroll = ChipStripNSScrollView()
    scroll.drawsBackground = false
    scroll.borderType = .noBorder
    // Overlay scroller appears on overflow so chips are discoverable without a trackpad.
    scroll.hasHorizontalScroller = true
    scroll.hasVerticalScroller = false
    scroll.autohidesScrollers = true
    scroll.scrollerStyle = .overlay
    scroll.horizontalScrollElasticity = .allowed
    scroll.verticalScrollElasticity = .none
    scroll.allowsMagnification = false
    // false: a mostly-vertical pan still reaches this strip (parent won't steal it first).
    scroll.usesPredominantAxisScrolling = false
    scroll.scrollerInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)

    let host = NSHostingView(rootView: content())
    // Frame-based document sizing — Auto Layout constraints break document width.
    host.translatesAutoresizingMaskIntoConstraints = true
    scroll.documentView = host
    context.coordinator.host = host
    context.coordinator.scroll = scroll
    context.coordinator.relayout()
    return scroll
  }

  func updateNSView(_ scrollView: ChipStripNSScrollView, context: Context) {
    guard let host = context.coordinator.host else { return }
    host.rootView = content()
    context.coordinator.scroll = scrollView
    context.coordinator.relayout()
    // Hosting views often report 0 width until the next runloop after rootView changes.
    DispatchQueue.main.async {
      context.coordinator.relayout()
    }
  }

  final class Coordinator {
    var host: NSHostingView<Content>?
    weak var scroll: ChipStripNSScrollView?

    func relayout() {
      guard let host, let scroll else { return }
      let height: CGFloat = 28
      let fitted = host.fittingSize
      let width = max(ceil(fitted.width), 1)
      let newFrame = NSRect(x: 0, y: 0, width: width, height: height)
      if host.frame != newFrame {
        host.frame = newFrame
      }
      scroll.reflectScrolledClipView(scroll.contentView)
      // Only show the scroller when content actually overflows the clip.
      let overflows = width > scroll.contentView.bounds.width + 0.5
      scroll.hasHorizontalScroller = overflows
    }
  }
}

/// Horizontal-only strip that maps vertical trackpad pans to X when content overflows.
final class ChipStripNSScrollView: NSScrollView {
  override var intrinsicContentSize: NSSize {
    NSSize(width: NSView.noIntrinsicMetric, height: 34)
  }

  override var documentView: NSView? {
    didSet {
      (oldValue as? NSHostingView<AnyView>)?.removeFromSuperview()
    }
  }

  override func layout() {
    super.layout()
    guard let host = documentView else { return }
    let height: CGFloat = 28
    // Remeasure when SwiftUI assigns a new clip width.
    if let hosting = host as? NSHostingView<AnyView> {
      let fitted = hosting.fittingSize
      let width = max(ceil(fitted.width), 1)
      if abs(host.frame.width - width) > 0.5 {
        host.setFrameSize(NSSize(width: width, height: height))
      }
    } else if host.frame.height != height {
      host.setFrameSize(NSSize(width: max(host.frame.width, 1), height: height))
    }
  }

  override func scrollWheel(with event: NSEvent) {
    let docWidth = documentView?.bounds.width ?? 0
    let clipWidth = contentView.bounds.width
    let canScrollX = docWidth > clipWidth + 0.5

    if canScrollX {
      // Vertical-dominant pans (normal trackpad) → scroll this strip horizontally.
      // Otherwise the parent vertical ScrollView eats the gesture and chips feel stuck.
      let dx: CGFloat
      if abs(event.scrollingDeltaX) >= abs(event.scrollingDeltaY) {
        dx = event.scrollingDeltaX
      } else {
        dx = event.scrollingDeltaY
      }
      if dx != 0 {
        let maxX = max(0, docWidth - clipWidth)
        var origin = contentView.bounds.origin
        // scrollingDelta is inverted vs bounds origin.
        origin.x = min(maxX, max(0, origin.x - dx))
        contentView.setBoundsOrigin(origin)
        reflectScrolledClipView(contentView)
        return
      }
    }
    // Fully scrolled or no overflow — let the parent vertical panel scroll.
    super.scrollWheel(with: event)
  }

  override func wantsForwardedScrollEvents(for axis: NSEvent.GestureAxis) -> Bool {
    axis == .horizontal || axis == .vertical
  }
}

// MARK: - Brand mark & tray icon

struct AnyPickMark: Shape {
  func path(in rect: CGRect) -> Path {
    let side = min(rect.width, rect.height)
    let scale = side / 64
    let offsetX = rect.midX - side / 2
    let offsetY = rect.midY - side / 2
    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: offsetX + x * scale, y: offsetY + y * scale)
    }
    func circle(_ x: CGFloat, _ y: CGFloat, _ radius: CGFloat) -> CGRect {
      CGRect(
        x: offsetX + (x - radius) * scale,
        y: offsetY + (y - radius) * scale,
        width: radius * 2 * scale,
        height: radius * 2 * scale
      )
    }

    var branches = Path()
    branches.move(to: point(14, 14))
    branches.addLine(to: point(23, 14))
    branches.addLine(to: point(36, 24))
    branches.move(to: point(14, 32))
    branches.addLine(to: point(29, 32))
    branches.move(to: point(14, 50))
    branches.addLine(to: point(23, 50))
    branches.addLine(to: point(36, 40))
    branches.move(to: point(30, 14))
    branches.addLine(to: point(50, 32))
    branches.addLine(to: point(30, 50))
    var mark = branches.strokedPath(
      StrokeStyle(lineWidth: 7.5 * scale, lineCap: .round, lineJoin: .round)
    )
    for (x, y, radius) in [(10, 14, 5.6), (10, 32, 5.6), (10, 50, 5.6)] {
      mark.addEllipse(in: circle(CGFloat(x), CGFloat(y), CGFloat(radius)))
    }
    return mark
  }
}

/// The supplied app icon is a violet surface with the white brand symbol.
struct AnyPickBrandMark: View {
  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(
          LinearGradient(
            colors: [anypickVioletLight, anypickVioletDark],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
      AnyPickMark()
        .fill(.white)
        .padding(8)
    }
  }
}

enum AnyPickTrayIcon {
  static let image: NSImage = {
    let icon = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
      let scale: CGFloat = 18 / 64
      func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(x: x * scale, y: y * scale)
      }
      func circle(_ x: CGFloat, _ y: CGFloat, _ radius: CGFloat) -> NSRect {
        NSRect(
          x: (x - radius) * scale,
          y: (y - radius) * scale,
          width: radius * 2 * scale,
          height: radius * 2 * scale
        )
      }

      let branches = NSBezierPath()
      branches.move(to: point(14, 14))
      branches.line(to: point(23, 14))
      branches.line(to: point(36, 24))
      branches.move(to: point(14, 32))
      branches.line(to: point(29, 32))
      branches.move(to: point(14, 50))
      branches.line(to: point(23, 50))
      branches.line(to: point(36, 40))
      branches.move(to: point(30, 14))
      branches.line(to: point(50, 32))
      branches.line(to: point(30, 50))
      branches.lineWidth = 7.5 * scale
      branches.lineCapStyle = .round
      branches.lineJoinStyle = .round
      NSColor.black.setFill()
      NSColor.black.setStroke()
      branches.stroke()
      for (x, y, radius) in [(10, 14, 5.6), (10, 32, 5.6), (10, 50, 5.6)] {
        NSBezierPath(ovalIn: circle(CGFloat(x), CGFloat(y), CGFloat(radius))).fill()
      }
      return true
    }
    icon.isTemplate = true
    icon.accessibilityDescription = "AnyPick"
    return icon
  }()
}

/// Dock / Cmd-Tab app icon (color brand mark). Prefers bundle Resources, then generated mark.
enum AnyPickAppIcon {
  static let image: NSImage = {
    if let bundled = NSImage(named: "AppIcon") { return bundled }
    if let url = Bundle.main.url(forResource: "AppIcon", withExtension: "icns")
      ?? Bundle.main.url(forResource: "AppIcon", withExtension: "png"),
      let image = NSImage(contentsOf: url)
    {
      return image
    }
    if let exeDir = Bundle.main.executableURL?.deletingLastPathComponent() {
      let resources = exeDir.deletingLastPathComponent().appendingPathComponent("Resources")
      for file in ["AppIcon.icns", "AppIcon.png"] {
        let url = resources.appendingPathComponent(file)
        if let image = NSImage(contentsOf: url) { return image }
      }
    }
    return generatedColorMark(size: 256)
  }()

  static func applyToApp() {
    NSApp.applicationIconImage = image
  }

  private static func generatedColorMark(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
      let background = NSBezierPath(
        roundedRect: rect,
        xRadius: size * 14 / 64,
        yRadius: size * 14 / 64
      )
      NSGradient(
        starting: NSColor(red: 139 / 255, green: 92 / 255, blue: 246 / 255, alpha: 1),
        ending: NSColor(red: 109 / 255, green: 40 / 255, blue: 217 / 255, alpha: 1)
      )?.draw(in: background, angle: -45)

      let scale = size * 0.75 / 64
      let offset = size * 0.125
      func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(x: offset + x * scale, y: offset + y * scale)
      }
      func circle(_ x: CGFloat, _ y: CGFloat, _ radius: CGFloat) -> NSRect {
        NSRect(
          x: offset + (x - radius) * scale,
          y: offset + (y - radius) * scale,
          width: radius * 2 * scale,
          height: radius * 2 * scale
        )
      }
      let branches = NSBezierPath()
      branches.move(to: point(14, 14))
      branches.line(to: point(23, 14))
      branches.line(to: point(36, 24))
      branches.move(to: point(14, 32))
      branches.line(to: point(29, 32))
      branches.move(to: point(14, 50))
      branches.line(to: point(23, 50))
      branches.line(to: point(36, 40))
      branches.move(to: point(30, 14))
      branches.line(to: point(50, 32))
      branches.line(to: point(30, 50))
      branches.lineWidth = 7.5 * scale
      branches.lineCapStyle = .round
      branches.lineJoinStyle = .round
      NSColor.white.setFill()
      NSColor.white.setStroke()
      branches.stroke()
      for (x, y, radius) in [(10, 14, 5.6), (10, 32, 5.6), (10, 50, 5.6)] {
        NSBezierPath(ovalIn: circle(CGFloat(x), CGFloat(y), CGFloat(radius))).fill()
      }
      return true
    }
    image.accessibilityDescription = "AnyPick"
    return image
  }
}

struct AnyPickBusyIndicator: View {
  var isBusy: Bool

  var body: some View {
    ZStack {
      if isBusy {
        ProgressView()
          .controlSize(.small)
      }
    }
    .frame(width: 16, height: 16)
    .accessibilityLabel(isBusy ? "Working" : "")
  }
}

// MARK: - Status

struct TrayLed: View {
  enum Kind { case on, off, warn }
  var kind: Kind

  var body: some View {
    Circle()
      .fill(fill)
      .frame(width: 7, height: 7)
      .accessibilityLabel(label)
  }

  private var fill: Color {
    switch kind {
    case .on: return anypickSuccess
    case .warn: return anypickAmber
    case .off: return Color.secondary.opacity(0.35)
    }
  }

  private var label: String {
    switch kind {
    case .on: return "Active"
    case .warn: return "Needs attention"
    case .off: return "Inactive"
    }
  }
}

struct NativeStatusDot: View {
  enum Kind { case on, off, warn, error }
  var kind: Kind
  var title: String? = nil

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(fill)
        .frame(width: 7, height: 7)
      if let title {
        Text(title)
          .font(.caption)
          .foregroundStyle(Color.secondary)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(title ?? defaultLabel)
  }

  private var fill: Color {
    switch kind {
    case .on: return anypickSuccess
    case .warn: return anypickAmber
    case .error: return anypickRed
    case .off: return Color.secondary.opacity(0.35)
    }
  }

  private var defaultLabel: String {
    switch kind {
    case .on: return "Active"
    case .warn: return "Needs attention"
    case .error: return "Error"
    case .off: return "Inactive"
    }
  }
}

// MARK: - Section chrome (Quick Panel)

struct TraySectionHeader: View {
  let title: String
  var actionTitle: String? = nil
  var action: (() -> Void)? = nil

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.secondary)
      Spacer()
      if let actionTitle, let action {
        Button(action: action) {
          Text(actionTitle)
            .font(.callout.weight(.semibold))
            .foregroundStyle(Color.accentColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
        }
        .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
      }
    }
    .padding(.horizontal, 2)
  }
}

struct TrayGroup<Content: View>: View {
  @ViewBuilder var content: () -> Content

  var body: some View {
    VStack(spacing: 0) {
      content()
    }
    // Glass group: material, not opaque controlBackground (HIG vibrancy).
    .background(nativeGroupMaterial, in: RoundedRectangle(cornerRadius: TraySpacing.groupRadius, style: .continuous))
    .clipShape(RoundedRectangle(cornerRadius: TraySpacing.groupRadius, style: .continuous))
  }
}

func anypickDisplayName(_ client: String) -> String {
  switch client.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "claude", "claude-code": return "Claude Code"
  case "codex": return "Codex"
  case "gemini", "gemini-cli": return "Gemini"
  case "kiro": return "Kiro"
  default: return client
  }
}

/// Shared confirm copy when switching routes that reset model role overrides.
func trayRouteResetMessage(client: String? = nil, overrideCount: Int, destination: String) -> String {
  let who = client.map { anypickDisplayName($0) + " " } ?? ""
  let roles = "\(overrideCount) custom \(who)model role\(overrideCount == 1 ? "" : "s")"
  return "\(roles) will return to \(destination) defaults."
}

struct TrayUsageMeter: View {
  let usage: UsageSnapshot?
  var compact: Bool = false
  var barWidth: CGFloat = 56

  /// Dynamic Type–scaled width so Usage + Switch columns still align.
  @ScaledMetric(relativeTo: .caption) private var compactWidth: CGFloat = 76
  @ScaledMetric(relativeTo: .caption) private var fullWidth: CGFloat = 104
  @ScaledMetric(relativeTo: .caption) private var scaledBarWidth: CGFloat = 56

  private var windows: [UsageWindow] {
    Array((usage?.windows ?? []).prefix(compact ? 1 : 2))
  }

  private var effectiveBarWidth: CGFloat { compact ? compactWidth - 4 : min(barWidth, scaledBarWidth) }

  var body: some View {
    Group {
      if windows.isEmpty {
        // Reserve space so Switch doesn't jump left when a row has no quota.
        if compact {
          Color.clear.frame(width: compactWidth, height: 1)
        }
      } else {
        VStack(alignment: .trailing, spacing: compact ? 2 : 5) {
          ForEach(Array(windows.enumerated()), id: \.offset) { _, window in
            windowRow(window)
          }
        }
        .frame(width: compact ? compactWidth : fullWidth, alignment: .trailing)
        .accessibilityElement(children: .combine)
      }
    }
  }

  @ViewBuilder
  private func windowRow(_ window: UsageWindow) -> some View {
    let color = trayUsageColor(window.remainingPercent)
    if compact {
      // Product language: “Usage · N%” + bar (never a bare percentage).
      VStack(alignment: .trailing, spacing: 3) {
        Text("Usage · \(window.remainingPercent)%")
          .font(.caption2.weight(.semibold).monospacedDigit())
          .foregroundStyle(color)
          .lineLimit(1)
          .minimumScaleFactor(0.75)
        Capsule()
          .fill(Color.primary.opacity(0.10))
          .frame(width: effectiveBarWidth, height: 3)
          .overlay(alignment: .leading) {
            Capsule()
              .fill(color)
              .frame(
                width: max(2, effectiveBarWidth * CGFloat(window.remainingPercent) / 100),
                height: 3
              )
          }
      }
      .frame(width: compactWidth, alignment: .trailing)
      .accessibilityLabel(accessibilityText(window))
    } else {
      VStack(alignment: .trailing, spacing: 3) {
        if windows.count > 1 {
          Text(shortLabel(window.label))
            .font(.caption2.weight(.medium))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        } else {
          Text("Usage")
            .font(.caption2.weight(.medium))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
        Text("\(window.remainingPercent)% left")
          .font(.callout.weight(.semibold).monospacedDigit())
          .foregroundStyle(color)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
        Capsule()
          .fill(Color.primary.opacity(0.10))
          .frame(width: effectiveBarWidth, height: 4)
          .overlay(alignment: .leading) {
            Capsule()
              .fill(color)
              .frame(width: max(2, effectiveBarWidth * CGFloat(window.remainingPercent) / 100), height: 4)
          }
        if let resets = resetCaption(window.resetsAtMs) {
          Text("resets \(resets)")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      .accessibilityLabel(accessibilityText(window))
    }
  }

  private func shortLabel(_ label: String) -> String {
    let t = label.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return "Quota" }
    if t.count <= 12 { return t }
    return String(t.prefix(11)) + "…"
  }

  private func accessibilityText(_ window: UsageWindow) -> String {
    let base = "\(window.remainingPercent) percent remaining"
    if let resets = resetCaption(window.resetsAtMs) {
      return "\(window.label) \(base), resets \(resets)"
    }
    return "\(window.label) \(base)"
  }

  private func resetCaption(_ ms: Double?) -> String? {
    guard let ms, ms > 0 else { return nil }
    let date = Date(timeIntervalSince1970: ms / 1000)
    let delta = date.timeIntervalSinceNow
    if delta <= 0 { return "soon" }
    if delta < 3600 {
      let mins = max(1, Int(delta / 60))
      return "in \(mins)m"
    }
    if delta < 86_400 {
      let hours = Int(delta / 3600)
      return "in \(hours)h"
    }
    let days = Int(delta / 86_400)
    return "in \(days)d"
  }
}
