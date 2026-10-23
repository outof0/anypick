import AppKit
import SwiftUI

// Settings > Updates. The Go core owns every decision and every string the
// pane shows (src/go/internal/update, `anypick update check|download --json`).
// Swift only launches the bundled `anypick-core` helper as a one-shot process,
// decodes its JSON lines, and renders them. No desktop-protocol capability is
// involved, so an older/newer core cannot break the long-lived service pipe.

/// Mirror of Go `update.StatusDTO` (schema 1).
struct UpdateStatusDTO: Codable, Equatable, Sendable {
  var schema: Int
  var kind: String
  var current: String
  var latest: String?
  var notes: String?
  var channel: String
  var actionKind: String?
  var command: String?
  var lead: String?
  var downloadAsset: String?
  var releaseURL: String?
  var progress: Double
  var message: String?
  var footnote: String?
  var skippedHint: String?
  var retry: Bool
  var filePath: String?
  var lastChecked: String?

  static let supportedSchema = 1

  static func decode(line: String) -> UpdateStatusDTO? {
    guard let data = line.data(using: .utf8),
      let value = try? JSONDecoder().decode(UpdateStatusDTO.self, from: data),
      value.schema == supportedSchema
    else { return nil }
    return value
  }

  /// Shown when the helper is missing, crashes, or prints nothing usable.
  static func bridgeFailure(current: String) -> UpdateStatusDTO {
    UpdateStatusDTO(
      schema: supportedSchema, kind: "bridgeFailure", current: current, latest: nil, notes: nil,
      channel: "unknown", actionKind: nil, command: nil, lead: nil, downloadAsset: nil,
      releaseURL: "https://github.com/outof0/anypick/releases", progress: 0,
      message: nil,
      footnote: nil, skippedHint: nil, retry: true, filePath: nil, lastChecked: nil)
  }
}

/// What the pane shows for one status. Pure, so it is unit-tested without UI.
struct UpdatePanePresentation: Equatable {
  var showsDownloadUpdate = false
  var showsCommand = false
  var showsRetry = false
  var showsViewOnGitHub = false
  var showsRevealDownload = false
  var showsProgress = false
  var isIndeterminate = false
  var showsChangelog = false
  var isError = false

  init(_ status: UpdateStatusDTO?) {
    guard let status else { return }
    switch status.kind {
    case "checking":
      showsProgress = true
      isIndeterminate = true
    case "availableDirect":
      showsDownloadUpdate = true
      showsChangelog = true
    case "availablePackageManager":
      // Package-manager installs never self-update: show the command instead.
      showsCommand = !(status.command ?? "").isEmpty && status.actionKind != "manual"
      showsViewOnGitHub = !showsCommand
      showsChangelog = true
    case "downloading":
      showsProgress = true
      isIndeterminate = status.progress <= 0
      showsChangelog = true
    case "verifying":
      showsProgress = true
      isIndeterminate = true
      showsChangelog = true
    case "ready":
      showsRevealDownload = status.filePath != nil
      showsChangelog = true
    case "storageUnavailable":
      isError = true
      showsViewOnGitHub = true
    case "hostBlocked":
      // Locked by Design: View on GitHub, never Retry.
      isError = true
      showsViewOnGitHub = true
    case "notWritable":
      isError = true
      showsViewOnGitHub = true
    default:
      // offline, rateLimited, githubDown, badChecksum, installFailed.
      isError = status.kind != "upToDate" && status.kind != "idle"
      showsRetry = status.retry
    }
    if status.kind != "hostBlocked" && status.retry { showsRetry = true }
    if (status.notes ?? "").isEmpty { showsChangelog = false }
  }
}

enum UpdateCoreBridge {
  static func finalStatus(_ last: UpdateStatusDTO?, exitStatus: Int32, current: String) -> UpdateStatusDTO {
    guard let last else { return .bridgeFailure(current: current) }
    switch last.kind {
    case "offline", "rateLimited", "githubDown", "badChecksum", "hostBlocked", "notWritable", "storageUnavailable", "installFailed":
      // The helper reports operational failures through both NDJSON and its
      // exit status. Keep the specific explanation and recovery action.
      return last
    case "upToDate", "availableDirect", "availablePackageManager", "ready", "idle":
      return exitStatus == 0 ? last : .bridgeFailure(current: current)
    default:
      return .bridgeFailure(current: current)
    }
  }

  /// Runs `anypick-core update <verb> --json --current <version>` and reports
  /// each decoded line. Returns the last line (the final state).
  static func run(
    verb: String, current: String,
    onStatus: @escaping @MainActor (UpdateStatusDTO) -> Void
  ) async -> UpdateStatusDTO {
    do {
      let process = Process()
      process.executableURL = try GoServiceProcess.helperURL()
      process.arguments = ["update", verb, "--json", "--current", current]
      let stdout = Pipe()
      process.standardOutput = stdout
      process.standardError = FileHandle.nullDevice
      try process.run()
      var last: UpdateStatusDTO?
      for try await line in stdout.fileHandleForReading.bytes.lines {
        guard let status = UpdateStatusDTO.decode(line: line) else { continue }
        last = status
        await onStatus(status)
      }
      process.waitUntilExit()
      return finalStatus(last, exitStatus: process.terminationStatus, current: current)
    } catch {
      return .bridgeFailure(current: current)
    }
  }
}

@MainActor
final class UpdatesModel: ObservableObject {
  @Published private(set) var status: UpdateStatusDTO?
  @Published private(set) var isRunning = false
  @Published private(set) var copied = false
  private var lastVerb = "check"
  /// `ANYPICK_MACOS_UPDATE_FIXTURE=<kind>` pins a canned state for QA/renders
  /// and disables the buttons' real work.
  let fixture: String?
  let currentVersion: String

  init(environment: [String: String] = ProcessInfo.processInfo.environment) {
    currentVersion =
      (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
      .flatMap { $0.isEmpty ? nil : $0 } ?? "(devel)"
    fixture = environment["ANYPICK_MACOS_UPDATE_FIXTURE"].flatMap { $0.isEmpty ? nil : $0 }
    if let fixture { status = UpdateStatusFixtures.status(fixture) }
  }

  var presentation: UpdatePanePresentation { UpdatePanePresentation(status) }

  func checkForUpdates() { run("check") }
  func downloadUpdate() { run("download") }
  func retry() { run(status?.kind == "badChecksum" ? "download" : lastVerb) }

  private func run(_ verb: String) {
    guard fixture == nil, !isRunning else { return }
    lastVerb = verb
    isRunning = true
    copied = false
    let current = currentVersion
    Task { @MainActor in
      let final = await UpdateCoreBridge.run(verb: verb, current: current) { [weak self] next in
        self?.status = next
      }
      status = final
      isRunning = false
    }
  }

  func copyCommand() {
    guard let command = status?.command, !command.isEmpty else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(command, forType: .string)
    copied = true
  }

  func openRelease() {
    let raw = status?.releaseURL ?? "https://github.com/outof0/anypick/releases"
    if let url = URL(string: raw), url.scheme == "https", url.host == "github.com" {
      NSWorkspace.shared.open(url)
    }
  }

  func revealDownload() {
    guard let path = status?.filePath else { return }
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
  }
}

struct SettingsUpdatesPane: View {
  @ObservedObject var updates: UpdatesModel
  @ObservedObject var model: MacOSDesignModel

  @ViewBuilder
  var body: some View {
    let status = updates.status
    let p = updates.presentation
    Section {
      LabeledContent(model.localized("desktop.settings.current_version")) {
        HStack {
          Text(status?.current ?? updates.currentVersion).textSelection(.enabled)
          Button(
            model.localized("desktop.settings.check_for_updates"), action: updates.checkForUpdates
          )
          .disabled(updates.isRunning)
          .fixedSize()
          .accessibilityIdentifier("settings.updates.check")
        }
      }
      .accessibilityIdentifier("settings.updates.current")

      if let status, let latest = status.latest, status.kind != "upToDate" {
        LabeledContent(model.localized("desktop.settings.available"), value: latest)
          .accessibilityIdentifier("settings.updates.latest")
      }

      if status?.kind != "checking", status?.kind != "upToDate",
        let message =
          (status?.kind == "bridgeFailure"
            ? model.localized("desktop.updates.bridge_failed")
            : status?.message), !message.isEmpty
      {
        Label {
          Text(message).fixedSize(horizontal: false, vertical: true)
        } icon: {
          Image(systemName: p.isError ? "exclamationmark.triangle.fill" : "info.circle")
            .foregroundStyle(p.isError ? Color.orange : Color.secondary)
        }
        .accessibilityIdentifier("settings.updates.message")
      }
      if let hint = status?.skippedHint, !hint.isEmpty {
        Text(hint).foregroundStyle(.secondary)
      }

      HStack {
        if status?.kind == "checking" {
          ProgressView().controlSize(.small)
          Text(status?.message ?? "").foregroundStyle(.secondary)
        } else {
          Text(status?.kind == "upToDate" ? (status?.message ?? "") : " ")
            .foregroundStyle(.secondary)
        }
        Spacer()
      }
      .frame(minHeight: 20)

      if p.showsProgress && status?.kind != "checking" {
        Group {
          if p.isIndeterminate {
            ProgressView().controlSize(.small)
          } else {
            ProgressView(value: min(max(status?.progress ?? 0, 0), 1))
          }
        }
        .accessibilityIdentifier("settings.updates.progress")
      }

      if p.showsCommand, let command = status?.command {
        VStack(alignment: .leading, spacing: 6) {
          if let lead = status?.lead, !lead.isEmpty { Text(lead) }
          HStack {
            Text(command)
              .font(.system(.body, design: .monospaced))
              .textSelection(.enabled)
              .accessibilityIdentifier("settings.updates.command")
            Spacer()
            Button(
              model.localized(updates.copied ? "desktop.updates.copied" : "desktop.common.copy"),
              action: updates.copyCommand
            )
            .accessibilityIdentifier("settings.updates.copy-command")
          }
        }
      }

      if p.showsViewOnGitHub || p.showsRevealDownload || p.showsRetry || p.showsDownloadUpdate {
        HStack {
          Spacer()
          if p.showsViewOnGitHub {
            Button(model.localized("desktop.updates.view_on_github"), action: updates.openRelease)
              .accessibilityIdentifier("settings.updates.view-on-github")
          }
          if p.showsRevealDownload {
            Button(
              model.localized("desktop.updates.show_in_finder"), action: updates.revealDownload
            )
            .accessibilityIdentifier("settings.updates.reveal")
          }
          if p.showsRetry {
            Button(model.localized("desktop.common.try_again"), action: updates.retry)
              .disabled(updates.isRunning)
              .accessibilityIdentifier("settings.updates.retry")
          }
          if p.showsDownloadUpdate {
            Button(
              model.localized("desktop.updates.download_update"), action: updates.downloadUpdate
            )
            .buttonStyle(.borderedProminent)
            .disabled(updates.isRunning)
            .accessibilityIdentifier("settings.updates.download")
          }
        }
      }
    } header: {
      Text(model.localized("desktop.settings.updates"))
    } footer: {
      if let footnote = status?.footnote, !footnote.isEmpty {
        Text(footnote)
      }
    }

    if p.showsChangelog, let notes = status?.notes {
      Section {
        ScrollView {
          ReleaseNotesView(notes: notes)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 220)
        .accessibilityIdentifier("settings.updates.changelog")
      } header: {
        Text(
          model.localized("desktop.updates.whats_new", replacing: ["version": status?.latest ?? ""])
        )
      }
    }
  }
}

/// One rendered block of release notes. GitHub release bodies are block
/// Markdown (headings, bullet lists, paragraphs), which SwiftUI `Text` can't
/// lay out, so blocks are split per line here and only inline Markdown
/// (bold, code, links) goes through `AttributedString(markdown:)`.
enum ReleaseNoteBlock: Equatable {
  case heading(level: Int, text: String)
  case bullet(text: String)
  case paragraph(text: String)
}

enum ReleaseNotesMarkdown {
  static func blocks(_ notes: String) -> [ReleaseNoteBlock] {
    var out: [ReleaseNoteBlock] = []
    var paragraph: [String] = []
    var inComment = false
    func flush() {
      if !paragraph.isEmpty {
        out.append(.paragraph(text: paragraph.joined(separator: " ")))
        paragraph.removeAll()
      }
    }
    for raw in notes.replacingOccurrences(of: "\r\n", with: "\n").split(
      separator: "\n", omittingEmptySubsequences: false)
    {
      var line = raw.trimmingCharacters(in: .whitespaces)
      // Drop HTML comments (release tooling leaves markers in the body).
      if inComment {
        if let end = line.range(of: "-->") {
          inComment = false
          line = String(line[end.upperBound...]).trimmingCharacters(in: .whitespaces)
        } else { continue }
      }
      while let start = line.range(of: "<!--") {
        if let end = line.range(of: "-->", range: start.upperBound..<line.endIndex) {
          line.removeSubrange(start.lowerBound..<end.upperBound)
        } else {
          line = String(line[..<start.lowerBound])
          inComment = true
        }
        line = line.trimmingCharacters(in: .whitespaces)
      }
      if line.isEmpty {
        flush()
        continue
      }
      let hashes = line.prefix(while: { $0 == "#" }).count
      if (1...6).contains(hashes), line.dropFirst(hashes).first == " " {
        flush()
        out.append(.heading(level: hashes, text: line.dropFirst(hashes + 1)
          .trimmingCharacters(in: .whitespaces)))
      } else if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
        flush()
        out.append(.bullet(text: String(line.dropFirst(2))))
      } else {
        paragraph.append(line)
      }
    }
    flush()
    return out
  }

  /// Inline Markdown, or the literal text when it does not parse.
  static func inline(_ text: String) -> AttributedString {
    (try? AttributedString(
      markdown: text,
      options: .init(
        allowsExtendedAttributes: false,
        interpretedSyntax: .inlineOnlyPreservingWhitespace,
        failurePolicy: .throwError)))
      ?? AttributedString(text)
  }
}

struct ReleaseNotesView: View {
  let notes: String

  var body: some View {
    let blocks = ReleaseNotesMarkdown.blocks(notes)
    VStack(alignment: .leading, spacing: 6) {
      if blocks.isEmpty {
        Text(notes)
      }
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        switch block {
        case .heading(let level, let text):
          Text(ReleaseNotesMarkdown.inline(text))
            .font(level <= 2 ? .headline : .subheadline.weight(.semibold))
            .padding(.top, 4)
        case .bullet(let text):
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("•")
            Text(ReleaseNotesMarkdown.inline(text))
              .fixedSize(horizontal: false, vertical: true)
          }
        case .paragraph(let text):
          Text(ReleaseNotesMarkdown.inline(text))
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .textSelection(.enabled)
  }
}

/// Canned states, byte-for-byte the output of
/// `ANYPICK_UPDATE_TESTING=1 ANYPICK_UPDATE_FIXTURE=<kind> anypick update check --json --current 1.1.0`
/// on darwin. Go test TestSwiftUpdateFixturesMatchGo fails if they drift.
enum UpdateStatusFixtures {
  static let lines: [String: String] = [
    "storageUnavailable": ###"{"schema":1,"kind":"storageUnavailable","current":"1.1.0","latest":"1.1.1","notes":"## What's new\n- Settings \u003e Updates checks GitHub Releases for you.\n- Fixed the Add App… button lining up with the cards.\n","channel":"direct","releaseURL":"https://github.com/outof0/anypick/releases/tag/v1.1.1","progress":0,"message":"AnyPick couldn't read or save the update safety state. No update was downloaded. Check folder permissions, then retry.","retry":true}"###,
    "checking": ###"{"schema":1,"kind":"checking","current":"1.1.0","channel":"direct","releaseURL":"https://github.com/outof0/anypick/releases","progress":0,"message":"Checking for updates…","retry":false}"###,
    "upToDate": ###"{"schema":1,"kind":"upToDate","current":"1.1.0","latest":"1.1.0","channel":"direct","releaseURL":"https://github.com/outof0/anypick/releases","progress":0,"message":"AnyPick 1.1.0 is the latest version.","retry":false}"###,
    "availableDirect": ###"{"schema":1,"kind":"availableDirect","current":"1.1.0","latest":"1.1.1","notes":"## What's new\n- Settings \u003e Updates checks GitHub Releases for you.\n- Fixed the Add App… button lining up with the cards.\n","channel":"direct","actionKind":"selfUpdate","releaseURL":"https://github.com/outof0/anypick/releases/tag/v1.1.1","progress":0,"retry":false}"###,
    "availablePackageManager": ###"{"schema":1,"kind":"availablePackageManager","current":"1.1.0","latest":"1.1.1","notes":"## What's new\n- Settings \u003e Updates checks GitHub Releases for you.\n- Fixed the Add App… button lining up with the cards.\n","channel":"brew","actionKind":"command","command":"brew upgrade --cask anypick","lead":"Installed with Homebrew, so update it there:","releaseURL":"https://github.com/outof0/anypick/releases/tag/v1.1.1","progress":0,"retry":false}"###,
    "downloading": ###"{"schema":1,"kind":"downloading","current":"1.1.0","latest":"1.1.1","notes":"## What's new\n- Settings \u003e Updates checks GitHub Releases for you.\n- Fixed the Add App… button lining up with the cards.\n","channel":"direct","releaseURL":"https://github.com/outof0/anypick/releases/tag/v1.1.1","progress":0.42,"message":"Downloading the update…","retry":false}"###,
    "verifying": ###"{"schema":1,"kind":"verifying","current":"1.1.0","latest":"1.1.1","notes":"## What's new\n- Settings \u003e Updates checks GitHub Releases for you.\n- Fixed the Add App… button lining up with the cards.\n","channel":"direct","releaseURL":"https://github.com/outof0/anypick/releases/tag/v1.1.1","progress":1,"message":"Checking the download against the release checksum…","retry":false}"###,
    "ready": ###"{"schema":1,"kind":"ready","current":"1.1.0","latest":"1.1.1","notes":"## What's new\n- Settings \u003e Updates checks GitHub Releases for you.\n- Fixed the Add App… button lining up with the cards.\n","channel":"direct","releaseURL":"https://github.com/outof0/anypick/releases/tag/v1.1.1","progress":1,"message":"Downloaded from GitHub Releases. The file matches the release checksum. Install it manually from Finder; AnyPick stays on this version.","footnote":"macOS may ask again for access AnyPick already had, such as Keychain or Automation, because this build isn't notarized. Allow it to keep things working.","retry":false,"filePath":"/Users/qa/Library/Caches/AnyPick/update/1.1.1/AnyPick-macos-universal.zip"}"###,
    "offline": ###"{"schema":1,"kind":"offline","current":"1.1.0","channel":"direct","releaseURL":"https://github.com/outof0/anypick/releases","progress":0,"message":"Couldn't reach GitHub. Check your connection and try again.","retry":true}"###,
    "badChecksum": ###"{"schema":1,"kind":"badChecksum","current":"1.1.0","latest":"1.1.1","notes":"## What's new\n- Settings \u003e Updates checks GitHub Releases for you.\n- Fixed the Add App… button lining up with the cards.\n","channel":"direct","releaseURL":"https://github.com/outof0/anypick/releases/tag/v1.1.1","progress":0,"message":"Update didn't finish. The download didn't match the release checksum, so it was deleted and nothing was changed. You're still on 1.1.0.","retry":true}"###,
    "hostBlocked": ###"{"schema":1,"kind":"hostBlocked","current":"1.1.0","latest":"1.1.1","notes":"## What's new\n- Settings \u003e Updates checks GitHub Releases for you.\n- Fixed the Add App… button lining up with the cards.\n","channel":"direct","actionKind":"manual","lead":"View on GitHub","releaseURL":"https://github.com/outof0/anypick/releases/tag/v1.1.1","progress":0,"message":"Update didn't finish. The download came from an address AnyPick doesn't trust, so nothing was changed. You're still on 1.1.0.","retry":false}"###,
    "rateLimited": ###"{"schema":1,"kind":"rateLimited","current":"1.1.0","channel":"direct","releaseURL":"https://github.com/outof0/anypick/releases","progress":0,"message":"GitHub is limiting update checks right now. Try again in a little while.","retry":true}"###,
    "notWritable": ###"{"schema":1,"kind":"notWritable","current":"1.1.0","latest":"1.1.1","notes":"## What's new\n- Settings \u003e Updates checks GitHub Releases for you.\n- Fixed the Add App… button lining up with the cards.\n","channel":"direct","releaseURL":"https://github.com/outof0/anypick/releases/tag/v1.1.1","progress":0,"message":"AnyPick can't save the download to its cache folder. Download the update in your browser instead.","retry":false}"###,
  ]

  static func status(_ kind: String) -> UpdateStatusDTO? {
    lines[kind].flatMap { UpdateStatusDTO.decode(line: $0) }
  }
}
