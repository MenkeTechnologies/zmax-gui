// zmax-gui shell — mounts the ZGui.appShell baseline and runs the zmax editor (Helix fork) in a
// fullscreen embedded terminal (shared zpwr-embed-terminal frontend). The PTY spawns the login shell;
// we then `exec zmax` so the editor replaces it and fills the window. See GUI_APP_ARCHITECTURE.md.
(function () {
  "use strict";
  // Translate via the shared zpwr-i18n runtime (window.t), falling back to the English literal.
  function T(key, english) {
    var s = (typeof window.t === "function") ? window.t(key) : null;
    return (s && s !== key) ? s : english;
  }
  // Commands the SHELL owns — the ones with no menu item and no shared-embed equivalent. Each carries
  // a stable, locale-independent id: the appShell registers every published id as an `appshell.<id>`
  // verb on the GUI Automation Bus, and a saved command chain stores that id, so deriving one from
  // the (translated) label would rename the verb on a locale switch. Restart / Focus editor and the
  // Hooks editor are NOT here: menu.js publishes the first two as Editor ▸ Restart / Focus, and the
  // shell lists the hooks editor itself as a shared embed.
  function shellCommands() {
    return [
      // Tmux tiling (ZGui.tmux) — opens the overlay; C-b is the prefix (C-b c new window, %/" split).
      { id: "zmax.tmux", label: T("zmax.shell.tmux", "Tmux"), icon: "▦", keyword: "tmux tile split pane", run: function () { if (window.ZGui && ZGui.tmux && typeof ZGui.tmux.open === "function") ZGui.tmux.open(); } },
    ];
  }

  // Merge `extra` into `list`, first id wins. setCommands replaces the vocabulary wholesale, so every
  // publisher has to hand over the union or it erases the others.
  function mergeCommands(list, extra) {
    var out = Array.isArray(list) ? list.slice() : [];
    var have = {};
    out.forEach(function (c) { if (c && c.id) have[c.id] = 1; });
    extra.forEach(function (c) { if (!have[c.id]) out.push(c); });
    return out;
  }

  function boot() {
    if (!window.ZGui || typeof ZGui.appShell !== "function") return;
    // The appShell audits every published vocabulary and records the two silent miswirings it can
    // see — a ⌘K row with no id (listed in the palette but never reachable as an `appshell.<id>`
    // verb) and an id containing whitespace (a translated label used as an id, which renames itself
    // on a locale change and breaks every saved chain). It never prints them. Forward each to
    // zmax.log, the file the Diagnostics "Open log file" button reveals. Armed BEFORE the mount,
    // because the shell publishes its first vocabulary while constructing. No console output.
    document.addEventListener("zgui:diagnostic", function (e) {
      var d = (e && e.detail) || {}, TA = window.__TAURI__;
      if (TA && TA.core && typeof TA.core.invoke === "function")
        TA.core.invoke("log_diagnostic", { source: String(d.source || "zgui"), message: String(d.message || "") }).catch(function () {});
    });
    var shell = ZGui.appShell(document.getElementById("app"), {
      brand: { branch: "app", title: "ZMAX", subtitle: T("zmax.shell.subtitle", "editor") },
      filterPlaceholder: T("zmax.shell.filter", "Filter…"),
      commands: shellCommands(),
      // Extend the real Settings panel (⚙ / ⌘,) with the editor's language picker + toggles.
      settingsExtra: function (b) { if (window.ZmaxMenu && typeof window.ZmaxMenu.settingsExtra === "function") window.ZmaxMenu.settingsExtra(b); },
    });

    // menu.js (at mount and after a locale switch) and panels.js both publish their own vocabulary
    // through setCommands, which REPLACES the list — so re-merge the shell's own commands on every
    // call. Without this the shell's commands survive only until the first republish, which is the
    // same boot: menu.js mounts a few lines below.
    if (typeof shell.setCommands === "function") {
      var setCommands = shell.setCommands.bind(shell);
      shell.setCommands = function (list) { setCommands(mergeCommands(list, shellCommands())); };
    }

    // A fullscreen terminal pane inside shell.body — provided so zpwr-embed-terminal uses it instead
    // of injecting its floating dock pane (its _ensureTerminalDom is a no-op when #terminalPane exists).
    var pane = document.createElement("div");
    pane.id = "terminalPane";
    pane.className = "terminal-pane zmax-fill active";
    var container = document.createElement("div");
    container.id = "terminalContainer";
    container.className = "term-body";
    // Editor HUD — the buffer/tab bar, status strip and minimap, driven entirely by the state
    // editor-state.js reconstructs from the PTY stream (the editor is unmodified and exposes no RPC).
    // Sits above the terminal body inside the same pane so it scrolls and hides with it.
    var hudHost = document.createElement("div");
    hudHost.id = "editorHud";
    pane.appendChild(hudHost);
    pane.appendChild(container);
    shell.body.appendChild(pane);

    // MacVim-style menu bar + Cmd-shortcuts + dialogs + drag-drop (all zgui widgets), bridged to the PTY
    if (window.ZmaxMenu && typeof window.ZmaxMenu.mount === "function") window.ZmaxMenu.mount(shell);

    // App-local project workbench: quick-open (⌘P), find-in-files (⇧⌘J), recent (⌘E), project files
    // (⇧⌘E) and a git panel — all in the ⌘K palette. Mounts after menu.js so its palette items append.
    if (window.ZmaxPanels && typeof window.ZmaxPanels.mount === "function") window.ZmaxPanels.mount(shell);

    // Mount the HUD after menu.js, so its tab clicks drive the editor through the same PTY bridge
    // (and therefore the same mode handling) every other GUI action uses.
    if (window.ZmaxEditorHud && typeof window.ZmaxEditorHud.mount === "function") {
      try { window.ZmaxEditorHud.mount(hudHost, {}); } catch (e) { /* the HUD is additive; never block boot */ }
    }

    // Install the automation-bus webview dispatcher (window.__zguiBridgeDispatch + emit forwarding) so
    // the native bus (bus.rs) can forward App::here()->verbs() into ZGui.automation — WITHOUT this the
    // GUI Scripts "Actions" browser gets an empty surface. Default reply/event command names match bus.rs.
    if (window.ZGui && ZGui.automationHost && typeof ZGui.automationHost.install === "function") {
      try { ZGui.automationHost.install(); } catch (e) { /* automation optional */ }
    }

    // Exposed so the Preferences language picker can re-render the whole UI after switching locale.
    window.zmaxRetranslate = function () { retranslate(shell); };

    // Recovery check. A batch refactor journals itself to disk step by step (plan-panel.js →
    // txn.rs), so a run this app died inside is still a transaction the next launch can see. If any
    // is open, say so — once, quietly, as a toast — and put the unwind one click away. It is never
    // performed automatically: unwinding rewrites files, and an interrupted run is not always an
    // unwanted one. Deferred past boot so it cannot delay the editor coming up.
    setTimeout(function () {
      if (!window.ZmaxPlan || typeof ZmaxPlan.pending !== "function") return;
      ZmaxPlan.pending().then(function (rows) {
        if (!rows.length) return;
        var msg = rows.length + " " + T("zmax.plan.recover_toast", "interrupted run(s) found — open “Interrupted runs” to unwind");
        if (window.ZGui && ZGui.toast) ZGui.toast.show(msg, 8000, "warn");
      }, function () { /* no backend: nothing to report */ });
    }, 3000);

    // show + spawn the PTY, then exec the editor over the shell once it's up
    if (typeof window.showTerminal === "function") window.showTerminal();
    startEditor();

    // ── Floating shell terminal (⌘K "Terminal") ──
    // #terminalPane is the always-on IDE. The appShell's "Terminal" command calls
    // window.toggleTerminalPopup — point it at a SEPARATE floating shell that pops up ON TOP of the IDE.
    // It's an independent PTY (shell_term_* commands / shell-term-output event), so it never disturbs the
    // editor's terminal_* PTY. Reuses the shared .terminal-pane chrome + the bundled xterm.
    (function () {
      var T = window.__TAURI__;
      if (!T || !T.core || !T.event || typeof window.Terminal !== "function") return;
      var pane = null, body = null, term = null, spawned = false, listening = false;
      var lastRows = 0, lastCols = 0, fitTimer = null;

      // Pane geometry → rows/cols, through the SAME cell-metric maths the shared embedded terminal
      // uses for its own PTY (zpwr-embed-terminal exports it as window.zpwrTermFit). Re-deriving it
      // here would let the two terminals disagree about what a cell is. It also resizes `term`, so
      // the xterm and the PTY are told the same geometry. Falls back to the current xterm size when
      // the export is missing (a host serving an older terminal.js) — never guesses at the maths.
      function fit() {
        if (!term) return { rows: 24, cols: 80 };
        if (typeof window.zpwrTermFit === "function" && body) {
          try { return window.zpwrTermFit(term, body); } catch (e) { /* fall through to the xterm's own size */ }
        }
        return { rows: term.rows || 24, cols: term.cols || 80 };
      }

      // Push the current fit to the floating shell's PTY. Without this the kernel keeps the boot
      // geometry for the life of the session and anything full-screen (vim, less, htop) draws to the
      // wrong width. Only sent when the fit actually changed, so a window resize that the pane's
      // max-width/max-height clamp absorbs costs nothing.
      function sendResize() {
        if (!spawned || !term) return;
        var d = fit();
        if (d.rows === lastRows && d.cols === lastCols) return;
        lastRows = d.rows; lastCols = d.cols;
        T.core.invoke("shell_term_resize", { rows: d.rows, cols: d.cols }).catch(function () {});
      }
      function scheduleResize() { clearTimeout(fitTimer); fitTimer = setTimeout(sendResize, 60); }

      function ensure() {
        if (pane) return;
        pane = document.createElement("div");
        pane.className = "terminal-pane zshell-float";
        pane.style.cssText = "top:auto;left:auto;right:24px;bottom:24px;";
        var head = document.createElement("div");
        head.className = "term-toolbar";
        head.innerHTML = '<span class="term-toolbar-title">shell</span>' +
          '<div class="term-toolbar-actions">' +
          '<button class="term-btn" data-a="hide" title="Hide">—</button>' +
          '<button class="term-btn term-btn-close" data-a="close" title="Close">✕</button></div>';
        body = document.createElement("div");
        body.className = "term-body";
        pane.append(head, body);
        document.body.appendChild(pane);
        head.addEventListener("click", function (e) {
          var a = e.target && e.target.getAttribute && e.target.getAttribute("data-a");
          if (a === "hide") { pane.classList.remove("active"); }
          else if (a === "close") {
            try { T.core.invoke("shell_term_kill"); } catch (x) {}
            spawned = false; lastRows = 0; lastCols = 0;
            pane.classList.remove("active");
          }
        });
      }

      // The xterm is created only once the pane is visible: .terminal-pane is display:none until
      // .active, and xterm measures its cell box at open() time — opening it inside a hidden pane
      // leaves the renderer with no dimensions, so the first fit would be a guess.
      function attach() {
        if (term) return;
        term = new window.Terminal({ fontFamily: "'Hack Nerd Font', Menlo, monospace", fontSize: 13, cursorBlink: true, theme: { background: "rgba(0,0,0,0)" } });
        term.open(body);
        term.onData(function (d) { try { T.core.invoke("shell_term_write", { data: d }); } catch (x) {} });
        if (!listening) { listening = true; T.event.listen("shell-term-output", function (ev) { if (term) term.write(ev.payload); }); }
        // Covers every way the pane can change size: the window resize the max-width/max-height
        // clamp passes through, a show (0 → laid out), and a future drag-resize handle.
        if (typeof ResizeObserver === "function") new ResizeObserver(scheduleResize).observe(body);
        window.addEventListener("resize", scheduleResize);
      }

      window.toggleTerminalPopup = function () {
        ensure();
        if (pane.classList.contains("active")) { pane.classList.remove("active"); return; }
        pane.classList.add("active");
        attach();
        var needSpawn = !spawned;
        if (needSpawn) spawned = true;
        // One frame after .active so the pane has a laid-out box to measure: the first PTY gets the
        // geometry it will actually be drawn at, instead of xterm's 80x24 default.
        requestAnimationFrame(function () {
          var d = fit();
          if (needSpawn) {
            lastRows = d.rows; lastCols = d.cols;
            T.core.invoke("shell_term_spawn", { rows: d.rows, cols: d.cols }).catch(function () {});
          } else {
            sendResize();
          }
        });
        // Focus after the pane has settled, as before — xterm's textarea is not reliably focusable
        // in the same frame it was laid out in.
        setTimeout(function () { try { term.focus(); } catch (x) {} }, 40);
      };

      // Both terminals are .terminal-pane (z-index 9998, fixed) and so render ABOVE the full-screen
      // hooks/file-browser overlays (z-index 9000). Keep them off the overlays:
      //   • the floating shell (.zshell-float) — drop its .active when an overlay opens (manual re-show).
      //   • the always-on IDE (#terminalPane) — hide via .ze-overlay-hidden while ANY overlay is open,
      //     then restore when both close (it's the editor, so it must come back). visibility:hidden keeps
      //     layout so xterm needs no reflow on restore.
      function overlayOpen() {
        return ["hooksOverlay", "fbOverlay"].some(function (id) { var o = document.getElementById(id); return o && !o.hidden; });
      }
      function syncOverlays() {
        var open = overlayOpen();
        if (open && pane && pane.classList.contains("active")) pane.classList.remove("active");
        var ide = document.getElementById("terminalPane");
        if (ide) ide.classList.toggle("ze-overlay-hidden", open);
      }
      if (typeof MutationObserver === "function") {
        ["hooksOverlay", "fbOverlay"].forEach(function (id) {
          var ov = document.getElementById(id);
          if (!ov) return;
          new MutationObserver(syncOverlays).observe(ov, { attributes: true, attributeFilter: ["hidden"] });
        });
      }
    })();

    // i18n: the UI above was built synchronously (English fallbacks) to preserve the #terminalPane
    // creation timing; the locale catalog loads async, so re-translate the menu/toolbar/palette/shell
    // strings in place once it's ready.
    if (typeof window.loadLocale === "function") {
      var loc = (typeof window.savedLocale === "function" && window.savedLocale()) ||
                (typeof window.detectLocale === "function" && window.detectLocale()) || "en";
      window.loadLocale(loc).then(function () { retranslate(shell); }, function () {});
    }
  }

  function retranslate(shell) {
    if (window.ZmaxMenu && typeof window.ZmaxMenu.retranslate === "function") window.ZmaxMenu.retranslate();
    if (shell && shell.filterInput) shell.filterInput.placeholder = T("zmax.shell.filter", "Filter…");
    var sub = document.querySelector(".zg-shell-sub");
    if (sub) sub.textContent = T("zmax.shell.subtitle", "editor");
  }

  function tauri() { return window.__TAURI__ && window.__TAURI__.core; }
  function startEditor() {
    var T = tauri();
    if (!T) return; // in-browser preview: no PTY backend
    // give the login shell a moment to come up, then replace it with the BUNDLED editor (sidecar path,
    // with the sidecar dir prepended to PATH so the bundled stryke is reachable too) — never a bare
    // `zmax` off the user's PATH, so the shipped .app is self-contained.
    // `--ide` so the GUI boots straight into the workbench (toolbar + tool windows visible),
    // since the windowed app IS the IDE. (F2 still toggles it.)
    setTimeout(function () {
      T.invoke("zmax_exec_command").then(function (cmd) {
        T.invoke("terminal_write", { data: "exec " + (cmd || "zmax") + " --ide\n" }).catch(function () {});
      }).catch(function () {
        T.invoke("terminal_write", { data: "exec zmax --ide\n" }).catch(function () {});
      });
      // once the editor is up, sync its theme to the saved zgui-core colorscheme (unified palette)
      setTimeout(function () { if (typeof window.zmaxSyncTheme === "function") window.zmaxSyncTheme(); }, 2500);
    }, 800);
  }

  // Run immediately (scripts are at body end, so #app + the terminal globals already exist) — this
  // creates #terminalPane before terminal.js's DOMContentLoaded wire, so it adopts ours. i18n is
  // applied afterward (see boot) without disturbing this timing.
  boot();
})();
