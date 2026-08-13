// zmax-gui — the DOCUMENT PANE: open a `.pdf` / `.docx` / `.xlsx` / `.pptx` / ODF file INSIDE the
// IDE instead of handing it to whatever the OS has registered for it.
//
// WHY THIS EXISTS. zmax-gui already reads binary documents: `search_documents` walks them
// in-process through the zoffice-core / zpdf-core rlibs, `replace_documents` rewrites them, and
// `doc_blame` attributes their cells and pages to git revisions (doc_search.rs / doc_blame.rs). But
// a *hit* could not be looked at. `panels.js` openDocument had exactly one move — `opener.openPath`,
// the OS default application — so finding a paragraph in a `.docx` from the workbench meant leaving
// the IDE for Word or LibreOffice, and the in-document locator (¶12, Sheet1!B7, p. 4) could only be
// put on the clipboard because the external app cannot be told where to go. That is also a
// third-party binary in the middle of a workflow this app otherwise owns end to end.
//
// Both engines now ship a MOUNTABLE view, so the pane is the engine's own surface rather than a
// re-implementation: `window.mountZoffice` (zoffice-core webui/zoffice-view.js) and
// `window.mountZpdf` (zpdf-core frontend/js/zpdf.js), staged into frontend/lib/doc-views by
// scripts/copy-doc-views.mjs and backed by the bare `zoffice_invoke` / `zpdf_invoke` app commands
// registered in lib.rs. The locator is spent on arrival: a PDF page hit lands on that page, a
// spreadsheet cell hit opens the Data view, and a text hit is searched for in the document.
//
// THREE RULES A HOST MOUNTING A SHARED PANE HAS TO FOLLOW, all of them load-bearing here:
//
//   1. NEVER hand a pane `automationApp`. `ZGui.automation` keeps one flat registry with a single
//      app name and the last `register({app})` wins (zgui-core/webui/automation.js), so a pane that
//      names itself renames the host: `App::open("zmax-gui")` would stop matching what this app's
//      socket answers. mountZoffice only sets it when asked; we never ask. mountZpdf sets
//      `app: "zpdf"` unconditionally inside `registerViewerState()` — which is why this file never
//      calls `window.zpdfSetShell`, the only thing that reaches it.
//   2. NAMESPACE the verbs. Ids collide in that same flat registry and later ids win. The pane's
//      own verbs are `zoffice.view.*`; the host's pane-control verbs added here are `zmax.doc.*`,
//      which is the prefix zmax-gui already owns.
//   3. MOUNT INSIDE `ZGui.embed.view()`. It swaps the app-level global surface (appShell, the
//      global ⌘K bind, the `:root` theme, the splash) for throwing stubs for the duration of the
//      mount, so a view that reaches for a document-global singleton fails loudly instead of
//      quietly fighting the editor's own chrome.
//
// Surfaces stay modal overlays, per the panels.js rule: a docked pane would have to reflow the
// embedded terminal, which resolves differently in release WebKit.
(function () {
  "use strict";

  function Z() { return window.ZGui; }
  function T(key, english) {
    var s = (typeof window.t === "function") ? window.t(key, english) : null;
    return (s && s !== key) ? s : english;
  }

  // Which engine owns a path. `null` = neither, and a null answer is what makes the OS-opener
  // fallback in panels.js correct rather than dead code: an `.epub` or `.pages` hit still opens.
  var OFFICE_EXT = ["docx", "odt", "xlsx", "ods", "pptx", "odp"];
  function kindOf(path) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(path || ""));
    if (!m) return null;
    var ext = m[1].toLowerCase();
    if (ext === "pdf") return "pdf";
    return OFFICE_EXT.indexOf(ext) >= 0 ? "office" : null;
  }

  // ── the single live pane ────────────────────────────────────────────────────────────────────
  // One at a time, deliberately. mountZpdf's handle exposes no destroy(), so a pane that is
  // dropped can leave document-level listeners behind; reusing one modal bounds that to one
  // instance per engine per session instead of one per document opened.
  var live = null;   // { kind, path, api, modal }

  function close() {
    if (!live) return;
    try { if (live.api && typeof live.api.destroy === "function") live.api.destroy(); } catch (_) {}
    try { if (live.modal) live.modal.close(); } catch (_) {}
    live = null;
  }

  /// Run `fn` under the embed guard when zgui-core provides one. `ZGui.embed.view` keeps the guard
  /// installed until an async mount's promise SETTLES, so returning fn's promise matters.
  function guarded(fn) {
    var E = Z() && Z().embed;
    return (E && typeof E.view === "function") ? E.view(fn) : fn();
  }

  /// The label a locator reads as, used for the pane title. Mirrors panels.js locatorLabel; kept
  /// here rather than imported because panels.js exposes no module surface.
  function locatorLabel(loc) {
    if (!loc) return "";
    switch (loc.kind) {
      case "paragraph": return "¶" + (loc.index + 1);
      case "cell": return (loc.sheet_name || ("sheet " + (loc.sheet + 1))) + "!" + loc.reference;
      case "slide": return T("zmax.doc.slide", "slide") + " " + (loc.index + 1);
      case "page": return "p. " + loc.page;
      default: return "";
    }
  }

  /// Spend the locator on the freshly opened pane. Best-effort by construction: a document that
  /// changed since the search ran may no longer have the address, and that must not fail the open.
  function applyLocator(kind, api, loc, text) {
    if (!loc) return;
    try {
      if (kind === "pdf") {
        if (loc.kind === "page" && typeof api.goToPage === "function") api.goToPage(loc.page);
        return;
      }
      // Office: a cell address is only meaningful in the Data view; everything else is prose, so
      // the hit's own text is the most precise thing we can hand the view.
      if (loc.kind === "cell" && typeof api.showView === "function") api.showView("data");
      if (text && typeof api.find === "function") api.find(text);
    } catch (_) { /* navigation is a courtesy, never a failure mode */ }
  }

  /// Open `path` in the pane. Resolves to the mounted instance handle, or rejects with a reason the
  /// caller can show. Rejecting rather than silently degrading is what lets panels.js fall back to
  /// the OS opener only when the pane genuinely cannot serve the file.
  function open(path, opts) {
    var o = opts || {};
    var kind = kindOf(path);
    if (!kind) return Promise.reject(new Error("no document pane for " + path));
    var mount = kind === "pdf" ? window.mountZpdf : window.mountZoffice;
    if (typeof mount !== "function") {
      return Promise.reject(new Error("the " + kind + " view is not loaded"));
    }
    if (!Z() || !Z().modal) return Promise.reject(new Error("no modal host"));

    close();
    var where = locatorLabel(o.locator);
    var root = document.createElement("div");
    root.className = "zmax-doc-pane";

    var modal = Z().modal.open({
      id: "zmaxDocPane",                       // stable id → the pane keeps its size across opens
      title: (o.title || path) + (where ? " · " + where : ""),
      body: root,
      className: "zmax-doc-modal",
    });

    // `guarded` is entered inside the promise executor, not before it: a mount that throws
    // SYNCHRONOUSLY (a view whose script did not load, an engine command missing at construction)
    // would otherwise throw straight out of `open()` past the cleanup below, leaving an empty modal
    // on screen and `live` pointing at a pane that never built.
    // Recorded BEFORE the mount, with no api yet: `close()` is what tears the modal down, and it
    // can only do that for a pane it knows about. Assigning after a successful mount left the
    // modal of a FAILED mount on screen forever, with no view in it.
    live = { kind: kind, path: path, api: null, modal: modal };

    return new Promise(function (resolve) {
      resolve(guarded(function () {
        var api = mount(root, kind === "pdf"
          ? { transport: typeof window.zpdfPluginTransport === "function" ? window.zpdfPluginTransport() : undefined }
          : {});                                // zoffice-view auto-detects `zoffice_invoke` itself
        live.api = api;
        var opened = kind === "pdf" ? api.openPath(path) : api.open(path);
        return Promise.resolve(opened).then(function () {
          applyLocator(kind, api, o.locator, o.text);
          return api;
        });
      }));
    }).catch(function (e) {
      close();
      throw (e instanceof Error ? e : new Error(String(e)));
    });
  }

  /// What the pane is showing — the state query a script reads instead of taking a screenshot.
  function state() {
    if (!live) return { open: false, path: null, kind: null };
    var inner = null;
    try { inner = (live.api && typeof live.api.state === "function") ? live.api.state() : null; } catch (_) {}
    return { open: true, path: live.path, kind: live.kind, view: inner };
  }

  // The pane-control VERBS are not registered here. verbs.js owns this app's whole typed
  // automation surface (one `A.register({app: "zmax-gui", …})`), and splitting registration across
  // two files is how an id ends up published twice with two different labels. It publishes
  // `zmax.doc.open` / `zmax.doc.close` / `zmax.doc.state` against this handle.
  window.ZmaxDocView = {
    kindOf: kindOf,
    open: open,
    close: close,
    state: state,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = window.ZmaxDocView;
  }
})();
