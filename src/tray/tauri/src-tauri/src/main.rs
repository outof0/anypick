#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{self, BufRead, Write};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State, WindowEvent};

const MAX_PROTOCOL_LINE_BYTES: usize = 16 * 1024;

#[derive(Default)]
struct BridgeState {
    last_supervisor_line: Mutex<Option<String>>,
}

#[tauri::command]
fn send_command(command: String) -> Result<(), String> {
    if !valid_ui_command(&command) {
        return Err("AnyPick rejected an invalid tray command.".into());
    }
    let stdout = io::stdout();
    let mut output = stdout.lock();
    writeln!(output, "{command}").map_err(|_| "AnyPick supervisor is unavailable.".to_string())?;
    output
        .flush()
        .map_err(|_| "AnyPick supervisor is unavailable.".to_string())
}

#[tauri::command]
fn last_supervisor_line(state: State<'_, BridgeState>) -> Option<String> {
    state
        .last_supervisor_line
        .lock()
        .ok()
        .and_then(|line| line.clone())
}

fn valid_ui_command(command: &str) -> bool {
    if command.is_empty()
        || command.len() > MAX_PROTOCOL_LINE_BYTES
        || command.contains('\n')
        || command.contains('\r')
    {
        return false;
    }
    matches!(command, "open" | "refresh" | "restart" | "stop" | "quit")
        // model-roles is required by the React tray UI (Claude Code role editor).
        || ["invoke\t", "logs\t", "mutate\t", "model-roles\t", "navigate\t"]
            .iter()
            .any(|prefix| command.starts_with(prefix))
}

fn valid_supervisor_line(line: &str) -> bool {
    line.len() <= MAX_PROTOCOL_LINE_BYTES * 4
        && ["snapshot\t", "result\t", "logs\t", "status\t"]
            .iter()
            .any(|prefix| line.starts_with(prefix))
}

fn is_protocol_mode(smoke: bool, probe: bool) -> bool {
    smoke || probe
}

fn command_for_probe(kind: &str) -> Option<&'static str> {
    match kind {
        "refresh" => Some("refresh"),
        "logs" => Some("logs\te30="),
        "mutate" => Some("mutate\te30="),
        "invoke" => Some("invoke\te30="),
        "model-roles" => Some("model-roles\te30="),
        "navigate" => Some("navigate\taccounts"),
        "quit" => Some("quit"),
        _ => None,
    }
}

fn run_protocol_mode(smoke: bool, probe: bool) {
    // This path intentionally returns before Tauri/GTK/WebKit initialization.
    // CI runners may have Xvfb without an accessibility D-Bus service.
    let stdin = io::stdin();
    for line in stdin.lock().lines().map_while(Result::ok) {
        if probe {
            if let Some(kind) = line.strip_prefix("probe\t") {
                if let Some(command) = command_for_probe(kind) {
                    let _ = send_command(command.into());
                    if command == "quit" {
                        return;
                    }
                }
                continue;
            }
        }
        if smoke && valid_supervisor_line(&line) {
            let _ = send_command("refresh".into());
            return;
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn read_supervisor(app: tauri::AppHandle) {
    let stdin = io::stdin();
    for line in stdin.lock().lines().map_while(Result::ok) {
        if !valid_supervisor_line(&line) {
            continue;
        }
        if let Ok(mut current) = app.state::<BridgeState>().last_supervisor_line.lock() {
            *current = Some(line.clone());
        }
        let _ = app.emit("supervisor-line", line);
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

    tauri::Builder::default()
        .manage(BridgeState::default())
        .invoke_handler(tauri::generate_handler![send_command, last_supervisor_line])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Open AnyPick", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit AnyPick", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &refresh, &separator, &quit])?;
            TrayIconBuilder::with_id("anypick")
                .icon(tauri::include_image!("../../../../assets/icon-32.png"))
                .tooltip("AnyPick")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "refresh" => {
                        let _ = send_command("refresh".into());
                    }
                    "quit" => {
                        let _ = send_command("quit".into());
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            let handle = app.handle().clone();
            std::thread::spawn(move || read_supervisor(handle));
            if std::env::var_os("ANYPICK_TRAY_DEMO").is_some() {
                show_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run the AnyPick tray helper");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_accepts_only_one_bounded_protocol_command() {
        assert!(valid_ui_command("refresh"));
        assert!(valid_ui_command("invoke\te30="));
        assert!(valid_ui_command("model-roles\te30="));
        assert!(!valid_ui_command("invoke\te30=\nquit"));
        assert!(!valid_ui_command("unknown"));
    }

    #[test]
    fn bridge_accepts_only_supervisor_output_kinds() {
        assert!(valid_supervisor_line("snapshot\te30="));
        assert!(valid_supervisor_line("result\te30="));
        assert!(!valid_supervisor_line("invoke\te30="));
    }

    #[test]
    fn protocol_modes_bypass_interactive_tray_runtime() {
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
