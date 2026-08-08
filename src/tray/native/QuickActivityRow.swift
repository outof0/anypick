import AppKit
import Foundation
import SwiftUI

// Module: QuickActivityRow.swift — activity stream row

// MARK: - Activity

struct NativeQuickActivityRow: View {
  let event: ActivityEvent

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(event.date, style: .time)
        .font(.caption.monospacedDigit())
        .foregroundStyle(.tertiary)
        .frame(width: 46, alignment: .leading)
      Image(systemName: icon)
        .font(.caption.weight(.semibold))
        .foregroundStyle(event.isError ? anypickAmber : Color.secondary)
        .frame(width: 14)
      Text(event.message)
        .font(.callout)
        .foregroundStyle(.secondary)
        .lineLimit(2)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, TraySpacing.rowPadding)
    .padding(.vertical, 10)
  }

  private var icon: String {
    if event.isError { return "exclamationmark.circle.fill" }
    switch event.kind {
    case "switch": return "arrow.left.arrow.right"
    case "account": return "person.crop.circle"
    default: return "circle.fill"
    }
  }
}
