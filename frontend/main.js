// zemacs-gui shell — mounts the ZGui.appShell baseline and runs the zemacs editor (Helix fork) in a
// fullscreen embedded terminal (shared zpwr-embed-terminal frontend). The PTY spawns the login shell;
// we then `exec zemacs` so the editor replaces it and fills the window. See GUI_APP_ARCHITECTURE.md.
(function () {
  "use strict";
  function boot() {
    if (!window.ZGui || typeof ZGui.appShell !== "function") return;
    var shell = ZGui.appShell(document.getElementById("app"), {
      brand: { glyph: "✎", title: "ZEMACS", subtitle: "editor" },
      filterPlaceholder: "Filter…",
      palette: [
        { label: "Restart editor", run: restart },
        { label: "Focus editor", run: function () { var c = document.getElementById("terminalContainer"); if (c) { var ta = c.querySelector("textarea"); if (ta) ta.focus(); } } },
      ],
    });

    // A fullscreen terminal pane inside shell.body — provided so zpwr-embed-terminal uses it instead
    // of injecting its floating dock pane (its _ensureTerminalDom is a no-op when #terminalPane exists).
    var pane = document.createElement("div");
    pane.id = "terminalPane";
    pane.className = "terminal-pane zemacs-fill active";
    var container = document.createElement("div");
    container.id = "terminalContainer";
    container.className = "term-body";
    pane.appendChild(container);
    shell.body.appendChild(pane);

    // MacVim-style menu bar + Cmd-shortcuts + dialogs + drag-drop (all zgui widgets), bridged to the PTY
    if (window.ZemacsMenu && typeof window.ZemacsMenu.mount === "function") window.ZemacsMenu.mount(shell);

    // show + spawn the PTY, then exec the editor over the shell once it's up
    if (typeof window.showTerminal === "function") window.showTerminal();
    startEditor();
  }

  function tauri() { return window.__TAURI__ && window.__TAURI__.core; }
  function startEditor() {
    var T = tauri();
    if (!T) return; // in-browser preview: no PTY backend
    // give the login shell a moment to come up, then replace it with the BUNDLED editor (sidecar path,
    // with the sidecar dir prepended to PATH so the bundled stryke is reachable too) — never a bare
    // `zemacs` off the user's PATH, so the shipped .app is self-contained.
    setTimeout(function () {
      T.invoke("zemacs_exec_command").then(function (cmd) {
        T.invoke("terminal_write", { data: "exec " + (cmd || "zemacs") + "\n" }).catch(function () {});
      }).catch(function () {
        T.invoke("terminal_write", { data: "exec zemacs\n" }).catch(function () {});
      });
    }, 800);
  }
  function restart() {
    var T = tauri();
    if (!T) return;
    T.invoke("terminal_kill").then(function () {
      if (typeof window.showTerminal === "function") window.showTerminal();
      startEditor();
    }).catch(function () {});
  }

  // Run immediately (scripts are at body end, so #app + the terminal globals already exist) — this
  // creates #terminalPane before terminal.js's DOMContentLoaded wire, so it adopts ours.
  boot();
})();
