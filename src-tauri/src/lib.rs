use std::fs::{create_dir_all, read_to_string, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct SidecarInner {
    child: Option<CommandChild>,
    running: bool,
    spawn_error: Option<String>,
    terminated: Option<String>,
    logs: Vec<String>,
}

#[derive(Clone)]
struct SidecarState(Arc<Mutex<SidecarInner>>);

#[derive(serde::Serialize)]
struct SidecarDiagnosticsSnapshot {
    running: bool,
    port_listening: bool,
    spawn_error: Option<String>,
    terminated: Option<String>,
    logs: Vec<String>,
    log_file_path: String,
    log_file_tail: String,
}

fn is_sidecar_port_open() -> bool {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    let addr = SocketAddr::from(([127, 0, 0, 1], 43111));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn sidecar_log_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    let dir = home.join(".cutline_studio");
    let _ = create_dir_all(&dir);
    Some(dir.join("sidecar.log"))
}

fn append_rust_log(line: &str) {
    if let Some(path) = sidecar_log_path() {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "[tauri-host] {}", line);
        }
    }
}

fn push_log(inner: &mut SidecarInner, line: String) {
    if inner.logs.len() >= 80 {
        inner.logs.remove(0);
    }
    inner.logs.push(line);
}

#[cfg(target_os = "windows")]
fn kill_sidecar_tree() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/IM", "cutline-sidecar.exe", "/T"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(target_os = "windows"))]
fn kill_sidecar_tree() {}

fn spawn_sidecar(app: &AppHandle, state: &SidecarState) {
    {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.child.take() {
                let _ = child.kill();
            }
            guard.running = false;
            guard.spawn_error = None;
            guard.terminated = None;
            guard.logs.clear();
        }
    }
    kill_sidecar_tree();

    let sidecar_cmd = match app.shell().sidecar("cutline-sidecar") {
        Ok(cmd) => cmd,
        Err(err) => {
            let msg = format!("Failed to resolve sidecar binary: {}", err);
            append_rust_log(&msg);
            if let Ok(mut guard) = state.0.lock() {
                guard.spawn_error = Some(msg.clone());
                push_log(&mut guard, msg);
            }
            return;
        }
    };

    match sidecar_cmd.spawn() {
        Ok((mut rx, child)) => {
            append_rust_log("Spawned cutline-sidecar process");
            if let Ok(mut guard) = state.0.lock() {
                guard.child = Some(child);
                guard.running = true;
            }
            let shared = state.0.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let text = String::from_utf8_lossy(&line).trim().to_string();
                            if !text.is_empty() {
                                if let Ok(mut guard) = shared.lock() {
                                    push_log(&mut guard, text);
                                }
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            let text = String::from_utf8_lossy(&line).trim().to_string();
                            if !text.is_empty() {
                                append_rust_log(&format!("stderr: {}", text));
                                if let Ok(mut guard) = shared.lock() {
                                    push_log(&mut guard, format!("stderr: {}", text));
                                }
                            }
                        }
                        CommandEvent::Error(err) => {
                            let msg = format!("process error: {}", err);
                            append_rust_log(&msg);
                            if let Ok(mut guard) = shared.lock() {
                                guard.spawn_error = Some(msg.clone());
                                push_log(&mut guard, msg);
                            }
                        }
                        CommandEvent::Terminated(payload) => {
                            let msg = format!(
                                "sidecar exited (code={:?}, signal={:?})",
                                payload.code, payload.signal
                            );
                            append_rust_log(&msg);
                            if let Ok(mut guard) = shared.lock() {
                                guard.running = false;
                                guard.child = None;
                                guard.terminated = Some(msg.clone());
                                push_log(&mut guard, msg);
                            }
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(err) => {
            let msg = format!("Failed to spawn cutline-sidecar: {}", err);
            append_rust_log(&msg);
            if let Ok(mut guard) = state.0.lock() {
                guard.spawn_error = Some(msg.clone());
                push_log(&mut guard, msg);
            }
        }
    }
}

#[tauri::command]
fn get_sidecar_diagnostics(state: State<'_, SidecarState>) -> SidecarDiagnosticsSnapshot {
    let log_path = sidecar_log_path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "%USERPROFILE%\\.cutline_studio\\sidecar.log".to_string());

    let log_file_tail = sidecar_log_path()
        .and_then(|p| read_to_string(p).ok())
        .map(|content| {
            let lines: Vec<&str> = content.lines().collect();
            let start = lines.len().saturating_sub(25);
            lines[start..].join("\n")
        })
        .unwrap_or_default();

    let port_listening = is_sidecar_port_open();
    let guard = state.0.lock().ok();
    match guard {
        Some(g) => SidecarDiagnosticsSnapshot {
            running: g.running,
            port_listening,
            spawn_error: g.spawn_error.clone(),
            terminated: g.terminated.clone(),
            logs: g.logs.clone(),
            log_file_path: log_path,
            log_file_tail,
        },
        None => SidecarDiagnosticsSnapshot {
            running: false,
            port_listening,
            spawn_error: Some("Sidecar state lock poisoned".to_string()),
            terminated: None,
            logs: Vec::new(),
            log_file_path: log_path,
            log_file_tail,
        },
    }
}

#[tauri::command]
fn restart_sidecar(app: AppHandle, state: State<'_, SidecarState>) {
    spawn_sidecar(&app, &state);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared_state = SidecarState(Arc::new(Mutex::new(SidecarInner::default())));
    let setup_state = shared_state.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(shared_state)
        .invoke_handler(tauri::generate_handler![
            get_sidecar_diagnostics,
            restart_sidecar
        ])
        .setup(move |app| {
            spawn_sidecar(app.handle(), &setup_state);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Cutline Studio");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<SidecarState>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(child) = guard.child.take() {
                        let _ = child.kill();
                    }
                    guard.running = false;
                }
            }
            kill_sidecar_tree();
        }
    });
}
