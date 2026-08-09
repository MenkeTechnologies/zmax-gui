// The app's command vocabulary, end to end and headless.
//
// zmax-gui has THREE publishers of ⌘K commands — main.js (the shell's own, e.g. Tmux), menu.js (the
// whole MacVim menu tree, from zmax-gui-core) and panels.js (the project workbench) — and the
// appShell's setCommands REPLACES the list on every call. So the only thing that makes the app
// scriptable is that each publisher hands over the UNION, through setCommands (the path that
// registers `appshell.<id>` verbs on the GUI Automation Bus) rather than the legacy setPaletteItems
// path, and that every id is locale-independent so a saved script survives a language switch.
//
// This drives the real files in a vm with a stubbed appShell, and asserts what the bus would see.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MENU = path.join(__dirname, "..", "crates", "zmax-gui-core", "webui", "menu.js");
const PANELS = path.join(__dirname, "panels.js");
const MAIN = path.join(__dirname, "main.js");

function el() {
  const node = {
    id: "",
    className: "",
    hidden: true,
    style: {},
    innerHTML: "",
    textContent: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, append() {}, insertBefore() {}, addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null,
  };
  node.parentNode = { insertBefore() {} };
  return node;
}

// Boot the three publishers against a stubbed shell and return every setCommands / setPaletteItems
// call it received. `t` (optional) is the i18n catalog, so a locale switch can be simulated.
function boot(opts) {
  opts = opts || {};
  const commandCalls = [];
  const paletteCalls = [];
  const shell = {
    body: el(),
    filterInput: { placeholder: "" },
    setCommands(list) { commandCalls.push(list); },
    setPaletteItems(list) { paletteCalls.push(list); },
  };

  const win = {
    ZGui: {
      appShell: () => shell,
      menubar() {},
      palette: { register() {} },
    },
    addEventListener() {},
    t: opts.t,
  };
  const doc = {
    body: el(),
    documentElement: el(),
    head: el(),
    getElementById: () => null,
    createElement: () => el(),
    addEventListener() {},
    querySelector: () => null,
    readyState: "complete",
  };
  const ctx = {
    window: win,
    ZGui: win.ZGui,
    document: doc,
    navigator: { platform: "MacIntel" },
    setTimeout: () => 0,           // never run the deferred PTY writes
    clearTimeout() {},
    requestAnimationFrame: (fn) => fn(),
    localStorage: { getItem: () => null, setItem() {} },
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of [MENU, PANELS, MAIN]) vm.runInContext(fs.readFileSync(f, "utf8"), ctx);
  return { win, shell, commandCalls, paletteCalls, published: commandCalls[commandCalls.length - 1] || [] };
}

test("vocabulary: the app publishes through setCommands, never the palette-only path", () => {
  const env = boot();
  assert.ok(env.commandCalls.length >= 1, "nothing was published at all");
  assert.deepEqual(env.paletteCalls, [], "setPaletteItems registers no automation verbs — it must not be used");
});

test("vocabulary: the final publish is the UNION of all three publishers", () => {
  const env = boot();
  const ids = new Set(env.published.map((c) => c.id));
  // main.js — a shell command with no menu item and no shared-embed equivalent.
  assert.ok(ids.has("zmax.tmux"), "the shell's own commands were dropped by a later publisher");
  // menu.js — the MacVim menu tree.
  assert.ok(ids.has("zmax.save"), "the menu vocabulary is missing");
  assert.ok(ids.has("zmax.gitBlame"), "the menu vocabulary is missing");
  // panels.js — the project workbench overlays.
  assert.ok(ids.has("zmax.panel.quickOpen"), "the workbench vocabulary is missing");
  assert.ok(ids.has("zmax.panel.docBlame"), "the workbench vocabulary is missing");
});

test("vocabulary: every published command is callable — id + label + run", () => {
  const env = boot();
  // command-palette.js's setCommands drops anything missing an id or a label, so such a row is
  // invisible in ⌘K *and* absent from the bus.
  const broken = env.published.filter((c) => !c || !c.id || !c.label || typeof c.run !== "function");
  assert.deepEqual(broken.map((c) => (c && (c.id || c.label)) || c), []);
});

test("vocabulary: no id is claimed by two different commands", () => {
  const env = boot();
  const byId = new Map();
  for (const c of env.published) {
    if (!byId.has(c.id)) byId.set(c.id, new Set());
    byId.get(c.id).add(c.run);
  }
  const clashes = [...byId].filter(([, runs]) => runs.size > 1).map(([id]) => id);
  assert.deepEqual(clashes, [], "one bus verb cannot mean two different actions");
});

test("vocabulary: a locale switch changes every label and no id", () => {
  const en = boot();
  const fr = boot({ t: (k) => "«" + k + "»" });
  const ids = (e) => e.published.map((c) => c.id).sort();
  assert.deepEqual(ids(fr), ids(en), "a translated verb name breaks every saved script and chain");
  const label = (e, id) => e.published.find((c) => c.id === id).label;
  for (const id of ["zmax.tmux", "zmax.panel.quickOpen"]) {
    assert.notEqual(label(fr, id), label(en, id), "the stub catalog must really translate");
  }
});

test("vocabulary: a locale switch re-publishes the union, not just the menu", () => {
  const env = boot();
  const before = env.commandCalls.length;
  env.win.ZmaxMenu.retranslate();
  assert.equal(env.commandCalls.length, before + 1, "retranslate must re-publish");
  const ids = new Set(env.commandCalls[env.commandCalls.length - 1].map((c) => c.id));
  for (const id of ["zmax.tmux", "zmax.save", "zmax.panel.quickOpen"]) {
    assert.ok(ids.has(id), `${id} was lost when the locale changed`);
  }
});
