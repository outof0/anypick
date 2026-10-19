use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashSet;
use std::fmt;

pub const PROTOCOL_VERSION: u32 = 2;
pub const MESSAGE_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

#[cfg(test)]
#[path = "protocol_service_tests.rs"]
mod service_tests;

const MAX_HANDSHAKE_VERSION_BYTES: usize = 128;
const MAX_HANDSHAKE_CAPABILITIES: usize = 64;
const MAX_CAPABILITY_BYTES: usize = 64;
const MAX_REJECTION_CODE_BYTES: usize = 64;
const MAX_REJECTION_MESSAGE_BYTES: usize = 512;

const HOST_CAPABILITIES: &[&str] = &[
    "cancel-v1",
    "command-dto-v1",
    "explicit-refresh",
    "host-effects-v1",
    "post-mutation-events",
    "snapshot-dto-v1",
    "usage-events-v1",
];
const REQUIRED_CAPABILITIES: &[&str] = &["command-dto-v1", "snapshot-dto-v1"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Send(String),
    Ready,
    Deliver(String),
    HostEffect {
        request_id: String,
        kind: String,
        enabled: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    FrameTooLarge,
    UnexpectedFrame(String),
    InvalidPayload(String),
    Incompatible(String),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FrameTooLarge => write!(formatter, "the service frame exceeded its bound"),
            Self::UnexpectedFrame(kind) => {
                write!(formatter, "unexpected service frame {kind:?}")
            }
            Self::InvalidPayload(kind) => write!(formatter, "invalid {kind} payload"),
            Self::Incompatible(reason) => {
                write!(formatter, "the bundled service is incompatible: {reason}")
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    WaitingForHello,
    WaitingForReady,
    Ready,
}

pub struct AppProtocol {
    app_version: String,
    platform: String,
    phase: Phase,
    max_frame_bytes: usize,
    engine_capabilities: Vec<String>,
}

impl AppProtocol {
    pub fn new(app_version: impl Into<String>, platform: impl Into<String>) -> Self {
        Self {
            app_version: app_version.into(),
            platform: platform.into(),
            phase: Phase::WaitingForHello,
            max_frame_bytes: MAX_FRAME_BYTES,
            engine_capabilities: Vec::new(),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.phase == Phase::Ready
    }

    pub fn consume_line(&mut self, line: &str) -> Result<Vec<Action>, ProtocolError> {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.len() > self.max_frame_bytes {
            return Err(ProtocolError::FrameTooLarge);
        }
        let (kind, encoded) = line
            .split_once('\t')
            .ok_or_else(|| ProtocolError::UnexpectedFrame("unframed".into()))?;

        match self.phase {
            Phase::WaitingForHello => {
                if kind != "hello" {
                    return Err(ProtocolError::UnexpectedFrame(kind.into()));
                }
                let hello: EngineHello = decode_frame(encoded, "hello", self.max_frame_bytes)?;
                self.validate_engine_hello(&hello)?;
                let max_frame_bytes = hello.max_frame_bytes.min(MAX_FRAME_BYTES);
                let host = HostHello {
                    protocol_version: PROTOCOL_VERSION,
                    app_version: &self.app_version,
                    platform: &self.platform,
                    capabilities: HOST_CAPABILITIES,
                    host_state: HostState {
                        launch_at_login: false,
                    },
                };
                let response = encode_frame_with_limit("hello", &host, max_frame_bytes)?;
                self.engine_capabilities = hello.capabilities;
                self.max_frame_bytes = max_frame_bytes;
                self.phase = Phase::WaitingForReady;
                Ok(vec![Action::Send(response)])
            }
            Phase::WaitingForReady => {
                if kind == "handshake-rejected" {
                    let rejected: HandshakeRejected =
                        decode_frame(encoded, kind, self.max_frame_bytes)?;
                    if rejected.protocol_version != PROTOCOL_VERSION
                        || !safe_required_string(&rejected.code, MAX_REJECTION_CODE_BYTES)
                        || !safe_required_string(&rejected.message, MAX_REJECTION_MESSAGE_BYTES)
                    {
                        return Err(ProtocolError::InvalidPayload(kind.into()));
                    }
                    return Err(ProtocolError::Incompatible(rejected.message));
                }
                if kind != "ready" {
                    return Err(ProtocolError::UnexpectedFrame(kind.into()));
                }
                let ready: HandshakeReady = decode_frame(encoded, "ready", self.max_frame_bytes)?;
                if ready.protocol_version != PROTOCOL_VERSION
                    || !contains_required(&ready.capabilities)
                    || !valid_capabilities(&ready.capabilities)
                    || !ready.capabilities.iter().all(|capability| {
                        HOST_CAPABILITIES.contains(&capability.as_str())
                            && self.engine_capabilities.contains(capability)
                    })
                {
                    return Err(ProtocolError::Incompatible(
                        "capability negotiation failed".into(),
                    ));
                }
                self.phase = Phase::Ready;
                Ok(vec![Action::Ready])
            }
            Phase::Ready => {
                const DELIVERED: &[&str] = &[
                    "snapshot",
                    "snapshot-event",
                    "usage-event",
                    "result",
                    "logs",
                    "backup-preview",
                    "doctor",
                    "protocol-error",
                ];
                if kind == "host-effect" {
                    let effect: HostEffectFrame =
                        decode_frame(encoded, kind, self.max_frame_bytes)?;
                    if effect.protocol_version != PROTOCOL_VERSION
                        || !safe_required_string(&effect.request_id, 128)
                        || effect.effect.kind != "launch-at-login"
                    {
                        return Err(ProtocolError::InvalidPayload(kind.into()));
                    }
                    return Ok(vec![Action::HostEffect {
                        request_id: effect.request_id,
                        kind: effect.effect.kind,
                        enabled: effect.effect.enabled,
                    }]);
                }
                if !DELIVERED.contains(&kind) {
                    return Err(ProtocolError::UnexpectedFrame(kind.into()));
                }
                // Full DTO decoding remains in the existing TypeScript boundary;
                // Rust validates ordering, framing, envelope versions and size.
                let payload = canonical_payload(encoded, kind, self.max_frame_bytes)?;
                validate_delivered_version(kind, &payload)?;
                Ok(vec![Action::Deliver(line.to_string())])
            }
        }
    }

    pub fn host_effect_unavailable(
        &self,
        request_id: &str,
        message: &str,
    ) -> Result<String, ProtocolError> {
        encode_frame_with_limit(
            "host-effect-result",
            &HostEffectResult {
                protocol_version: PROTOCOL_VERSION,
                request_id,
                status: "error",
                message,
                host_state: HostState {
                    launch_at_login: false,
                },
            },
            self.max_frame_bytes,
        )
    }

    fn validate_engine_hello(&self, hello: &EngineHello) -> Result<(), ProtocolError> {
        if hello.protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolError::Incompatible(format!(
                "protocol {}, expected {PROTOCOL_VERSION}",
                hello.protocol_version
            )));
        }
        if hello.message_version != MESSAGE_VERSION {
            return Err(ProtocolError::Incompatible(format!(
                "message schema {}, expected {MESSAGE_VERSION}",
                hello.message_version
            )));
        }
        if hello.max_frame_bytes == 0 || hello.max_frame_bytes > MAX_FRAME_BYTES {
            return Err(ProtocolError::Incompatible("invalid frame bound".into()));
        }
        if !contains_required(&hello.capabilities) || !valid_capabilities(&hello.capabilities) {
            return Err(ProtocolError::Incompatible(
                "required capabilities are missing or duplicated".into(),
            ));
        }
        if !safe_required_string(&hello.engine_version, MAX_HANDSHAKE_VERSION_BYTES)
            || hello.schema_version == 0
            || !valid_instance_id(&hello.instance_id)
        {
            return Err(ProtocolError::InvalidPayload("hello".into()));
        }
        if self.app_version != "(devel)"
            && hello.engine_version != "(devel)"
            && self.app_version != hello.engine_version
        {
            return Err(ProtocolError::Incompatible(format!(
                "app {}, service {}",
                self.app_version, hello.engine_version
            )));
        }
        Ok(())
    }
}

pub fn host_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn contains_required(capabilities: &[String]) -> bool {
    REQUIRED_CAPABILITIES
        .iter()
        .all(|required| capabilities.iter().any(|value| value == required))
}

fn has_duplicates(values: &[String]) -> bool {
    let mut seen = HashSet::with_capacity(values.len());
    values.iter().any(|value| !seen.insert(value))
}

fn valid_capabilities(capabilities: &[String]) -> bool {
    !capabilities.is_empty()
        && capabilities.len() <= MAX_HANDSHAKE_CAPABILITIES
        && !has_duplicates(capabilities)
        && capabilities
            .iter()
            .all(|value| safe_required_string(value, MAX_CAPABILITY_BYTES))
}

fn safe_required_string(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && !value
            .chars()
            .any(|character| character < '\u{20}' || character == '\u{7f}')
}

fn valid_instance_id(value: &str) -> bool {
    value == "unavailable"
        || (value.len() == 32
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn canonical_payload(
    encoded: &str,
    kind: &str,
    limit: usize,
) -> Result<serde_json::Value, ProtocolError> {
    let raw = STANDARD
        .decode(encoded)
        .map_err(|_| ProtocolError::InvalidPayload(kind.into()))?;
    if raw.len() > limit || STANDARD.encode(&raw) != encoded {
        return Err(ProtocolError::InvalidPayload(kind.into()));
    }
    let value = serde_json::from_slice::<serde_json::Value>(&raw)
        .map_err(|_| ProtocolError::InvalidPayload(kind.into()))?;
    if !value.is_object() {
        return Err(ProtocolError::InvalidPayload(kind.into()));
    }
    Ok(value)
}

fn validate_delivered_version(
    kind: &str,
    payload: &serde_json::Value,
) -> Result<(), ProtocolError> {
    let expected = match kind {
        "snapshot" => return Ok(()),
        "snapshot-event" | "usage-event" | "protocol-error" => {
            ("protocolVersion", PROTOCOL_VERSION)
        }
        "result" | "logs" | "backup-preview" | "doctor" => ("version", MESSAGE_VERSION),
        _ => return Err(ProtocolError::UnexpectedFrame(kind.into())),
    };
    if payload.get(expected.0).and_then(serde_json::Value::as_u64) != Some(expected.1.into()) {
        return Err(ProtocolError::InvalidPayload(kind.into()));
    }
    Ok(())
}

fn decode_frame<T: DeserializeOwned>(
    encoded: &str,
    kind: &str,
    limit: usize,
) -> Result<T, ProtocolError> {
    let raw = STANDARD
        .decode(encoded)
        .map_err(|_| ProtocolError::InvalidPayload(kind.into()))?;
    if raw.len() > limit || STANDARD.encode(&raw) != encoded {
        return Err(ProtocolError::InvalidPayload(kind.into()));
    }
    serde_json::from_slice(&raw).map_err(|_| ProtocolError::InvalidPayload(kind.into()))
}

#[cfg(test)]
fn encode_frame<T: Serialize>(kind: &str, value: &T) -> Result<String, ProtocolError> {
    encode_frame_with_limit(kind, value, MAX_FRAME_BYTES)
}

fn encode_frame_with_limit<T: Serialize>(
    kind: &str,
    value: &T,
    limit: usize,
) -> Result<String, ProtocolError> {
    let raw = serde_json::to_vec(value).map_err(|_| ProtocolError::InvalidPayload(kind.into()))?;
    let frame = format!("{kind}\t{}", STANDARD.encode(raw));
    if frame.len() > limit {
        return Err(ProtocolError::FrameTooLarge);
    }
    Ok(frame)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EngineHello {
    protocol_version: u32,
    message_version: u32,
    engine_version: String,
    schema_version: u32,
    capabilities: Vec<String>,
    instance_id: String,
    max_frame_bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostHello<'a> {
    protocol_version: u32,
    app_version: &'a str,
    platform: &'a str,
    capabilities: &'a [&'a str],
    host_state: HostState,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostState {
    launch_at_login: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandshakeReady {
    protocol_version: u32,
    capabilities: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandshakeRejected {
    protocol_version: u32,
    code: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostEffectFrame {
    protocol_version: u32,
    request_id: String,
    effect: HostEffect,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HostEffect {
    kind: String,
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostEffectResult<'a> {
    protocol_version: u32,
    request_id: &'a str,
    status: &'a str,
    message: &'a str,
    host_state: HostState,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(kind: &str, value: serde_json::Value) -> String {
        encode_frame(kind, &value).unwrap()
    }

    fn hello(version: u32) -> String {
        hello_with(serde_json::json!({
            "protocolVersion": version,
            "messageVersion": 1,
            "engineVersion": "1.0.0",
            "schemaVersion": 12,
            "capabilities": HOST_CAPABILITIES,
            "instanceId": "0123456789abcdef0123456789abcdef",
            "maxFrameBytes": MAX_FRAME_BYTES,
        }))
    }

    fn hello_with(value: serde_json::Value) -> String {
        encoded("hello", value)
    }

    fn ready() -> String {
        encoded(
            "ready",
            serde_json::json!({
                "protocolVersion": 2,
                "capabilities": HOST_CAPABILITIES,
            }),
        )
    }

    #[test]
    fn handshake_gates_delivery_until_ready() {
        let mut protocol = AppProtocol::new("1.0.0", "test");
        let actions = protocol.consume_line(&hello(2)).unwrap();
        assert!(matches!(actions.as_slice(), [Action::Send(line)] if line.starts_with("hello\t")));
        assert!(!protocol.is_ready());
        assert_eq!(
            protocol.consume_line(&ready()).unwrap(),
            vec![Action::Ready]
        );
        assert!(protocol.is_ready());
        let snapshot = encoded("snapshot", serde_json::json!({"revision": 1}));
        assert_eq!(
            protocol.consume_line(&snapshot).unwrap(),
            vec![Action::Deliver(snapshot)]
        );
    }

    #[test]
    fn handshake_rejects_protocol_and_build_mismatches() {
        let mut protocol = AppProtocol::new("1.0.0", "test");
        assert!(matches!(
            protocol.consume_line(&hello(1)),
            Err(ProtocolError::Incompatible(_))
        ));
        let mut protocol = AppProtocol::new("2.0.0", "test");
        assert!(matches!(
            protocol.consume_line(&hello(2)),
            Err(ProtocolError::Incompatible(_))
        ));
    }

    #[test]
    fn ready_protocol_decodes_typed_host_effects() {
        let mut protocol = AppProtocol::new("1.0.0", "test");
        protocol.consume_line(&hello(2)).unwrap();
        protocol.consume_line(&ready()).unwrap();
        let effect = encoded(
            "host-effect",
            serde_json::json!({
                "protocolVersion": 2,
                "requestId": "req-1",
                "effect": {"kind": "launch-at-login", "enabled": true},
            }),
        );
        assert_eq!(
            protocol.consume_line(&effect).unwrap(),
            vec![Action::HostEffect {
                request_id: "req-1".into(),
                kind: "launch-at-login".into(),
                enabled: true,
            }]
        );
    }

    #[test]
    fn protocol_rejects_noncanonical_and_oversized_frames() {
        let mut protocol = AppProtocol::new("1.0.0", "test");
        assert!(matches!(
            protocol.consume_line("hello\t***"),
            Err(ProtocolError::InvalidPayload(_))
        ));
        let huge = "x".repeat(MAX_FRAME_BYTES + 1);
        assert_eq!(
            protocol.consume_line(&huge),
            Err(ProtocolError::FrameTooLarge)
        );
    }

    #[test]
    fn handshake_strictly_validates_message_version_capabilities_and_instance_id() {
        let base = serde_json::json!({
            "protocolVersion": 2,
            "messageVersion": 1,
            "engineVersion": "1.0.0",
            "schemaVersion": 12,
            "capabilities": HOST_CAPABILITIES,
            "instanceId": "0123456789abcdef0123456789abcdef",
            "maxFrameBytes": MAX_FRAME_BYTES,
        });
        for (field, replacement) in [
            ("messageVersion", serde_json::json!(2)),
            (
                "capabilities",
                serde_json::json!(["command-dto-v1", "command-dto-v1", "snapshot-dto-v1"]),
            ),
            (
                "instanceId",
                serde_json::json!("0123456789ABCDEF0123456789ABCDEF"),
            ),
        ] {
            let mut value = base.clone();
            value[field] = replacement;
            let mut protocol = AppProtocol::new("1.0.0", "test");
            assert!(protocol.consume_line(&hello_with(value)).is_err());
            assert!(!protocol.is_ready());
        }

        let mut fallback = base;
        fallback["instanceId"] = serde_json::json!("unavailable");
        let mut protocol = AppProtocol::new("1.0.0", "test");
        assert!(matches!(
            protocol
                .consume_line(&hello_with(fallback))
                .unwrap()
                .as_slice(),
            [Action::Send(_)]
        ));
    }

    #[test]
    fn ready_capabilities_must_be_unique_and_negotiated() {
        for capabilities in [
            serde_json::json!(["command-dto-v1", "snapshot-dto-v1", "snapshot-dto-v1"]),
            serde_json::json!(["command-dto-v1", "snapshot-dto-v1", "invented-v1"]),
        ] {
            let mut protocol = AppProtocol::new("1.0.0", "test");
            protocol.consume_line(&hello(2)).unwrap();
            let frame = encoded(
                "ready",
                serde_json::json!({
                    "protocolVersion": 2,
                    "capabilities": capabilities,
                }),
            );
            assert!(matches!(
                protocol.consume_line(&frame),
                Err(ProtocolError::Incompatible(_))
            ));
            assert!(!protocol.is_ready());
        }
    }

    #[test]
    fn handshake_rejection_and_delivered_envelopes_require_matching_versions() {
        let mut rejected = AppProtocol::new("1.0.0", "test");
        rejected.consume_line(&hello(2)).unwrap();
        let rejection = encoded(
            "handshake-rejected",
            serde_json::json!({
                "protocolVersion": 1,
                "code": "HANDSHAKE_REJECTED",
                "message": "mismatch",
            }),
        );
        assert_eq!(
            rejected.consume_line(&rejection),
            Err(ProtocolError::InvalidPayload("handshake-rejected".into()))
        );

        let mut protocol = AppProtocol::new("1.0.0", "test");
        protocol.consume_line(&hello(2)).unwrap();
        protocol.consume_line(&ready()).unwrap();
        for (kind, payload) in [
            (
                "snapshot-event",
                serde_json::json!({"protocolVersion": 1, "revision": 1}),
            ),
            (
                "result",
                serde_json::json!({"version": 2, "requestId": "r", "status": "success"}),
            ),
        ] {
            assert_eq!(
                protocol.consume_line(&encoded(kind, payload)),
                Err(ProtocolError::InvalidPayload(kind.into()))
            );
        }
    }
    #[test]
    fn doctor_report_reaches_ui_and_keeps_service_ready() {
        let mut protocol = AppProtocol::new("1.0.0", "linux");
        protocol.consume_line(&hello(2)).unwrap();
        protocol.consume_line(&ready()).unwrap();
        let report = encoded(
            "doctor",
            serde_json::json!({
                "version": MESSAGE_VERSION,
                "requestId": "doctor-1",
                "status": "ok",
                "findings": [],
            }),
        );
        assert_eq!(
            protocol.consume_line(&report).unwrap(),
            vec![Action::Deliver(report)]
        );
        assert!(protocol.is_ready());
        let snapshot = encoded("snapshot", serde_json::json!({"revision": 2}));
        assert_eq!(
            protocol.consume_line(&snapshot).unwrap(),
            vec![Action::Deliver(snapshot)]
        );
        for payload in [serde_json::json!({"version": 2}), serde_json::json!({})] {
            assert_eq!(
                protocol.consume_line(&encoded("doctor", payload)),
                Err(ProtocolError::InvalidPayload("doctor".into()))
            );
        }
    }
}
