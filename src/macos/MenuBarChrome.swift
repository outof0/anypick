import SwiftUI

/// Board 29 uses the platform accent for actions and selection. AnyPick's
/// brand color remains reserved for its identity assets.
enum TrayPaint {
  static let accent = Color.accentColor
  static let accentInk = Color.accentColor
  static let cardFill = Color(nsColor: .controlBackgroundColor).opacity(0.94)
  static let recessedFill = Color(nsColor: .controlBackgroundColor).opacity(0.62)
  static let hairline = Color.primary.opacity(0.08)
  static let ready = Color(nsColor: .systemGreen)
  static let attention = Color(nsColor: .systemOrange)
}

/// Keep tray copy on the system type ramp. Pencil uses smaller proxy text,
/// but the shipping surface follows the 11 pt product-content floor.
enum TrayFont {
  static let eyebrow = Font.system(size: 10, weight: .semibold)
  static let title = Font.headline
  static let body = Font.subheadline
  static let bodyStrong = Font.subheadline.weight(.semibold)
  static let detail = Font.caption
  static let detailMedium = Font.caption.weight(.medium)
  static let detailStrong = Font.caption.weight(.semibold)
}

func traySectionTitle(_ title: String) -> some View {
  Text(title)
    .font(TrayFont.eyebrow)
    .foregroundStyle(.secondary)
    .textCase(.uppercase)
    .frame(maxWidth: .infinity, alignment: .leading)
}

struct TrayCardSurface<Content: View>: View {
  var radius: CGFloat = 11
  var fill: Color = TrayPaint.cardFill
  var stroke: Color = TrayPaint.hairline
  var strokeWidth: CGFloat = 0.5
  @ViewBuilder var content: () -> Content

  var body: some View {
    content()
      .background(fill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .strokeBorder(stroke, lineWidth: strokeWidth)
      )
  }
}

struct TrayFillButton: View {
  let title: String
  var prominent = true
  var action: () -> Void

  var body: some View {
    if prominent {
      Button(title, action: action)
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
    } else {
      Button(title, action: action)
        .buttonStyle(.bordered)
        .controlSize(.small)
    }
  }
}

struct TrayTextButton: View {
  let title: String
  var action: () -> Void

  var body: some View {
    Button(title, action: action)
      .buttonStyle(.borderless)
      .font(TrayFont.detailMedium)
  }
}

struct TrayAccountChip: View {
  let title: String
  let selected: Bool
  var compact = false
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(selected ? "✓ \(title)" : title)
        .font(selected ? TrayFont.detailStrong : TrayFont.detailMedium)
        .padding(.horizontal, compact ? 6 : 7)
        .frame(height: compact ? 20 : 23)
        .background(chipFill, in: RoundedRectangle(cornerRadius: compact ? 6 : 7, style: .continuous))
        .foregroundStyle(chipInk)
    }
    .buttonStyle(.plain)
  }

  private var chipFill: Color {
    selected ? TrayPaint.accent : Color.primary.opacity(0.08)
  }

  private var chipInk: Color {
    selected ? Color.white : Color.primary.opacity(0.82)
  }
}

struct TrayRoutingHeader: View {
  @ObservedObject var model: MacOSDesignModel
  var showDetails = true
  var openDetails: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      traySectionTitle(model.localized("desktop.nav.proxies"))
      Spacer(minLength: 4)
      if showDetails {
        Button(model.localized("desktop.common.show_details"), action: openDetails)
          .buttonStyle(.borderless)
          .font(TrayFont.detailMedium)
          .foregroundStyle(TrayPaint.accent)
          .accessibilityIdentifier("tray.routing.details")
      }
    }
    .frame(height: 16)
  }
}

struct TrayMetaPill: View {
  let title: String

  var body: some View {
    Text(title)
      .font(TrayFont.detailMedium)
      .padding(.horizontal, 6)
      .frame(height: 20)
      .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
  }
}

struct TrayRadioMark: View {
  var selected: Bool
  var size: CGFloat = 18

  var body: some View {
    ZStack {
      Circle()
        .strokeBorder(selected ? TrayPaint.accent : Color.secondary.opacity(0.45), lineWidth: 1)
        .background(Circle().fill(selected ? TrayPaint.accent : Color.clear))
        .frame(width: size, height: size)
      if selected {
        Image(systemName: "checkmark")
          .font(.system(size: size < 16 ? 7 : 8, weight: .bold))
          .foregroundStyle(.white)
      }
    }
  }
}

struct TrayAttentionItem: Identifiable {
  let id: String
  let title: String
  let actionTitle: String
  let destination: DesignDestination
}

let trayPreferredPrimaryAppIDs = ["claude", "codex"]
let trayPrimaryAppLimit = 2

func trayPrimaryApps(from apps: [DesignApp]) -> [DesignApp] {
  let preferred = trayPreferredPrimaryAppIDs.compactMap { id in apps.first { $0.id == id } }
  var result = Array(preferred.prefix(trayPrimaryAppLimit))
  if result.count == trayPrimaryAppLimit { return result }
  var seen = Set(result.map(\.id))
  for app in apps where !seen.contains(app.id) {
    result.append(app)
    seen.insert(app.id)
    if result.count == trayPrimaryAppLimit { break }
  }
  return result
}

func trayOtherApps(from apps: [DesignApp]) -> [DesignApp] {
  guard apps.count > trayPrimaryAppLimit else { return [] }
  let primaryIDs = Set(trayPrimaryApps(from: apps).map(\.id))
  return apps.filter { !primaryIDs.contains($0.id) }
}

func trayAccountRoutes(in app: DesignApp) -> [DesignRoute] {
  nativeFirstRoutes(app.routeOptions.filter { $0.kind == .account || $0.kind == .native })
}

func trayGatewayRoutes(in app: DesignApp) -> [DesignRoute] {
  app.routeOptions.filter { $0.kind == .gateway }
}

@MainActor
func trayAttentionItems(from model: MacOSDesignModel) -> [TrayAttentionItem] {
  var items: [TrayAttentionItem] = []
  for app in model.apps where app.status == .attention || app.status == .unavailable {
    let shortName = app.name
      .replacingOccurrences(of: " CLI", with: "")
      .replacingOccurrences(of: " Code", with: "")
    items.append(
      TrayAttentionItem(
        id: "app.\(app.id)",
        title: app.attentionMessage ?? model.localized(
          "desktop.menu_bar.account_mismatch",
          replacing: ["app": shortName]
        ),
        actionTitle: model.localized("desktop.menu_bar.hide_attention"),
        destination: .apps
      )
    )
  }
  if model.routingConflicts.contains(where: \.needsAttention) {
    items.append(
      TrayAttentionItem(
        id: "hub.models",
        title: model.localized("desktop.menu_bar.proxy_conflict_title"),
        actionTitle: model.localized("desktop.menu_bar.hide_attention"),
        destination: .proxyHub
      )
    )
  }
  if model.trayScene == .attention, items.isEmpty {
    items = [
      TrayAttentionItem(
        id: "app.kiro",
        title: model.localized("desktop.menu_bar.account_mismatch", replacing: ["app": "Kiro"]),
        actionTitle: model.localized("desktop.menu_bar.hide_attention"),
        destination: .apps
      )
    ]
  }
  return items
}
