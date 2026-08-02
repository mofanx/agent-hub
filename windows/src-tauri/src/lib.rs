use std::{fs, path::PathBuf};
use tauri::{Manager, WindowEvent};
use tauri_plugin_notification::NotificationExt;

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Result<String, String> {
    let path = config_path(&app)?;
    match fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".into()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, config: String) -> Result<(), String> {
    let path = config_path(&app)?;
    fs::write(path, config).map_err(|e| e.to_string())
}

#[tauri::command]
fn show_notification(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn is_notification_permission_granted(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_notification::PermissionState;
    let state = app
        .notification()
        .permission_state()
        .map_err(|e| e.to_string())?;
    Ok(matches!(state, PermissionState::Granted))
}

#[tauri::command]
fn request_notification_permission(app: tauri::AppHandle) -> Result<String, String> {
    let state = app
        .notification()
        .request_permission()
        .map_err(|e| e.to_string())?;
    Ok(format!("{:?}", state).to_lowercase())
}

#[tauri::command]
fn show_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn toggle_window(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().map_err(|e| e.to_string())? {
            w.hide().map_err(|e| e.to_string())?;
            Ok(false)
        } else {
            w.show().map_err(|e| e.to_string())?;
            w.set_focus().map_err(|e| e.to_string())?;
            Ok(true)
        }
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn set_tray_tooltip(app: tauri::AppHandle, tooltip: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_tooltip(Some(&tooltip)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_tray_title(app: tauri::AppHandle, title: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_title(Some(&title)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            show_notification,
            is_notification_permission_granted,
            request_notification_permission,
            show_window,
            hide_window,
            toggle_window,
            set_tray_tooltip,
            set_tray_title
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                let menu = tauri::menu::MenuBuilder::new(app)
                    .text("show", "显示窗口")
                    .text("hide", "隐藏窗口")
                    .separator()
                    .text("quit", "退出")
                    .build()?;

                let _ = tauri::tray::TrayIconBuilder::with_id("main-tray")
                    .icon(
                        app.default_window_icon()
                            .expect("no default window icon")
                            .clone(),
                    )
                    .tooltip("Agent Hub - 未连接")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "hide" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click { .. } = event {
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
