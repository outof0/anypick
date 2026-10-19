#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(feature = "e2e-webdriver", not(debug_assertions)))]
compile_error!("the e2e-webdriver feature is only available in debug builds");

mod protocol;
mod sidecar;

use sidecar::{graceful_quit, send_ui_command, start_owned_sidecar, BridgeState, ServiceStatus};
use std::io::{self, BufRead, Write};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

const MAX_FIXTURE_LINE_BYTES: usize = 64 * 1024;
const SETTINGS_MENU_ID: &str = "settings-menu";

fn menu_with_settings<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem};

    let menu = Menu::default(app)?;
    let settings = MenuItemBuilder::with_id(SETTINGS_MENU_ID, "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let items = menu.items()?;

    #[cfg(target_os = "macos")]
    {
        // macOS puts preferences in the application menu, directly after About
        // and before Services, while the command selects the main-window pane.
        let app_menu = items
            .first()
            .and_then(|item| item.as_submenu())
            .expect("Tauri's default macOS menu starts with the application menu");
        app_menu.insert(&settings, 2)?;
        let separator = PredefinedMenuItem::separator(app)?;
        app_menu.insert(&separator, 3)?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        // On Windows and Linux, preferences conventionally live under Edit.
        let edit_menu = items
            .iter()
            .filter_map(|item| item.as_submenu())
            .find(|submenu| submenu.text().is_ok_and(|text| text == "Edit"))
            .expect("Tauri's default menu includes an Edit menu");
        let separator = PredefinedMenuItem::separator(app)?;
        edit_menu.append(&separator)?;
        edit_menu.append(&settings)?;
    }

    Ok(menu)
}

#[tauri::command]
fn send_command(
    app: AppHandle,
    command: String,
    state: State<'_, BridgeState>,
) -> Result<(), String> {
    if is_fixture_mode() {
        if !sidecar::valid_ui_command(&command) {
            return Err("AnyPick rejected an invalid fixture command.".into());
        }
        return write_fixture_command(&command);
    }
    if command == "quit" {
        graceful_quit(app);
        return Ok(());
    }
    if state.status().phase == "stopped" {
        return Err("AnyPick core is stopped. Restart the app to try again.".into());
    }
    send_ui_command(&app, &command)
}

#[tauri::command]
fn last_service_line(state: State<'_, BridgeState>) -> Option<String> {
    state.last_service_line()
}

#[tauri::command]
fn last_supervisor_line(state: State<'_, BridgeState>) -> Option<String> {
    state.last_service_line()
}

#[tauri::command]
fn service_status(state: State<'_, BridgeState>) -> ServiceStatus {
    state.status()
}

fn write_fixture_command(command: &str) -> Result<(), String> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    writeln!(output, "{command}").map_err(|_| "Fixture bridge is unavailable.".to_string())?;
    output
        .flush()
        .map_err(|_| "Fixture bridge is unavailable.".to_string())
}

fn valid_fixture_line(line: &str) -> bool {
    // Every frame kind the UI decodes.
    line.len() <= MAX_FIXTURE_LINE_BYTES
        && [
            "snapshot\t",
            "snapshot-event\t",
            "usage-event\t",
            "result\t",
            "logs\t",
            "backup-preview\t",
            "doctor\t",
            "protocol-error\t",
            "status\t",
        ]
        .iter()
        .any(|prefix| line.starts_with(prefix))
}

fn is_protocol_mode(smoke: bool, probe: bool) -> bool {
    smoke || probe
}

fn is_fixture_mode() -> bool {
    std::env::var_os("ANYPICK_TRAY_DEMO").is_some()
}

const MAX_AUTH_PASTE_BYTES: usize = 256 * 1024;

struct AuthPasteState {
    dir: std::sync::Mutex<Option<std::path::PathBuf>>,
}

impl Default for AuthPasteState {
    fn default() -> Self {
        Self {
            dir: std::sync::Mutex::new(None),
        }
    }
}

fn auth_paste_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("anypick-auth-paste-{}", std::process::id()))
}

fn paste_file_name() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{nanos}-{seq}.json")
}

fn ensure_auth_paste_dir(state: &AuthPasteState) -> Result<std::path::PathBuf, String> {
    let mut guard = state
        .dir
        .lock()
        .map_err(|_| "Paste directory is unavailable.".to_string())?;
    if let Some(dir) = guard.as_ref() {
        return Ok(dir.clone());
    }
    let dir = auth_paste_dir();
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|err| err.to_string())?;
    }
    *guard = Some(dir.clone());
    Ok(dir)
}

fn stage_auth_paste_file(dir: &std::path::Path, body: &str) -> Result<std::path::PathBuf, String> {
    if body.len() > MAX_AUTH_PASTE_BYTES {
        return Err("Pasted auth JSON is larger than 256 KiB.".into());
    }
    std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|err| err.to_string())?;
    }
    let path = dir.join(paste_file_name());
    write_private(&path, body.as_bytes())?;
    Ok(path)
}

/// Deletes a regular file whose parent is `dir`. A symlink, a sibling
/// directory that only shares the name prefix, and a missing file are not
/// deleted. A missing file inside `dir` succeeds.
fn forget_auth_paste_file(dir: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    let refused = "Refusing to delete a path outside the paste directory.";
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| refused.to_string())?;
    let real_dir = std::fs::canonicalize(dir).map_err(|_| refused.to_string())?;
    let real_parent = std::fs::canonicalize(parent).map_err(|_| refused.to_string())?;
    if real_parent != real_dir {
        return Err(refused.into());
    }
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => Err(refused.into()),
        Ok(_) => std::fs::remove_file(path).map_err(|err| err.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|err| err.to_string())?;
    file.write_all(bytes).map_err(|err| err.to_string())
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|err| err.to_string())
}

#[tauri::command]
fn stage_auth_paste(body: String, state: State<'_, AuthPasteState>) -> Result<String, String> {
    let dir = ensure_auth_paste_dir(&state)?;
    let path = stage_auth_paste_file(&dir, &body)?;
    Ok(path.to_string_lossy().into_owned())
}

/// What the ZCode desktop app leaves on this Mac, as plan-status context only.
///
/// The provider owns reading the encrypted ZCode login. This answers two
/// questions the sheet cannot answer from a snapshot — is the app installed, and
/// does its plan cache report a connected plan — because a webview cannot stat
/// the user's home directory. Both are hints: nothing here blocks a save.
#[derive(serde::Serialize)]
pub struct ZcodeContext {
    pub app_installed: bool,
    pub plan_warning: Option<String>,
}

#[tauri::command]
fn zcode_context() -> ZcodeContext {
    let home = home_dir();
    ZcodeContext {
        app_installed: zcode_app_installed(home.as_deref()),
        plan_warning: zcode_plan_warning(home.as_deref()),
    }
}

/// The ZCode app is present if any of its three install roots exists as a
/// directory. A file with the same name is not an app.
fn zcode_app_installed(home: Option<&std::path::Path>) -> bool {
    let Some(home) = home else {
        return false;
    };
    [
        home.join(".zcode"),
        home.join("Library/Application Support/ZCode"),
        std::path::PathBuf::from("/Applications/ZCode.app"),
    ]
    .iter()
    .any(|candidate| std::fs::metadata(candidate).is_ok_and(|meta| meta.is_dir()))
}

/// The plan-status warning from `~/.zcode/v2/coding-plan-cache.json`.
///
/// The document is another app's cache, so a read failure is not an error worth
/// surfacing — the sheet simply has no plan context to show. `home` is a
/// parameter rather than a read of the environment so a test can point it at a
/// temp directory instead of the developer's own account.
fn zcode_plan_warning(home: Option<&std::path::Path>) -> Option<String> {
    let cache = home?.join(".zcode/v2/coding-plan-cache.json");
    let body = std::fs::read_to_string(&cache).ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    let items = json.get("entryStatus")?.get("items")?.as_object()?;
    if items.is_empty() {
        return None;
    }
    let connected = items.values().any(|entry| {
        entry
            .get("status")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|status| !status.is_empty() && status != "unavailable")
    });
    if connected {
        return None;
    }
    Some(ZCODE_PLAN_WARNING.into())
}

const ZCODE_PLAN_WARNING: &str = "The ZCode app reports no connected coding plan. You can still use the ZCode login on this Mac, sign in again with Z.ai, or paste a GLM Coding Plan key from the Z.ai dashboard (API Keys).";

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(std::path::PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

#[tauri::command]
fn forget_auth_paste(path: String, state: State<'_, AuthPasteState>) -> Result<(), String> {
    let guard = state
        .dir
        .lock()
        .map_err(|_| "Paste directory is unavailable.".to_string())?;
    let Some(dir) = guard.as_ref() else {
        return Ok(());
    };
    forget_auth_paste_file(dir, std::path::Path::new(&path))
}

fn command_for_probe(kind: &str) -> Option<&'static str> {
    match kind {
        "refresh" => Some("refresh"),
        "logs" => Some("logs\te30="),
        "mutate" => Some("mutate\te30="),
        "invoke" => Some("invoke\te30="),
        "model-roles" => Some("model-roles\te30="),
        "doctor" => Some("doctor\te30="),
        "navigate" => Some("navigate\taccounts"),
        "quit" => Some("quit"),
        _ => None,
    }
}

fn run_protocol_mode(smoke: bool, probe: bool) {
    // This explicit CI seam returns before Tauri/GTK/WebKit initialization.
    // Production never reads its parent stdin or writes commands to stdout.
    let stdin = io::stdin();
    for line in stdin.lock().lines().map_while(Result::ok) {
        if probe {
            if let Some(kind) = line.strip_prefix("probe\t") {
                if let Some(command) = command_for_probe(kind) {
                    let _ = write_fixture_command(command);
                    if command == "quit" {
                        return;
                    }
                }
                continue;
            }
        }
        if smoke && valid_fixture_line(&line) {
            let _ = write_fixture_command("refresh");
            return;
        }
    }
}

fn read_fixture(app: tauri::AppHandle) {
    let stdin = io::stdin();
    for line in stdin.lock().lines().map_while(Result::ok) {
        if valid_fixture_line(&line) {
            sidecar::deliver_fixture_line(&app, line);
        }
    }
    app.exit(0);
}

fn main() {
    let smoke = std::env::var_os("ANYPICK_TRAY_SMOKE").is_some();
    let probe = std::env::var_os("ANYPICK_TRAY_PROBE").is_some();
    if is_protocol_mode(smoke, probe) {
        run_protocol_mode(smoke, probe);
        return;
    }

    let builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());
    // Keep the loopback automation server out of release binaries.
    #[cfg(feature = "e2e-webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    let app = builder
        .menu(menu_with_settings)
        .on_menu_event(|app, event| {
            if event.id() == SETTINGS_MENU_ID {
                let _ = app.emit("open-settings", ());
            }
        })
        .manage(BridgeState::new())
        .manage(AuthPasteState::default())
        .invoke_handler(tauri::generate_handler![
            send_command,
            last_service_line,
            last_supervisor_line,
            service_status,
            stage_auth_paste,
            forget_auth_paste,
            zcode_context
        ])
        // App-first, matching the macOS app: the main window is the product.
        // There is no tray icon — on Linux and Windows closing the window quits
        // the app, and the Go sidecar is owned here, not by a tray utility.
        .setup(|app| {
            let handle = app.handle().clone();
            if is_fixture_mode() {
                sidecar::mark_fixture_ready(&handle);
                std::thread::spawn(move || read_fixture(handle));
            } else {
                start_owned_sidecar(handle);
            }
            Ok(())
        })
        // Closing the window quits. Do not hide-and-linger: without a tray icon
        // there would be no way to reach the app again.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                graceful_quit(window.app_handle().clone());
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the AnyPick desktop app");
    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<BridgeState>().is_shutting_down() {
                api.prevent_exit();
                graceful_quit(app.clone());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_accepts_only_bounded_service_output() {
        assert!(valid_fixture_line("snapshot\te30="));
        assert!(valid_fixture_line("result\te30="));
        assert!(!valid_fixture_line("invoke\te30="));
        assert!(!valid_fixture_line(&"x".repeat(MAX_FIXTURE_LINE_BYTES + 1)));
    }

    #[test]
    fn auth_paste_file_stays_inside_its_directory() {
        let dir =
            std::env::temp_dir().join(format!("anypick-auth-paste-test-{}", std::process::id()));
        let sibling = std::env::temp_dir().join(format!(
            "anypick-auth-paste-test-{}-evil",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&sibling);

        let path = stage_auth_paste_file(&dir, "{\"tokens\":{}}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"tokens\":{}}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        forget_auth_paste_file(&dir, &path).unwrap();
        assert!(!path.exists());
        forget_auth_paste_file(&dir, &path).unwrap();

        std::fs::create_dir_all(&sibling).unwrap();
        let victim = sibling.join("secret.json");
        std::fs::write(&victim, b"keep").unwrap();
        assert!(forget_auth_paste_file(&dir, &victim).is_err());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");

        #[cfg(unix)]
        {
            let link = dir.join("link.json");
            std::os::unix::fs::symlink(&victim, &link).unwrap();
            assert!(forget_auth_paste_file(&dir, &link).is_err());
            assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
            let _ = std::fs::remove_file(&link);
        }

        let too_big = "a".repeat(MAX_AUTH_PASTE_BYTES + 1);
        assert_eq!(
            stage_auth_paste_file(&dir, &too_big).unwrap_err(),
            "Pasted auth JSON is larger than 256 KiB."
        );

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&sibling);
    }

    /// A temp home directory, removed when the guard drops.
    struct TempHome(std::path::PathBuf);

    impl TempHome {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("anypick-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn zcode_plan_warning_reads_only_its_own_cache() {
        // The cache is another app's document. Anything unreadable means "no
        // plan context", never a fabricated warning and never a panic.
        let home = TempHome::new("zcode-plan");
        let cache = home.path().join(".zcode/v2/coding-plan-cache.json");
        std::fs::create_dir_all(cache.parent().unwrap()).unwrap();

        assert_eq!(zcode_plan_warning(Some(home.path())), None, "no cache file");
        std::fs::write(&cache, b"garbage").unwrap();
        assert_eq!(
            zcode_plan_warning(Some(home.path())),
            None,
            "garbage is not a plan cache"
        );
        std::fs::write(&cache, b"{}").unwrap();
        assert_eq!(
            zcode_plan_warning(Some(home.path())),
            None,
            "an empty document says nothing"
        );
        std::fs::write(&cache, br#"{"entryStatus":{"items":{}}}"#).unwrap();
        assert_eq!(
            zcode_plan_warning(Some(home.path())),
            None,
            "no items is not a stale plan"
        );
        std::fs::write(
            &cache,
            br#"{"entryStatus":{"items":{"builtin:zai-coding-plan":{"status":"unavailable"}}}}"#,
        )
        .unwrap();
        let warning = zcode_plan_warning(Some(home.path())).expect("an unavailable plan is stale");
        assert!(warning.contains("no connected coding plan"), "{warning}");
        std::fs::write(
            &cache,
            br#"{"entryStatus":{"items":{"builtin:zai-coding-plan":{"status":"connected"}}}}"#,
        )
        .unwrap();
        assert_eq!(
            zcode_plan_warning(Some(home.path())),
            None,
            "a connected plan is not a warning"
        );
        assert_eq!(zcode_plan_warning(None), None, "no home, no warning");
    }

    #[test]
    fn zcode_app_installation_looks_for_a_directory() {
        let home = TempHome::new("zcode-app");
        assert!(!zcode_app_installed(Some(home.path())), "nothing installed");
        std::fs::write(home.path().join(".zcode"), b"not a directory").unwrap();
        assert!(
            !zcode_app_installed(Some(home.path())),
            "a file is not an install root"
        );
        std::fs::remove_file(home.path().join(".zcode")).unwrap();
        std::fs::create_dir_all(home.path().join(".zcode")).unwrap();
        assert!(zcode_app_installed(Some(home.path())));
        assert!(!zcode_app_installed(None), "no home, nothing installed");
    }

    #[test]
    fn protocol_modes_bypass_interactive_runtime() {
        assert!(is_protocol_mode(true, false));
        assert!(is_protocol_mode(false, true));
        assert!(!is_protocol_mode(false, false));
    }

    #[test]
    fn probe_commands_are_bounded_to_the_supported_bridge_surface() {
        assert_eq!(command_for_probe("refresh"), Some("refresh"));
        assert_eq!(command_for_probe("model-roles"), Some("model-roles\te30="));
        assert_eq!(command_for_probe("navigate"), Some("navigate\taccounts"));
        assert_eq!(command_for_probe("quit"), Some("quit"));
        assert_eq!(command_for_probe("unknown"), None);
    }
}
