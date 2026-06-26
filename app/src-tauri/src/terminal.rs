//! Embedded PTY terminal — thin Tauri adapter over the shared `zpwr-embed-terminal` crate (same as
//! ztunnel/Audio-Haxor). The editor (zemacs) runs inside this PTY: the frontend execs `zemacs` once
//! the session is up. Forwards the session's `on_output`/`on_exit` callbacks to webview events.

use tauri::{AppHandle, Emitter, State};
use zpwr_embed_terminal::TerminalSession;

/// Managed state for the embedded terminal.
#[derive(Default)]
pub struct TerminalState {
    session: TerminalSession,
}

/// Spawn a new PTY session (login shell). Kills any existing session first. The frontend then runs
/// `exec zemacs` so the editor replaces the shell and fills the window.
#[tauri::command]
pub async fn terminal_spawn(
    rows: Option<u16>,
    cols: Option<u16>,
    app: AppHandle,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    let app_out = app.clone();
    let app_exit = app;
    state.session.spawn(
        rows.unwrap_or(40),
        cols.unwrap_or(120),
        move |text| {
            let _ = app_out.emit("terminal-output", text);
        },
        move || {
            let _ = app_exit.emit("terminal-exit", ());
        },
    )
}

/// Write raw bytes (user keystrokes) into the PTY.
#[tauri::command]
pub fn terminal_write(data: String, state: State<'_, TerminalState>) -> Result<(), String> {
    state.session.write(&data)
}

/// Notify the PTY of a viewport resize.
#[tauri::command]
pub fn terminal_resize(rows: u16, cols: u16, state: State<'_, TerminalState>) -> Result<(), String> {
    state.session.resize(rows, cols)
}

/// Kill the terminal session.
#[tauri::command]
pub fn terminal_kill(state: State<'_, TerminalState>) -> Result<(), String> {
    state.session.kill();
    Ok(())
}
