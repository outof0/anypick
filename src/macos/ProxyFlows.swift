import SwiftUI

struct PublishedModelIdentity {
  let vendorKey: String
  let vendorName: String
  let cleanName: String
  let tag: String?
  let fallbackSymbol: String
}

private let identityCache = NSCache<NSString, IdentityBox>()
private final class IdentityBox {
  let value: PublishedModelIdentity
  init(_ value: PublishedModelIdentity) { self.value = value }
}

func parseModelIdentity(_ modelID: String, fallbackProvider: String) -> PublishedModelIdentity {
  let cacheKey = "\(modelID)|\(fallbackProvider)" as NSString
  if let cached = identityCache.object(forKey: cacheKey) {
    return cached.value
  }

  let mid = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
  var vendorKey = ""
  var clean = mid

  if mid.hasPrefix("~") && mid.contains("/") {
    let parts = mid.dropFirst().split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true)
    if parts.count == 2 {
      let prefix = String(parts[0]).lowercased()
      clean = String(parts[1])
      if prefix.contains("anthropic") || prefix.contains("claude") {
        vendorKey = "claude"
      } else if prefix.contains("openai") || prefix.contains("gpt") {
        vendorKey = "codex"
      } else if prefix.contains("google") || prefix.contains("gemini") {
        vendorKey = "gemini"
      } else if prefix.contains("deepseek") {
        vendorKey = "deepseek"
      } else if prefix.contains("x-ai") || prefix.contains("xai") || prefix.contains("grok") {
        vendorKey = "grok"
      } else if prefix.contains("moonshot") || prefix.contains("kimi") {
        vendorKey = "kimi"
      } else if prefix.contains("z-ai") || prefix.contains("zai") || prefix.contains("glm") {
        vendorKey = "zai"
      } else if prefix.contains("qwen") {
        vendorKey = "qwen"
      } else if prefix.contains("mistral") {
        vendorKey = "mistral"
      } else {
        vendorKey = prefix
      }
    }
  } else {
    let lower = mid.lowercased()
    if lower.hasPrefix("claude") {
      vendorKey = "claude"
    } else if lower.hasPrefix("gpt") || lower.hasPrefix("o1") || lower.hasPrefix("o3") || lower.hasPrefix("text-embedding") {
      vendorKey = "codex"
    } else if lower.hasPrefix("gemini") {
      vendorKey = "gemini"
    } else if lower.hasPrefix("deepseek") {
      vendorKey = "deepseek"
    } else if lower.hasPrefix("grok") {
      vendorKey = "grok"
    } else if lower.hasPrefix("kimi") {
      vendorKey = "kimi"
    } else if lower.hasPrefix("glm") {
      vendorKey = "zai"
    } else if lower.hasPrefix("qwen") {
      vendorKey = "qwen"
    } else if lower.hasPrefix("mistral") {
      vendorKey = "mistral"
    } else {
      vendorKey = fallbackProvider.lowercased()
    }
  }

  let normVendor = vendorKey.lowercased()
  if normVendor.contains("claude") || normVendor.contains("anthropic") {
    vendorKey = "claude"
  } else if normVendor.contains("openai") || normVendor.contains("codex") || normVendor.contains("gpt") {
    vendorKey = "codex"
  } else if normVendor.contains("gemini") || normVendor.contains("google") {
    vendorKey = "gemini"
  } else if normVendor.contains("deepseek") {
    vendorKey = "deepseek"
  } else if normVendor.contains("grok") || normVendor.contains("xai") || normVendor.contains("x-ai") {
    vendorKey = "grok"
  } else if normVendor.contains("kimi") || normVendor.contains("moonshot") {
    vendorKey = "kimi"
  } else if normVendor.contains("zai") || normVendor.contains("glm") || normVendor.contains("zhipu") {
    vendorKey = "zai"
  } else if normVendor.contains("qwen") || normVendor.contains("alibaba") {
    vendorKey = "qwen"
  } else if normVendor.contains("mistral") {
    vendorKey = "mistral"
  } else if normVendor.contains("cline") {
    vendorKey = "cline"
  }

  var tag: String? = nil
  for suffix in ["-latest", "-preview", "-reasoning", "-instruct", "-turbo"] {
    if clean.hasSuffix(suffix) {
      tag = String(suffix.dropFirst())
      clean = String(clean.dropLast(suffix.count))
      break
    }
  }

  let (vendorName, symbol): (String, String) = {
    switch vendorKey {
    case "claude", "anthropic": return ("Anthropic Claude", "brain.head.profile")
    case "codex", "openai": return ("OpenAI", "terminal.fill")
    case "gemini", "google": return ("Google Gemini", "sparkle")
    case "deepseek": return ("DeepSeek", DesignBrandAsset.fallbackSymbol(for: "deepseek"))
    case "grok", "xai": return ("xAI Grok", "sparkles")
    case "kimi", "moonshot": return ("Moonshot Kimi", "moon.fill")
    case "zai", "glm": return ("Zhipu AI (GLM)", "z.circle.fill")
    case "qwen": return ("Qwen", "character.textbox")
    case "mistral": return ("Mistral", "wind")
    default:
      let display = hubProviderDisplayName(vendorKey)
      return (display.isEmpty ? anypickDisplayName(fallbackProvider) : display, "server.rack")
    }
  }()

  let result = PublishedModelIdentity(
    vendorKey: vendorKey,
    vendorName: vendorName,
    cleanName: clean,
    tag: tag,
    fallbackSymbol: symbol
  )
  identityCache.setObject(IdentityBox(result), forKey: cacheKey)
  return result
}

struct PublishedModelsView: View {
  @ObservedObject var model: MacOSDesignModel
  @State private var search = ""
  @State private var selectedVendor = "all"
  @State private var inspectingModel: DesignPublishedModel?
  @State private var copiedID: String?
  @State private var expandedVendors: Set<String> = []
  @State private var didInitializeExpansion = false

  private func matchesSearch(_ item: DesignPublishedModel) -> Bool {
    guard !search.isEmpty else { return true }
    let parsed = parseModelIdentity(item.modelID, fallbackProvider: item.ownerProvider)
    return item.modelID.localizedCaseInsensitiveContains(search)
      || parsed.cleanName.localizedCaseInsensitiveContains(search)
      || parsed.vendorName.localizedCaseInsensitiveContains(search)
      || item.ownerName.localizedCaseInsensitiveContains(search)
      || item.ownerProvider.localizedCaseInsensitiveContains(search)
  }

  private var matchingConflicts: [DesignRoutingConflict] {
    model.routingConflicts.filter { conflict in
      let providers = Set(conflict.candidates.filter(\.providerChoice).map { $0.provider.lowercased() })
      guard providers.count > 1 else { return false }
      return search.isEmpty
        || conflict.title.localizedCaseInsensitiveContains(search)
        || conflict.detail.localizedCaseInsensitiveContains(search)
        || conflict.models.contains { $0.localizedCaseInsensitiveContains(search) }
    }
  }

  private var conflictModelIDs: Set<String> {
    Set(matchingConflicts.flatMap(\.models))
  }

  private var allPublished: [DesignPublishedModel] {
    model.publishedModels.filter {
      !conflictModelIDs.contains($0.modelID) || !$0.needsChoice
    }
  }

  private var published: [DesignPublishedModel] {
    allPublished.filter { item in
      guard matchesSearch(item) else { return false }
      if selectedVendor != "all" {
        let parsed = parseModelIdentity(item.modelID, fallbackProvider: item.ownerProvider)
        return parsed.vendorKey == selectedVendor || parsed.vendorName == selectedVendor
      }
      return true
    }
  }

  private var needsChoice: [DesignPublishedModel] {
    model.publishedModels.filter {
      $0.needsChoice && conflictModelIDs.contains($0.modelID) && matchesSearch($0)
    }
  }

  private var switchableModels: [DesignPublishedModel] {
    allPublished.filter { item in
      let candidates = model.routeCandidates(for: item.modelID)
      guard candidates.count > 1 else { return false }
      return matchesSearch(item)
    }
  }

  private func isGroupExpanded(_ id: String) -> Bool {
    if !search.isEmpty { return true }
    if selectedVendor != "all" { return selectedVendor == id }
    return expandedVendors.contains(id)
  }

  private func toggleGroup(_ id: String, expanded: Bool) {
    if expanded {
      expandedVendors.insert(id)
    } else {
      expandedVendors.remove(id)
    }
  }


  private func initializeExpansionIfNeeded() {
    guard !didInitializeExpansion else { return }
    if allPublished.count <= 25 {
      expandedVendors = Set(vendorGroups.map(\.id))
    } else {
      expandedVendors.removeAll()
    }
    didInitializeExpansion = true
  }

  private var availableVendors: [(id: String, name: String, count: Int)] {
    let counts = Dictionary(grouping: allPublished) { item in
      parseModelIdentity(item.modelID, fallbackProvider: item.ownerProvider).vendorKey
    }
    return counts.keys.sorted().compactMap { key -> (id: String, name: String, count: Int)? in
      guard let items = counts[key], let sample = items.first else { return nil }
      let parsed = parseModelIdentity(sample.modelID, fallbackProvider: sample.ownerProvider)
      return (id: key, name: parsed.vendorName, count: items.count)
    }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }

  private struct VendorGroup: Identifiable {
    let id: String
    let vendorKey: String
    let vendorName: String
    let fallbackSymbol: String
    let models: [DesignPublishedModel]
    let footerDetail: String
  }

  private var vendorGroups: [VendorGroup] {
    let grouped = Dictionary(grouping: published) { item in
      parseModelIdentity(item.modelID, fallbackProvider: item.ownerProvider).vendorKey
    }
    return grouped.keys.sorted().compactMap { key -> VendorGroup? in
      guard let models = grouped[key], !models.isEmpty, let sample = models.first else { return nil }
      let parsed = parseModelIdentity(sample.modelID, fallbackProvider: sample.ownerProvider)

      let distinctSources = Set(models.map { resolveModelOwnerDisplay($0) }.filter { !$0.isEmpty })
      let footer: String
      if distinctSources.count == 1, let single = distinctSources.first {
        footer = "Serving source: \(single)"
      } else {
        let distinctProviders = Set(models.map { hubProviderDisplayName($0.ownerProvider) }.filter { !$0.isEmpty })
        if distinctProviders.count == 1, let p = distinctProviders.first {
          footer = "Published via \(p)"
        } else {
          footer = ""
        }
      }

      return VendorGroup(
        id: key,
        vendorKey: key,
        vendorName: parsed.vendorName,
        fallbackSymbol: parsed.fallbackSymbol,
        models: models.sorted { $0.modelID.localizedStandardCompare($1.modelID) == .orderedAscending },
        footerDetail: footer
      )
    }.sorted { $0.vendorName.localizedStandardCompare($1.vendorName) == .orderedAscending }
  }

  var body: some View {
    Group {
      if allPublished.isEmpty && needsChoice.isEmpty && matchingConflicts.isEmpty {
        ContentUnavailableView {
          Label(model.localized("desktop.published.no_models"), systemImage: "square.stack.3d.up.slash")
        } description: {
          Text(model.localized("desktop.published.empty_detail"))
        }
      } else if (selectedVendor == "switchable" ? switchableModels.isEmpty : published.isEmpty) && needsChoice.isEmpty && matchingConflicts.isEmpty {
        ContentUnavailableView {
          Label(model.localized("desktop.published.no_results"), systemImage: "magnifyingglass")
        } description: {
          Text(model.localized("desktop.published.no_results_detail"))
        } actions: {
          Button(model.localized("desktop.published.reset_filters")) {
            search = ""
            selectedVendor = "all"
          }
          .help(model.localized("desktop.published.reset_help"))
        }
      } else {
        DesignGroupedPane {
          if !matchingConflicts.isEmpty {
            Section {
              ForEach(matchingConflicts) { conflict in
                conflictPicker(conflict)
              }
            } header: {
              Text(model.localized("desktop.hub.conflicts"))
            } footer: {
              Text(model.localized("desktop.hub.conflict_footer"))
            }
          } else if !needsChoice.isEmpty {
            Section {
              ForEach(needsChoice) { item in
                let parsed = parseModelIdentity(item.modelID, fallbackProvider: item.ownerProvider)
                HStack(spacing: 8) {
                  DesignProviderIcon(
                    provider: parsed.vendorKey,
                    fallbackSymbol: parsed.fallbackSymbol,
                    size: 20
                  )
                  Text(item.modelID)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)

                  Spacer(minLength: 8)

                  Text(model.localized("desktop.hub.need_choice"))
                    .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("published-models.row.\(item.modelID)")
              }
            } header: {
              Text(model.localized("desktop.hub.conflicts"))
            } footer: {
              Text(model.localized("desktop.published.conflict_footer"))
            }
          }

          if selectedVendor == "switchable" {
            Section {
              ForEach(switchableModels) { item in
                switchableModelRow(item)
              }
            } header: {
              Text(model.localized("desktop.published.multi_provider_routes"))
            } footer: {
              Text(model.localized("desktop.published.multi_route_detail"))
            }
          } else if selectedVendor != "all" {
            if let group = vendorGroups.first(where: { $0.vendorKey == selectedVendor || $0.id == selectedVendor }) {
              Section {
                ForEach(group.models) { item in
                  modelRow(item)
                }
              } header: {
                Text(group.vendorName)
              } footer: {
                if !group.footerDetail.isEmpty {
                  Text(group.footerDetail)
                }
              }
            }
          } else {
            Section {
              ForEach(vendorGroups) { group in
                DisclosureGroup(
                  isExpanded: Binding(
                    get: { isGroupExpanded(group.id) },
                    set: { toggleGroup(group.id, expanded: $0) }
                  )
                ) {
                  ForEach(group.models) { item in
                    modelRow(item)
                  }
                } label: {
                  HStack(spacing: 8) {
                    DesignProviderIcon(
                      provider: group.vendorKey,
                      fallbackSymbol: group.fallbackSymbol,
                      size: 18
                    )
                    Text(group.vendorName)
                      .font(.body)
                      .fontWeight(.medium)
                    Spacer()
                    Text("\(group.models.count)")
                      .font(.subheadline)
                      .foregroundStyle(.secondary)
                  }
                  .contentShape(Rectangle())
                  .onTapGesture {
                    toggleGroup(group.id, expanded: !isGroupExpanded(group.id))
                  }
                }
                .accessibilityIdentifier("published-models.group.\(group.id)")
              }
            } header: {
              Text(model.localized("desktop.published.published_catalogs"))
            } footer: {
              Text(model.localized("desktop.published.catalogs_footer"))
            }
          }
        }
      }
    }
    .navigationTitle(model.localized("desktop.published.title"))
    .searchable(text: $search, placement: .toolbar, prompt: model.localized("desktop.apps.search"))
    .toolbar {

      if availableVendors.count > 1 || !switchableModels.isEmpty {
        ToolbarItem(placement: .automatic) {
          Picker(model.localized("desktop.published.catalog"), selection: $selectedVendor) {
            Text(model.localized("desktop.published.all_catalogs")
              .replacingOccurrences(of: "{count}", with: String(allPublished.count))).tag("all")
            if !switchableModels.isEmpty {
              Text(model.localized("desktop.published.multi_routes_count")
                .replacingOccurrences(of: "{count}", with: String(switchableModels.count))).tag("switchable")
            }
            Divider()
            ForEach(availableVendors, id: \.id) { v in
              Text("\(v.name) (\(v.count))").tag(v.id)
            }
          }
          .pickerStyle(.menu)
          .accessibilityIdentifier("published-models.vendor-picker")
        }
      }
    }
    .sheet(item: $inspectingModel) { item in
      PublishedModelInspectSheet(model: model, publishedModel: item)
    }
    .onAppear {
      initializeExpansionIfNeeded()
      if model.pendingStartupFlow == "inspect-model" {
        model.pendingStartupFlow = nil
        inspectingModel = published.first
      }
    }
  }

  @ViewBuilder
  private func switchableModelRow(_ item: DesignPublishedModel) -> some View {
    let parsed = parseModelIdentity(item.modelID, fallbackProvider: item.ownerProvider)
    let candidates = model.routeCandidates(for: item.modelID)
    let selectedID = activeCandidateID(for: item, candidates: candidates)
    let providerNames = candidates.map { hubProviderDisplayName($0.provider) }

    HStack(spacing: 12) {
      DesignProviderIcon(
        provider: parsed.vendorKey,
        fallbackSymbol: parsed.fallbackSymbol,
        size: 22
      )

      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(parsed.cleanName)
            .font(.body)
            .fontWeight(.medium)
            .lineLimit(1)

          Text(model.localized("desktop.published.multi_provider"))
            .font(.caption2)
            .foregroundStyle(.secondary)
        }

        HStack(spacing: 4) {
          Text(item.modelID)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)

          if !providerNames.isEmpty {
            Text("·")
              .foregroundStyle(.tertiary)
            Text(model.localized("desktop.hub.available_via")
              .replacingOccurrences(of: "{providers}", with: providerNames.joined(separator: ", ")))
              .font(.caption2)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
      }

      Spacer(minLength: 8)

      HStack(spacing: 8) {
        DesignCandidatePicker(
          candidates: candidates,
          selection: Binding<String?>(
            get: { selectedID },
            set: { newID in
              guard let newID, let cand = candidates.first(where: { $0.id == newID }) else { return }
              model.selectRoutingCandidate(actionID: cand.actionID)
            }
          ),
          accessibilityIdentifier: "published-models.switch-picker.\(item.modelID)"
        )
        .fixedSize()

        DesignIconButton(
          symbol: "info.circle",
          label: "Inspect \(item.modelID)",
          identifier: "published-models.switch-inspect.\(item.modelID)"
        ) {
          inspectingModel = item
        }
      }
      .layoutPriority(1)
    }
    .padding(.vertical, 2)
    .accessibilityIdentifier("published-models.switch-row.\(item.modelID)")
  }

  @ViewBuilder
  private func modelRow(_ item: DesignPublishedModel) -> some View {
    let parsed = parseModelIdentity(item.modelID, fallbackProvider: item.ownerProvider)
    let isCopied = copiedID == item.modelID
    let candidates = model.routeCandidates(for: item.modelID)

    HStack(spacing: 12) {
      DesignProviderIcon(
        provider: parsed.vendorKey,
        fallbackSymbol: parsed.fallbackSymbol,
        size: 22
      )

      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(parsed.cleanName)
            .font(.body)
            .fontWeight(.medium)
            .lineLimit(1)

          if let tag = parsed.tag {
            Text(tag)
              .font(.caption2)
              .foregroundStyle(.secondary)
          }

          if candidates.count > 1 {
            Text(model.localized("desktop.published.multi_provider"))
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
        }

        HStack(spacing: 4) {
          Text(item.modelID)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)

          let ownerDisplay = resolveModelOwnerDisplay(item)
          if !ownerDisplay.isEmpty {
            Text("·")
              .foregroundStyle(.tertiary)
            Text(ownerDisplay)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
      }

      Spacer(minLength: 8)

      HStack(spacing: 8) {
        if candidates.count > 1 {
          let selectedID = activeCandidateID(for: item, candidates: candidates)
          DesignCandidatePicker(
            candidates: candidates,
            selection: Binding<String?>(
              get: { selectedID },
              set: { newID in
                guard let newID, let cand = candidates.first(where: { $0.id == newID }) else { return }
                model.selectRoutingCandidate(actionID: cand.actionID)
              }
            ),
            accessibilityIdentifier: "published-models.row-picker.\(item.modelID)"
          )
          .fixedSize()
        }

        DesignCopyButton(
          copied: isCopied,
          label: model.localized("desktop.published.copy_model_id"),
          copiedLabel: model.localized("desktop.common.copied_to_clipboard"),
          identifier: "published-models.copy.\(item.modelID)"
        ) {
          if copyText(item.modelID) {
            copiedID = item.modelID
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
              if copiedID == item.modelID { copiedID = nil }
            }
          }
        }

        DesignIconButton(
          symbol: "info.circle",
          label: "\(model.localized("desktop.published.inspect_model")) \(item.modelID)",
          identifier: "published-models.inspect.\(item.modelID)"
        ) {
          inspectingModel = item
        }
      }
      .layoutPriority(1)
    }
    .padding(.vertical, 2)
    .contentShape(Rectangle())
    .contextMenu {
      if candidates.count > 1 {
        Menu(model.localized("desktop.published.route_to")) {
          ForEach(candidates) { cand in
            Button {
              model.selectRoutingCandidate(actionID: cand.actionID)
            } label: {
              HStack {
                Text(cand.label)
                if isCandidateActive(cand, for: item) {
                  Image(systemName: "checkmark")
                }
              }
            }
            .help("\(model.localized("desktop.published.route_to")) \(cand.label)")
          }
        }
        .help(model.localized("desktop.hub.model_routing_footer"))
        Divider()
      }
      Button(model.localized("desktop.published.copy_model_id")) {
        copyText(item.modelID)
      }
      .help(model.localized("desktop.published.copy_model_id_help"))
      Button(model.localized("desktop.published.inspect_model")) {
        inspectingModel = item
      }
      .help(model.localized("desktop.published.inspect_model_help"))
    }
    .accessibilityIdentifier("published-models.row.\(item.modelID)")
  }

  private func isCandidateActive(_ cand: DesignRoutingCandidate, for item: DesignPublishedModel) -> Bool {
    if cand.providerChoice {
      return cand.provider.localizedCaseInsensitiveCompare(item.ownerProvider) == .orderedSame
    }
    if let ownerID = item.ownerAccountID {
      return cand.id == ownerID || ownerID.contains(cand.id)
    }
    return cand.provider.localizedCaseInsensitiveCompare(item.ownerProvider) == .orderedSame
  }

  private func resolveModelOwnerDisplay(_ item: DesignPublishedModel) -> String {
    let providerName = hubProviderDisplayName(item.ownerProvider)
    let hasRotation = model.hubSources.contains { src in
      src.rotates && src.enabled && (src.provider == item.ownerProvider || src.name.localizedCaseInsensitiveContains(providerName))
    }
    if hasRotation {
    return model.localized("desktop.published.rotates_across_accounts")
    }
    if !providerName.isEmpty && providerName.caseInsensitiveCompare("Needs a choice") != .orderedSame {
      return providerName
    }
    if !item.ownerName.isEmpty && item.ownerName != "Needs a choice" {
      return cleanSourceDisplayName(item.ownerName)
    }
    if let match = model.accounts.first(where: {
      $0.id == item.ownerAccountID || (item.ownerAccountID != nil && item.ownerAccountID!.contains($0.id))
    }) {
      return hubProviderDisplayName(match.provider)
    }
    return ""
  }

  @discardableResult
  private func copyText(_ string: String) -> Bool {
    let copied = model.pasteString(string)
    model.announceOnly(model.localized(copied ? "desktop.common.copied_to_clipboard" : "desktop.common.copy_failed"))
    return copied
  }

  @ViewBuilder
  private func conflictPicker(_ conflict: DesignRoutingConflict) -> some View {
    let serviceID = hubConflictServiceID(conflict.id)
    let resolving = model.serviceOperations[serviceID] != nil
    let (infoTitle, infoSubtitle) = hubConflictDisplayInfo(conflict, using: model)
    let candidatesToShow = uniqueProviderCandidates(conflict.candidates)
    let conflictModelID = conflict.models.first ?? conflict.title
    let parsed = parseModelIdentity(conflictModelID, fallbackProvider: conflict.candidates.first?.provider ?? "")

    LabeledContent {
      HStack(spacing: 6) {
        if resolving {
          ProgressView()
            .controlSize(.small)
          .accessibilityLabel(model.localized("desktop.published.applying_choice_for", replacing: ["name": infoTitle]))
        }
        DesignCandidatePicker(
          candidates: candidatesToShow,
          selection: Binding<String?>(
            get: {
              if let selected = conflict.selectedCandidateID,
                 candidatesToShow.contains(where: { $0.id == selected }) {
                return selected
              }
              return nil
            },
            set: { candidateID in
              guard let candidateID,
                    let candidate = candidatesToShow.first(where: { $0.id == candidateID })
              else { return }
              model.selectRoutingCandidate(actionID: candidate.actionID)
            }
          ),
          placeholder: model.localized("desktop.published.select_provider"),
          accessibilityIdentifier: "published-models.conflict.\(conflict.id).picker"
        )
        .fixedSize()
        .disabled(model.isBusy || candidatesToShow.isEmpty || resolving)
      }
    } label: {
      HStack(spacing: 8) {
        DesignProviderIcon(
          provider: parsed.vendorKey,
          fallbackSymbol: parsed.fallbackSymbol,
          size: 20
        )
        VStack(alignment: .leading, spacing: 2) {
          Text(infoTitle)
            .font(.system(.body, design: .monospaced))
          Text(infoSubtitle)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }
    }
    .accessibilityIdentifier("published-models.conflict.\(conflict.id)")
    if let failure = model.serviceFailures[serviceID] {
      Text(failure)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("published-models.conflict.\(conflict.id).error")
    }
  }
}

struct PublishedModelInspectSheet: View {
  @ObservedObject var model: MacOSDesignModel
  let publishedModel: DesignPublishedModel
  @Environment(\.dismiss) private var dismiss
  @State private var copiedLabel: String?

  private var modelIdentity: PublishedModelIdentity {
    parseModelIdentity(publishedModel.modelID, fallbackProvider: publishedModel.ownerProvider)
  }

  private var providerName: String {
    hubProviderDisplayName(publishedModel.ownerProvider)
  }

  private var hubAddress: String {
    "http://127.0.0.1:\(model.proxyHubPort)"
  }

  private var chatCompletionsURL: String {
    "\(hubAddress)/v1/chat/completions"
  }

  private var servingAccountDisplay: String {
    if !publishedModel.ownerName.isEmpty && publishedModel.ownerName != "Needs a choice" {
      if let match = model.accounts.first(where: {
        $0.name.caseInsensitiveCompare(publishedModel.ownerName) == .orderedSame
          || $0.id == publishedModel.ownerAccountID
          || (publishedModel.ownerAccountID != nil && publishedModel.ownerAccountID!.contains($0.id))
      }) {
        let identity = accountIdentityLine(provider: match.provider, detail: match.detail)
        return identity.isEmpty ? match.name : "\(match.name) (\(identity))"
      }
      return publishedModel.ownerName
    }
    if let match = model.accounts.first(where: {
      $0.id == publishedModel.ownerAccountID || (publishedModel.ownerAccountID != nil && publishedModel.ownerAccountID!.contains($0.id))
    }) {
      let identity = accountIdentityLine(provider: match.provider, detail: match.detail)
      return identity.isEmpty ? match.name : "\(match.name) (\(identity))"
    }
    return providerName
  }

  private var strategyDisplay: String {
    let hasRotation = model.hubSources.contains { src in
      src.rotates && src.enabled && (src.provider == publishedModel.ownerProvider || src.name.localizedCaseInsensitiveContains(providerName))
    }
    if hasRotation {
      return model.localized("desktop.published.round_robin_strategy")
    }
    return model.localized("desktop.published.failover_strategy")
  }

  private var curlExample: String {
    """
    curl \(chatCompletionsURL) \\
      -H "Content-Type: application/json" \\
      -d '{"model": "\(publishedModel.modelID)", "messages": [{"role": "user", "content": "Hello"}]}'
    """
  }

  var body: some View {
    DesignSheetHost(
      model: model,
      title: modelIdentity.cleanName,
      width: 480,
      primaryTitle: model.localized("desktop.published.done"),
      primaryIdentifier: "model-inspect.done",
      showsCancel: false,
      onCancel: { dismiss() },
      onPrimary: { dismiss() }
    ) {
      Form {
        Section {
          Label {
            VStack(alignment: .leading, spacing: 3) {
              HStack(spacing: 6) {
                Text(modelIdentity.cleanName)
                  .font(.headline)
                if let tag = modelIdentity.tag {
                  Text(tag.uppercased())
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
              }
              Text(publishedModel.modelID)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            }
          } icon: {
            DesignProviderIcon(provider: modelIdentity.vendorKey, fallbackSymbol: modelIdentity.fallbackSymbol, size: 28)
          }

          LabeledContent(model.localized("desktop.common.status")) {
            HStack(spacing: 6) {
              Circle()
                .fill(Color.green)
                .frame(width: 8, height: 8)
              Text(model.localized("desktop.published.active"))
                .foregroundStyle(.secondary)
            }
          }
          LabeledContent(model.localized("desktop.published.model_family"), value: modelIdentity.vendorName)

          let candidates = model.routeCandidates(for: publishedModel.modelID)
          if candidates.count > 1 {
            LabeledContent(model.localized("desktop.published.route_to")) {
              DesignCandidatePicker(
                candidates: candidates,
                selection: Binding<String?>(
                  get: { activeCandidateID(for: publishedModel, candidates: candidates) },
                  set: { newID in
                    guard let newID, let cand = candidates.first(where: { $0.id == newID }) else { return }
                    model.selectRoutingCandidate(actionID: cand.actionID)
                  }
                ),
                accessibilityIdentifier: "published-models.inspect-route.\(publishedModel.modelID)"
              )
              .fixedSize()
            }
          } else {
          LabeledContent(model.localized("desktop.account_detail.provider"), value: providerName)
          }

          LabeledContent(model.localized("desktop.proxy_detail.serving_account"), value: servingAccountDisplay)
          LabeledContent(model.localized("desktop.published.routing_strategy"), value: strategyDisplay)
        } header: {
          Text(model.localized("desktop.published.model_routing"))
        }

        Section {
          LabeledContent(model.localized("desktop.published.base_url")) {
            HStack(spacing: 8) {
              Text(hubAddress)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
              copyButton(for: hubAddress, label: "base-url")
            }
          }

          LabeledContent {
            HStack(spacing: 8) {
              Text(chatCompletionsURL)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
              copyButton(for: chatCompletionsURL, label: "chat-url")
            }
          } label: {
            Text(model.localized("desktop.published.chat_url"))
          }

          LabeledContent(model.localized("desktop.published.test_terminal")) {
            let copied = copiedLabel == "curl"
            Button {
              copyToClipboard(curlExample, label: "curl")
            } label: {
              HStack(spacing: 4) {
                DesignCopyGlyph(copied: copied)
                Text(model.localized("desktop.published.copy_curl"))
              }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help(model.localized(copied ? "desktop.published.copied_curl" : "desktop.published.copy_curl"))
            .accessibilityLabel(model.localized(copied ? "desktop.published.copied_curl" : "desktop.published.copy_curl"))
            .accessibilityIdentifier("model-inspect.copy-curl")
          }
        } header: {
          Text(model.localized("desktop.published.endpoint"))
        } footer: {
          Text(model.localized("desktop.published.endpoint_detail"))
        }
      }
    }
  }

  private func copyButton(for text: String, label: String) -> some View {
    DesignCopyButton(
      copied: copiedLabel == label,
      label: model.localized(label == "base-url" ? "desktop.published.copy_base_url" : "desktop.published.copy_chat_url"),
      copiedLabel: model.localized("desktop.common.copied_to_clipboard"),
      identifier: "model-inspect.copy-\(label)"
    ) {
      copyToClipboard(text, label: label)
    }
  }

  private func copyToClipboard(_ text: String, label: String) {
    let copied = model.pasteString(text)
    guard copied else {
      model.announceOnly(model.localized("desktop.common.copy_failed"))
      return
    }
    copiedLabel = label
    model.announceOnly(model.localized("desktop.common.copied_to_clipboard"))
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
      if copiedLabel == label { copiedLabel = nil }
    }
  }
}
