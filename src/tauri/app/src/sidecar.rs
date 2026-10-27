use crate::protocol::{host_platform, Action, AppProtocol, ProtocolError, MAX_FRAME_BYTES};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Serialize;
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const SIDECAR_NAME: &str = "anypick-core";
const SIDECAR_ARGS: [&str; 2] = ["desktop-service", "--stdio"];
const MAX_UI_COMMAND_BYTES: usize = 16 * 1024;
const MAX_RESTARTS: usize = 3;
const RESTART_DELAYS_MS: [u64; MAX_RESTARTS] = [250, 1_000, 2_000];
const RESTART_STABILITY_WINDOW: Duration = Duration::from_secs(30);
const GRACEFUL_QUIT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
enum StdoutFrameError {
    LineTooLarge,
    InvalidUtf8,
    UnterminatedLine,
}

impl fmt::Display for StdoutFrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LineTooLarge => write!(formatter, "AnyPick core sent an oversized frame."),
            Self::InvalidUtf8 => write!(formatter, "AnyPick core sent invalid UTF-8."),
            Self::UnterminatedLine => {
                write!(formatter, "AnyPick core closed with an incomplete frame.")
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ChunkError<E> {
    Framing(StdoutFrameError),
    Consumer(E),
}

struct StdoutLineBuffer {
    pending: Vec<u8>,
    max_line_bytes: usize,
}

impl StdoutLineBuffer {
    fn new(max_line_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            max_line_bytes,
        }
    }

    fn push<E>(
        &mut self,
        chunk: &[u8],
        mut consume: impl FnMut(&str) -> Result<(), E>,
    ) -> Result<(), ChunkError<E>> {
        let mut remaining = chunk;
        while let Some(newline) = remaining.iter().position(|byte| *byte == b'\n') {
            self.append(&remaining[..newline])
                .map_err(ChunkError::Framing)?;
            let line_len = self
                .pending
                .len()
                .checked_sub(usize::from(self.pending.last() == Some(&b'\r')))
                .expect("line terminator accounting underflowed");
            let line = match std::str::from_utf8(&self.pending[..line_len]) {
                Ok(line) => line,
                Err(_) => {
                    self.pending.clear();
                    return Err(ChunkError::Framing(StdoutFrameError::InvalidUtf8));
                }
            };
            let consumed = consume(line).map_err(ChunkError::Consumer);
            self.pending.clear();
            consumed?;
            remaining = &remaining[newline + 1..];
        }
        self.append(remaining).map_err(ChunkError::Framing)
    }

    fn finish(&mut self) -> Result<(), StdoutFrameError> {
        if self.pending.is_empty() {
            return Ok(());
        }
        self.pending.clear();
        Err(StdoutFrameError::UnterminatedLine)
    }

    fn append(&mut self, bytes: &[u8]) -> Result<(), StdoutFrameError> {
        let length = self
            .pending
            .len()
            .checked_add(bytes.len())
            .ok_or(StdoutFrameError::LineTooLarge)?;
        if length > self.max_line_bytes {
            self.pending.clear();
            return Err(StdoutFrameError::LineTooLarge);
        }
        self.pending.extend_from_slice(bytes);
        Ok(())
    }
}

#[derive(Debug)]
struct ConnectionFailure {
    message: String,
    restart: bool,
}

impl ConnectionFailure {
    fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            restart: true,
        }
    }
}

impl From<ProtocolError> for ConnectionFailure {
    fn from(error: ProtocolError) -> Self {
        let restart = !matches!(&error, ProtocolError::Incompatible(_));
        Self {
            message: error.to_string(),
            restart,
        }
    }
}

#[derive(Debug, Default)]
struct RestartPolicy {
    consecutive_failures: usize,
    ready_since: Option<Instant>,
}

impl RestartPolicy {
    fn begin_attempt(&mut self) {
        self.ready_since = None;
    }

    fn mark_ready(&mut self, now: Instant) {
        self.ready_since = Some(now);
    }

    fn next_delay(&mut self, now: Instant) -> Option<Duration> {
        self.next_delay_with(now, RESTART_STABILITY_WINDOW, &RESTART_DELAYS_MS)
    }

    fn next_delay_with(
        &mut self,
        now: Instant,
        stability_window: Duration,
        delays_ms: &[u64],
    ) -> Option<Duration> {
        if self
            .ready_since
            .take()
            .is_some_and(|ready| now.saturating_duration_since(ready) >= stability_window)
        {
            self.consecutive_failures = 0;
        }
        let delay = delays_ms.get(self.consecutive_failures).copied()?;
        self.consecutive_failures += 1;
        Some(Duration::from_millis(delay))
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ServiceStatus {
    fn new(phase: &str, message: Option<String>) -> Self {
        Self {
            phase: phase.into(),
            message,
        }
    }
}

pub struct BridgeState {
    child: Mutex<Option<CommandChild>>,
    protocol: Mutex<AppProtocol>,
    last_service_line: Mutex<Option<String>>,
    status: Mutex<ServiceStatus>,
    generation: AtomicU64,
    restart_policy: Mutex<RestartPolicy>,
    shutting_down: AtomicBool,
}

impl BridgeState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            protocol: Mutex::new(AppProtocol::new(env!("CARGO_PKG_VERSION"), host_platform())),
            last_service_line: Mutex::new(None),
            status: Mutex::new(ServiceStatus::new("starting", None)),
            generation: AtomicU64::new(0),
            restart_policy: Mutex::new(RestartPolicy::default()),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn last_service_line(&self) -> Option<String> {
        self.last_service_line
            .lock()
            .ok()
            .and_then(|line| line.clone())
    }

    pub fn status(&self) -> ServiceStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| {
                ServiceStatus::new("degraded", Some("Service state is unavailable.".into()))
            })
    }

    fn is_ready(&self) -> bool {
        self.protocol
            .lock()
            .map(|protocol| protocol.is_ready())
            .unwrap_or(false)
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }
}

pub fn start_owned_sidecar(app: AppHandle) {
    if let Err(error) = spawn_sidecar(&app) {
        let state = app.state::<BridgeState>();
        if state.shutting_down.load(Ordering::Acquire) {
            return;
        }
        let generation = state.generation.load(Ordering::Acquire);
        set_status(
            &app,
            ServiceStatus::new(
                "degraded",
                Some(format!("AnyPick core could not start: {error}")),
            ),
        );
        schedule_restart(app, generation);
    }
}

fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<BridgeState>();
    if state.shutting_down.load(Ordering::Acquire) {
        return Err("the app is shutting down".into());
    }
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    state
        .restart_policy
        .lock()
        .map_err(|_| "restart policy is unavailable")?
        .begin_attempt();
    *state
        .protocol
        .lock()
        .map_err(|_| "protocol state is unavailable")? =
        AppProtocol::new(env!("CARGO_PKG_VERSION"), host_platform());
    *state
        .last_service_line
        .lock()
        .map_err(|_| "snapshot state is unavailable")? = None;
    set_status(app, ServiceStatus::new("starting", None));

    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|error| format!("resolve bundled sidecar: {error}"))?
        .args(SIDECAR_ARGS)
        // The plugin's default reader buffers until a line ending with no
        // application-level limit. Raw chunks let StdoutLineBuffer enforce it.
        .set_raw_out(true);
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("spawn bundled sidecar: {error}"))?;
    let mut child_slot = state
        .child
        .lock()
        .map_err(|_| "sidecar state is unavailable")?;
    if state.shutting_down.load(Ordering::Acquire) {
        drop(child_slot);
        let _ = child.kill();
        return Err("the app is shutting down".into());
    }
    *child_slot = Some(child);
    drop(child_slot);
    set_status(app, ServiceStatus::new("handshaking", None));

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut stdout = StdoutLineBuffer::new(MAX_FRAME_BYTES);
        let mut failure: Option<ConnectionFailure> = None;
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) if failure.is_none() => {
                    let result = stdout.push(&bytes, |line| {
                        consume_service_line(&handle, generation, line)
                    });
                    if let Err(error) = result {
                        let current = match error {
                            ChunkError::Framing(error) => {
                                ConnectionFailure::retryable(error.to_string())
                            }
                            ChunkError::Consumer(error) => error,
                        };
                        fail_connection(&handle, generation, &current.message);
                        failure = Some(current);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[anypick-core] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Error(error) if failure.is_none() => {
                    let current = ConnectionFailure::retryable(format!(
                        "AnyPick core transport failed: {error}"
                    ));
                    fail_connection(&handle, generation, &current.message);
                    failure = Some(current);
                }
                CommandEvent::Terminated(payload) => {
                    if failure.is_none() {
                        if let Err(error) = stdout.finish() {
                            failure = Some(ConnectionFailure::retryable(error.to_string()));
                        }
                    }
                    handle_termination(&handle, generation, payload.code, payload.signal, failure);
                    return;
                }
                _ => {}
            }
        }
        if failure.is_none() {
            if let Err(error) = stdout.finish() {
                failure = Some(ConnectionFailure::retryable(error.to_string()));
            }
        }
        handle_termination(&handle, generation, None, None, failure);
    });
    Ok(())
}

fn consume_service_line(
    app: &AppHandle,
    generation: u64,
    line: &str,
) -> Result<(), ConnectionFailure> {
    if app
        .state::<BridgeState>()
        .generation
        .load(Ordering::Acquire)
        != generation
    {
        return Ok(());
    }
    let actions = app
        .state::<BridgeState>()
        .protocol
        .lock()
        .map_err(|_| ConnectionFailure::retryable("AnyPick protocol state is unavailable."))?
        .consume_line(line)
        .map_err(ConnectionFailure::from)?;

    for action in actions {
        match action {
            Action::Send(line) => {
                write_line(app, generation, &line).map_err(ConnectionFailure::retryable)?
            }
            Action::Ready => {
                app.state::<BridgeState>()
                    .restart_policy
                    .lock()
                    .map_err(|_| {
                        ConnectionFailure::retryable("AnyPick restart policy is unavailable.")
                    })?
                    .mark_ready(Instant::now());
                set_status(app, ServiceStatus::new("ready", None));
            }
            Action::Deliver(line) => {
                if line.starts_with("snapshot\t") || line.starts_with("snapshot-event\t") {
                    if let Ok(mut current) = app.state::<BridgeState>().last_service_line.lock() {
                        *current = Some(line.clone());
                    }
                }
                emit_service_line(app, line);
            }
            Action::HostEffect {
                request_id,
                kind,
                enabled,
            } => {
                let message = format!(
                    "The {kind} host effect ({}) is not available in this Tauri build.",
                    if enabled { "enable" } else { "disable" }
                );
                let result = app
                    .state::<BridgeState>()
                    .protocol
                    .lock()
                    .map_err(|_| {
                        ConnectionFailure::retryable("AnyPick protocol state is unavailable.")
                    })?
                    .host_effect_unavailable(&request_id, &message)
                    .map_err(ConnectionFailure::from)?;
                write_line(app, generation, &result).map_err(ConnectionFailure::retryable)?;
            }
        }
    }
    Ok(())
}

fn write_line(app: &AppHandle, generation: u64, line: &str) -> Result<(), String> {
    let state = app.state::<BridgeState>();
    if state.generation.load(Ordering::Acquire) != generation {
        return Err("AnyPick core restarted before the command was sent.".into());
    }
    let mut child = state
        .child
        .lock()
        .map_err(|_| "AnyPick core state is unavailable.".to_string())?;
    let child = child
        .as_mut()
        .ok_or_else(|| "AnyPick core is unavailable.".to_string())?;
    let mut framed = Vec::with_capacity(line.len() + 1);
    framed.extend_from_slice(line.as_bytes());
    framed.push(b'\n');
    child
        .write(&framed)
        .map_err(|error| format!("send command to AnyPick core: {error}"))
}

pub fn send_ui_command(app: &AppHandle, command: &str) -> Result<(), String> {
    if !valid_ui_command(command) {
        return Err("AnyPick rejected an invalid app command.".into());
    }
    let state = app.state::<BridgeState>();
    if !state.is_ready() {
        return Err("AnyPick core is still starting.".into());
    }
    write_line(app, state.generation.load(Ordering::Acquire), command)
}

pub fn graceful_quit(app: AppHandle) {
    let state = app.state::<BridgeState>();
    if state.shutting_down.swap(true, Ordering::AcqRel) {
        return;
    }
    set_status(&app, ServiceStatus::new("stopping", None));
    let generation = state.generation.load(Ordering::Acquire);
    if write_line(&app, generation, "quit").is_err() {
        if let Ok(mut child) = state.child.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
        app.exit(0);
        return;
    }

    std::thread::spawn(move || {
        std::thread::sleep(GRACEFUL_QUIT_TIMEOUT);
        if let Ok(mut child) = app.state::<BridgeState>().child.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
        app.exit(0);
    });
}

fn fail_connection(app: &AppHandle, generation: u64, message: &str) {
    let state = app.state::<BridgeState>();
    if state.generation.load(Ordering::Acquire) != generation {
        return;
    }
    set_status(
        app,
        ServiceStatus::new("degraded", Some(message.to_string())),
    );
    if let Ok(mut child) = state.child.lock() {
        if let Some(child) = child.take() {
            let _ = child.kill();
        }
    };
}

fn handle_termination(
    app: &AppHandle,
    generation: u64,
    code: Option<i32>,
    signal: Option<i32>,
    failure: Option<ConnectionFailure>,
) {
    let state = app.state::<BridgeState>();
    if state.generation.load(Ordering::Acquire) != generation {
        return;
    }
    if let Ok(mut child) = state.child.lock() {
        *child = None;
    }
    if state.shutting_down.load(Ordering::Acquire) {
        set_status(app, ServiceStatus::new("stopped", None));
        app.exit(0);
        return;
    }
    let restart = failure
        .as_ref()
        .map(|failure| failure.restart)
        .unwrap_or(true);
    let detail = match failure {
        Some(failure) => failure.message,
        None => match (code, signal) {
            (Some(code), _) => format!("AnyPick core exited with code {code}."),
            (_, Some(signal)) => format!("AnyPick core exited after signal {signal}."),
            _ => "AnyPick core connection closed unexpectedly.".into(),
        },
    };
    if !restart {
        set_status(app, ServiceStatus::new("stopped", Some(detail)));
        return;
    }
    set_status(app, ServiceStatus::new("degraded", Some(detail)));
    schedule_restart(app.clone(), generation);
}

fn schedule_restart(app: AppHandle, generation: u64) {
    let delay = app
        .state::<BridgeState>()
        .restart_policy
        .lock()
        .ok()
        .and_then(|mut policy| policy.next_delay(Instant::now()));
    let Some(delay) = delay else {
        set_status(
            &app,
            ServiceStatus::new(
                "stopped",
                Some("AnyPick core stopped after three restart attempts.".into()),
            ),
        );
        return;
    };
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let state = app.state::<BridgeState>();
        if state.shutting_down.load(Ordering::Acquire)
            || state.generation.load(Ordering::Acquire) != generation
        {
            return;
        }
        start_owned_sidecar(app.clone());
    });
}

fn set_status(app: &AppHandle, status: ServiceStatus) {
    if let Ok(mut current) = app.state::<BridgeState>().status.lock() {
        *current = status.clone();
    }
    let _ = app.emit("service-state", status);
}

pub fn mark_fixture_ready(app: &AppHandle) {
    set_status(app, ServiceStatus::new("ready", None));
}

pub fn deliver_fixture_line(app: &AppHandle, line: String) {
    // Both state frames are replayed, not just the bare `snapshot`. A
    // post-mutation `snapshot-event` is the newer state, so caching only the
    // bare snapshot made a fixture window act on a revision the engine had
    // already superseded.
    if line.starts_with("snapshot\t") || line.starts_with("snapshot-event\t") {
        if let Ok(mut current) = app.state::<BridgeState>().last_service_line.lock() {
            *current = Some(line.clone());
        }
    }
    emit_service_line(app, line);
}

fn emit_service_line(app: &AppHandle, line: String) {
    let _ = app.emit("service-line", line.clone());
    // Keep the existing React bridge live while it migrates to service naming.
    let _ = app.emit("supervisor-line", line);
}

pub fn valid_ui_command(command: &str) -> bool {
    if command.is_empty()
        || command.len() > MAX_UI_COMMAND_BYTES
        || command.contains('\n')
        || command.contains('\r')
    {
        return false;
    }
    if matches!(command, "open" | "refresh" | "restart" | "stop" | "quit") {
        return true;
    }
    let Some((kind, payload)) = command.split_once('\t') else {
        return false;
    };
    if kind == "navigate" {
        return matches!(
            payload,
            "accounts" | "gateways" | "proxy" | "proxy-hub" | "add-account" | "add-gateway"
        );
    }
    // `doctor` is here because the engine accepts it
    // (internal/desktop/protocol.go validateCommand) and the Swift client sends
    // it. Leaving it out made Run Doctor fail on every Tauri build with
    // "AnyPick rejected an invalid app command."
    matches!(
        kind,
        "invoke" | "logs" | "mutate" | "model-roles" | "backup-inspect" | "doctor" | "cancel"
    ) && canonical_json_payload(payload)
}

fn canonical_json_payload(encoded: &str) -> bool {
    let Ok(raw) = STANDARD.decode(encoded) else {
        return false;
    };
    raw.len() <= MAX_UI_COMMAND_BYTES
        && STANDARD.encode(&raw) == encoded
        && serde_json::from_slice::<serde_json::Value>(&raw).is_ok_and(|value| value.is_object())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdout_chunks_are_reassembled_into_complete_crlf_normalized_lines() {
        let input = "snapshot\t8J+Zgg==\r\nresult\te30=\n";
        let split = input.find('8').unwrap() + 3;
        let mut buffer = StdoutLineBuffer::new(128);
        let mut lines = Vec::new();

        buffer
            .push(&input.as_bytes()[..split], |line| {
                lines.push(line.to_string());
                Ok::<_, ()>(())
            })
            .unwrap();
        assert!(lines.is_empty());
        buffer
            .push(&input.as_bytes()[split..], |line| {
                lines.push(line.to_string());
                Ok::<_, ()>(())
            })
            .unwrap();

        assert_eq!(lines, ["snapshot\t8J+Zgg==", "result\te30="]);
        assert_eq!(buffer.finish(), Ok(()));
    }

    #[test]
    fn stdout_buffer_rejects_oversized_invalid_and_unterminated_frames() {
        let mut oversized = StdoutLineBuffer::new(4);
        oversized.push(b"1234", |_| Ok::<_, ()>(())).unwrap();
        assert_eq!(
            oversized.push(b"5\n", |_| Ok::<_, ()>(())),
            Err(ChunkError::Framing(StdoutFrameError::LineTooLarge))
        );
        assert_eq!(oversized.finish(), Ok(()));

        let mut invalid = StdoutLineBuffer::new(4);
        assert_eq!(
            invalid.push(&[0xff, b'\n'], |_| Ok::<_, ()>(())),
            Err(ChunkError::Framing(StdoutFrameError::InvalidUtf8))
        );

        let mut truncated = StdoutLineBuffer::new(8);
        truncated.push(b"partial", |_| Ok::<_, ()>(())).unwrap();
        assert_eq!(truncated.finish(), Err(StdoutFrameError::UnterminatedLine));
    }

    #[test]
    fn ui_command_boundary_is_bounded_and_single_line() {
        assert!(valid_ui_command("refresh"));
        assert!(valid_ui_command("invoke\te30="));
        assert!(valid_ui_command("model-roles\te30="));
        assert!(valid_ui_command("backup-inspect\te30="));
        // The UI's Doctor button sends this. It was rejected here while the
        // engine accepted it, so the button failed on every build.
        assert!(valid_ui_command("doctor\te30="));
        assert!(valid_ui_command("cancel\te30="));
        assert!(valid_ui_command("navigate\taccounts"));
        assert!(!valid_ui_command("invoke\te30=\nquit"));
        assert!(!valid_ui_command("invoke\t***"));
        assert!(!valid_ui_command("navigate\tsecrets"));
        assert!(!valid_ui_command("unknown"));
        assert!(!valid_ui_command(&"x".repeat(MAX_UI_COMMAND_BYTES + 1)));
    }

    /// Every command the UI can build crosses this boundary before the engine
    /// sees it. The corpus is written by the UI's own builders
    /// (src/tauri/ui/test/command-corpus.ts) and the engine's decoder accepts
    /// every entry (internal/desktop/ui_command_corpus_test.go), so the host
    /// must not be the one layer that refuses them, as it once did Doctor.
    #[test]
    fn ui_command_corpus_crosses_the_host_boundary() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../go/testdata/parity/ui-commands.json");
        let raw = std::fs::read_to_string(&path).unwrap();
        let entries: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        assert!(entries.len() > 50, "the UI corpus is unexpectedly small");
        for entry in entries {
            let kind = entry["kind"].as_str().unwrap();
            let payload = serde_json::to_vec(&entry["payload"]).unwrap();
            let line = format!("{kind}\t{}", STANDARD.encode(payload));
            assert!(
                valid_ui_command(&line),
                "host rejects {}: {line}",
                entry["case"]
            );
        }
    }

    #[test]
    fn restart_schedule_is_bounded() {
        assert_eq!(RESTART_DELAYS_MS.len(), MAX_RESTARTS);
        assert!(RESTART_DELAYS_MS.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn ready_then_crash_does_not_reset_the_restart_budget() {
        let delays = [1, 2, 3];
        let stability = Duration::from_secs(10);
        let now = Instant::now();
        let mut policy = RestartPolicy::default();

        for expected in delays {
            policy.begin_attempt();
            policy.mark_ready(now);
            assert_eq!(
                policy.next_delay_with(now + Duration::from_secs(9), stability, &delays),
                Some(Duration::from_millis(expected))
            );
        }
        policy.begin_attempt();
        policy.mark_ready(now);
        assert_eq!(
            policy.next_delay_with(now + Duration::from_secs(9), stability, &delays),
            None
        );
    }

    #[test]
    fn a_stable_generation_restores_the_restart_budget() {
        let delays = [5, 10, 20];
        let stability = Duration::from_secs(10);
        let now = Instant::now();
        let mut policy = RestartPolicy::default();

        assert_eq!(
            policy.next_delay_with(now, stability, &delays),
            Some(Duration::from_millis(5))
        );
        assert_eq!(
            policy.next_delay_with(now, stability, &delays),
            Some(Duration::from_millis(10))
        );
        policy.begin_attempt();
        policy.mark_ready(now);

        assert_eq!(
            policy.next_delay_with(now + stability, stability, &delays),
            Some(Duration::from_millis(5))
        );
    }
}
