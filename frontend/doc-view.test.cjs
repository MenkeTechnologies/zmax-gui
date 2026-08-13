// The in-app DOCUMENT PANE (G2), headless: doc-view.js over stubbed mountZpdf / mountZoffice, plus
// the panels.js hit-activation path that reaches it.
//
// What is worth testing here is not "does it render" — the two views are tested in their own repos
// — but the four host-side decisions that are invisible until they are wrong:
//
//   * the ENGINE CHOICE per extension, and the null answer that keeps the OS-opener fallback alive;
//   * the two shared-pane invariants: never hand a pane `automationApp` (one flat automation
//     registry, last `register({app})` wins, so a pane that names itself renames this app) and
//     never reach `zpdfSetShell`, the only thing that runs zpdf's unconditional `app: "zpdf"`;
//   * the EMBED GUARD: the mount body has to run inside `ZGui.embed.view()`, which is what makes a
//     view that grabs a document-global singleton throw instead of fighting the editor's chrome;
//   * the LOCATOR being spent — the whole reason an in-app pane beats handing the file to Preview.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DOC_VIEW = path.join(__dirname, "doc-view.js");
const PANELS = path.join(__dirname, "panels.js");
const VERBS = path.join(__dirname, "verbs.js");
const INDEX = path.join(__dirname, "index.html");
const COPY_SCRIPT = path.join(__dirname, "..", "scripts", "copy-doc-views.mjs");

const tick = () => new Promise((r) => setImmediate(r));

function el(tag) {
  const classes = new Set();
  const node = {
    tag: tag || "div", id: "", style: {}, innerHTML: "", textContent: "", value: "",
    children: [], listeners: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    appendChild(c) { node.children.push(c); return c; },
    append(...cs) { cs.forEach((c) => node.children.push(c)); },
    insertBefore(c) { node.children.unshift(c); return c; },
    removeChild(c) { node.children = node.children.filter((x) => x !== c); return c; },
    addEventListener(t, fn) { (node.listeners[t] = node.listeners[t] || []).push(fn); },
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null, focus() {}, scrollIntoView() {},
  };
  Object.defineProperty(node, "className", {
    get: () => [...classes].join(" "),
    set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  return node;
}

/// A recording stand-in for one engine's mountable view. `calls` records every mount so a test can
/// assert on the OPTIONS the host passed, which is where the `automationApp` invariant lives.
function fakeView(name, calls, opts) {
  const o = opts || {};
  return function mount(root, mountOpts) {
    const rec = { name, root, opts: mountOpts || {}, nav: [] };
    calls.push(rec);
    if (o.throws) throw new Error(o.throws);
    const api = {
      openPath: (p) => { rec.opened = p; return o.rejectOpen ? Promise.reject(new Error(o.rejectOpen)) : Promise.resolve(); },
      open: (p) => { rec.opened = p; return o.rejectOpen ? Promise.reject(new Error(o.rejectOpen)) : Promise.resolve(); },
      goToPage: (n) => rec.nav.push(["goToPage", n]),
      showView: (v) => rec.nav.push(["showView", v]),
      find: (q) => { rec.nav.push(["find", q]); return Promise.resolve([]); },
      state: () => ({ path: rec.opened || null }),
      destroy: () => { rec.destroyed = true; },
    };
    rec.api = api;
    return api;
  };
}

/// Boot `files` against a stubbed browser. `guardDepth` counts how deep inside `ZGui.embed.view`
/// the code is at any moment, so a mount that ran outside the guard is observable.
function host(files, opts) {
  opts = opts || {};
  const mounts = [];
  const invokes = [];
  const toasts = [];
  const registered = [];
  const modals = [];
  let guardDepth = 0;
  let mountedInsideGuard = null;

  const doc = {
    body: el("body"), documentElement: el(), head: el(),
    createElement: (t) => el(t),
    getElementById: () => null,
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  };

  const win = {
    ZGui: {
      modal: {
        open(o) {
          const m = { body: o.body, opts: o, closed: false, close() { m.closed = true; } };
          modals.push(m);
          return m;
        },
      },
      toast: { show: (msg, ms, type) => toasts.push({ msg: String(msg), type }) },
      embed: {
        view(fn) {
          guardDepth += 1;
          let out;
          try { out = fn(); } finally {
            if (out && typeof out.then === "function") return out.finally(() => { guardDepth -= 1; });
            guardDepth -= 1;
          }
          return out;
        },
      },
      automation: { register: (spec) => registered.push(spec) },
    },
    mountZpdf: fakeView("zpdf", mounts, opts.pdf),
    mountZoffice: fakeView("zoffice", mounts, opts.office),
    zpdfPluginTransport: () => ({ kind: "tauri-zpdf_invoke" }),
    // Deliberately present so a test can prove the host never calls it: reaching zpdfSetShell is
    // the ONLY path to zpdf's unconditional `A.register({ app: "zpdf" })`.
    zpdfSetShell: () => { throw new Error("the host must never call zpdfSetShell"); },
    t: (k, english) => english || k,
    addEventListener() {},
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    __TAURI__: {
      core: { invoke(cmd, args) { invokes.push({ cmd, args: args || {} }); return Promise.resolve(null); } },
      event: { listen: () => Promise.resolve(() => {}) },
      opener: { openPath(p) { invokes.push({ cmd: "__opener", args: { path: p } }); return Promise.resolve(); } },
    },
  };
  // Record the guard depth at the moment each view mounts.
  for (const key of ["mountZpdf", "mountZoffice"]) {
    const inner = win[key];
    win[key] = function (root, o) { mountedInsideGuard = guardDepth; return inner(root, o); };
  }

  const ctx = {
    window: win, ZGui: win.ZGui, document: doc, navigator: win.navigator, console,
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(f, "utf8"), ctx);

  return {
    win, doc, mounts, invokes, toasts, registered, modals,
    guardDepthAtMount: () => mountedInsideGuard,
    opened: () => invokes.filter((i) => i.cmd === "__opener").map((i) => i.args.path),
  };
}

// ── engine selection ────────────────────────────────────────────────────────────────────────────

test("document pane: each extension routes to the engine that can actually read it", () => {
  const env = host([DOC_VIEW]);
  const k = env.win.ZmaxDocView.kindOf;
  assert.equal(k("/p/report.pdf"), "pdf");
  assert.equal(k("/p/REPORT.PDF"), "pdf", "the extension match must not be case-sensitive");
  for (const ext of ["docx", "odt", "xlsx", "ods", "pptx", "odp"]) {
    assert.equal(k("/p/book." + ext), "office", ext + " is the office engine's");
  }
  // The null answer is load-bearing: it is what keeps the OS-opener fallback reachable.
  for (const p of ["/p/notes.txt", "/p/book.epub", "/p/Keynote.key", "/p/no-extension"]) {
    assert.equal(k(p), null, p + " belongs to neither engine");
  }
});

test("document pane: a format neither engine owns is refused, not mounted empty", async () => {
  const env = host([DOC_VIEW]);
  await assert.rejects(() => env.win.ZmaxDocView.open("/p/book.epub"), /no document pane/);
  assert.equal(env.mounts.length, 0, "nothing may mount for a format the engines cannot read");
});

// ── the two shared-pane invariants ──────────────────────────────────────────────────────────────

test("document pane: a mounted pane is never handed automationApp, and zpdfSetShell is never called", async () => {
  const env = host([DOC_VIEW]);
  await env.win.ZmaxDocView.open("/p/sheet.xlsx");
  await env.win.ZmaxDocView.open("/p/report.pdf");

  assert.equal(env.mounts.length, 2);
  for (const m of env.mounts) {
    assert.ok(!("automationApp" in m.opts),
      m.name + " was handed automationApp — ZGui.automation keeps ONE app name and the last " +
      "register({app}) wins, so the pane would rename zmax-gui on the bus");
  }
  // The stub throws if reached; getting here at all is the proof.
  assert.ok(typeof env.win.zpdfSetShell === "function", "the stub must still be installed");
});

test("document pane: the mount body runs inside ZGui.embed.view", async () => {
  const env = host([DOC_VIEW]);
  await env.win.ZmaxDocView.open("/p/report.pdf");
  assert.equal(env.guardDepthAtMount(), 1,
    "mountZpdf ran outside ZGui.embed.view — a view that seizes a global would silently win");
});

test("document pane: the PDF view gets the bare-command transport, not the app's own", async () => {
  const env = host([DOC_VIEW]);
  await env.win.ZmaxDocView.open("/p/report.pdf");
  assert.equal(env.mounts[0].opts.transport.kind, "tauri-zpdf_invoke",
    "zpdf's default transport calls the standalone app's commands, which this host does not have");
});

// ── the locator, which is the point ─────────────────────────────────────────────────────────────

test("document pane: a PDF page hit lands on that page", async () => {
  const env = host([DOC_VIEW]);
  await env.win.ZmaxDocView.open("/p/report.pdf", { locator: { kind: "page", page: 7 } });
  assert.deepEqual(env.mounts[0].nav, [["goToPage", 7]]);
  assert.equal(env.mounts[0].opened, "/p/report.pdf");
});

test("document pane: a spreadsheet cell hit opens the Data view and searches for the hit text", async () => {
  const env = host([DOC_VIEW]);
  await env.win.ZmaxDocView.open("/p/book.xlsx", {
    locator: { kind: "cell", sheet: 0, sheet_name: "Sheet1", reference: "B7" },
    text: "42.00",
  });
  assert.deepEqual(env.mounts[0].nav, [["showView", "data"], ["find", "42.00"]],
    "a cell address only means something in the Data view");
});

test("document pane: a paragraph hit is searched for, and never asks for the Data view", async () => {
  const env = host([DOC_VIEW]);
  await env.win.ZmaxDocView.open("/p/spec.docx", { locator: { kind: "paragraph", index: 11 }, text: "throughput" });
  assert.deepEqual(env.mounts[0].nav, [["find", "throughput"]]);
});

test("document pane: one pane at a time — opening a second document tears the first down", async () => {
  const env = host([DOC_VIEW]);
  await env.win.ZmaxDocView.open("/p/a.docx");
  await env.win.ZmaxDocView.open("/p/b.docx");
  assert.equal(env.mounts[0].destroyed, true, "the first view must be destroyed, not orphaned");
  assert.equal(env.modals[0].closed, true, "and its modal closed");
  assert.equal(env.modals.length, 2);
  assert.equal(env.win.ZmaxDocView.state().path, "/p/b.docx");
});

test("document pane: a mount that throws leaves no half-open pane behind", async () => {
  const env = host([DOC_VIEW], { office: { throws: "engine unavailable" } });
  await assert.rejects(() => env.win.ZmaxDocView.open("/p/a.docx"), /engine unavailable/);
  assert.equal(env.modals[0].closed, true, "the modal opened for the failed mount must be closed");
  assert.deepEqual(env.win.ZmaxDocView.state(), { open: false, path: null, kind: null });
});

// ── the panels.js hit-activation path ───────────────────────────────────────────────────────────

/// Reach panels.js's document-hit activation the way the UI does: through the picker row that
/// `docRowsFrom` builds. `ZmaxPanels` is what panels.js exports.
function activate(env, hit) {
  const rows = env.win.ZmaxPanels.docRowsFrom([hit]);
  assert.equal(rows.length, 1);
  rows[0].onPick();
}

test("documents search: a hit the pane can read opens in-app, never in the OS handler", async () => {
  const env = host([DOC_VIEW, PANELS]);
  activate(env, { path: "/p/report.pdf", rel: "report.pdf", text: "revenue", locator: { kind: "page", page: 3 } });
  await tick();

  assert.equal(env.mounts.length, 1, "the pane must mount");
  assert.deepEqual(env.mounts[0].nav, [["goToPage", 3]]);
  assert.deepEqual(env.opened(), [], "nothing may be handed to the OS default application");
  assert.ok(env.invokes.some((i) => i.cmd === "recent_add" && i.args.path === "/p/report.pdf"),
    "an opened document still joins the recents list");
});

test("documents search: a format the engines cannot read still opens — in the OS handler", async () => {
  const env = host([DOC_VIEW, PANELS]);
  activate(env, { path: "/p/notes.epub", rel: "notes.epub", locator: null });
  await tick();

  assert.equal(env.mounts.length, 0);
  assert.deepEqual(env.opened(), ["/p/notes.epub"], "the row must never be inert");
});

test("documents search: a pane that fails to mount falls back rather than swallowing the row", async () => {
  const env = host([DOC_VIEW, PANELS], { pdf: { throws: "no pdf backend" } });
  activate(env, { path: "/p/report.pdf", rel: "report.pdf", locator: { kind: "page", page: 2 } });
  await tick();
  await tick();

  assert.deepEqual(env.opened(), ["/p/report.pdf"], "the OS handler is the fallback, not the default");
  assert.ok(env.toasts.some((t) => t.type === "error" && /no pdf backend/.test(t.msg)),
    "the user has to be told why it left the app: " + JSON.stringify(env.toasts));
});

// ── the automation surface ──────────────────────────────────────────────────────────────────────

test("automation: the pane's control verbs are published under the host's namespace, once", () => {
  const env = host([DOC_VIEW, PANELS, VERBS]);
  const specs = env.registered.filter((s) => s.app === "zmax-gui");
  assert.equal(specs.length, 1, "verbs.js is the single registration site for this app's surface");

  const ids = specs[0].verbs.map((v) => v.id).concat(specs[0].state.map((s) => s.id));
  for (const id of ["zmax.doc.open", "zmax.doc.close", "zmax.doc.state"]) {
    assert.ok(ids.includes(id), "missing " + id);
    // The panes publish `zoffice.view.*` into the SAME flat registry; a host id under that prefix
    // would replace the pane's verb, or be replaced by it, depending on mount order.
    assert.ok(!id.startsWith("zoffice.") && !id.startsWith("zp."),
      id + " collides with an embedded pane's namespace");
  }
  assert.equal(new Set(ids).size, ids.length, "no id may be published twice");
});

test("automation: zmax.doc.open drives the real pane and reports what it opened", async () => {
  const env = host([DOC_VIEW, PANELS, VERBS]);
  const spec = env.registered.find((s) => s.app === "zmax-gui");
  const open = spec.verbs.find((v) => v.id === "zmax.doc.open");
  assert.equal(open.rev, "irreversible", "opening replaces the pane's contents and records nothing");

  const out = await open.run({ path: "/p/deck.pptx" });
  assert.equal(env.mounts.length, 1);
  assert.equal(out.path, "/p/deck.pptx");
  assert.equal(out.kind, "office");

  const close = spec.verbs.find((v) => v.id === "zmax.doc.close");
  assert.deepEqual(close.run({}), { open: false, path: null, kind: null });
});

// ── the staging drift guard ─────────────────────────────────────────────────────────────────────

test("staging: every lib/doc-views asset index.html loads is one copy-doc-views.mjs stages", () => {
  const html = fs.readFileSync(INDEX, "utf8");
  const wanted = [...html.matchAll(/(?:src|href)="lib\/doc-views\/([^"]+)"/g)].map((m) => m[1]).sort();
  assert.ok(wanted.length >= 4, "index.html must load the staged views: " + JSON.stringify(wanted));

  // Run the real staging script, then compare against what it produced — a rename on either side
  // fails here instead of loading a 404 into the webview at runtime.
  const { execFileSync } = require("node:child_process");
  execFileSync(process.execPath, [COPY_SCRIPT], { stdio: "pipe" });
  const staged = fs.readdirSync(path.join(__dirname, "lib", "doc-views")).sort();
  for (const f of wanted) {
    assert.ok(staged.includes(f), f + " is loaded by index.html but not staged: " + JSON.stringify(staged));
  }
});
