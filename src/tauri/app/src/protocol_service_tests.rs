//! Exercise the bundled Go child through the production Rust parser. Go-only
//! E2E and FakeBridge UI tests cannot catch a host rejecting a valid reply.

use super::{host_platform, Action, AppProtocol};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

struct Service {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    protocol: AppProtocol,
    home: PathBuf,
}

impl Service {
    fn start() -> Self {
        let home = std::env::temp_dir().join(format!(
            "anypick-rust-service-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&home).unwrap();
        let mut command = Command::new(env!("ANYPICK_TEST_SIDECAR"));
        command.env_clear();
        for key in [
            "PATH",
            "Path",
            "SystemRoot",
            "WINDIR",
            "COMSPEC",
            "PATHEXT",
            "TEMP",
            "TMP",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .args(["desktop-service", "--stdio"])
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("APPDATA", home.join("AppData/Roaming"))
            .env("LOCALAPPDATA", home.join("AppData/Local"))
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_DATA_HOME", home.join(".local/share"))
            .env("ANYPICK_HOME", home.join(".anypick"))
            .env("ANYPICK_CLAUDE_NO_KEYCHAIN", "1")
            .env("ANYPICK_KIRO_NO_KEYCHAIN", "1")
            .env("LANG", "C.UTF-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::sync_channel(32);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut service = Self {
            child,
            stdin,
            lines,
            home,
            protocol: AppProtocol::new("(devel)", host_platform()),
        };
        service.receive("snapshot", None);
        assert!(service.protocol.is_ready());
        service
    }

    fn send(&mut self, kind: &str, payload: Value) {
        writeln!(
            self.stdin,
            "{kind}\t{}",
            STANDARD.encode(serde_json::to_vec(&payload).unwrap())
        )
        .unwrap();
    }

    fn receive(&mut self, kind: &str, request: Option<&str>) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let line = self
                .lines
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|error| panic!("waiting for {kind}: {error}"));
            for action in self
                .protocol
                .consume_line(&line)
                .unwrap_or_else(|error| panic!("production Rust host rejected Go frame: {error}"))
            {
                match action {
                    Action::Send(line) => writeln!(self.stdin, "{line}").unwrap(),
                    Action::Deliver(line) => {
                        let (actual, encoded) = line.split_once('\t').unwrap();
                        let payload: Value =
                            serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
                        if actual == kind && request.map_or(true, |id| payload["requestId"] == id) {
                            return payload;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

#[test]
fn bundled_service_replies_survive_the_production_host() {
    let mut service = Service::start();
    service.send("doctor", json!({"version":1,"requestId":"doctor-1"}));
    assert!(service.receive("doctor", Some("doctor-1"))["findings"].is_array());
    service.send(
        "logs",
        json!({"version":1,"requestId":"logs-1","providerId":"codex","name":"missing","lines":20}),
    );
    assert_eq!(
        service.receive("logs", Some("logs-1"))["state"],
        "not-running"
    );
    service.send(
        "backup-inspect",
        json!({"version":1,"requestId":"backup-1","path":service.home.join("missing.anypick")}),
    );
    assert_eq!(
        service.receive("backup-preview", Some("backup-1"))["status"],
        "error"
    );
    for kind in ["invoke", "model-roles"] {
        let payload = if kind == "invoke" {
            json!({"version":1,"requestId":kind,"revision":0,"actionId":"missing"})
        } else {
            json!({"version":1,"requestId":kind,"revision":0,"clientId":"missing","roleActionIds":{}})
        };
        service.send(kind, payload);
        assert_eq!(service.receive("result", Some(kind))["status"], "error");
    }
    service.send("mutate", json!({"version":1,"requestId":"setting-1","operation":"setting-show-quota","name":"show-quota","enabled":false}));
    assert_eq!(
        service.receive("result", Some("setting-1"))["status"],
        "success"
    );
    let snapshot = service.receive("snapshot-event", None);
    assert_eq!(snapshot["snapshot"]["settings"]["showQuota"], false);
    writeln!(service.stdin, "refresh").unwrap();
    service.receive("snapshot-event", None);
    service.send("doctor", json!({"version":99,"requestId":"bad-doctor"}));
    service.receive("protocol-error", Some("bad-doctor"));
    service.send("doctor", json!({"version":1,"requestId":"doctor-2"}));
    service.receive("doctor", Some("doctor-2"));
    writeln!(service.stdin, "quit").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = service.child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(Instant::now() < deadline, "Go child did not shut down");
        std::thread::sleep(Duration::from_millis(25));
    }
}
