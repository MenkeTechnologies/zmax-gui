// Headless test of the MacVim menu→PTY bridge (frontend/menu.js). No DOM/display needed: we load the
// IIFE in a vm context with a minimal `window`/`__TAURI__` shim that captures what gets written into
// the PTY, then drive `ZemacsMenu.actions.*` and assert the exact escape sequences sent to the editor.
// Catches accidental changes to the command mapping (e.g. zemacs is a Helix fork → buffers, not tabs).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const writes = [];
  const tauri = {
    core: {
      invoke(cmd, args) {
        if (cmd === "terminal_write") writes.push(args.data);
        // zemacs_exec_command etc. aren't exercised by the simple actions under test.
        return Promise.resolve("");
      },
    },
  };
  const win = { __TAURI__: tauri, addEventListener() {}, ZGui: undefined };
  const ctx = {
    window: win,
    document: { getElementById: () => null, createElement: () => ({ classList: { add() {}, toggle() {} }, appendChild() {}, addEventListener() {}, querySelectorAll: () => [], style: {} }) },
    setTimeout: (fn) => fn(),
    requestAnimationFrame: (fn) => fn(),
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "menu.js"), "utf8"), ctx);
  return { acts: win.ZemacsMenu.actions, writes };
}

// Each case: an action name → the exact bytes it must write into the PTY. `\x1b` = Esc (force normal
// mode first), `:cmd\r` = an ex-command, bare keys = normal-mode input.
const CASES = [
  ["save", "\x1b:write\r"],
  ["reload", "\x1b:reload\r"],
  ["closeBuffer", "\x1b:buffer-close\r"],
  ["newBuffer", "\x1b:new\r"],
  ["quit", "\x1b:quit-all\r"],
  ["nextBuffer", "\x1b:buffer-next\r"],
  ["prevBuffer", "\x1b:buffer-previous\r"],
  ["hsplit", "\x1b:hsplit\r"],
  ["vsplit", "\x1b:vsplit\r"],
  ["undo", "\x1bu"],
  ["redo", "\x1b\x12"], // C-r
  ["find", "\x1b/"],
  ["findNext", "\x1bn"],
  ["findPrev", "\x1bN"],
  ["copy", "\x1by"],
  ["paste", "\x1bp"],
  ["closeSplit", "\x1b\x17q"], // C-w q
  ["rotate", "\x1b\x17w"], // C-w w
];

for (const [action, expected] of CASES) {
  test(`bridge: ${action} writes ${JSON.stringify(expected)}`, () => {
    const { acts, writes } = load();
    assert.equal(typeof acts[action], "function", `actions.${action} should exist`);
    acts[action]();
    // The bridge sends ESC on its own, then the command (Alt-key disambiguation), so assert on the
    // concatenation; the leading ESC must be a separate chunk.
    assert.equal(writes[0], "\x1b", `${action} must send ESC on its own first`);
    assert.equal(writes.join(""), expected);
  });
}

test("bridge: actions surface is exposed", () => {
  const { acts } = load();
  assert.ok(acts && typeof acts === "object");
  assert.equal(typeof acts.fullscreen, "function");
});
