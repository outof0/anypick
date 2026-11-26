import Foundation

enum AppServiceConnectionState: Equatable, Sendable {
  case starting
  case handshaking
  case ready
  case degraded(String)
  case stopped
}

enum AppServiceClientAction: Sendable {
  case send(String)
  case deliver(Data)
  case state(AppServiceConnectionState)
  case hostEffect(requestId: String, effect: AppHostEffect)
}

struct AppHostState: Codable, Sendable {
  let launchAtLogin: Bool
}

struct AppHostEffect: Codable, Sendable {
  let kind: String
  let enabled: Bool
}

enum AppServiceProtocolError: LocalizedError {
  case frameTooLarge
  case invalidUTF8
  case unexpectedFrame(String)
  case invalidPayload(String)
  /// A frame this build recognizes but cannot decode: the two sides disagree
  /// about a payload. `detail` names the disagreeing key; `errorDescription`
  /// stays generic so nothing engine-authored reaches the UI unvetted.
  case decodeFailed(kind: String, detail: String)
  case incompatible(String)

  var errorDescription: String? {
    switch self {
    case .frameTooLarge:
      "The AnyPick service sent a frame larger than the negotiated limit."
    case .invalidUTF8:
      "The AnyPick service sent invalid text."
    case .unexpectedFrame:
      "The AnyPick service sent an unexpected protocol frame."
    case .invalidPayload(let kind):
      "The AnyPick service sent an invalid \(kind) payload."
    case .decodeFailed(let kind, _):
      "The AnyPick service sent an invalid \(kind) payload."
    case .incompatible(let reason):
      "This AnyPick app and its bundled service are incompatible: \(safeProtocolReason(reason))"
    }
  }

  /// Diagnostic detail for the app log. It names frame kinds and decoding keys,
  /// never payload values, so it is the difference between "invalid payload"
  /// and "the engine added a field this build requires" — and it is safe to
  /// record where a reader can find it. A failure that only says "the service
  /// sent an unexpected frame" cannot be acted on by anyone.
  var diagnosticDetail: String {
    switch self {
    case .frameTooLarge:
      return "frameTooLarge"
    case .invalidUTF8:
      return "invalidUTF8"
    case .unexpectedFrame(let kind):
      return "unexpectedFrame: \(kind)"
    case .invalidPayload(let kind):
      return "invalidPayload: \(kind)"
    case .decodeFailed(let kind, let detail):
      return "\(kind): \(detail)"
    case .incompatible(let reason):
      return "incompatible: \(safeProtocolReason(reason))"
    }
  }
}

private func safeProtocolReason(_ reason: String) -> String {
  let compact = reason
    .replacingOccurrences(of: "\n", with: " ")
    .trimmingCharacters(in: .whitespacesAndNewlines)
  let longestToken = compact
    .split(whereSeparator: { $0 == " " || $0 == "\t" })
    .map(\.count)
    .max() ?? 0
  guard !compact.isEmpty, compact.count <= 160, longestToken < 80 else {
    return "protocol negotiation failed"
  }
  return compact
}

private struct EngineHello: Decodable {
  let protocolVersion: Int
  let messageVersion: Int
  let engineVersion: String
  let schemaVersion: Int
  let capabilities: [String]
  let instanceId: String
  let maxFrameBytes: Int
}

private struct HostHello: Encodable {
  let protocolVersion: Int
  let appVersion: String
  let platform: String
  let capabilities: [String]
  let hostState: AppHostState
}

private struct HostEffectFrame: Decodable {
  let protocolVersion: Int
  let requestId: String
  let effect: AppHostEffect
}

private struct HostEffectResult: Encodable {
  let protocolVersion: Int
  let requestId: String
  let status: String
  let message: String?
  let hostState: AppHostState
}

private struct HandshakeReady: Decodable {
  let protocolVersion: Int
  let capabilities: [String]
}

private struct HandshakeRejected: Decodable {
  let protocolVersion: Int
  let code: String
  let message: String
}

/// Pure, stateful decoder for the app-service pipe. Process ownership lives in
/// GoServiceProcess; this actor only validates negotiation and frame ordering.
actor AppServiceClient {
  static let protocolVersion = 3
  static let messageVersion = 1
  static let maxFrameBytes = 4 * 1024 * 1024
  static let capabilities = [
    "cancel-v1",
    "command-dto-v1",
    "doctor-v1",
    "explicit-refresh",
    "host-effects-v1",
    "post-mutation-events",
    "snapshot-dto-v1",
    "usage-events-v1",
  ]

  private enum Phase {
    case waitingForHello
    case waitingForReady
    case ready
  }

  private let appVersion: String
  private var hostState: AppHostState
  private var phase = Phase.waitingForHello
  private var buffer = Data()
  private var negotiatedMaxFrameBytes = AppServiceClient.maxFrameBytes

  init(appVersion: String, launchAtLogin: Bool) {
    self.appVersion = appVersion
    hostState = AppHostState(launchAtLogin: launchAtLogin)
  }

  func reset() {
    phase = .waitingForHello
    buffer.removeAll(keepingCapacity: true)
    negotiatedMaxFrameBytes = Self.maxFrameBytes
  }

  func isReady() -> Bool {
    if case .ready = phase { return true }
    return false
  }

  func updateHostState(launchAtLogin: Bool) {
    hostState = AppHostState(launchAtLogin: launchAtLogin)
  }

  func hostEffectResultLine(
    requestId: String,
    status: String,
    message: String?,
    launchAtLogin: Bool
  ) throws -> String {
    hostState = AppHostState(launchAtLogin: launchAtLogin)
    return try encode(
      "host-effect-result",
      HostEffectResult(
        protocolVersion: Self.protocolVersion,
        requestId: requestId,
        status: status,
        message: message,
        hostState: hostState
      )
    )
  }

  func consume(_ data: Data) throws -> [AppServiceClientAction] {
    guard !data.isEmpty else { return [] }
    buffer.append(data)
    if buffer.count > negotiatedMaxFrameBytes, !buffer.contains(10) {
      throw AppServiceProtocolError.frameTooLarge
    }

    var actions: [AppServiceClientAction] = []
    while let newline = buffer.firstIndex(of: 10) {
      let lineData = Data(buffer.prefix(upTo: newline))
      buffer.removeSubrange(...newline)
      guard lineData.count <= negotiatedMaxFrameBytes else {
        throw AppServiceProtocolError.frameTooLarge
      }
      guard let line = String(data: lineData, encoding: .utf8) else {
        throw AppServiceProtocolError.invalidUTF8
      }
      actions.append(contentsOf: try consumeLine(line))
    }
    return actions
  }

  private func consumeLine(_ line: String) throws -> [AppServiceClientAction] {
    let fields = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
      .map(String.init)
    guard fields.count == 2 else {
      throw AppServiceProtocolError.unexpectedFrame("unframed")
    }

    switch phase {
    case .waitingForHello:
      guard fields[0] == "hello" else {
        throw AppServiceProtocolError.unexpectedFrame(fields[0])
      }
      let hello: EngineHello = try decode(fields[1], kind: "hello")
      try validate(hello)
      negotiatedMaxFrameBytes = min(hello.maxFrameBytes, Self.maxFrameBytes)
      phase = .waitingForReady
      let host = HostHello(
        protocolVersion: Self.protocolVersion,
        appVersion: appVersion,
        platform: "macos",
        capabilities: Self.capabilities,
        hostState: hostState
      )
      return [
        .state(.handshaking),
        .send(try encode("hello", host)),
      ]

    case .waitingForReady:
      if fields[0] == "handshake-rejected" {
        let rejection: HandshakeRejected = try decode(fields[1], kind: fields[0])
        throw AppServiceProtocolError.incompatible(rejection.message)
      }
      guard fields[0] == "ready" else {
        throw AppServiceProtocolError.unexpectedFrame(fields[0])
      }
      let ready: HandshakeReady = try decode(fields[1], kind: "ready")
      guard ready.protocolVersion == Self.protocolVersion,
            Self.requiredCapabilities.isSubset(of: Set(ready.capabilities)) else {
        throw AppServiceProtocolError.incompatible("capability negotiation failed")
      }
      phase = .ready
      return [.state(.ready)]

    case .ready:
      let allowed = Set([
        "snapshot", "snapshot-event", "usage-event", "result", "logs",
        "backup-preview", "doctor", "protocol-error", "host-effect",
      ])
      guard allowed.contains(fields[0]) else {
        throw AppServiceProtocolError.unexpectedFrame(fields[0])
      }
      if fields[0] == "host-effect" {
        let effect: HostEffectFrame = try decode(fields[1], kind: fields[0])
        guard effect.protocolVersion == Self.protocolVersion,
              !effect.requestId.isEmpty, effect.requestId.count <= 128,
              effect.effect.kind == "launch-at-login" else {
          throw AppServiceProtocolError.invalidPayload(fields[0])
        }
        return [.hostEffect(requestId: effect.requestId, effect: effect.effect)]
      }
      return [.deliver(Data("\(line)\n".utf8))]
    }
  }

  private func validate(_ hello: EngineHello) throws {
    guard hello.protocolVersion == Self.protocolVersion else {
      throw AppServiceProtocolError.incompatible(
        "protocol \(hello.protocolVersion), expected \(Self.protocolVersion)"
      )
    }
    guard hello.messageVersion == Self.messageVersion else {
      throw AppServiceProtocolError.incompatible(
        "message schema \(hello.messageVersion), expected \(Self.messageVersion)"
      )
    }
    guard hello.maxFrameBytes > 0, hello.maxFrameBytes <= Self.maxFrameBytes else {
      throw AppServiceProtocolError.incompatible("invalid frame bound")
    }
    guard Self.requiredCapabilities.isSubset(of: Set(hello.capabilities)) else {
      throw AppServiceProtocolError.incompatible("required capabilities are missing")
    }
    guard !hello.engineVersion.isEmpty, hello.schemaVersion > 0,
          hello.instanceId.count == 32 else {
      throw AppServiceProtocolError.invalidPayload("hello")
    }
    if appVersion != "(devel)", hello.engineVersion != "(devel)",
       appVersion != hello.engineVersion {
      throw AppServiceProtocolError.incompatible(
        "app \(appVersion), service \(hello.engineVersion)"
      )
    }
  }

  private func decode<T: Decodable>(_ encoded: String, kind: String) throws -> T {
    guard let data = Data(base64Encoded: encoded),
          data.base64EncodedString() == encoded,
          data.count <= negotiatedMaxFrameBytes else {
      throw AppServiceProtocolError.invalidPayload(kind)
    }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      // `try?` here discarded the only clue about which field diverged, and
      // the user got the same sentence for a version skew and a corrupt frame.
      throw AppServiceProtocolError.decodeFailed(
        kind: kind,
        detail: String("\(error)".prefix(300))
      )
    }
  }

  private func encode<T: Encodable>(_ prefix: String, _ value: T) throws -> String {
    let data = try JSONEncoder().encode(value)
    guard data.count <= negotiatedMaxFrameBytes else {
      throw AppServiceProtocolError.frameTooLarge
    }
    return "\(prefix)\t\(data.base64EncodedString())"
  }

  private static let requiredCapabilities = Set(["command-dto-v1", "doctor-v1", "snapshot-dto-v1"])
}
