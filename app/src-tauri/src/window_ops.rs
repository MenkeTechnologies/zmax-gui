//! Window chrome the zgui menubar drives — the MacVim fullscreen / transparency / blur analogs.
//! There is no native UI: the frontend menubar items `invoke` these; the effects live on the window.

use tauri::{Manager, WebviewWindow};

/// Toggle native fullscreen (MacVim's `:fullscreen`). Returns the new state so the menu can re-label.
#[tauri::command]
pub fn toggle_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    let now = window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(!now).map_err(|e| e.to_string())?;
    Ok(!now)
}

/// Apply or clear a translucent blurred material behind the webview — MacVim's `transparency` +
/// `blurradius`. The terminal renders on a transparent xterm background (see terminal.js theme), so
/// lowering the pane's background alpha on the frontend lets this material show through.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn set_blur(window: WebviewWindow, on: bool) -> Result<(), String> {
    use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial};
    if on {
        apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None)
            .map_err(|e| e.to_string())
    } else {
        clear_vibrancy(&window).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn set_blur(_window: WebviewWindow, _on: bool) -> Result<(), String> {
    Ok(())
}

/// Bring the window to the front and focus it — used when files are opened from the CLI / Finder /
/// `mvim://` while the app is already running (single-instance + deep-link forwarding).
#[tauri::command]
pub fn focus_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}
