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
//! `zoffice-core` and `zpdf-core` link in as rlibs to back the document commands in `doc_search`.
//! Their own command surfaces (`zoffice_core::commands`, `zpdf_core::commands`) stay *off* this bus,
//! unchanged and deliberately: zmax-gui uses those crates as libraries inside its walker, not as
//! managed engines, so a bus call would run against an ad-hoc engine with no relation to the
//! editor's open buffers; and `zpdf-core` is built with `default-features = false`, which leaves its
//! `zpdf_invoke` dispatch (behind the `tauri` feature) out of the binary entirely. Those verbs are
//! scriptable at their own apps' buses (`App::open("zoffice")`, `App::open("zpdf")`).

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
    fn call(&self, verb: &str, args: Value) -> Result<Value, String> {
        if crate::commands::NOT_ON_BUS.contains(&verb) {
            return Err(format!("{verb} is bridge plumbing and is not callable over the bus"));
        }
        if is_host_cmd(verb) {
            self.host_invoke(verb, args)
        } else {
            self.forward("call", verb, args)
        }
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
