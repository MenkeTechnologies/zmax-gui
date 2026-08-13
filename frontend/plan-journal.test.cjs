// The crash record: whether a Batch Plan run actually leaves behind something a later launch can
// recover from, and whether a sealed compensation is reported honestly.
//
// `automation.js` journals a transaction in the WEBVIEW'S MEMORY. That is enough to unwind a step
// that failed while the app is alive, and it is nothing at all if the app dies mid-run — which is
// the one moment a forty-file refactor most needs its pre-images. So `plan-panel.js` writes the same
// ordering to disk through `txn.rs` (`txn_open` / `txn_append` / `txn_close`), and `verbs.js` seals
// each step's snapshot so the eventual restore can refuse a file the world moved past.
//
// Three things there are silent when wrong and destructive rather than loud:
//
//   * journalling a step BEFORE it runs — recovery would then restore a file the run never touched;
//   * closing the journal on a path that did not reach an outcome, or not closing it on one that
//     did — the first loses the record, the second prompts the user to undo work they kept;
//   * reporting a rollback as clean when a sealed restore declined files.
//
// These drive the real `plan-panel.js` and `verbs.js` against the real `zgui-core/webui/
// automation.js` with a recording Tauri host, and assert the wire traffic.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const VERBS = path.join(__dirname, "verbs.js");
const PLAN = path.join(__dirname, "plan-panel.js");
// The submodule source, not the gitignored frontend/lib copy — the copy may not exist in a clean
// checkout, and a test that silently skips is worse than no test.
const AUTOMATION = path.join(__dirname, "..", "crates", "zgui-core", "webui", "automation.js");

/**
 * Boot automation.js + verbs.js + plan-panel.js in a vm with a scripted Tauri host.
 *   replies: { [command]: (args) => value | Error }
 * Returns the live plan API, the automation registry, and every invoke in call order.
 */
function boot(replies) {
  const calls = [];
  let token = 0;
  const table = Object.assign({
    list_dir: () => ({ dir: "/proj" }),
    txn_snapshot: () => `tok${++token}`,
    txn_seal: () => 1,
    txn_restore: () => ({ restored: [], removed: [], failed: [], conflicted: [] }),
    txn_discard: () => null,
    txn_open: () => "jrnl1",
    txn_append: () => null,
    txn_close: () => null,
    txn_pending: () => [],
    txn_unwind: () => ({ id: "jrnl1", restored: 0, conflicted: 0, failed: 0, steps: [] }),
  }, replies || {});

  const win = { ZGui: {} };
  win.__TAURI__ = {
    core: {
      invoke(cmd, args) {
        calls.push({ cmd, args });
        const fn = table[cmd];
        if (!fn) return Promise.reject(new Error(`unscripted command: ${cmd}`));
        const out = fn(args);
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
      },
    },
  };
  const ctx = {
    window: win, console, Promise, Object, Array, JSON, String, Number, Error,
    setTimeout, clearTimeout,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(AUTOMATION, "utf8"), ctx);
  vm.runInContext(fs.readFileSync(VERBS, "utf8"), ctx);
  vm.runInContext(fs.readFileSync(PLAN, "utf8"), ctx);
  return {
    plan: win.ZmaxPlan,
    A: win.ZGui.automation,
    calls,
    win,
    of: (cmd) => calls.filter((c) => c.cmd === cmd),
  };
}

const STEPS = [
  { verb: "zmax.cleanup.apply", args: { path: "/proj/a.txt" }, label: "Clean up" },
  { verb: "zmax.sort.apply", args: { path: "/proj/b.txt" }, label: "Sort lines" },
];

test("a landed mutation seals its snapshot, so its compensation can refuse a file that moved on", async () => {
  const env = boot({ convert_file: () => ({ applied: true }) });
  const res = await env.A.call("zmax.cleanup.apply", { path: "/proj/a.txt" });

  assert.deepEqual(env.of("txn_seal").map((c) => c.args.token), [res.txn],
    "the verb's own token must be sealed — an unsealed one restores blind");
  // Order is the point: seal AFTER the mutation (so the fingerprint is what the verb left) and
  // BEFORE the result is handed back (so nothing the caller does next is recorded as the verb's).
  const order = env.calls.map((c) => c.cmd)
    .filter((c) => c === "txn_snapshot" || c === "convert_file" || c === "txn_seal");
  assert.deepEqual(order, ["txn_snapshot", "convert_file", "txn_seal"]);
});

test("a mutation that changed nothing is never sealed — there is no effect to fingerprint", async () => {
  const env = boot({ sort_file_lines: () => ({ applied: false, differs: false }) });
  const res = await env.A.call("zmax.sort.apply", { path: "/proj/a.txt" });
  assert.equal(res.txn, null);
  assert.equal(env.of("txn_seal").length, 0, "sealing a released token would arm an undo for a no-op");
});

test("a run journals each step to disk AFTER it lands, in order, then closes as committed", async () => {
  const env = boot({
    convert_file: () => ({ applied: true }),
    sort_file_lines: () => ({ applied: true }),
  });
  const res = await env.plan.run(STEPS);
  assert.equal(res.ok, true, `run failed: ${res.error}`);

  assert.equal(env.of("txn_open").length, 1, "the run must open a disk journal");
  assert.equal(env.of("txn_open")[0].args.label.includes("2"), true,
    "the recovery prompt needs the run's size, not just an id");

  const appends = env.of("txn_append");
  assert.deepEqual(appends.map((c) => c.args.verb), ["zmax.cleanup.apply", "zmax.sort.apply"],
    "every landed step must be on record, in run order");
  assert.deepEqual(appends.map((c) => c.args.token), ["tok1", "tok2"],
    "each record must carry the step's OWN token, or recovery restores the wrong file");
  assert.ok(appends.every((c) => c.args.id === "jrnl1"), "all steps belong to one transaction");

  // A step recorded before it ran would make a recovery pass restore a file the run never touched.
  // The first mutation must precede the first append, and the SECOND mutation must precede the
  // second append — checking only the first pair would pass on a run that pre-recorded every
  // remaining step up front.
  const at = (cmd, n) => env.calls.reduce((acc, c, i) => (c.cmd === cmd ? acc.concat(i) : acc), [])[n];
  assert.ok(at("convert_file", 0) < at("txn_append", 0), "step 1 must be journalled after it lands");
  assert.ok(at("sort_file_lines", 0) < at("txn_append", 1), "step 2 must be journalled after it lands");

  assert.deepEqual(env.of("txn_close").map((c) => c.args.outcome), ["committed"],
    "a finished run must close its journal, or the next launch offers to undo it");
});

test("a failed run closes its journal as unwound — a record left open would re-prompt forever", async () => {
  const env = boot({
    convert_file: () => ({ applied: true }),
    sort_file_lines: () => new Error("disk full"),
  });
  const res = await env.plan.run(STEPS);
  assert.equal(res.ok, false);
  assert.match(res.error, /disk full/);

  assert.deepEqual(env.of("txn_append").map((c) => c.args.verb), ["zmax.cleanup.apply"],
    "only the step that landed may be on record");
  assert.deepEqual(env.of("txn_close").map((c) => c.args.outcome), ["unwound"]);
  assert.equal(env.of("txn_restore").length, 1, "the landed step must have been compensated");
});

test("a rollback that DECLINED files does not report itself as clean", async () => {
  const env = boot({
    convert_file: () => ({ applied: true }),
    sort_file_lines: () => new Error("nope"),
    // The sealed restore refused: something changed /proj/a.txt after its step ran.
    txn_restore: () => ({
      restored: [], removed: [], failed: [],
      conflicted: [{ path: "/proj/a.txt", parked: "/proj/a.txt.zmax-undo-tok1", reason: "changed" }],
    }),
  });
  const res = await env.plan.run(STEPS);
  assert.equal(res.ok, false);
  // txnAbort counts a declined step as compensated (its undo() resolved, correctly), so without
  // this tally the status line would claim a clean rollback over a file it deliberately left alone.
  assert.equal(res.conflicted, 1, "the declined file must be surfaced, not absorbed into 'compensated'");
});

test("a host with no journal backend still runs, and still compensates in memory", async () => {
  const env = boot({
    convert_file: () => ({ applied: true }),
    sort_file_lines: () => ({ applied: true }),
    txn_open: () => new Error("no such command"),
  });
  const res = await env.plan.run(STEPS);
  assert.equal(res.ok, true, `the run must not depend on the disk journal: ${res.error}`);
  assert.equal(env.of("txn_append").length, 0, "nothing may be appended to a journal that never opened");
  assert.equal(env.of("txn_close").length, 0, "nor closed");
});

test("recovery reads the pending journals and unwinds one by id", async () => {
  const env = boot({
    txn_pending: () => [{ id: "jA", label: "Batch Plan: 3 steps", steps: [{ verb: "v", token: "t" }] }],
    txn_unwind: (a) => ({ id: a.id, restored: 3, conflicted: 1, failed: 0, steps: [] }),
  });
  const rows = await env.plan.pending();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Batch Plan: 3 steps");

  const report = await env.plan.recover("jA");
  assert.deepEqual(env.of("txn_unwind").map((c) => c.args.id), ["jA"]);
  assert.equal(report.conflicted, 1, "the unwind's declined files must reach the caller");
});

test("a host that cannot answer reports no interrupted runs rather than guessing", async () => {
  const env = boot({ txn_pending: () => new Error("no backend") });
  assert.deepEqual(await env.plan.pending(), [],
    "a recovery prompt raised on a failed query would offer to undo a run that may not exist");
});

test("the crash record is on the bus, classified, and the unwind is not pretending to be reversible", () => {
  const env = boot();
  const surface = env.A.surface();
  const pending = surface.verbs.find((v) => v.id === "zmax.txn.interrupted");
  const unwind = surface.verbs.find((v) => v.id === "zmax.txn.unwind");
  assert.ok(pending && unwind, "both recovery verbs must be published");
  assert.equal(pending.rev, "pure", "listing interrupted runs changes nothing");
  assert.equal(unwind.rev, "irreversible",
    "unwinding rewrites the tree; claiming inverse would let a transaction journal it with no way back");
});
