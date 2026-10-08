// What the frontend actually invokes, headless.
//
// The vocabulary test proves the ⌘K rows exist; this one proves the wiring behind two of them
// reaches the Rust commands with the right arguments. Both cases are regressions a "does it
// publish" check cannot see, and that stay invisible on screen until you resize or go looking:
//
//   * the floating shell terminal (main.js) spawned its PTY at xterm's default 80x24 and never
//     called `shell_term_resize` again, so the kernel kept the boot geometry for the life of the
//     session and anything full-screen (vim, less, htop) drew to the wrong width;
//   * `search_documents` (doc_search.rs) — the documents-only pass, the only one with a formats
//     filter — had no caller at all.
//
// The real files run in a vm; only the browser and Tauri surfaces are stubs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MAIN = path.join(__dirname, "main.js");
const PANELS = path.join(__dirname, "panels.js");

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

// ── the documents-only search ───────────────────────────────────────────────────────────────────

async function bootPanels(replies) {
  const env = host([PANELS], { replies: Object.assign({ list_dir: { dir: "/proj" } }, replies || {}) });
  env.win.ZmaxPanels.mount(env.shell);
  await tick();
  return env;
}

// Open Search Documents from the published vocabulary and type `query` into its picker.
async function search(env, query) {
  const item = env.commands().find((c) => c.id === "zmax.panel.searchDocuments");
  assert.ok(item, "Search Documents is not in the published vocabulary");
  item.run();
  await tick();                       // getRoot() resolves, then the modal is built
  const input = env.of("zp-input")[0];
  assert.ok(input, "the picker built no search input");
  input.value = query;
  input.fire("input");
  env.flush();                        // the 250ms debounce
  await tick();
  return input;
}

test("documents search: the panel queries search_documents over every supported format", async () => {
  const env = await bootPanels({
    search_documents: {
      hits: [{
        path: "/proj/q3.xlsx", rel: "q3.xlsx", format: "xlsx", text: "budget",
        locator: { kind: "cell", sheet: 0, sheet_name: "Sheet1", reference: "B7" },
      }],
      truncated: false,
      errors: [],
    },
  });
  await search(env, "budget");

  const calls = env.sent("search_documents");
  assert.equal(calls.length, 1, "typing must run exactly one documents search");
  assert.equal(calls[0].args.root, "/proj");
  assert.equal(calls[0].args.query, "budget");
  assert.equal(calls[0].args.opts.formats, null, "no format toggle on means every supported format");
  assert.equal(calls[0].args.opts.case_insensitive, true, "the 'Match case' toggle is off by default");
  assert.equal(calls[0].args.opts.regex, undefined, "the engines are substring-only: never send a regex");

  // The hit is rendered as a row addressed by its in-document locator, not by a line number.
  const rows = env.of("zp-row");
  assert.equal(rows.length, 1, "the hit was not rendered");
  assert.ok(rows[0].children.some((c) => c.textContent === "q3.xlsx · Sheet1!B7"),
    "a spreadsheet hit must be addressed by its cell reference, not a line number");
  assert.ok(rows[0].children.some((c) => c.textContent === "xlsx"), "the format badge is missing");
});

test("documents search: the format toggles narrow the pass and re-run it", async () => {
  const env = await bootPanels({ search_documents: { hits: [], truncated: false, errors: [] } });
  await search(env, "budget");
  assert.equal(env.sent("search_documents").length, 1);

  const toggles = env.of("zp-opt").filter((b) => b.textContent === "xlsx" || b.textContent === "pdf");
  assert.equal(toggles.length, 2, "the per-format toggles were not built");
  toggles.forEach((b) => b.fire("click"));
  env.flush();
  await tick();

  const calls = env.sent("search_documents");
  assert.ok(calls.length > 1, "flipping a format toggle must re-run the search");
  assert.deepEqual(calls[calls.length - 1].args.opts.formats, ["xlsx", "pdf"],
    "the chosen formats are the filter doc_search.rs walks with");
});

// ── git commit + line filters ───────────────────────────────────────────────────────────────────

// The stub modal drops its options; these panels act through their action buttons, so record them.
function recordModals(env) {
  const opened = [];
  env.win.ZGui.modal.open = (o) => { opened.push(o); return { body: o.body, close() {} }; };
  env.win.ZGui.modal.confirm = () => Promise.resolve(true);
  return opened;
}
function action(modal, label) {
  const a = modal.actions.find((x) => x.label === label);
  assert.ok(a, `no "${label}" action on "${modal.title}"`);
  return a;
}
const runCommand = (env, id) => {
  const item = env.commands().find((c) => c.id === id);
  assert.ok(item, `${id} is not in the published vocabulary`);
  item.run();
};

test("git commit: the panel commits its message, and amend starts from the tip's message", async () => {
  const fired = [];
  const env = await bootPanels({
    git_commit_info: { branch: "main", has_head: true, staged: [{ status: "M", path: "src/a.rs" }], last_message: "previous subject" },
    git_commit: { hash: "abcdef0123", short: "abcdef01", subject: "add parser" },
  });
  env.win.ZGui.hooks = { fire: (id, ctx) => { fired.push([id, ctx]); return Promise.resolve(); } };
  const opened = recordModals(env);
  runCommand(env, "zmax.panel.gitCommit");
  await tick(); await tick();

  const modal = opened[opened.length - 1];
  assert.equal(modal.title, "Git Commit");
  const staged = env.of("zp-row").find((r) => r.children.some((c) => c.textContent === "src/a.rs"));
  assert.ok(staged, "the staged path is not listed");
  const msg = env.created.find((n) => n.tag === "textarea");
  assert.ok(msg, "no message box");

  msg.value = "add parser";
  action(modal, "Commit").onClick();
  await tick();
  assert.deepEqual(env.sent("git_commit").map((c) => c.args),
    [{ root: "/proj", message: "add parser", amend: false, signOff: false }]);
  assert.deepEqual(fired, [["git.committed", { root: "/proj", hash: "abcdef0123", subject: "add parser" }]],
    "the declared git.committed hook must fire after a commit from the panel");

  // Amend on an empty box pre-fills the tip's message, then commits as an amend.
  msg.value = "";
  env.of("zp-opt").find((b) => b.textContent === "Amend").fire("click");
  assert.equal(msg.value, "previous subject");
  action(modal, "Commit").onClick();
  await tick(); await tick();
  const last = env.sent("git_commit").pop();
  assert.equal(last.args.amend, true);
  assert.equal(last.args.message, "previous subject");
});

test("git commit: an empty message is refused before it reaches git", async () => {
  const env = await bootPanels({
    git_commit_info: { branch: "main", has_head: false, staged: [{ status: "A", path: "a" }], last_message: "" },
  });
  const opened = recordModals(env);
  runCommand(env, "zmax.panel.gitCommit");
  await tick(); await tick();
  const shown = env.of("zp-opts").pop().children;
  assert.ok(!shown.some((b) => b.textContent === "Amend"), "an unborn branch has nothing to amend");
  assert.ok(shown.some((b) => b.textContent === "Sign-off"));
  action(opened[opened.length - 1], "Commit").onClick();
  await tick();
  assert.equal(env.sent("git_commit").length, 0);
});

test("keep / flush lines: previews the picked file, flips mode, and applies only on Apply", async () => {
  const env = await bootPanels({
    find_files: [{ path: "/proj/notes.txt", rel: "notes.txt" }],
    filter_file_lines: (a) => ({
      lines_before: 4, lines_after: 3, removed: 1, differs: true, applied: !!a.opts.apply,
      sample: [{ line: 3, text: "TODO drop me" }], sample_truncated: false,
    }),
  });
  const opened = recordModals(env);
  runCommand(env, "zmax.panel.filterLines");
  await tick();
  const picker = env.of("zp-input")[0];
  picker.value = "notes";
  picker.fire("input");
  env.flush(); await tick();
  env.of("zp-row")[0].fire("click");             // pick the file

  const pat = env.of("zp-input")[1];
  assert.ok(pat, "the pattern box was not built");
  pat.value = "TODO";
  pat.fire("input");
  env.flush(); await tick();
  let calls = env.sent("filter_file_lines");
  assert.deepEqual(calls[0].args, {
    path: "/proj/notes.txt",
    opts: { pattern: "TODO", keep: true, regex: false, case_insensitive: false, apply: false },
  });
  // The removed line is listed by its line number.
  assert.ok(env.of("zp-row").some((r) => r.children.some((c) => c.textContent === "3")), "removed-line row missing");

  const keep = env.of("zp-opt").find((b) => b.textContent === "Keep matching");
  const flush = env.of("zp-opt").find((b) => b.textContent === "Flush matching");
  flush.fire("click");
  env.flush(); await tick();
  calls = env.sent("filter_file_lines");
  assert.equal(calls[calls.length - 1].args.opts.keep, false);
  assert.ok(!keep.classList.contains("active") && flush.classList.contains("active"), "keep and flush must be exclusive");
  flush.fire("click");                           // clicking the active mode keeps it on
  assert.ok(flush.classList.contains("active"));
  assert.ok(calls.every((c) => c.args.opts.apply === false), "a preview applied");

  action(opened[opened.length - 1], "Apply").onClick();
  await tick();
  const applied = env.sent("filter_file_lines").pop();
  assert.equal(applied.args.opts.apply, true);
  assert.equal(applied.args.opts.keep, false);
});

// ── merge conflicts, cherry-pick / revert, history search ───────────────────────────────────────

const hunk = (index, start, base) => ({
  index, start_line: start, end_line: start + 4, ours_label: "HEAD", theirs_label: "topic",
  base_label: base ? "base" : null, ours: ["o"], base: base ? ["b"] : null, theirs: ["t"],
  ours_lines: 1, base_lines: base ? 1 : 0, theirs_lines: 1,
});
const btn = (row, label) => row.children.find((c) => c.textContent === label);
const rowFor = (env, text) => env.of("zp-row").find((r) => r.children.some((c) => c.textContent === text));

test("merge conflicts: each hunk resolves in place, and a file's last hunk stages it only when git lists it unmerged", async () => {
  let remaining = 1;
  const env = await bootPanels({
    git_op_state: { op: "cherry-pick", unmerged: ["src/a.rs"] },
    conflict_scan: {
      total_hunks: 3, truncated: false,
      files: [
        { path: "/proj/src/a.rs", rel: "src/a.rs", hunks: [hunk(0, 2, true), hunk(1, 9, false)], malformed: null, malformed_line: null },
        { path: "/proj/notes.txt", rel: "notes.txt", hunks: [hunk(0, 1, false)], malformed: null, malformed_line: null },
        { path: "/proj/bad.txt", rel: "bad.txt", hunks: [], malformed: "conflict is not closed", malformed_line: 4 },
      ],
    },
    resolve_conflicts: () => ({ remaining: remaining--, resolved: 1, applied: true, differs: true }),
    git_stage: null,
  });
  recordModals(env);
  runCommand(env, "zmax.panel.mergeConflicts");
  await tick(); await tick(); await tick();

  const rows = env.of("zp-row").filter((r) => r.children.some((c) => c.textContent === "src/a.rs"));
  assert.equal(rows.length, 2, "one row per hunk");
  assert.ok(btn(rows[0], "Base"), "a diff3 hunk offers its base");
  assert.ok(!btn(rows[1], "Base"), "a merge-style hunk has no base to keep");
  const bad = rowFor(env, "bad.txt:4");
  assert.ok(bad && !btn(bad, "Ours"), "a malformed file is listed but never offered a rewrite");

  btn(rows[1], "Theirs").fire("click", { stopPropagation() {} });
  await tick(); await tick();
  assert.deepEqual(env.sent("resolve_conflicts")[0].args, { path: "/proj/src/a.rs", opts: { take: "theirs", hunk: 1, apply: true } });
  assert.equal(env.sent("git_stage").length, 0, "a file with a hunk left must not be staged");

  btn(rows[0], "Ours").fire("click", { stopPropagation() {} });
  await tick(); await tick(); await tick();
  assert.deepEqual(env.sent("git_stage").map((c) => c.args), [{ path: "/proj/src/a.rs" }],
    "the last hunk of an unmerged file stages it");

  // notes.txt is not in git's unmerged list (markers from a patch tool): resolved, never staged.
  remaining = 0;
  btn(rowFor(env, "notes.txt"), "Both").fire("click", { stopPropagation() {} });
  await tick(); await tick(); await tick();
  assert.equal(env.sent("git_stage").length, 1);
  assert.ok(env.sent("conflict_scan").length >= 3, "every resolution rescans the tree");
});

test("merge conflicts: Continue and Abort drive the stopped operation", async () => {
  const env = await bootPanels({
    git_op_state: { op: "revert", unmerged: [] },
    conflict_scan: { total_hunks: 0, truncated: false, files: [] },
    git_op_continue: { op: null, unmerged: [] },
    git_op_abort: null,
  });
  const opened = recordModals(env);
  runCommand(env, "zmax.panel.mergeConflicts");
  await tick(); await tick(); await tick();
  const modal = opened[opened.length - 1];
  assert.equal(modal.title, "Merge Conflicts");
  action(modal, "Continue").onClick();
  await tick();
  assert.deepEqual(env.sent("git_op_continue").map((c) => c.args), [{ root: "/proj" }]);
  action(modal, "Abort").onClick();
  await tick(); await tick();
  assert.deepEqual(env.sent("git_op_abort").map((c) => c.args), [{ root: "/proj" }]);
});

test("cherry-pick from the repository log: a conflict stop opens Merge Conflicts instead of failing", async () => {
  const env = await bootPanels({
    git_log_repo: [{ hash: "abc1234567", short: "abc12345", author: "a", date: "2026-01-01", subject: "topic edit", refs: "" }],
    git_cherry_pick: { stopped: true, op: "cherry-pick", unmerged: ["f.txt"], hash: null, subject: null },
    git_op_state: { op: "cherry-pick", unmerged: ["f.txt"] },
    conflict_scan: { total_hunks: 0, truncated: false, files: [] },
  });
  const opened = recordModals(env);
  runCommand(env, "zmax.panel.gitLog");
  await tick(); await tick();
  btn(rowFor(env, "topic edit"), "⇡").fire("click", { stopPropagation() {} });
  await tick(); await tick(); await tick(); await tick();
  assert.deepEqual(env.sent("git_cherry_pick").map((c) => c.args), [{ root: "/proj", rev: "abc1234567", noCommit: false }]);
  assert.equal(opened[opened.length - 1].title, "Merge Conflicts");
});

test("search history: the mode buttons are exclusive and every flag reaches git_log_search", async () => {
  const env = await bootPanels({ git_log_search: [] });
  recordModals(env);
  runCommand(env, "zmax.panel.historySearch");
  await tick();
  const [query, pathIn] = env.of("zp-input");
  query.value = "fn alpha";
  query.fire("input");
  env.flush(); await tick();
  assert.deepEqual(env.sent("git_log_search")[0].args, {
    root: "/proj", query: "fn alpha",
    opts: { mode: "pickaxe", ignore_case: false, all: false, path: null, limit: 300 },
  });
  const g = env.of("zp-opt").find((b) => b.textContent === "-G");
  const s = env.of("zp-opt").find((b) => b.textContent === "-S");
  g.fire("click");
  env.of("zp-opt").find((b) => b.textContent === "Aa").fire("click");
  pathIn.value = " src/ ";
  pathIn.fire("input");
  env.flush(); await tick();
  const last = env.sent("git_log_search").pop().args.opts;
  assert.deepEqual(last, { mode: "regex", ignore_case: true, all: false, path: "src/", limit: 300 });
  assert.ok(g.classList.contains("active") && !s.classList.contains("active"), "exactly one mode is on");
});

// ── remotes, bisect, line history, worktrees ────────────────────────────────────────────────────

// Scripted answers for ZGui.modal.prompt, consumed in order.
function scriptPrompts(env, answers) {
  const asked = [];
  env.win.ZGui.modal.prompt = (o) => { asked.push(o); return Promise.resolve(answers.shift()); };
  return asked;
}
const settle = async (n) => { for (let i = 0; i < (n || 6); i++) await tick(); };

test("remotes: the header and sections reflect the upstream, and a branch with none is pushed with -u to the chosen remote", async () => {
  const commit = (s) => ({ hash: s.repeat(10), short: s.repeat(8), author: "a", date: "2026-01-01", subject: "commit " + s, refs: "" });
  const env = await bootPanels({
    git_remotes: [{ name: "origin", fetch_url: "/srv/o.git", push_url: "/srv/o.git" }, { name: "fork", fetch_url: "/f", push_url: "ssh://p/f" }],
    git_upstream_status: { branch: "dev", upstream: null, ahead: 0, behind: 0, unpushed: [], unpulled: [] },
    git_push: { output: "", status: { branch: "dev", upstream: "fork/dev", ahead: 0, behind: 0, unpushed: [], unpulled: [commit("b")] } },
  });
  const opened = recordModals(env);
  const asked = scriptPrompts(env, ["fork"]);
  runCommand(env, "zmax.panel.gitRemotes");
  await settle();
  const modal = opened[opened.length - 1];
  assert.equal(modal.title, "Git Remotes");
  assert.ok(env.of("zp-row").some((r) => r.children.some((c) => c.textContent === "push → ssh://p/f")),
    "a separate push URL is shown");

  action(modal, "Push").onClick();
  await settle();
  assert.equal(asked[0].value, "origin", "the first remote is the default");
  assert.deepEqual(env.sent("git_push").map((c) => c.args),
    [{ root: "/proj", remote: "fork", branch: null, setUpstream: true, forceWithLease: false }]);
  assert.ok(env.of("zp-count").some((n) => n.textContent === "dev  →  fork/dev   ↑0  ↓0"), "the header shows the new upstream");
  assert.ok(env.of("zp-count").some((n) => n.textContent === "Unpulled from fork/dev (1)"));
  assert.ok(rowFor(env, "commit b"), "the unpulled commit is listed");
});

test("remotes: a lease push is confirmed and sent to the upstream; a pull that stops opens Merge Conflicts", async () => {
  const env = await bootPanels({
    git_remotes: [{ name: "origin", fetch_url: "/o", push_url: "/o" }],
    git_upstream_status: { branch: "main", upstream: "origin/main", ahead: 1, behind: 1, unpushed: [], unpulled: [] },
    git_push: { output: "", status: { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, unpushed: [], unpulled: [] } },
    git_pull: { stopped: true, op: "rebase", unmerged: ["f.txt"], before: "a", after: "a", output: "" },
    git_op_state: { op: "rebase", unmerged: ["f.txt"] },
    conflict_scan: { total_hunks: 0, truncated: false, files: [] },
  });
  const opened = recordModals(env);
  runCommand(env, "zmax.panel.gitRemotes");
  await settle();
  const modal = opened[opened.length - 1];
  action(modal, "Push --force-with-lease").onClick();
  await settle();
  assert.deepEqual(env.sent("git_push").map((c) => c.args),
    [{ root: "/proj", remote: null, branch: null, setUpstream: false, forceWithLease: true }]);
  action(modal, "Pull --rebase").onClick();
  await settle();
  assert.deepEqual(env.sent("git_pull").map((c) => c.args), [{ root: "/proj", mode: "rebase" }]);
  assert.equal(opened[opened.length - 1].title, "Merge Conflicts");
});

test("bisect: Start sends every good revision, and the answer heads the panel", async () => {
  const env = await bootPanels({
    git_bisect_state: { active: false, log: [], first_bad: null, current: null, remaining: null, steps: null, output: "" },
    git_bisect_start: { active: true, log: [], first_bad: null, current: { hash: "c4c4", short: "c4c4", subject: "c4" }, remaining: 3, steps: 2, output: "" },
    git_bisect_mark: {
      active: true, current: null, remaining: null, steps: null, output: "",
      first_bad: { hash: "c5c5", short: "c5c5", subject: "c5" },
      log: [{ verdict: "bad", commit: { hash: "c5c5", short: "c5c5", subject: "c5" } }],
    },
  });
  const opened = recordModals(env);
  scriptPrompts(env, ["", "v1.0  v1.1 "]);
  runCommand(env, "zmax.panel.gitBisect");
  await settle();
  const modal = opened[opened.length - 1];
  action(modal, "Start…").onClick();
  await settle();
  assert.deepEqual(env.sent("git_bisect_start").map((c) => c.args), [{ root: "/proj", bad: null, good: ["v1.0", "v1.1"] }],
    "a blank bad revision means HEAD (the host's default), and the good list is split on whitespace");
  assert.ok(env.of("zp-count").some((n) => n.textContent === "Testing c4c4 c4  ·  3 left, roughly 2 steps"));
  action(modal, "Bad").onClick();
  await settle();
  assert.deepEqual(env.sent("git_bisect_mark")[0].args, { root: "/proj", verdict: "bad", rev: null });
  assert.ok(env.of("zp-count").some((n) => n.textContent === "First bad commit: c5c5 c5"));
});

test("line history: a single line, a range and a function each reach git_log_lines, and a row shows its own range patch", async () => {
  const env = await bootPanels({
    find_files: [{ path: "/proj/src/m.c", rel: "src/m.c" }],
    git_log_lines: [{ hash: "h1", short: "h1", author: "a", date: "d", subject: "tweak f", patch: "@@ -5 +5 @@\n-1\n+2" }],
  });
  const opened = recordModals(env);
  runCommand(env, "zmax.panel.lineHistory");
  await settle();
  env.flush(); await settle();
  const pick = rowFor(env, "m.c");
  assert.ok(pick, "the file picker lists the file");
  pick.fire("click");
  await settle();
  assert.equal(opened[opened.length - 1].title, "Line History — /proj/src/m.c");

  const [startIn, endIn, fnIn] = env.of("zp-input").slice(-3);
  const optsSent = () => env.sent("git_log_lines").map((c) => c.args.opts);
  startIn.value = "7"; startIn.fire("input"); env.flush(); await settle();
  endIn.value = "9"; endIn.fire("input"); env.flush(); await settle();
  fnIn.value = " ^int f "; fnIn.fire("input"); env.flush(); await settle();
  assert.deepEqual(optsSent(), [
    { start: 7, end: 7, limit: 200 },
    { start: 7, end: 9, limit: 200 },
    { funcname: "^int f", limit: 200 },
  ], "a lone start is a one-line range; a function name replaces the range");
  assert.equal(env.sent("git_log_lines")[0].args.path, "/proj/src/m.c");

  rowFor(env, "tweak f").fire("click");
  const pre = env.of("zp-diff").pop();
  assert.equal(pre.textContent, "@@ -5 +5 @@\n-1\n+2", "the row shows the range patch, not the whole commit");
  assert.equal(env.sent("git_show_commit").length, 0);
});

test("worktrees: an unknown branch is created, a refused remove offers the forced one, the main worktree has no remove", async () => {
  const env = await bootPanels({
    git_worktrees: [
      { path: "/proj", head: "a".repeat(40), branch: "main", detached: false, bare: false, main: true, locked: null, prunable: null },
      { path: "/wt", head: "b".repeat(40), branch: null, detached: true, bare: false, main: false, locked: "usb", prunable: null },
    ],
    git_branches: [{ name: "main" }, { name: "dev" }],
    git_worktree_add: (a) => ({ path: a.path, branch: a.branch, head: "c" }),
    git_worktree_remove: (a) => (a.force ? null : Promise.reject("contains modified or untracked files")),
  });
  const opened = recordModals(env);
  const confirms = [];
  env.win.ZGui.modal.confirm = (o) => { confirms.push(o); return Promise.resolve(true); };
  scriptPrompts(env, ["../hot", "hotfix", "../dev", "dev"]);
  runCommand(env, "zmax.panel.gitWorktrees");
  await settle();
  const modal = opened[opened.length - 1];
  assert.ok(!btn(rowFor(env, "/proj"), "✕"), "the main worktree cannot be removed");
  assert.ok(rowFor(env, "/wt").children.some((c) => c.textContent === "bbbbbbbb · locked: usb"));

  action(modal, "＋ Add Worktree").onClick(); await settle(8);
  action(modal, "＋ Add Worktree").onClick(); await settle(8);
  assert.deepEqual(env.sent("git_worktree_add").map((c) => [c.args.branch, c.args.newBranch]), [["hotfix", true], ["dev", false]],
    "a name with no branch behind it is created; an existing branch is only checked out");

  btn(rowFor(env, "/wt"), "✕").fire("click", { stopPropagation() {} });
  await settle(8);
  assert.deepEqual(env.sent("git_worktree_remove").map((c) => c.args.force), [false, true],
    "the plain remove runs first; force only after git refused it and the user confirmed again");
  assert.ok(confirms[1].message.includes("contains modified or untracked files"), "git's reason is shown before forcing");
});
