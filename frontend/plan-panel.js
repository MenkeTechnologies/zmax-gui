// plan-panel.js — the Batch Plan: paint a grid of operations × files, then run the whole painting
// as ONE automation-bus transaction that compensates every applied step if any step fails.
//
// This is the R9 arrangement-grid embed (`GUI_APP_REQUIREMENTS.md`) and the user-facing half of the
// reversible verb surface in `verbs.js`. It reuses the SHARED zpwr-clip-engine grid — `createGrid`
// plus the renderer/model/interaction layer the DAW uses — driven by zmax-gui's own domain in
// `plan-domain.js`. The grid engine is never forked: this file supplies the host wiring (file list,
// operation lanes, persistence, and the runner) and nothing else.
//
// Why a grid rather than a form: a batch refactor is two-dimensional (which files × which
// operations) and a form makes the user express that as N separate runs, which is exactly the shape
// that cannot be undone as a unit. Painted, it is one plan, one transaction, one undo.
(function () {
  "use strict";

  var GRID_BASE = "./lib/zpwr-clip-engine/webui/grid/";
  var DOMAIN_MODULE = "./plan-domain.js";
  var PLAN_KEY = "zmax.plan.cells";

  function Z() { return window.ZGui || {}; }
  function core() { return window.__TAURI__ && window.__TAURI__.core; }
  function invoke(cmd, args) {
    var T = core();
    return T ? T.invoke(cmd, args || {}) : Promise.reject(new Error("the batch plan needs the desktop app"));
  }
  function T(key, english) {
    var s = (typeof window.t === "function") ? window.t(key) : null;
    return (s && s !== key) ? s : english;
  }
  function toast(msg, kind) { if (Z().toast) Z().toast.show(msg, 3200, kind || ""); }

  // Disk-backed when the host installed prefs, localStorage otherwise. Both satisfy the grid
  // model's { getItem, setItem } store contract.
  function store() {
    return (window.prefs && typeof window.prefs.getItem === "function") ? window.prefs : window.localStorage;
  }

  // The operation lanes, in apply order within one file. Every id is a `rev: "inverse"` verb from
  // verbs.js — that is the whole reason a painted plan can be run transactionally, so a lane whose
  // verb is not reversible must never be added here.
  function operations() {
    return [
      {
        id: "cleanup", verb: "zmax.cleanup.apply",
        label: T("zmax.plan.op_cleanup", "Clean up (trim + final newline)"),
        args: { opts: { trim_trailing: true, final_newline: true } },
      },
      {
        id: "sort", verb: "zmax.sort.apply",
        label: T("zmax.plan.op_sort", "Sort lines"),
        args: { opts: {} },
      },
      {
        id: "sortUnique", verb: "zmax.sort.apply",
        label: T("zmax.plan.op_sort_unique", "Sort lines (unique)"),
        args: { opts: { unique: true } },
      },
      {
        id: "alignEq", verb: "zmax.align.apply",
        label: T("zmax.plan.op_align_eq", "Align on ="),
        args: { opts: { separator: "=" } },
      },
      {
        id: "utf8", verb: "zmax.encoding.apply",
        label: T("zmax.plan.op_utf8", "Transcode → UTF-8"),
        args: { to: "utf-8" },
      },
    ];
  }

  var files = [];        // [{ path, rel }] — the plan's run order, refreshed on each open
  var root = null;       // the project root, and the witness root a run is opened against
  var grid = null;
  var dom = null;        // the loaded plan-domain module
  var statusEl = null;

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = "zp-plan-status" + (kind ? " zp-plan-" + kind : "");
  }

  /**
   * Run the painted plan. One `txnBegin`, every step through `ZGui.automation.call` (so each one is
   * journaled with its own compensation), and on the FIRST failure a `txnAbort` that restores every
   * file already rewritten — in reverse order. A run that reaches the end commits, which only drops
   * the journal; the files keep their new content.
   *
   * That journal lives in `automation.js`, in the webview's memory, and so does not survive the app.
   * A batch refactor is exactly the operation you do not want interrupted: it can be the only thing
   * standing between a hundred rewritten files and the tree they came from. So the run ALSO writes
   * itself to disk — `txn_open` before the first step, `txn_append` after each step lands, a
   * `txn_close` at either end — through `txn.rs`'s sync-then-rename journal.
   *
   * The two journals record the same steps for different lifetimes. The in-memory one unwinds a
   * failure while the app is alive; the on-disk one is what makes an interrupted run recoverable
   * after it is not (`recover()` below, and the boot check in main.js). The disk write happens
   * AFTER the step, not before, because a step that has not run has nothing to compensate and a
   * record of it would make recovery restore a file the run never touched.
   *
   * A host with no `txn_*` backend (the in-browser preview) degrades to the in-memory journal alone
   * rather than refusing to run.
   *
   * The open also hands the backend the project root as the run's WITNESS root. Everything above is
   * the run's own paperwork, and a run's paperwork can only ever describe the run: the tree it is
   * rewriting is shared with the user's editor, with save hooks, and — in this user's setup — with
   * fifteen other instances of this app. The witness is what lets the finished run say which files
   * moved that none of its steps recorded, instead of reporting a clean rollback across a tree it
   * only half covers. A run whose root cannot be resolved still runs; it is then unwitnessed, and
   * its coverage says so rather than claiming an empty reach.
   */
  function run(steps, root) {
    var A = Z().automation;
    if (!A || typeof A.txnBegin !== "function") {
      return Promise.reject(new Error("the automation bus is not loaded"));
    }
    if (A.txnActive() != null) {
      return Promise.reject(new Error("another transaction is already open"));
    }
    var label = T("zmax.plan.title", "Batch Plan") + ": " + steps.length + " " +
                T("zmax.plan.steps_word", "steps");
    var txn = A.txnBegin();
    var done = 0;
    var jid = null;
    var chain = invoke("txn_open", { label: label, roots: root ? [root] : null })
      .then(function (id) { jid = id; }, function () { jid = null; });
    steps.forEach(function (s) {
      chain = chain.then(function () {
        setStatus(T("zmax.plan.running", "Running") + " " + (done + 1) + "/" + steps.length + ": " + s.label, "busy");
        return A.call(s.verb, s.args).then(function (res) {
          done++;
          // The verb's own snapshot token, already sealed by verbs.js. A step that wrote nothing
          // carries no token and is not journalled: there is nothing for a recovery to put back.
          var token = res && res.txn;
          if (!jid || !token) return null;
          return invoke("txn_append", { id: jid, verb: s.verb, token: token }).catch(function () {});
        });
      });
    });
    /** Close the disk journal, and never let that failure mask the run's own outcome. */
    function close(outcome) {
      if (!jid) return Promise.resolve();
      return invoke("txn_close", { id: jid, outcome: outcome }).catch(function () {});
    }
    /**
     * The receipt, read back AFTER the close — which is where the backend computes it, while the
     * pre-image blobs it hashes against still exist. Never fatal: a run whose receipt could not be
     * read reports `coverage: null`, which the caller must read as "unknown", never as "clean".
     */
    function receipt() {
      if (!jid) return Promise.resolve(null);
      return invoke("txn_coverage", { id: jid }).catch(function () { return null; });
    }
    // `txnAbort` counts a step as compensated whenever its `undo()` resolved, and a sealed restore
    // that DECLINED a file resolves — correctly, since declining is the right outcome. So the count
    // alone would report a clean rollback over files it deliberately left alone. verbs.js emits the
    // per-step conflict count with each compensation; tally it here for the duration of this run so
    // the status line can say so. The shared counter is not extended for this: `conflicted` is this
    // app's notion, and automation.js is fleet-wide.
    var conflicted = 0;
    var off = (typeof A.on === "function")
      ? A.on("zmax.txn.compensated", function (p) { conflicted += (p && p.conflicted) || 0; })
      : function () {};
    // `uncovered` is the count of paths the tree says moved inside this run's window that no step
    // recorded — the reach this run's undo does not have. `null` rather than 0 when the run had no
    // witness or the receipt could not be read, because "nobody looked" and "nothing else moved"
    // are the two answers a status line must never print with the same words.
    function finish(out) {
      off();
      out.conflicted = conflicted;
      var cov = out.coverage;
      out.uncovered = (cov && cov.witnessed) ? (cov.undeclared || []).length : null;
      return out;
    }
    return chain.then(
      function () {
        return A.txnCommit(txn)
          .then(function () { return close("committed"); })
          .then(receipt)
          .then(function (cov) { return finish({ ok: true, done: done, txnId: jid, coverage: cov }); });
      },
      function (err) {
        // The failing step never landed (automation.js journals only AFTER a successful run), so the
        // abort unwinds exactly the steps that did.
        return A.txnAbort(txn).then(function (report) {
          return close("unwound").then(receipt).then(function (cov) {
            return finish({
              ok: false, done: done, error: String((err && err.message) || err),
              report: report, txnId: jid, coverage: cov,
            });
          });
        });
      }
    );
  }

  /**
   * Transactions with no recorded outcome — a run this app died inside. Answers `[]` on any host
   * that cannot tell (no backend), because the recovery prompt must never appear on a guess.
   */
  function pending() {
    return invoke("txn_pending").then(function (list) {
      return Array.isArray(list) ? list : [];
    }, function () { return []; });
  }

  /**
   * Compensate one interrupted transaction, newest step first. Every restore is the sealed,
   * conflict-refusing one, so a file the user changed after the crash is left alone and its
   * pre-image parked beside it rather than overwritten — reported back as `conflicted`.
   */
  function recover(id) {
    return invoke("txn_unwind", { id: id });
  }

  /**
   * What one transaction can and cannot account for. On a run that has NOT been unwound yet this is
   * the honest half of the recovery prompt: how much of the tree moved inside that run's window
   * that unwinding will not reach. Answers `null` on any host that cannot tell, which the caller
   * must render as silence rather than as a zero.
   */
  function coverage(id) {
    return invoke("txn_coverage", { id: id }).catch(function () { return null; });
  }

  function refreshFiles(root) {
    return invoke("find_files", { root: root, query: "", limit: 200 }).then(function (hits) {
      files = (hits || []).map(function (h) { return { path: h.path, rel: h.rel || h.path }; });
      return files;
    });
  }

  function projectRoot() {
    return invoke("list_dir", { path: null }).then(function (l) { return l && l.dir; });
  }

  function open() {
    if (!Z().modal) return;
    var body = document.createElement("div");
    body.className = "zp-plan";

    var help = document.createElement("div");
    help.className = "zp-plan-help";
    help.textContent = T(
      "zmax.plan.help",
      "Paint a cell to apply that row's operation to that column's file. Run executes the whole " +
      "painting as one transaction: if any step fails, every file already rewritten is restored."
    );
    body.appendChild(help);

    var wrap = document.createElement("div");
    wrap.className = "zp-plan-canvas-wrap";
    var canvas = document.createElement("canvas");
    canvas.className = "zp-plan-canvas";
    wrap.appendChild(canvas);
    body.appendChild(wrap);

    statusEl = document.createElement("div");
    statusEl.className = "zp-plan-status";
    body.appendChild(statusEl);

    var dlg = Z().modal.open({
      title: T("zmax.plan.title", "Batch Plan"),
      body: body,
      className: "zp-modal zp-plan-modal",
      actions: [
        {
          label: T("zmax.plan.run", "Run as one transaction"), close: false, onClick: function () {
            if (!grid || !dom) return;
            var plan = grid.serialize();
            var stale = dom.staleCells(plan, files);
            var steps = dom.planSteps(plan, operations(), files);
            if (!steps.length) { setStatus(T("zmax.plan.empty", "Nothing painted."), "warn"); return; }
            run(steps, root).then(function (res) {
              // What the run changed that it could NOT have taken back. Said on a SUCCESS too, and
              // that is the point: a clean "Applied 12/12" over a tree where three other files also
              // moved is the report a transaction cannot honestly make about a shared checkout.
              var reach = res.uncovered
                ? " · " + res.uncovered + " " +
                  T("zmax.plan.uncovered", "other files changed while this ran (outside this undo)")
                : "";
              if (res.ok) {
                setStatus(T("zmax.plan.done", "Applied") + " " + res.done + "/" + steps.length + reach,
                          res.uncovered ? "warn" : "ok");
                toast(T("zmax.plan.done", "Applied") + " " + res.done + "/" + steps.length + reach);
              } else {
                var comp = (res.report && res.report.compensated) || 0;
                var failed = (res.report && res.report.failed) || [];
                setStatus(
                  T("zmax.plan.failed", "Failed") + ": " + res.error + " — " +
                  T("zmax.plan.rolled_back", "rolled back") + " " + comp +
                  (failed.length ? " (" + failed.length + " " + T("zmax.plan.uncompensated", "uncompensated") + ")" : "") +
                  // Not a failure: files something else changed after their step ran, which the
                  // rollback declined to overwrite. Said out loud, because a silent "rolled back 12"
                  // over a tree where two files were left as they are is the report lying.
                  (res.conflicted ? " (" + res.conflicted + " " +
                    T("zmax.plan.recover_conflicted", "left alone (changed since)") + ")" : "") +
                  reach,
                  "err"
                );
                toast(T("zmax.plan.failed", "Failed") + ": " + res.error, "error");
              }
            }, function (err) {
              setStatus(String((err && err.message) || err), "err");
            });
            if (stale) {
              setStatus(stale + " " + T("zmax.plan.stale", "painted cells no longer address a file and were skipped"), "warn");
            }
          },
        },
        {
          label: T("zmax.plan.clear", "Clear"), close: false, onClick: function () {
            if (!grid) return;
            grid.model.clear();
            grid.model.save();
            grid.render();
            setStatus("");
          },
        },
        { label: T("zmax.dialog.close", "Close"), close: true },
      ],
    });

    setStatus(T("zmax.plan.loading", "Loading the project's files…"));
    projectRoot()
      .then(function (dir) { root = dir || null; return refreshFiles(dir); })
      .then(function () {
        return Promise.all([import(GRID_BASE + "index.js"), import(DOMAIN_MODULE)]);
      })
      .then(function (mods) {
        var createGrid = mods[0].createGrid;
        dom = mods[1];
        var axis = dom.fileAxis({ getFiles: function () { return files; } });
        grid = createGrid({
          canvas: canvas,
          domain: dom.createPlanDomain({ axis: axis, getOps: operations }),
          store: store(),
          storageKey: PLAN_KEY,
          onChange: function (model) {
            var steps = dom.planSteps(model.serialize(), operations(), files);
            setStatus(steps.length + " " + T("zmax.plan.steps", "steps painted"));
          },
        });
        var steps = dom.planSteps(grid.serialize(), operations(), files);
        setStatus(files.length + " " + T("zmax.plan.files", "files") + " · " + steps.length + " " +
                  T("zmax.plan.steps", "steps painted"));
      })
      .catch(function (e) {
        setStatus(String((e && e.message) || e), "err");
      });

    return dlg;
  }

  /**
   * The recovery prompt: one row per interrupted transaction, with what it was and how many steps
   * had landed, and a single button that unwinds it. Opened from the boot check in main.js when
   * `pending()` is non-empty, and from the ⌘K palette otherwise.
   *
   * Deliberately NOT automatic. An interrupted batch refactor is not necessarily unwanted — the app
   * may have been quit on purpose after the steps that mattered — so the app reports what it found
   * and the user decides. Unwinding is the one action here that rewrites files, and the fleet's rule
   * is that a destructive default is not a default.
   */
  function openRecovery() {
    if (!Z().modal) return null;
    var body = document.createElement("div");
    body.className = "zp-plan";

    var help = document.createElement("div");
    help.className = "zp-plan-help";
    // One string literal, not a concatenation: scripts/i18n-extract-seed.mjs seeds the FIRST
    // literal of a `T(key, default)` call, so a default split across lines ships to the English
    // seed truncated mid-sentence (`zmax.plan.help` above is the pre-existing example).
    help.textContent = T("zmax.plan.recover_help", "These runs were journalled to disk but never finished — the app stopped in the middle of them. Unwinding restores every step that landed, newest first. A file that changed after its step ran is left alone, and its previous content is saved beside it as .zmax-undo-…");
    body.appendChild(help);

    var list = document.createElement("div");
    list.className = "zp-plan-recover-list";
    body.appendChild(list);

    var status = document.createElement("div");
    status.className = "zp-plan-status";
    body.appendChild(status);

    function render() {
      list.textContent = "";
      return pending().then(function (rows) {
        if (!rows.length) {
          status.textContent = T("zmax.plan.recover_none", "No interrupted runs.");
          return rows;
        }
        rows.forEach(function (j) {
          var row = document.createElement("div");
          row.className = "zp-plan-recover-row";
          var text = document.createElement("span");
          text.className = "zp-plan-recover-label";
          text.textContent = (j.label || j.id) + " · " + ((j.steps || []).length) + " " +
                             T("zmax.plan.steps_word", "steps");
          // The reach, appended when the backend answers. Asked BEFORE the unwind on purpose: the
          // decision the user is being handed is "put this back", and how much of the crash's
          // damage this will not touch belongs in front of them while it is still a choice.
          coverage(j.id).then(function (cov) {
            if (!cov || !cov.witnessed || !(cov.undeclared || []).length) return;
            text.textContent += " · " + cov.undeclared.length + " " +
              T("zmax.plan.uncovered", "other files changed while this ran (outside this undo)");
          });
          var btn = document.createElement("button");
          btn.className = "zg-btn";
          btn.textContent = T("zmax.plan.recover_unwind", "Unwind");
          btn.addEventListener("click", function () {
            btn.disabled = true;
            status.textContent = T("zmax.plan.recover_running", "Unwinding…");
            recover(j.id).then(function (r) {
              var msg = T("zmax.plan.recover_done", "Restored") + " " + (r.restored || 0);
              if (r.conflicted) {
                msg += " · " + r.conflicted + " " +
                       T("zmax.plan.recover_conflicted", "left alone (changed since)");
              }
              if (r.failed) msg += " · " + r.failed + " " + T("zmax.plan.recover_failed", "unrecoverable");
              // The proof, not the count: `divergent` is every declared path whose bytes are still
              // not what the run found, hashed after the restore ran. Empty means the tree is back.
              var cov = r.coverage || null;
              var off = cov ? (cov.divergent || []).length : 0;
              if (off) {
                msg += " · " + off + " " +
                       T("zmax.plan.recover_divergent", "not back at their previous content");
              }
              status.textContent = msg;
              toast(msg, r.conflicted || r.failed || off ? "warn" : "");
              render();
            }, function (e) {
              btn.disabled = false;
              status.textContent = String((e && e.message) || e);
            });
          });
          row.append(text, btn);
          list.appendChild(row);
        });
        return rows;
      });
    }

    var dlg = Z().modal.open({
      title: T("zmax.plan.recover_title", "Interrupted runs"),
      body: body,
      className: "zp-modal zp-plan-modal",
      actions: [{ label: T("zmax.dialog.close", "Close"), close: true }],
    });
    render();
    return dlg;
  }

  window.ZmaxPlan = {
    open: open,
    operations: operations,
    run: run,
    pending: pending,
    recover: recover,
    coverage: coverage,
    openRecovery: openRecovery,
  };
})();
