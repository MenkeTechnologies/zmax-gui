// zemacs-gui — the MacVim-style GUI surface, built ENTIRELY from zgui-core widgets (no native menus
// or dialogs). Every action is bridged to the editor by writing into the embedded PTY:
//   * a native-looking menu bar      → ZGui.menubar + ZGui.contextMenu
//   * Cmd-key shortcuts              → window keydown (zemacs-gui is the standalone host; macOS ⌘ keys
//                                       never reach the shell/tmux inside the PTY, so nothing is masked)
//   * Open / Save-As / Help dialogs  → ZGui.modal + ZGui.tree (file browser) / ZGui.modal.prompt
//   * drag-and-drop files            → ZGui.fileDrag.initDrop
// The OS-access primitives (list_dir, fullscreen, blur) are thin Tauri commands; the UI is all zgui.
(function () {
  "use strict";

  // ── PTY bridge ────────────────────────────────────────────────────────────────────────────────
  function core() { return window.__TAURI__ && window.__TAURI__.core; }
  function invoke(cmd, args) { var T = core(); return T ? T.invoke(cmd, args || {}) : Promise.reject("no tauri"); }
  function ptyWrite(data) { invoke("terminal_write", { data: data }).catch(function () {}); }

  // zemacs is a Helix fork with a vim keymap. Run an ex-command from ANY mode: Esc → `:cmd` → Enter.
  function ex(cmd) { ptyWrite("\x1b:" + cmd + "\r"); }
  // Send normal-mode keys (Esc first so we're not stuck in insert/command mode).
  function nkeys(keys) { ptyWrite("\x1b" + keys); }
  // Quote a path for Helix typed-command shellwords parsing (handles spaces).
  function q(p) { return '"' + String(p).replace(/"/g, '\\"') + '"'; }

  // GUI preferences (zgui-widget Preferences panel toggles these).
  var prefs = { showHidden: false };

  // ── editor actions (the bridge table; menu items and shortcuts both call these) ─────────────────
  var act = {
    newBuffer:   function () { ex("new"); },
    open:        function () { openDialog(); },
    save:        function () { ex("write"); },
    saveAs:      function () { saveAsDialog(); },
    reload:      function () { ex("reload"); },
    closeBuffer: function () { ex("buffer-close"); },
    quit:        function () { ex("quit-all"); },

    undo:   function () { nkeys("u"); },
    redo:   function () { nkeys("\x12"); },   // C-r
    copy:   function () { nkeys("y"); },
    cut:    function () { nkeys("d"); },
    paste:  function () { nkeys("p"); },
    find:   function () { nkeys("/"); },        // hands off to the editor's own search line
    findNext: function () { nkeys("n"); },
    findPrev: function () { nkeys("N"); },

    nextBuffer: function () { ex("buffer-next"); },
    prevBuffer: function () { ex("buffer-previous"); },

    hsplit: function () { ex("hsplit"); },
    vsplit: function () { ex("vsplit"); },
    closeSplit: function () { nkeys("\x17q"); }, // C-w q
    rotate:     function () { nkeys("\x17w"); }, // C-w w

    fullscreen: function () { invoke("toggle_fullscreen").catch(function () {}); },
    blurOn:  function () { invoke("set_blur", { on: true }).catch(function () {}); document.body.classList.add("zemacs-translucent"); },
    blurOff: function () { invoke("set_blur", { on: false }).catch(function () {}); document.body.classList.remove("zemacs-translucent"); },

    help: function () { helpDialog(); },
    tutor: function () { nkeys(":tutor\r"); },

    focusEditor: function () { var c = document.getElementById("terminalContainer"); if (c) { var ta = c.querySelector("textarea"); if (ta) ta.focus(); } },
    restartEditor: function () { invoke("terminal_kill").then(function () { if (typeof window.showTerminal === "function") window.showTerminal(); setTimeout(function () { invoke("zemacs_exec_command").then(function (cmd) { ptyWrite("exec " + (cmd || "zemacs") + "\r"); }).catch(function () { ptyWrite("exec zemacs\r"); }); }, 800); }).catch(function () {}); },
  };

  // ── menu bar (ZGui.menubar → ZGui.contextMenu) ──────────────────────────────────────────────────
  function item(label, hint, run) { return { label: hint ? label + "  " + hint : label, action: run }; }
  var SEP = "---";

  function menus() {
    return [
      { label: "File", items: [
        item("New Buffer", "⌘N", act.newBuffer),
        item("Open…", "⌘O", act.open),
        SEP,
        item("Save", "⌘S", act.save),
        item("Save As…", "⇧⌘S", act.saveAs),
        item("Reload", "", act.reload),
        SEP,
        item("Close Buffer", "⌘W", act.closeBuffer),
        item("Quit", "⌘Q", act.quit),
      ] },
      { label: "Edit", items: [
        item("Undo", "⌘Z", act.undo),
        item("Redo", "⇧⌘Z", act.redo),
        SEP,
        item("Cut", "", act.cut),
        item("Copy", "", act.copy),
        item("Paste", "", act.paste),
        SEP,
        item("Find", "⌘F", act.find),
        item("Find Next", "⌘G", act.findNext),
        item("Find Previous", "⇧⌘G", act.findPrev),
      ] },
      { label: "View", items: [
        item("Toggle Full Screen", "⌃⌘F", act.fullscreen),
        SEP,
        item("Translucent Background", "", act.blurOn),
        item("Opaque Background", "", act.blurOff),
        SEP,
        item("Preferences…", "⌘,", function () { preferences(); }),
      ] },
      { label: "Buffers", items: [
        item("Next Buffer", "⌘}", act.nextBuffer),
        item("Previous Buffer", "⌘{", act.prevBuffer),
        SEP,
        item("Close Buffer", "⌘W", act.closeBuffer),
      ] },
      { label: "Window", items: [
        item("Split Horizontally", "", act.hsplit),
        item("Split Vertically", "", act.vsplit),
        SEP,
        item("Rotate Splits", "", act.rotate),
        item("Close Split", "", act.closeSplit),
      ] },
      { label: "Help", items: [
        item("Search Help…", "", act.help),
        item("Open Tutor", "", act.tutor),
      ] },
    ];
  }

  // Flatten the menu tree into ⌘K command-palette entries so the palette mirrors the full menu (not
  // just the 2 seed items). Labels are "Menu ▸ Item" so they group + fuzzy-search cleanly.
  function paletteItems() {
    var out = [];
    menus().forEach(function (m) {
      m.items.forEach(function (it) {
        if (it === SEP) return;
        out.push({ label: m.label + " ▸ " + it.label, run: it.action });
      });
    });
    out.push({ label: "Editor ▸ Focus", run: act.focusEditor });
    out.push({ label: "Editor ▸ Restart", run: act.restartEditor });
    return out;
  }

  // ── Cmd-key shortcuts (host owns the global keymap; ⌘ keys don't reach the PTY shell) ────────────
  function onKey(e) {
    if (!e.metaKey) return;
    var k = e.key.toLowerCase();
    var shift = e.shiftKey, ctrl = e.ctrlKey;
    var handled = true;
    if (ctrl && k === "f") act.fullscreen();
    else if (k === "n" && !shift) act.newBuffer();
    else if (k === "o" && !shift) act.open();
    else if (k === "s" && shift) act.saveAs();
    else if (k === "s") act.save();
    else if (k === "w") act.closeBuffer();
    else if (k === "z" && shift) act.redo();
    else if (k === "z") act.undo();
    else if (k === "f") act.find();
    else if (k === "g" && shift) act.findPrev();
    else if (k === "g") act.findNext();
    else if (k === "}" || (k === "]" && shift)) act.nextBuffer();
    else if (k === "{" || (k === "[" && shift)) act.prevBuffer();
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  // ── Open dialog: ZGui.modal + ZGui.tree file browser ────────────────────────────────────────────
  function openDialog() {
    if (!window.ZGui || !ZGui.modal || !ZGui.tree) return;
    var bodyWrap = document.createElement("div");
    bodyWrap.className = "zemacs-fb";
    var pathBar = document.createElement("div");
    pathBar.className = "zemacs-fb-path";
    var treeHost = document.createElement("div");
    treeHost.className = "zemacs-fb-tree";
    bodyWrap.appendChild(pathBar);
    bodyWrap.appendChild(treeHost);

    var dlg = ZGui.modal.open({
      title: "Open File",
      body: bodyWrap,
      className: "zemacs-fb-modal",
      actions: [{ label: "Cancel", close: true }],
    });

    function load(dir) {
      invoke("list_dir", { path: dir || null, showHidden: prefs.showHidden }).then(function (listing) {
        pathBar.textContent = listing.dir;
        var nodes = [];
        if (listing.parent) nodes.push({ label: "..", icon: "↑", data: { path: listing.parent, dir: true } });
        listing.entries.forEach(function (en) {
          nodes.push({ label: en.name, icon: en.is_dir ? "\u{1F4C1}" : "\u{1F4C4}", data: { path: en.path, dir: en.is_dir } });
        });
        ZGui.tree.render(treeHost, nodes, {
          defaultExpanded: false,
          onSelect: function (node) {
            var d = node.data || {};
            if (d.dir) load(d.path);
            else { ex("open " + q(d.path)); dlg.close(); }
          },
        });
      }).catch(function () {});
    }
    load(null);
  }

  // ── Save As: ZGui.modal.prompt ──────────────────────────────────────────────────────────────────
  function saveAsDialog() {
    if (!window.ZGui || !ZGui.modal || !ZGui.modal.prompt) { act.save(); return; }
    invoke("home_dir").then(function (home) {
      return ZGui.modal.prompt({ title: "Save As", message: "Write the current buffer to:", value: home + "/", placeholder: "/path/to/file" });
    }).then(function (path) {
      if (path) ex("write " + q(path));
    }).catch(function () {});
  }

  function helpDialog() {
    if (!window.ZGui || !ZGui.modal || !ZGui.modal.prompt) { nkeys(":help\r"); return; }
    ZGui.modal.prompt({ title: "Search Help", message: "Topic:", placeholder: "e.g. registers" }).then(function (topic) {
      if (topic) ex("help " + topic);
    }).catch(function () {});
  }

  // ── file-open intake: CLI / Finder / mvim:// (Tauri open_intake.rs → :open) ──────────────────────
  function openPaths(paths) { (paths || []).forEach(function (p) { if (p) ex("open " + q(p)); }); }
  function initOpenIntake() {
    var T = window.__TAURI__;
    // Live opens while running (2nd `mvim file`, Finder, deep-link) — editor is already up.
    if (T && T.event && T.event.listen) {
      T.event.listen("open-files", function (e) { openPaths(e && e.payload); }).catch(function () {});
    }
    // Cold-launch file args were queued before the webview existed; drain once the editor has replaced
    // the login shell (exec happens at ~800ms in main.js).
    setTimeout(function () { invoke("take_pending_opens").then(openPaths).catch(function () {}); }, 1500);
  }

  // ── Preferences (ZGui.modal + toggle rows) ──────────────────────────────────────────────────────
  function toggleRow(parent, label, on, onChange) {
    var row = document.createElement("div"); row.className = "zemacs-pref-row";
    var name = document.createElement("span"); name.textContent = label;
    var btn = document.createElement("button"); btn.type = "button";
    btn.className = "zg-shell-toggle" + (on ? " on" : ""); btn.textContent = on ? "ON" : "OFF";
    btn.addEventListener("click", function () {
      var n = !btn.classList.contains("on");
      btn.classList.toggle("on", n); btn.textContent = n ? "ON" : "OFF"; onChange(n);
    });
    row.appendChild(name); row.appendChild(btn); parent.appendChild(row);
  }
  function preferences() {
    if (!window.ZGui || !ZGui.modal) return;
    var body = document.createElement("div"); body.className = "zemacs-prefs";
    toggleRow(body, "Translucent background", document.body.classList.contains("zemacs-translucent"),
      function (on) { if (on) act.blurOn(); else act.blurOff(); });
    toggleRow(body, "Show hidden files in Open dialog", prefs.showHidden,
      function (on) { prefs.showHidden = on; });
    ZGui.modal.open({ title: "Preferences", body: body, small: true, actions: [{ label: "Done", primary: true, close: true }] });
  }

  // ── Toolbar (ZGui.buttonBar) ────────────────────────────────────────────────────────────────────
  function toolbar(host) {
    if (!window.ZGui || !ZGui.buttonBar) return;
    var bar = ZGui.buttonBar(host, { className: "zemacs-toolbar" });
    bar.add("⊕", "New buffer", act.newBuffer);
    bar.add("\u{1F4C2}", "Open…", act.open);
    bar.add("\u{1F4BE}", "Save", act.save);
    bar.sep();
    bar.add("◀", "Previous buffer", act.prevBuffer);
    bar.add("▶", "Next buffer", act.nextBuffer);
    bar.sep();
    bar.add("\u{1F50D}", "Find", act.find);
    bar.add("▃", "Split horizontally", act.hsplit);
    bar.add("⛶", "Toggle full screen", act.fullscreen);
  }

  // ── Editor right-click context menu (ZGui.contextMenu) ───────────────────────────────────────────
  function editorContextMenu() {
    if (!window.ZGui || !ZGui.contextMenu || !ZGui.contextMenu.bind) return;
    var pane = document.getElementById("terminalPane");
    if (!pane) return;
    ZGui.contextMenu.bind(pane, function () {
      return [
        { label: "Copy", action: act.copy },
        { label: "Paste", action: act.paste },
        "---",
        { label: "Open…", action: act.open },
        { label: "Save", action: act.save },
        "---",
        { label: "Find", action: act.find },
      ];
    });
  }

  // ── drag-and-drop files → open as buffers (ZGui.fileDrag) ────────────────────────────────────────
  function initDrop() {
    if (window.ZGui && ZGui.fileDrag && ZGui.fileDrag.initDrop) {
      ZGui.fileDrag.initDrop({
        overlayText: "Drop to open in zemacs",
        onDrop: function (paths) { (paths || []).forEach(function (p) { ex("open " + q(p)); }); },
      });
    }
  }

  // ── mount ───────────────────────────────────────────────────────────────────────────────────────
  function mount(shell) {
    if (!window.ZGui || !ZGui.menubar) return;
    var bar = document.createElement("div");
    bar.id = "zemacsMenubar";
    // Insert between the appShell bar and the terminal body so the menu sits at the top of the window.
    if (shell && shell.body && shell.body.parentNode) shell.body.parentNode.insertBefore(bar, shell.body);
    else document.body.insertBefore(bar, document.body.firstChild);
    ZGui.menubar(bar, menus());
    // menubar opens the dropdown on a left click; that same click otherwise bubbles to
    // ZGui.contextMenu's document-level "click outside closes" handler and shuts it instantly.
    // Registered after menubar's own handler (same button, bubble phase), so the dropdown is already
    // open when we stop the click from reaching document.
    bar.querySelectorAll(".zg-menubar-item").forEach(function (btn) {
      btn.addEventListener("click", function (e) { e.stopPropagation(); });
    });
    // Toolbar (icon buttons) directly under the menu bar.
    var tb = document.createElement("div");
    tb.id = "zemacsToolbar";
    if (shell && shell.body && shell.body.parentNode) shell.body.parentNode.insertBefore(tb, shell.body);
    toolbar(tb);

    // Populate ⌘K with every menu action (the appShell seed had only Restart/Focus).
    if (shell && typeof shell.setPaletteItems === "function") shell.setPaletteItems(paletteItems());
    window.addEventListener("keydown", onKey, true);
    editorContextMenu();
    initDrop();
    initOpenIntake();
  }

  window.ZemacsMenu = { mount: mount, actions: act };
})();
