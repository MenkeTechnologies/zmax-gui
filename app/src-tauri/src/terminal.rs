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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Second, INDEPENDENT PTY: the floating shell terminal the user pops open on top of the IDE (⌘K
// "Terminal"). It runs a plain login shell — NOT `zemacs --ide` — so it's a real scratch terminal,
// separate from the editor's PTY above. Its own state + `shell-term-output`/`shell-term-exit` events.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/// Managed state for the floating shell terminal (independent of the IDE's [`TerminalState`]).
#[derive(Default)]
pub struct ShellTermState {
    session: TerminalSession,
}

/// Spawn (or respawn) the floating shell terminal's login shell.
#[tauri::command]
pub async fn shell_term_spawn(
    rows: Option<u16>,
    cols: Option<u16>,
    app: AppHandle,
    state: State<'_, ShellTermState>,
) -> Result<(), String> {
    let app_out = app.clone();
    let app_exit = app;
    state.session.spawn(
        rows.unwrap_or(24),
        cols.unwrap_or(80),
        move |text| {
            let _ = app_out.emit("shell-term-output", text);
        },
        move || {
            let _ = app_exit.emit("shell-term-exit", ());
        },
    )
}

/// Write raw bytes into the floating shell terminal's PTY.
#[tauri::command]
pub fn shell_term_write(data: String, state: State<'_, ShellTermState>) -> Result<(), String> {
    state.session.write(&data)
}

/// Notify the floating shell terminal's PTY of a viewport resize.
#[tauri::command]
pub fn shell_term_resize(rows: u16, cols: u16, state: State<'_, ShellTermState>) -> Result<(), String> {
    state.session.resize(rows, cols)
}

/// Kill the floating shell terminal session.
#[tauri::command]
pub fn shell_term_kill(state: State<'_, ShellTermState>) -> Result<(), String> {
    state.session.kill();
    Ok(())
}
