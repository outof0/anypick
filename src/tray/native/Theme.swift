import AppKit
import Foundation
import SwiftUI

// Module: Theme.swift — brand tokens, semantic surfaces, spacing

// MARK: - Brand

let anypickNavy = Color(red: 11 / 255, green: 15 / 255, blue: 25 / 255)
let anypickViolet = Color(red: 124 / 255, green: 58 / 255, blue: 237 / 255)
let anypickVioletLight = Color(red: 139 / 255, green: 92 / 255, blue: 246 / 255)
let anypickVioletDark = Color(red: 109 / 255, green: 40 / 255, blue: 217 / 255)
let anypickBlue = Color(red: 96 / 255, green: 165 / 255, blue: 250 / 255)
let anypickBlueBright = Color(red: 96 / 255, green: 165 / 255, blue: 250 / 255)
let anypickSuccess = Color(red: 34 / 255, green: 197 / 255, blue: 94 / 255)
let anypickAmber = Color(red: 245 / 255, green: 158 / 255, blue: 11 / 255)
let anypickRed = Color(red: 239 / 255, green: 68 / 255, blue: 68 / 255)

// MARK: - Semantic surfaces (system-adaptive)
// HIG materials: prefer vibrancy over opaque fills so MenuBarExtra stays glass-like.
// Opaque controlBackground on top of material is what makes the tray look “classic/flat”.

/// Soft fill for chips / nested chrome on materials (not a solid card).
var nativeControlFill: Color { Color.primary.opacity(0.06) }
/// Row hover surface on material.
var nativeHoverFill: Color { Color.primary.opacity(0.08) }
/// Pressed surface.
var nativePressFill: Color { Color.primary.opacity(0.14) }
/// Subtle chip / pill fill.
var nativeChipFill: Color { Color.primary.opacity(0.08) }
/// Hairline stroke matching separators.
var nativeStroke: Color { Color(nsColor: .separatorColor) }
/// Main window content only — never use this on the menu-bar panel.
var nativeWindowFill: Color { Color(nsColor: .windowBackgroundColor) }
/// Translucent group material for tray / settings groups (keeps glass).
var nativeGroupMaterial: Material { .ultraThinMaterial }


enum TraySpacing {
  /// Horizontal inset inside a settings group row.
  static let rowPadding: CGFloat = 12
  /// Inset grouped list corner radius (System Settings–like).
  static let groupRadius: CGFloat = 10
  /// Hairline indent under 28–32pt leading badge (12 pad + 28 badge + 12 gap).
  static let dividerLeading: CGFloat = 52
  /// Outer margin for menu-bar panel / detail content.
  static let outer: CGFloat = 12
  /// Vertical gap between section header and group.
  static let sectionGap: CGFloat = 6
  /// Vertical gap between major sections.
  static let groupGap: CGFloat = 16
  /// Menu-bar panel width (HIG compact utility).
  static let quickPanelWidth: CGFloat = 380
  /// Default max height before screen-clamping.
  static let quickPanelMaxHeight: CGFloat = 480
}

/// Dynamic Type–aware metrics (HIG: scale chrome with content size category).
struct TrayScaledMetrics {
  @ScaledMetric(relativeTo: .body) var badge: CGFloat = 30
  @ScaledMetric(relativeTo: .body) var badgeCompact: CGFloat = 28
  @ScaledMetric(relativeTo: .body) var dividerLeading: CGFloat = 52
  @ScaledMetric(relativeTo: .caption) var usageCompactWidth: CGFloat = 76
  @ScaledMetric(relativeTo: .body) var rowVertical: CGFloat = 10
}

/// Menu-bar panel height clamped to the visible screen (avoids off-screen overflow).
func trayQuickPanelMaxHeight(default defaultHeight: CGFloat = TraySpacing.quickPanelMaxHeight) -> CGFloat {
  guard let screen = NSScreen.main else { return defaultHeight }
  // Leave room for menu bar + Dock; never exceed ~55% of visible height.
  let cap = screen.visibleFrame.height * 0.55
  return min(defaultHeight, max(280, cap))
}

/// Light haptic on successful mutations (trackpad / Force Touch when available).
func trayHapticSuccess() {
  NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .default)
}

func trayHapticError() {
  NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .default)
}

/// Provider id used for brand badges on route chips / pickers.
func trayRouteProviderId(_ action: ActionSnapshot) -> String {
  if action.routeKind == "hub" { return "proxy-hub" }
  return action.upstreamProviderId ?? action.sourceId
}

func trayUsageColor(_ percent: Int) -> Color {
  if percent < 20 { return anypickRed }
  if percent < 45 { return anypickAmber }
  return anypickSuccess
}

// MARK: - Motion (HIG: respect Reduce Motion)

/// Shared animation tokens. Always prefer these over ad-hoc durations.
enum TrayMotion {
  /// ~HIG standard UI change (sidebar, tabs, expand/collapse).
  static var standard: Animation {
    reduceMotionEnabled ? .easeOut(duration: 0.01) : .easeInOut(duration: 0.18)
  }

  /// Slightly snappier control feedback (hover/press already use short durations).
  static var snappy: Animation {
    reduceMotionEnabled ? .easeOut(duration: 0.01) : .easeOut(duration: 0.14)
  }

  /// Message bar / toast enter-exit.
  static var message: Animation {
    reduceMotionEnabled ? .easeOut(duration: 0.01) : .spring(response: 0.32, dampingFraction: 0.86)
  }

  /// Detail / form panel cross-fade.
  static var panelTransition: AnyTransition {
    if reduceMotionEnabled {
      return .opacity
    }
    return .asymmetric(
      insertion: .opacity.combined(with: .offset(y: 6)),
      removal: .opacity
    )
  }

  /// Message bar drop-in from top.
  static var messageTransition: AnyTransition {
    if reduceMotionEnabled {
      return .opacity
    }
    return .move(edge: .top).combined(with: .opacity)
  }

  private static var reduceMotionEnabled: Bool {
    NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  }
}

/// Quota readout. Compact = fixed trailing block for tray rows (aligns with Switch).
