// zemacs-gui — the thin Tauri host for the zemacs editor (Helix fork). The editor runs in an embedded
// PTY terminal (zpwr-embed-terminal crate); this binary just registers the terminal commands and wires
// the PTY's output/exit to the webview.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod terminal;

fn main() {
    tauri::Builder::default()
        .manage(terminal::TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running zemacs-gui");
}
