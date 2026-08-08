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

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn read_supervisor(app: tauri::AppHandle) {
    // ANYPICK_TRAY_SMOKE=1: single-shot refresh after first valid snapshot.
    // ANYPICK_TRAY_PROBE=1: multi-command protocol probe without the webview.
    //   Supervisor may send: `probe\trefresh|logs|mutate|invoke|model-roles|navigate|quit`
    //   Helper replies with the matching UI command on stdout, then exits on quit/EOF.
    let smoke = std::env::var_os("ANYPICK_TRAY_SMOKE").is_some();
    let probe = std::env::var_os("ANYPICK_TRAY_PROBE").is_some();
    let stdin = io::stdin();
    for line in stdin.lock().lines().map_while(Result::ok) {
        if probe {
            if let Some(kind) = line.strip_prefix("probe\t") {
                match kind {
                    "refresh" => {
                        let _ = send_command("refresh".into());
                    }
                    "logs" => {
                        let _ = send_command("logs\te30=".into());
                    }
                    "mutate" => {
                        let _ = send_command("mutate\te30=".into());
                    }
                    "invoke" => {
                        let _ = send_command("invoke\te30=".into());
                    }
                    "model-roles" => {
                        let _ = send_command("model-roles\te30=".into());
                    }
                    "navigate" => {
                        let _ = send_command("navigate\taccounts".into());
                    }
                    "quit" => {
                        let _ = send_command("quit".into());
                        app.exit(0);
                        return;
                    }
                    _ => {}
                }
                continue;
            }
        }
        if !valid_supervisor_line(&line) {
            continue;
        }
        if let Ok(mut current) = app.state::<BridgeState>().last_supervisor_line.lock() {
            *current = Some(line.clone());
        }
        let _ = app.emit("supervisor-line", line);
        // CI smoke path: prove stdin → state → stdout without driving the webview.
        // One successful snapshot causes a single refresh, then a clean exit.
        if smoke {
            let _ = send_command("refresh".into());
            app.exit(0);
            return;
        }
    }
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .manage(BridgeState::default())
        .invoke_handler(tauri::generate_handler![send_command, last_supervisor_line])
        .setup(|app| {
            let protocol_mode = is_protocol_mode(
                std::env::var_os("ANYPICK_TRAY_SMOKE").is_some(),
                std::env::var_os("ANYPICK_TRAY_PROBE").is_some(),
            );
            if !protocol_mode {
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
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || read_supervisor(handle));
            if !protocol_mode && std::env::var_os("ANYPICK_TRAY_DEMO").is_some() {
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
    fn protocol_modes_do_not_install_interactive_tray_ui() {
        assert!(is_protocol_mode(true, false));
        assert!(is_protocol_mode(false, true));
        assert!(!is_protocol_mode(false, false));
    }
}
