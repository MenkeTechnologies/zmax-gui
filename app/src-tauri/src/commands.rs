//! Generated list of host command names — the zmax-gui bus surface
//! (`App::open("zmax-gui")->verbs()`).
//!
//! zmax-gui has no `-core` engine crate: `zmax-gui-core` ships only the webui (menu.js + css),
//! and the editor itself is the `zmax` binary running in the embedded terminal. The host's
//! engine-equivalent is its own `#[tauri::command]` surface — project search, binary-document
//! search/replace (`doc_search`), blame, git, text/editor tools, the file browser and the terminal —
//! registered in `lib.rs`'s `tauri::generate_handler![…]`.
//!
//! [`COMMANDS`] is that list, and [`NOT_ON_BUS`] is the explicit exception list. Every registered
//! command must appear in exactly one of the two; `tests::commands_cover_registered_handlers`
//! (drift guard) reads `lib.rs` and fails otherwise, so a newly registered command forces a
//! deliberate include/exclude decision rather than silently going missing.

/// Every host command a bus caller may invoke, sorted. Powers automation-bus discovery.
pub static COMMANDS: &[&str] = &[
    "align_columns",
    "batch_rename",
    "bookmark_add",
    "bookmark_clear",
    "bookmark_list",
    "bookmark_remove",
    "comment_toggle",
    "convert_encoding",
    "convert_file",
    "copy_path",
    "create_path",
    "delete_file",
    "delete_path",
    "detect_encoding",
    "diff_files",
    "doc_blame",
    "fb_watcher_set",
    "file_stats",
    "find_definition",
    "find_files",
    "focus_window",
    "fs_chmod",
    "fs_compare_dirs",
    "fs_compress",
    "fs_copy_path",
    "fs_create_dir",
    "fs_create_file",
    "fs_diff",
    "fs_disk_usage",
    "fs_duplicate",
    "fs_extract",
    "fs_find_duplicates",
    "fs_folder_size",
    "fs_get_info",
    "fs_git_status",
    "fs_grep",
    "fs_hash",
    "fs_list_dir",
    "fs_list_subdirs",
    "fs_make_alias",
    "fs_open_in_editor",
    "fs_open_terminal",
    "fs_read_file_base64",
    "fs_read_file_bytes",
    "fs_read_head",
    "fs_read_head_bytes",
    "fs_run_program",
    "fs_secure_delete",
    "fs_symlink_retarget",
    "fs_touch",
    "fs_write_file_base64",
    "fs_xattrs",
    "git_blame",
    "git_branch",
    "git_branches",
    "git_checkout_branch",
    "git_create_branch",
    "git_diff_revs",
    "git_discard",
    "git_file_diff",
    "git_graph",
    "git_log_file",
    "git_log_repo",
    "git_show",
    "git_show_commit",
    "git_stage",
    "git_stash_drop",
    "git_stash_list",
    "git_stash_pop",
    "git_stash_save",
    "git_stash_show",
    "git_status",
    "git_unstage",
    "home_dir",
    "licence_sign_in",
    "licence_sign_out",
    "licence_status",
    "list_dir",
    "move_to_trash",
    "project_stats",
    "project_symbols",
    "recent_add",
    "recent_clear",
    "recent_list",
    "rename_file",
    "rename_path",
    "replace_documents",
    "replace_project",
    "run_bash",
    "run_stryke_hook",
    "scan_markers",
    "search_documents",
    "search_project",
    "set_blur",
    "shell_term_kill",
    "shell_term_resize",
    "shell_term_spawn",
    "shell_term_write",
    "snippet_add",
    "snippet_clear",
    "snippet_list",
    "snippet_remove",
    "sort_file_lines",
    "stryke_bin_path",
    "stryke_lsp_send",
    "stryke_lsp_start",
    "stryke_lsp_stop",
    "sys_stats",
    "take_pending_opens",
    "term_session_kill",
    "term_session_resize",
    "term_session_spawn",
    "term_session_write",
    "terminal_kill",
    "terminal_resize",
    "terminal_spawn",
    "terminal_write",
    "toggle_fullscreen",
    // Compensation snapshots (txn.rs). On the bus deliberately: a script that drives a mutation
    // through a raw command rather than through its reversible verb still needs a way to take, and
    // hand back, the pre-state — and `txn_list` is how a stranded snapshot becomes visible.
    // The transaction journal. On the bus for the same reason the snapshots are: a script that
    // drives a multi-step run through raw commands needs the same crash record the Batch Plan gets,
    // and `txn_pending` / `txn_unwind` are how an interrupted run becomes visible and reversible
    // from outside the app.
    "txn_append",
    "txn_close",
    "txn_discard",
    "txn_list",
    "txn_open",
    "txn_pending",
    "txn_restore",
    "txn_seal",
    "txn_snapshot",
    "txn_unwind",
    "zgui_reveal_scripts",
    "zgui_write_scripts",
    "zmax_exec_command",
    // The document panes' engine transports. One command each carries that engine's ENTIRE
    // surface — `zoffice_invoke("writer.read", {path})`, `zpdf_invoke("open_pdf", {path})` — so a
    // script can drive an office document or a PDF open inside zmax-gui without going through the
    // pane's UI. `zoffice_commands` is the discovery call the view itself uses.
    "zoffice_commands",
    "zoffice_invoke",
    "zpdf_invoke",
];

/// Registered commands deliberately withheld from the bus. Two of them are the automation bridge's
/// own plumbing: `zgui_bridge_reply` fulfils a pending forwarded request by id and
/// `zgui_bridge_event` republishes an event to bus subscribers. Both are called *by* the bridge;
/// letting a script call them would let it resolve another caller's in-flight request or forge an
/// event. `log_diagnostic` is the appShell's diagnostics sink — the webview's one-way path for the
/// miswiring notes the shell records instead of printing. It reports on the app, so exposing it as
/// a verb would only let a script write arbitrary lines into the app's own log.
pub static NOT_ON_BUS: &[&str] = &["log_diagnostic", "zgui_bridge_event", "zgui_bridge_reply"];

#[cfg(test)]
mod tests {
    use super::{COMMANDS, NOT_ON_BUS};

    /// Every command name registered in `lib.rs`'s `tauri::generate_handler![…]`, parsed the same
    /// way [`COMMANDS`] was generated: one `path::to::name,` per line, comments skipped, only the
    /// final path segment kept (that is the name Tauri dispatches on).
    fn registered() -> Vec<String> {
        let src = include_str!("lib.rs");
        let start = src
            .find("generate_handler![")
            .expect("lib.rs registers a generate_handler! block");
        let block = &src[start..];
        let end = block.find("\n        ])").expect("generate_handler! block is closed");
        block[..end]
            .lines()
            .skip(1)
            .map(str::trim)
            .filter(|l| !l.starts_with("//") && l.ends_with(','))
            .map(|l| {
                let path = l.trim_end_matches(',');
                path.rsplit("::").next().unwrap_or(path).to_string()
            })
            .filter(|n| !n.is_empty())
            .collect()
    }

    // Drift guard: every registered command must be either advertised on the bus or explicitly
    // withheld. A new command that is neither fails here instead of quietly missing the surface.
    #[test]
    fn commands_cover_registered_handlers() {
        let registered = registered();
        // A parser that matched nothing would make every assertion below vacuous.
        assert!(
            registered.len() > 100,
            "parsed only {} handler entries — the parser drifted from lib.rs",
            registered.len()
        );
        let unclassified: Vec<&String> = registered
            .iter()
            .filter(|n| !COMMANDS.contains(&n.as_str()) && !NOT_ON_BUS.contains(&n.as_str()))
            .collect();
        assert!(
            unclassified.is_empty(),
            "registered commands missing from commands.rs (add to COMMANDS or NOT_ON_BUS): {unclassified:?}"
        );
    }

    // The reverse direction: the bus must not advertise a verb the host cannot dispatch.
    #[test]
    fn commands_have_no_extras() {
        let registered = registered();
        let extra: Vec<&&str> = COMMANDS
            .iter()
            .filter(|c| !registered.iter().any(|r| r == *c))
            .collect();
        assert!(
            extra.is_empty(),
            "COMMANDS advertises names lib.rs does not register: {extra:?}"
        );
    }

    // The withheld list is an exception list, not a dumping ground: each entry must really be
    // registered, otherwise it is stale and hides nothing.
    #[test]
    fn withheld_commands_are_registered() {
        let registered = registered();
        let stale: Vec<&&str> = NOT_ON_BUS
            .iter()
            .filter(|c| !registered.iter().any(|r| r == *c))
            .collect();
        assert!(stale.is_empty(), "NOT_ON_BUS lists unregistered commands: {stale:?}");
        // Withheld means withheld: a name in both lists would still reach the bus.
        let both: Vec<&&str> = NOT_ON_BUS.iter().filter(|c| COMMANDS.contains(c)).collect();
        assert!(both.is_empty(), "NOT_ON_BUS entries also advertised in COMMANDS: {both:?}");
    }
}
