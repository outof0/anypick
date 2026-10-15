import SwiftUI

enum TraySearchTarget: Hashable {
  case app(String)
  case destination(DesignDestination)
}

struct TraySearchResult: Identifiable {
  let id: String
  let title: String
  let detail: String
  let symbol: String
  let provider: String?
  let target: TraySearchTarget
}

struct MenuBarSearchResults: View {
  @ObservedObject var model: MacOSDesignModel
  let query: String
  let results: [TraySearchResult]
  let activate: (TraySearchResult) -> Void

  var body: some View {
    if results.isEmpty {
      ContentUnavailableView(
        model.localized("desktop.menu_bar.no_results"),
        systemImage: "magnifyingglass",
        description: Text(model.localized("desktop.menu_bar.no_results_detail", replacing: ["query": query]))
      )
      .frame(maxWidth: .infinity, minHeight: 150)
    } else {
      traySectionTitle(model.localized("desktop.menu_bar.search_results"))
      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(Array(results.enumerated()), id: \.element.id) { index, result in
            resultButton(result)
            if index < results.count - 1 {
              Divider().padding(.leading, 36)
            }
          }
        }
      }
      .frame(maxHeight: min(CGFloat(results.count * 41), 246))
    }
  }

  private func resultButton(_ result: TraySearchResult) -> some View {
    Button { activate(result) } label: {
      HStack(spacing: 9) {
        resultIcon(result)
        VStack(alignment: .leading, spacing: 1) {
          Text(result.title)
            .font(TrayFont.bodyStrong)
            .foregroundStyle(.primary)
            .lineLimit(1)
          Text(result.detail)
            .font(TrayFont.detail)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer(minLength: 8)
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 7)
      .frame(height: 40)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("tray.search.result.\(result.id)")
  }

  @ViewBuilder
  private func resultIcon(_ result: TraySearchResult) -> some View {
    if let provider = result.provider {
      DesignProviderIcon(provider: provider, fallbackSymbol: result.symbol, size: 20)
    } else {
      Image(systemName: result.symbol)
        .foregroundStyle(.secondary)
        .frame(width: 20, height: 20)
    }
  }
}
