// What the frontend actually invokes, headless.
//
// The vocabulary test proves the ⌘K rows exist; this one proves the wiring behind them reaches the
// Rust commands with the right arguments — regressions a "does it publish" check cannot see, and
// that stay invisible on screen until you resize or go looking:
//
//   * the floating shell terminal (main.js) spawned its PTY at xterm's default 80x24 and never
//     called `shell_term_resize` again, so the kernel kept the boot geometry for the life of the
//     session and anything full-screen (vim, less, htop) drew to the wrong width.
//
// The real files run in a vm; only the browser and Tauri surfaces are stubs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MAIN = path.join(__dirname, "main.js");

// A DOM node with a real classList (main.js drives the pane's visibility through it) and recorded
// listeners, so a test can fire a click or a window resize.
function el(tag, size) {
  const classes = new Set();
  const node = {
    tag: tag || "div",
    id: "",
    hidden: true,
    value: "",
    title: "",
    type: "",
    style: {},
    innerHTML: "",
    textContent: "",
    children: [],
    listeners: {},
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains: (c) => classes.has(c),
      toggle(c, on) {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
      },
    },
    appendChild(c) { node.children.push(c); return c; },
    append(...cs) { cs.forEach((c) => node.children.push(c)); },
    insertBefore(c) { node.children.unshift(c); return c; },
    addEventListener(type, fn) { (node.listeners[type] = node.listeners[type] || []).push(fn); },
    fire(type, ev) { (node.listeners[type] || []).forEach((fn) => fn(ev || {})); },
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    scrollIntoView() {},
  };
  Object.defineProperty(node, "className", {
    get() { return [...classes].join(" "); },
    set(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  // Layout is a live read: `size(node)` is consulted on every access, so a test can shrink the
  // window between two fits without rebuilding the tree.
  Object.defineProperty(node, "clientWidth", { get: () => (size ? size(node).w : 0) });
  Object.defineProperty(node, "clientHeight", { get: () => (size ? size(node).h : 0) });
  return node;
}

// Controllable timers: the code under test debounces, and a test must be able to say "time passed"
// instead of sleeping for it.
function timers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(fn) { const id = next++; pending.set(id, fn); return id; },
    clearTimeout(id) { pending.delete(id); },
    flush() {
      const due = [...pending.values()];
      pending.clear();
      due.forEach((fn) => fn());
    },
  };
}

// Let queued promise callbacks run.
const tick = () => new Promise((r) => setImmediate(r));

// A minimal xterm: the fit helper resizes it; main.js reads rows/cols back off it.
function FakeTerminal() {
  this.rows = 24;
  this.cols = 80;
}
FakeTerminal.prototype.open = function (container) { this.container = container; };
FakeTerminal.prototype.onData = function (fn) { this.dataHandler = fn; };
FakeTerminal.prototype.write = function () {};
FakeTerminal.prototype.focus = function () {};
FakeTerminal.prototype.resize = function (cols, rows) { this.cols = cols; this.rows = rows; };

// Stands in for zpwr-embed-terminal's exported cell-metric fit (window.zpwrTermFit). The maths
// belongs to that submodule and is not re-tested here; what matters is that main.js routes the
// pane's geometry through it and hands the answer to the PTY. 8x16 css pixels per cell.
function fakeFit(term, container) {
  if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) {
    return { rows: term.rows, cols: term.cols };
  }
  const cols = Math.max(2, Math.floor(container.clientWidth / 8));
  const rows = Math.max(1, Math.floor(container.clientHeight / 16));
  if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
  return { rows, cols };
}

// Boot `files` against a stubbed browser + Tauri host. `invokes` collects every command the
// frontend sends to Rust, in order; `created` is every element it built.
function host(files, opts) {
  opts = opts || {};
  const invokes = [];
  const created = [];
  const clock = timers();
  const observers = [];
  let published = [];

  const shell = {
    body: el(),
    filterInput: { placeholder: "" },
    setCommands(list) { published = list; },
    setPaletteItems() {},
  };

  const doc = {
    body: el("body"),
    documentElement: el(),
    head: el(),
    byId: { app: el() },
    getElementById(id) { return doc.byId[id] || null; },
    createElement(tag) { const n = el(tag, opts.size); created.push(n); return n; },
    addEventListener() {},
    querySelector: () => null,
  };

  const win = {
    ZGui: {
      appShell: () => shell,
      menubar() {},
      palette: { register() {} },
      modal: { open: (o) => ({ body: o.body, close() {} }) },
      toast: { show() {} },
    },
    Terminal: FakeTerminal,
    zpwrTermFit: fakeFit,
    listeners: {},
    addEventListener(type, fn) { (win.listeners[type] = win.listeners[type] || []).push(fn); },
    __TAURI__: {
      core: {
        invoke(cmd, args) {
          invokes.push({ cmd, args: args || {} });
          const reply = opts.replies && opts.replies[cmd];
          return Promise.resolve(typeof reply === "function" ? reply(args) : reply);
        },
      },
      event: { listen() { return Promise.resolve(() => {}); } },
    },
  };

  const ctx = {
    window: win,
    ZGui: win.ZGui,
    document: doc,
    navigator: { platform: "MacIntel" },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    ResizeObserver: function (cb) { observers.push(cb); this.observe = () => {}; this.disconnect = () => {}; },
    localStorage: { getItem: () => null, setItem() {} },
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(f, "utf8"), ctx);

  return {
    win, doc, shell, invokes, created, observers,
    flush: clock.flush,
    sent: (cmd) => invokes.filter((i) => i.cmd === cmd),
    of: (cls) => created.filter((n) => n.classList.contains(cls)),
    commands: () => published,
  };
}

// ── the floating shell terminal's PTY geometry ──────────────────────────────────────────────────

// Only the floating shell's own body has a laid-out box; everything else measures zero, which is
// also what the real pane reports while it is display:none.
const floatSize = (box) => (node) => (node.classList.contains("term-body") ? box : { w: 0, h: 0 });

test("floating shell: the PTY is spawned at the pane's real geometry, not xterm's 80x24 default", () => {
  const env = host([MAIN], { size: floatSize({ w: 960, h: 640 }) });
  env.win.toggleTerminalPopup();

  const spawns = env.sent("shell_term_spawn");
  assert.equal(spawns.length, 1, "one spawn per open");
  assert.deepEqual(spawns[0].args, { rows: 40, cols: 120 }, "960x640 at 8x16 per cell is 120x40");

  const pane = env.doc.body.children.find((n) => n.classList.contains("zshell-float"));
  assert.ok(pane && pane.classList.contains("active"), "the pane must be visible before it is measured");
});

test("floating shell: a pane resize is pushed to the PTY, and only when the fit changed", async () => {
  const box = { w: 960, h: 640 };
  const env = host([MAIN], { size: floatSize(box) });
  env.win.toggleTerminalPopup();
  assert.equal(env.sent("shell_term_spawn").length, 1);
  assert.equal(env.observers.length, 1, "the terminal body must be observed for size changes");

  // The window shrinks; the pane's max-width/max-height clamp passes the change through.
  box.w = 640; box.h = 320;
  env.observers[0]();
  env.flush();
  await tick();
  assert.deepEqual(env.sent("shell_term_resize").map((r) => r.args), [{ rows: 20, cols: 80 }],
    "the PTY was never told the pane changed size");

  // A resize that does not change the cell fit must not reach the PTY.
  box.w = 643;
  env.win.listeners.resize.forEach((fn) => fn());
  env.flush();
  await tick();
  assert.equal(env.sent("shell_term_resize").length, 1, "an unchanged fit must not be re-sent");

  // A hidden pane measures zero: the fit falls back to the current size rather than resizing to 0.
  box.w = 0; box.h = 0;
  env.observers[0]();
  env.flush();
  await tick();
  assert.equal(env.sent("shell_term_resize").length, 1, "a hidden pane must not resize the PTY to nothing");
});

test("floating shell: closing the pane lets the next open respawn at the current geometry", () => {
  const env = host([MAIN], { size: floatSize({ w: 800, h: 480 }) });
  env.win.toggleTerminalPopup();

  const pane = env.doc.body.children.find((n) => n.classList.contains("zshell-float"));
  pane.children[0].fire("click", { target: { getAttribute: () => "close" } });
  assert.equal(env.sent("shell_term_kill").length, 1);

  env.win.toggleTerminalPopup();
  const spawns = env.sent("shell_term_spawn");
  assert.equal(spawns.length, 2, "closing the pane must let the next open respawn");
  assert.deepEqual(spawns[1].args, { rows: 30, cols: 100 });
});
