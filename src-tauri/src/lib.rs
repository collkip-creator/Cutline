use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct SidecarState(Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            let sidecar_cmd = app.shell().sidecar("cutline-sidecar")?;
            let (_rx, child) = sidecar_cmd.spawn()?;
            if let Some(state) = app.try_state::<SidecarState>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(child);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Cutline Studio");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<SidecarState>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}
