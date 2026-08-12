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
   */
  function run(steps) {
    var A = Z().automation;
    if (!A || typeof A.txnBegin !== "function") {
      return Promise.reject(new Error("the automation bus is not loaded"));
    }
    if (A.txnActive() != null) {
      return Promise.reject(new Error("another transaction is already open"));
    }
    var txn = A.txnBegin();
    var done = 0;
    var chain = Promise.resolve();
    steps.forEach(function (s) {
      chain = chain.then(function () {
        setStatus(T("zmax.plan.running", "Running") + " " + (done + 1) + "/" + steps.length + ": " + s.label, "busy");
        return A.call(s.verb, s.args).then(function () { done++; });
      });
    });
    return chain.then(
      function () { return A.txnCommit(txn).then(function () { return { ok: true, done: done }; }); },
      function (err) {
        // The failing step never landed (automation.js journals only AFTER a successful run), so the
        // abort unwinds exactly the steps that did.
        return A.txnAbort(txn).then(function (report) {
          return { ok: false, done: done, error: String((err && err.message) || err), report: report };
        });
      }
    );
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
            run(steps).then(function (res) {
              if (res.ok) {
                setStatus(T("zmax.plan.done", "Applied") + " " + res.done + "/" + steps.length, "ok");
                toast(T("zmax.plan.done", "Applied") + " " + res.done + "/" + steps.length);
              } else {
                var comp = (res.report && res.report.compensated) || 0;
                var failed = (res.report && res.report.failed) || [];
                setStatus(
                  T("zmax.plan.failed", "Failed") + ": " + res.error + " — " +
                  T("zmax.plan.rolled_back", "rolled back") + " " + comp +
                  (failed.length ? " (" + failed.length + " " + T("zmax.plan.uncompensated", "uncompensated") + ")" : ""),
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
      .then(refreshFiles)
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

  window.ZmaxPlan = { open: open, operations: operations, run: run };
})();
