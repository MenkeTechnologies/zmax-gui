//! GUI Automation Bus wiring for zmax-gui (see GUI_AUTOMATION_BUS.md). Opens the per-app
//! `zgui-bridge` Unix socket so a stryke script can drive the whole app by name —
//! `App::open("zmax-gui")->call(...)`, or `App::here()` from a hook running inside the app.
//!
//! HYBRID handler, over two routes:
//!   * Host commands ([`crate::commands::COMMANDS`] — the app's own `#[tauri::command]` surface:
//!     project + document search/replace, blame, git, text/editor tools, file browser, terminal)
//!     are dispatched by name through the host's own IPC, so a script reaches exactly what the UI
//!     reaches, with the same argument deserialization and the same process state.
//!   * Everything else (`appshell.*`, the zmax menu, any `ZGui.automation`-registered verb) goes to
//!     the webview's automation-host.js dispatcher.
//!
//! Both routes come back through `zgui_bridge_reply`, which fulfils a per-request channel.
//!
//! Why the host route is not a direct Rust call: zmax-gui has no engine crate with a generic
//! `invoke(cmd, args)` — `zmax-gui-core` ships only the webui, and the host's surface is 100+
//! individually typed `#[tauri::command]` functions, nine of them async. Re-deriving their argument
//! marshalling in this file would duplicate what `generate_handler!` already does and would drift
//! from it silently. Dispatching by name through the same handler keeps one implementation.
//!
//! TRANSACTIONS. Every host command is classified by [`rev_of`] into the three `rev` classes the bus
//! defines (`zgui-core/CONSUMERS.md` §0.1), and [`Handler::undo`] compensates the `"inverse"` ones by
//! replaying the opposite host command. The honest headline for this app: **only the 13 verbs named
//! in [`INVERSE`] are reversible**, out of the whole [`crate::commands::COMMANDS`] surface, and the
//! reason is structural rather than an omission. zmax-gui's editor channel is
//! blind PTY keystrokes (`terminal_write` and friends), and its file commands overwrite content;
//! neither can be taken back. What IS reversible is the file-browser's create/copy/chmod primitives,
//! which prove their destination absent before writing, the snippet store, which the surface
//! returns verbatim, and `txn_snapshot`, whose only effect is a token directory `txn_discard`
//! removes. [`INVERSE`] names every case that was considered and rejected, with the reason.
//!
//! Compensation needs the state a verb overwrote, and `undo(verb, args, result)` never sees the host
//! as it was — so, exactly as CONSUMERS.md §0.1 rule 3 prescribes, the forward call captures its own
//! pre-state and returns it under the reserved [`WAS`] key. That key is added on the socket route
//! only; the UI invokes the commands directly and never sees it.
//!
//! `zoffice-core` and `zpdf-core` link in as rlibs, and are on this bus as of the document panes:
//! `zoffice_invoke` / `zpdf_invoke` (plus the office engine's `zoffice_commands` discovery call)
//! carry each engine's whole surface behind one command name. That is a reversal of the earlier
//! position here, and the reason it reversed is the reason it was taken: the engines used to be
//! libraries the `doc_search` walker called, so a bus call would have run against an ad-hoc engine
//! unrelated to anything on screen. `lib.rs`'s setup now hands each engine THIS host's app-data dir
//! and manages its state, so a bus call and the mounted pane address one engine — and a script that
//! opens a document in the pane can then read it, search it and export it through the same
//! transport the pane uses. The panes' own typed verbs (`zoffice.view.*`, `zmax.doc.*`) ride the
//! webview route alongside these, and the standalone apps' buses are unaffected.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use zgui_bridge::{serve, Bridge, Handler};

static BRIDGE: OnceLock<Arc<Bridge>> = OnceLock::new();

/// Per-request reply channels for forwarded calls, keyed by request id.
type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

/// Is `cmd` a host command (dispatched through the app's own IPC) vs an automation verb?
fn is_host_cmd(cmd: &str) -> bool {
    crate::commands::COMMANDS.contains(&cmd)
}

// ── reversibility ───────────────────────────────────────────────────────────────────────────────

/// Reserved key an inverse verb's socket reply carries its captured pre-state under.
pub(crate) const WAS: &str = "_zmx_was";

/// Host commands that change nothing observable: directory / file / archive reads, hashes and
/// diffs, every `git` query (`log`, `blame`, `status`, `show`, `stash list`), the project and
/// document searches, and the two resolvers that only compute a string (`stryke_bin_path`,
/// `zmax_exec_command` — the latter returns the command line the FRONTEND then writes into the PTY,
/// and writes nothing itself).
///
/// Two rows here were argued rather than assumed. `doc_blame` shells out to `git show` per revision
/// and stages each blob in a temp file it unlinks, entirely outside the user's tree. `sys_stats`
/// advances its own sampling timestamp, which changes what the NEXT call reports as a per-second
/// rate; that is inherent to sampling and touches no state outside the monitor.
///
/// `licence_status` is deliberately NOT here even though it is a read in this build. It is a read
/// only because the `licence` feature is off (`Cargo.toml` declares it with no default); a release
/// build turns it on, and it then runs an antitamper scan and can spawn a background network
/// refresh. A class that flips with a cargo feature is not a class.
///
/// `txn_list` enumerates the snapshot store's token directories and writes nothing, so it reads
/// like any other listing — including when the store holds stranded tokens, which is what it is for.
///
/// `txn_pending` is the same kind of read one level up: it parses the journal files and returns the
/// transactions that were never closed. It is the recovery prompt's query, and asking it changes
/// nothing about whether those transactions get unwound.
///
/// `zoffice_commands` returns the office engine's command descriptors and takes no arguments at
/// all. Its two siblings, `zoffice_invoke` and `zpdf_invoke`, are deliberately NOT here: each one
/// carries an entire engine behind a `cmd` STRING, so its class is a property of the argument
/// rather than of the command, and `rev_of` classifies by name. A read and a save arrive under one
/// name, so the only honest class for the pair is the fail-fast default.
const PURE: &[&str] = &[
    "bookmark_list",
    "detect_encoding",
    "diff_files",
    "doc_blame",
    "file_stats",
    "find_definition",
    "find_files",
    "fs_compare_dirs",
    "fs_diff",
    "fs_disk_usage",
    "fs_find_duplicates",
    "fs_folder_size",
    "fs_get_info",
    "fs_git_status",
    "fs_grep",
    "fs_hash",
    "fs_list_dir",
    "fs_list_subdirs",
    "fs_read_file_base64",
    "fs_read_file_bytes",
    "fs_read_head",
    "fs_read_head_bytes",
    "fs_xattrs",
    "git_blame",
    "git_branch",
    "git_branches",
    "git_diff_revs",
    "git_file_diff",
    "git_graph",
    "git_log_file",
    "git_log_repo",
    "git_show",
    "git_show_commit",
    "git_stash_list",
    "git_stash_show",
    "git_status",
    "home_dir",
    "list_dir",
    "project_stats",
    "project_symbols",
    "recent_list",
    "scan_markers",
    "search_documents",
    "search_project",
    "snippet_list",
    "stryke_bin_path",
    "sys_stats",
    "txn_list",
    "txn_pending",
    "zmax_exec_command",
    "zoffice_commands",
];

/// Host commands whose effect [`undo_plan`] reverses exactly, by replaying another host command.
///
/// The bar applied is deliberately narrow: **the compensation must be a command whose success does
/// not depend on state the bus cannot read.** Everything below either creates something at a path it
/// first proved absent (so deleting that path is exact), overwrites a scalar the surface can read
/// back (`fs_get_info`'s `modeOctal` / `symlinkTarget` — the struct is `rename_all = "camelCase"`), rewrites a store the surface returns
/// verbatim (`snippet_list`), or is its own inverse (`toggle_fullscreen`).
///
/// Cases considered and REJECTED, with the reason, because each one looks reversible:
///
/// * **The PTY keystroke channel** — `terminal_write`, `shell_term_write`, `term_session_write`.
///   These are the app's main editor channel, and compensating them with an editor-native `u` would
///   be a manufactured success signal. `TerminalSession::write` returns `Ok(())` when the bytes
///   reach the PTY master; there is no readback, no ack, and no way to know which editor mode
///   received them (the frontend itself hedges with an `Esc` and a 50 ms timer before each payload),
///   whether the command was undoable at all (`:w`, `:q`, `:!cmd` are not on the undo stack), or
///   whether one injected command is one undo unit. Every PTY lifecycle verb is blind for the same
///   reason: `terminal_spawn` kills the existing session first, and `terminal_kill` discards unsaved
///   buffers with no host-side record.
/// * **Every content write** — `fs_write_file_base64`, `replace_project`, `replace_documents`,
///   `convert_file`, `convert_encoding`, `sort_file_lines`, `align_columns`, `comment_toggle`.
///   Restoring these needs a full byte backup, which is a backup and not an inverse; no verb
///   restores mode or mtime either, and `convert_encoding` is lossy by construction (`latin1` maps
///   everything above U+00FF to `?`).
/// * **`bookmark_add` / `bookmark_remove` / `recent_add`** — `bookmark_list` and `recent_list`
///   filter to files that still exist, so the captured list is a lossy view of the store and
///   replaying it would silently drop entries. `snippet_list` returns its store verbatim, which is
///   the entire reason the snippet verbs ARE reversible and these are not.
/// * **`git_stage` / `git_unstage`** — invertible only under a porcelain precondition (`git add`
///   over an already-different index blob is unrecoverable by `reset HEAD`). Reversibility that
///   depends on a runtime check cannot be expressed in a per-name class.
/// * **`git_checkout_branch`** — the compensation refuses on a tree another step of the same
///   transaction dirtied, and a detached prior HEAD has no branch name to restore.
/// * **`create_path` / `rename_path` / `copy_path` / `fs_extract`** — all `create_dir_all` the
///   destination's parent, so a call that had to build a directory chain leaves it behind after the
///   named entity is removed. Their file-browser twins (`fs_create_file`, `fs_create_dir`,
///   `fs_copy_path`) use single-level `create_dir` / `create_new` and are exact.
/// * **`rename_file`** — a bare `fs::rename` that silently replaces an existing destination.
/// * **`take_pending_opens`** — reads like a getter, but `mem::take`s the queue; nothing re-enqueues.
/// * **`txn_restore`** — writes recorded bytes over whatever is at each path NOW. Undoing that
///   needs a snapshot of the content it overwrote, which is another snapshot, not an inverse.
/// * **`txn_discard`** — deletes a token directory outright. Nothing recreates it: the bytes it
///   held were the only copy of the pre-state it was recording.
/// * **`txn_seal`** — overwrites a manifest with the post-verb fingerprints and flips a one-way
///   flag. Un-sealing would have to restore the manifest as it was, which is a backup of the
///   backup; and a token that can be un-sealed can be re-sealed against a THIRD party's content,
///   which is precisely the clobbering restore the seal exists to refuse.
/// * **`txn_open` / `txn_append` / `txn_close`** — the crash record itself. Its value is that it
///   survives things going wrong, so a verb that erases part of it on a compensation pass would
///   defeat the mechanism at the exact moment it matters. `txn_close` additionally releases the
///   snapshots, and nothing recreates those.
/// * **`txn_unwind`** — writes recorded bytes over the user's tree, for a whole transaction at
///   once. Undoing that needs a snapshot of everything it overwrote, which is another transaction.
const INVERSE: &[&str] = &[
    "fs_chmod",
    "fs_compress",
    "fs_copy_path",
    "fs_create_dir",
    "fs_create_file",
    "fs_duplicate",
    "fs_make_alias",
    "fs_symlink_retarget",
    "snippet_add",
    "snippet_clear",
    "snippet_remove",
    "toggle_fullscreen",
    "txn_snapshot",
];

/// The reversibility class of a host command. Anything unlisted — including every webview-forwarded
/// verb — is `"irreversible"`, the bus-wide fail-fast default.
pub(crate) fn rev_of(verb: &str) -> &'static str {
    if PURE.contains(&verb) {
        "pure"
    } else if INVERSE.contains(&verb) {
        "inverse"
    } else {
        "irreversible"
    }
}

/// A read of the host surface, as `pre_state` needs it.
type Read<'a> = &'a dyn Fn(&str, Value) -> Result<Value, String>;

fn sarg(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// A command that returns a bare scalar arrives wrapped by [`Handler::call`]; unwrap it back.
fn returned(result: &Value) -> Value {
    match result.get("value") {
        Some(v) => v.clone(),
        None => result.clone(),
    }
}

/// Read what [`undo_plan`] will need, BEFORE the verb runs. Errors here abort the forward call,
/// which is the right order: a step we could not have unwound never lands.
fn pre_state(read: Read, verb: &str, args: &Value) -> Result<Value, String> {
    Ok(match verb {
        // `fs_get_info` reports both scalars these two overwrite, so the capture is complete. Its
        // struct is `rename_all = "camelCase"`, so the keys read back are `modeOctal` / `symlinkTarget`.
        "fs_chmod" | "fs_symlink_retarget" => {
            json!({ "info": read("fs_get_info", json!({ "path": sarg(args, "path") }))? })
        }
        // Any snippet mutation is undone by restoring the whole store, so all three capture it.
        "snippet_add" | "snippet_remove" | "snippet_clear" => {
            json!({ "snippets": read("snippet_list", json!({}))? })
        }
        // The creators all prove their destination absent before writing, and `fs_duplicate` /
        // `fs_make_alias` report the path they chose, so nothing has to be read first.
        _ => json!({}),
    })
}

/// The host commands that compensate one executed `verb`, in apply order.
fn undo_plan(verb: &str, args: &Value, result: &Value) -> Result<Vec<(String, Value)>, String> {
    let was = result
        .get(WAS)
        .ok_or_else(|| format!("{verb}: reply carries no {WAS} block to compensate from"))?;
    let del = |path: String| ("delete_file".to_string(), json!({ "file_path": path }));
    Ok(match verb {
        "fs_chmod" => {
            let mode = was
                .get("info")
                .and_then(|i| i.get("modeOctal"))
                .cloned()
                .ok_or_else(|| "fs_chmod: pre-state carries no mode".to_string())?;
            vec![(
                "fs_chmod".to_string(),
                json!({ "path": sarg(args, "path"), "mode_octal": mode }),
            )]
        }
        "fs_symlink_retarget" => {
            let target = was
                .get("info")
                .and_then(|i| i.get("symlinkTarget"))
                .filter(|t| !t.is_null())
                .cloned()
                .ok_or_else(|| "fs_symlink_retarget: pre-state carries no target".to_string())?;
            vec![(
                "fs_symlink_retarget".to_string(),
                json!({ "path": sarg(args, "path"), "new_target": target }),
            )]
        }
        "fs_create_file" => vec![del(sarg(args, "file_path"))],
        "fs_create_dir" => vec![del(sarg(args, "dir_path"))],
        "fs_copy_path" => vec![del(sarg(args, "dest"))],
        "fs_compress" => vec![del(sarg(args, "archive_path"))],
        // These two pick their own destination and report it; the reply is the only place it exists.
        "fs_duplicate" | "fs_make_alias" => {
            let made = returned(result);
            let path = made
                .as_str()
                .ok_or_else(|| format!("{verb}: reply did not name the path it created"))?;
            vec![del(path.to_string())]
        }
        // The store is rewritten wholesale: wipe it, then re-add every prior entry in REVERSE order,
        // because `upsert_snippet` inserts at the head. `snippet_list` returns the store verbatim,
        // so the restored list is identical, order included.
        "snippet_add" | "snippet_remove" | "snippet_clear" => {
            let prior = was
                .get("snippets")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| format!("{verb}: pre-state carries no snippet list"))?;
            let mut steps = vec![("snippet_clear".to_string(), json!({}))];
            for s in prior.iter().rev() {
                steps.push((
                    "snippet_add".to_string(),
                    json!({ "name": sarg(s, "name"), "body": sarg(s, "body") }),
                ));
            }
            steps
        }
        "toggle_fullscreen" => vec![("toggle_fullscreen".to_string(), json!({}))],
        // The snapshot's whole effect is one token directory outside the user's tree, and the reply
        // is the only place its name exists. `txn_discard` removes exactly that directory, so the
        // compensation needs no state the bus cannot read.
        "txn_snapshot" => {
            let made = returned(result);
            let token = made
                .as_str()
                .ok_or_else(|| "txn_snapshot: reply did not name the token it created".to_string())?;
            vec![("txn_discard".to_string(), json!({ "token": token }))]
        }
        other => return Err(format!("verb not reversible: {other}")),
    })
}

struct ZmaxBus {
    app: AppHandle,
    pending: Pending,
    next_id: AtomicU64,
}

impl ZmaxBus {
    /// Register a pending request and run `js`, which must eventually call `zgui_bridge_reply` with
    /// the id this returns. Blocks the socket thread until the reply lands (or a timeout).
    fn dispatch(&self, make_js: impl FnOnce(u64) -> String) -> Result<Value, String> {
        let win = self
            .app
            .get_webview_window("main")
            .ok_or_else(|| "no main webview".to_string())?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = win.eval(&make_js(id)) {
            self.pending.lock().unwrap().remove(&id);
            return Err(format!("eval failed: {e}"));
        }
        let out = rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "webview did not reply".to_string());
        self.pending.lock().unwrap().remove(&id);
        out?
    }

    /// Run one host `#[tauri::command]` by name through the app's own invoke handler — the same
    /// path the UI takes, so arguments deserialize with the command's real signature and async
    /// commands are awaited. `args` is the command's argument object.
    fn host_invoke(&self, cmd: &str, args: Value) -> Result<Value, String> {
        if !is_host_cmd(cmd) {
            return Err(format!("not a zmax-gui host command: {cmd}"));
        }
        self.dispatch(|id| {
            format!(
                "(function(){{var i={id},k={name},a={args};\
                 function r(o,v,e){{window.__TAURI__.core.invoke('zgui_bridge_reply',\
                 {{id:i,ok:o,value:v,error:e}})}}\
                 try{{window.__TAURI__.core.invoke(k,a).then(\
                 function(v){{r(true,v===undefined?null:v,null)}},\
                 function(e){{r(false,null,String(e&&e.message||e))}})}}\
                 catch(e){{r(false,null,String(e&&e.message||e))}}}})()",
                name = serde_json::to_string(cmd).unwrap_or_else(|_| "\"\"".into()),
                args = args,
            )
        })
    }

    /// Forward one request to the webview's `ZGui.automation` (via automation-host.js).
    /// `kind` is "call"|"get"|"verbs".
    fn forward(&self, kind: &str, name: &str, args: Value) -> Result<Value, String> {
        self.dispatch(|id| {
            format!(
                "window.__zguiBridgeDispatch&&window.__zguiBridgeDispatch({id},{kind},{name},{args})",
                kind = serde_json::to_string(kind).unwrap_or_else(|_| "\"call\"".into()),
                name = serde_json::to_string(name).unwrap_or_else(|_| "\"\"".into()),
                args = args,
            )
        })
    }
}

impl Handler for ZmaxBus {
    /// An inverse verb captures its pre-state first and carries it back under [`WAS`]; every other
    /// verb is dispatched unchanged. See the module header for why the pre-state travels in the
    /// reply rather than being read again at compensation time.
    fn call(&self, verb: &str, args: Value) -> Result<Value, String> {
        if crate::commands::NOT_ON_BUS.contains(&verb) {
            return Err(format!("{verb} is bridge plumbing and is not callable over the bus"));
        }
        if !is_host_cmd(verb) {
            return self.forward("call", verb, args);
        }
        if rev_of(verb) != "inverse" {
            return self.host_invoke(verb, args);
        }
        let read = |cmd: &str, a: Value| self.host_invoke(cmd, a);
        let was = pre_state(&read, verb, &args)?;
        let out = self.host_invoke(verb, args)?;
        // Most of these commands return `()` or a bare `String`; a scalar reply is wrapped under
        // `value` so the pre-state has somewhere to travel. `undo_plan::returned` unwraps it.
        Ok(match out {
            Value::Object(mut obj) => {
                obj.insert(WAS.to_string(), was);
                Value::Object(obj)
            }
            other => json!({ "value": other, WAS: was }),
        })
    }

    fn rev(&self, verb: &str) -> &'static str {
        rev_of(verb)
    }

    /// Compensate one executed verb by replaying [`undo_plan`]'s host commands in order.
    fn undo(&self, verb: &str, args: Value, result: Value) -> Result<Value, String> {
        if rev_of(verb) != "inverse" {
            return Err(format!("verb not reversible: {verb}"));
        }
        let mut last = Value::Null;
        for (cmd, cmd_args) in undo_plan(verb, &args, &result)? {
            last = self.host_invoke(&cmd, cmd_args)?;
        }
        Ok(last)
    }

    fn get(&self, state: &str) -> Result<Value, String> {
        if is_host_cmd(state) {
            self.host_invoke(state, json!({}))
        } else {
            self.forward("get", state, json!({}))
        }
    }

    /// The whole surface: every host command PLUS whatever the webview registered in
    /// `ZGui.automation` (appShell actions + the zmax menu). The webview part is best-effort.
    fn surface(&self) -> Value {
        let mut verbs: Vec<Value> = crate::commands::COMMANDS
            .iter()
            .map(|c| json!({ "id": *c, "label": *c }))
            .collect();
        // Readable, argument-free host commands, so `get(...)` works without a payload.
        let mut state = vec![
            json!({ "id": "recent_list", "label": "Recent projects" }),
            json!({ "id": "bookmark_list", "label": "Bookmarks" }),
            json!({ "id": "snippet_list", "label": "Snippets" }),
        ];
        let mut events: Vec<Value> = Vec::new();
        if let Ok(web) = self.forward("verbs", "", json!({})) {
            if let Some(v) = web.get("verbs").and_then(|x| x.as_array()) {
                verbs.extend(v.iter().cloned());
            }
            if let Some(s) = web.get("state").and_then(|x| x.as_array()) {
                state.extend(s.iter().cloned());
            }
            if let Some(e) = web.get("events").and_then(|x| x.as_array()) {
                events.extend(e.iter().cloned());
            }
        }
        json!({ "app": "zmax-gui", "verbs": verbs, "state": state, "events": events })
    }
}

/// The webview calls this (from automation-host.js) to report a forwarded request's result.
#[tauri::command]
pub fn zgui_bridge_reply(
    id: u64,
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
    pending: tauri::State<'_, Pending>,
) {
    if let Some(tx) = pending.lock().unwrap().remove(&id) {
        let _ = tx.send(if ok {
            Ok(value.unwrap_or(Value::Null))
        } else {
            Err(error.unwrap_or_else(|| "webview verb failed".into()))
        });
    }
}

/// The webview calls this to push an emitted automation event; we forward it to bus subscribers.
#[tauri::command]
pub fn zgui_bridge_event(event: String, payload: Value) {
    if let Some(b) = BRIDGE.get() {
        b.emit(&event, payload);
    }
}

/// Open the GUI-scripts directory (`<config>/zgui/scripts`) in the OS file manager.
#[tauri::command]
pub fn zgui_reveal_scripts(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app
        .path()
        .config_dir()
        .map_err(|e| e.to_string())?
        .join("zgui")
        .join("scripts");
    let _ = std::fs::create_dir_all(&dir);
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// The shared pending-map, created once so both `start` and the `zgui_bridge_reply` command state use it.
pub fn pending_state() -> Pending {
    static P: OnceLock<Pending> = OnceLock::new();
    P.get_or_init(|| Arc::new(Mutex::new(HashMap::new()))).clone()
}

/// Open zmax-gui's bus socket. Called once from `setup()`.
pub fn start(app: &AppHandle) {
    let handler = ZmaxBus {
        app: app.clone(),
        pending: pending_state(),
        next_id: AtomicU64::new(1),
    };
    match serve("zmax-gui", handler) {
        Ok(bridge) => {
            let _ = BRIDGE.set(bridge);
        }
        Err(e) => eprintln!("zmax-gui: could not open automation-bus socket: {e}"),
    }
}

#[cfg(all(test, unix))]
mod tests {
    //! The transactional contract, driven end to end over a real bus socket against a real
    //! filesystem in a throwaway directory.
    //!
    //! The handler under test is [`FsBus`]: the same [`rev_of`] / [`pre_state`] / [`undo_plan`] this
    //! file gives [`ZmaxBus`], but dispatching the file-browser verbs straight to the
    //! `zpwr_file_browser` functions the host's `#[tauri::command]`s wrap, instead of bouncing them
    //! through a webview. Those functions take no `AppHandle`, so the whole of the `fs_*` half of
    //! the inverse class runs headlessly — no window, no editor, no network.
    //!
    //! The snippet verbs need an `AppHandle` for their store path and so are covered at the plan
    //! level instead, which is where their only interesting property lives (restore order).

    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use zgui_bridge::socket_path;

    /// A bus handler over the real file-browser functions and a scratch directory.
    struct FsBus;

    fn block<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    fn s(v: &Value, k: &str) -> String {
        v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
    }

    impl FsBus {
        /// Dispatch by name to the same function the host command wraps.
        fn host(&self, cmd: &str, a: Value) -> Result<Value, String> {
            use zpwr_file_browser as fb;
            let ok = |_| Value::Null;
            match cmd {
                "fs_get_info" => block(fb::fs_get_info(s(&a, "path")))
                    .and_then(|i| serde_json::to_value(i).map_err(|e| e.to_string())),
                "fs_chmod" => block(fb::fs_chmod(s(&a, "path"), s(&a, "mode_octal"))).map(ok),
                "fs_symlink_retarget" => {
                    block(fb::fs_symlink_retarget(s(&a, "path"), s(&a, "new_target"))).map(ok)
                }
                "fs_create_file" => block(fb::fs_create_file(s(&a, "file_path"))).map(ok),
                "fs_create_dir" => block(fb::fs_create_dir(s(&a, "dir_path"))).map(ok),
                "fs_copy_path" => block(fb::fs_copy_path(s(&a, "src"), s(&a, "dest"))).map(ok),
                "fs_duplicate" => block(fb::fs_duplicate(s(&a, "path"))).map(Value::String),
                "fs_make_alias" => block(fb::fs_make_alias(s(&a, "path"))).map(Value::String),
                "fs_compress" => {
                    let paths = a
                        .get("paths")
                        .and_then(Value::as_array)
                        .map(|v| v.iter().map(|p| p.as_str().unwrap_or("").to_string()).collect())
                        .unwrap_or_default();
                    block(fb::fs_compress(paths, s(&a, "archive_path"))).map(Value::String)
                }
                "delete_file" => block(fb::delete_file(s(&a, "file_path"))).map(ok),
                "fs_list_dir" => block(fb::fs_list_dir(s(&a, "path"), None))
                    .and_then(|e| serde_json::to_value(e).map_err(|x| x.to_string())),
                other => Err(format!("not wired in this test handler: {other}")),
            }
        }
    }

    impl Handler for FsBus {
        fn call(&self, verb: &str, args: Value) -> Result<Value, String> {
            if rev_of(verb) != "inverse" {
                return self.host(verb, args);
            }
            let read = |cmd: &str, a: Value| self.host(cmd, a);
            let was = pre_state(&read, verb, &args)?;
            let out = self.host(verb, args)?;
            Ok(match out {
                Value::Object(mut obj) => {
                    obj.insert(WAS.to_string(), was);
                    Value::Object(obj)
                }
                other => json!({ "value": other, WAS: was }),
            })
        }

        fn get(&self, state: &str) -> Result<Value, String> {
            self.host(state, json!({}))
        }

        fn surface(&self) -> Value {
            json!({ "app": "zmax-gui", "verbs": [], "state": [], "events": [] })
        }

        fn rev(&self, verb: &str) -> &'static str {
            rev_of(verb)
        }

        fn undo(&self, verb: &str, args: Value, result: Value) -> Result<Value, String> {
            if rev_of(verb) != "inverse" {
                return Err(format!("verb not reversible: {verb}"));
            }
            let mut last = Value::Null;
            for (cmd, cmd_args) in undo_plan(verb, &args, &result)? {
                last = self.host(&cmd, cmd_args)?;
            }
            Ok(last)
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zmax-bus-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// Every path under `root`, relative and sorted — the shape of a tree, independent of order.
    fn tree(root: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let p = e.path();
                out.push(p.strip_prefix(root).unwrap().to_string_lossy().to_string());
                if std::fs::symlink_metadata(&p).map(|m| m.is_dir()).unwrap_or(false) {
                    stack.push(p);
                }
            }
        }
        out.sort();
        out
    }

    fn round(conn: &mut BufReader<UnixStream>, req: Value) -> Value {
        let mut w = conn.get_ref().try_clone().expect("clone stream");
        writeln!(w, "{req}").expect("write frame");
        w.flush().expect("flush");
        let mut line = String::new();
        conn.read_line(&mut line).expect("read reply");
        serde_json::from_str(&line).expect("parse reply")
    }

    fn bus(tag: &str) -> (Arc<Bridge>, BufReader<UnixStream>, PathBuf) {
        let app = format!("zmax-txn-{tag}-{}", std::process::id());
        let bridge = serve(&app, FsBus).expect("serve");
        let path = socket_path(&app).expect("socket path");
        let c = UnixStream::connect(&path).expect("connect");
        c.set_read_timeout(Some(Duration::from_secs(10))).expect("timeout");
        (bridge, BufReader::new(c), path)
    }

    /// Every host command lands in exactly one class, and the classification names only real
    /// commands. A command added to the host and not classified here would silently inherit
    /// `"irreversible"` and be refused inside every transaction with no diagnostic.
    #[test]
    fn every_host_command_has_exactly_one_declared_rev_class() {
        let all = crate::commands::COMMANDS;
        for v in PURE {
            assert!(all.contains(v), "PURE names a command the host does not have: {v}");
            assert!(!INVERSE.contains(v), "{v} is declared both pure and inverse");
        }
        for v in INVERSE {
            assert!(all.contains(v), "INVERSE names a command the host does not have: {v}");
        }
        let irreversible: Vec<&&str> = all.iter().filter(|c| rev_of(c) == "irreversible").collect();
        assert_eq!(
            (PURE.len(), INVERSE.len(), irreversible.len()),
            // +6 for the transaction journal: `txn_pending` is a read of the journal files, and the
            // five that write it (`txn_seal` / `txn_open` / `txn_append` / `txn_close` /
            // `txn_unwind`) stay at the fail-fast default — see the rejected list on [`INVERSE`],
            // where each one's reason is given.
            (51, 13, 70),
            "host surface changed: reclassify the new commands, do not let them default. \
             unclassified = {irreversible:?}"
        );
        assert_eq!(PURE.len() + INVERSE.len() + irreversible.len(), all.len());
    }

    /// `txn_snapshot` is declared reversible; this proves the declaration by running the plan the
    /// declaration promises against the real snapshot store. The compensation must remove exactly
    /// the token the forward call reported and nothing else — a second, untouched token in the same
    /// store is what makes "and nothing else" observable rather than assumed.
    ///
    /// The three sibling verbs stay irreversible on purpose: `txn_restore` overwrites live content,
    /// `txn_discard` destroys the only copy of a pre-state, and `txn_list` is a read.
    #[test]
    fn a_snapshot_is_taken_back_by_discarding_the_token_it_reported() {
        let base = scratch("txn-inverse");
        let doc = base.join("doc.txt");
        std::fs::write(&doc, b"original").expect("seed");

        let token = crate::txn::snapshot(&base, &[doc.to_string_lossy().to_string()]).expect("snapshot");
        let bystander =
            crate::txn::snapshot(&base, &[doc.to_string_lossy().to_string()]).expect("second snapshot");
        assert_ne!(token, bystander, "each snapshot gets its own token");

        // The plan the bus would run to unwind the forward call, derived from its reply exactly as
        // `Handler::undo` derives it (a bare scalar arrives wrapped under "value").
        let plan = undo_plan("txn_snapshot", &json!({}), &json!({ WAS: {}, "value": token }))
            .expect("txn_snapshot must be reversible");
        assert_eq!(plan.len(), 1, "one step, not a guessed sequence: {plan:?}");
        assert_eq!(plan[0].0, "txn_discard");
        assert_eq!(plan[0].1, json!({ "token": token }));

        crate::txn::discard(&base, &plan[0].1["token"].as_str().unwrap()).expect("discard");
        let left = crate::txn::list(&base).expect("list");
        assert!(!left.contains(&token), "the compensated token survived: {left:?}");
        assert!(left.contains(&bystander), "the compensation took an unrelated token with it: {left:?}");
    }

    /// The blind channels stay irreversible. This is the app's main editor path, so a future edit
    /// that "helpfully" made it compensable by injecting an editor-native undo would be a
    /// manufactured success signal — the host never learns whether the keystrokes applied.
    #[test]
    fn the_pty_keystroke_channel_is_never_declared_reversible() {
        for verb in [
            "terminal_write", "shell_term_write", "term_session_write",
            "terminal_spawn", "terminal_kill", "shell_term_spawn", "term_session_spawn",
        ] {
            assert_eq!(rev_of(verb), "irreversible", "`{verb}` writes blind to a PTY");
        }
        // The content rewriters, for the same reason: restoring them needs a backup, not an inverse.
        for verb in ["fs_write_file_base64", "replace_project", "replace_documents", "convert_file"] {
            assert_eq!(rev_of(verb), "irreversible", "`{verb}` overwrites content");
        }
    }

    /// A verb that cannot be taken back is rejected BEFORE it runs, so a transaction never contains
    /// a step the abort cannot unwind. The surviving file is the proof the refusal preceded the
    /// effect rather than following it.
    #[test]
    fn an_irreversible_verb_is_refused_before_it_runs() {
        let root = scratch("refuse");
        let victim = root.join("keep.txt");
        std::fs::write(&victim, b"precious").unwrap();
        let (_bridge, mut c, path) = bus("refuse");

        assert_eq!(round(&mut c, json!({ "t": "begin", "id": 1, "txn": 1 }))["ok"], true);
        let r = round(
            &mut c,
            json!({ "t": "call", "id": 2, "verb": "delete_file",
                    "args": { "file_path": victim.to_string_lossy() } }),
        );
        assert_eq!(r["ok"], false);
        assert_eq!(r["error"], "verb not reversible: delete_file");
        assert_eq!(std::fs::read(&victim).unwrap(), b"precious", "the refused call must not have run");
        let _ = std::fs::remove_file(&path);
    }

    /// Five creating verbs plus a chmod, then an abort. The directory tree and the mode must be
    /// exactly what they were — which they can only be if every compensation ran, in descending
    /// `seq`, including the two verbs that chose their own destination name.
    #[test]
    fn aborting_a_transaction_restores_the_tree_and_the_mode() {
        let root = scratch("abort");
        let seed = root.join("seed.txt");
        std::fs::write(&seed, b"hello").unwrap();
        let p = |n: &str| root.join(n).to_string_lossy().to_string();
        let before = tree(&root);
        let mode_before = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(&seed).unwrap().permissions().mode() & 0o7777
        };
        let (_bridge, mut c, path) = bus("abort");

        assert_eq!(round(&mut c, json!({ "t": "begin", "id": 1, "txn": 3 }))["ok"], true);
        let steps = [
            json!({ "verb": "fs_create_dir", "args": { "dir_path": p("made") } }),
            json!({ "verb": "fs_create_file", "args": { "file_path": p("made/new.txt") } }),
            json!({ "verb": "fs_copy_path", "args": { "src": p("seed.txt"), "dest": p("copy.txt") } }),
            json!({ "verb": "fs_duplicate", "args": { "path": p("seed.txt") } }),
            json!({ "verb": "fs_make_alias", "args": { "path": p("seed.txt") } }),
            json!({ "verb": "fs_compress",
                    "args": { "paths": [p("seed.txt")], "archive_path": p("bundle.zip") } }),
            json!({ "verb": "fs_chmod", "args": { "path": p("seed.txt"), "mode_octal": "0600" } }),
        ];
        for (n, st) in steps.iter().enumerate() {
            let r = round(
                &mut c,
                json!({ "t": "call", "id": 10 + n, "verb": st["verb"], "args": st["args"] }),
            );
            assert_eq!(r["ok"], true, "forward step {} failed: {r}", st["verb"]);
        }
        assert_ne!(tree(&root), before, "the forward steps must actually have created something");

        let r = round(&mut c, json!({ "t": "abort", "id": 30, "txn": 3 }));
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["value"]["compensated"], steps.len(), "{r}");
        assert_eq!(r["value"]["failed"].as_array().unwrap().len(), 0, "{r}");

        assert_eq!(tree(&root), before, "the tree must be exactly as it was");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&seed).unwrap().permissions().mode() & 0o7777,
            mode_before,
            "the mode must be restored, not left at the value the transaction set"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// Compensation is order-dependent, and the order is the reverse of execution. A directory
    /// created and then filled can only unwind file-then-directory here, because
    /// `undo_plan("fs_create_dir")` deletes the directory whole: unwinding forwards removes the
    /// directory with the file still in it and the file's own compensation then has nothing to
    /// delete — a compensation reported as FAILED for state that was in fact destroyed.
    #[test]
    fn compensation_order_is_the_reverse_of_execution() {
        let root = scratch("order");
        let dir = root.join("made").to_string_lossy().to_string();
        let file = root.join("made/new.txt").to_string_lossy().to_string();
        let h = FsBus;

        let dir_args = json!({ "dir_path": dir });
        let file_args = json!({ "file_path": file });
        let made_dir = h.call("fs_create_dir", dir_args.clone()).expect("mkdir");
        let made_file = h.call("fs_create_file", file_args.clone()).expect("create");

        // Forward order: the directory goes first, taking the file with it.
        h.undo("fs_create_dir", dir_args.clone(), made_dir.clone()).expect("undo mkdir");
        let err = h.undo("fs_create_file", file_args.clone(), made_file.clone()).unwrap_err();
        assert!(err.contains("not found"), "expected a missing-file error, got: {err}");

        // Reverse order, from the same starting point: both compensations land, tree restored.
        let root = scratch("order2");
        let dir = root.join("made").to_string_lossy().to_string();
        let file = root.join("made/new.txt").to_string_lossy().to_string();
        let before = tree(&root);
        let dir_args = json!({ "dir_path": dir });
        let file_args = json!({ "file_path": file });
        let made_dir = h.call("fs_create_dir", dir_args.clone()).expect("mkdir");
        let made_file = h.call("fs_create_file", file_args.clone()).expect("create");
        h.undo("fs_create_file", file_args, made_file).expect("undo create");
        h.undo("fs_create_dir", dir_args, made_dir).expect("undo mkdir");
        assert_eq!(tree(&root), before);
    }

    /// The snippet store is restored wholesale, and the order matters: `upsert_snippet` inserts at
    /// the head, so replaying the captured list forwards would come back reversed. `snippet_list`
    /// returns the store verbatim, which is what makes the restore exact — and is exactly what
    /// `bookmark_list` and `recent_list` do NOT do, hence their commands are irreversible.
    #[test]
    fn snippet_compensation_rebuilds_the_store_in_the_right_order() {
        let prior = json!([
            { "name": "third", "body": "c" },
            { "name": "second", "body": "b" },
            { "name": "first", "body": "a" },
        ]);
        let result = json!({ WAS: { "snippets": prior } });
        let plan = undo_plan("snippet_clear", &json!({}), &result).expect("plan");

        let names: Vec<String> = plan.iter().map(|(c, a)| format!("{c}:{}", s(a, "name"))).collect();
        assert_eq!(
            names,
            vec!["snippet_clear:", "snippet_add:first", "snippet_add:second", "snippet_add:third"],
            "the store is wiped, then re-added tail-first so head-insertion rebuilds the order"
        );
    }

    /// The two ways compensation can be asked for something it was never given: a verb outside the
    /// inverse class, and an inverse verb whose reply lost its pre-state block. Both must refuse
    /// with the wire message the bridge reports, never guess.
    #[test]
    fn compensation_refuses_rather_than_guesses() {
        let h = FsBus;
        let err = h.undo("terminal_write", json!({ "data": "u" }), json!({})).unwrap_err();
        assert_eq!(err, "verb not reversible: terminal_write");

        let err = undo_plan("fs_chmod", &json!({ "path": "/tmp/x" }), &json!({ "ok": true }))
            .unwrap_err();
        assert!(err.contains(WAS), "expected a missing-pre-state error, got: {err}");
    }
}
