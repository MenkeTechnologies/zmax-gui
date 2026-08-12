// The typed automation-bus surface, and — the part that actually matters — whether its
// "reversible" claim is true.
//
// `verbs.js` tells every bus client that its file-mutating verbs are `rev: "inverse"`. A stryke
// transaction reads that classification and DECIDES on it: an `inverse` verb is allowed inside a
// transaction and journaled for compensation; an `irreversible` one is refused up front. So a verb
// that claims `inverse` and cannot actually undo itself does not fail loudly — it strands a
// half-applied multi-step chain on the user's source tree. These tests drive the real `verbs.js`
// against the real `zgui-core/webui/automation.js` with a recording `invoke`, and assert the
// snapshot/compensate protocol at the wire level: which `txn_snapshot` paths were taken, whether
// the token survived to the result, and what `txnAbort` unwound, in what order.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const VERBS = path.join(__dirname, "verbs.js");
// The submodule source, not the gitignored frontend/lib copy — the copy may not exist in a clean
// checkout, and a test that silently skips is worse than no test.
const AUTOMATION = path.join(__dirname, "..", "crates", "zgui-core", "webui", "automation.js");

/**
 * Boot automation.js + verbs.js in a vm with a scripted Tauri host.
 *   replies: { [command]: (args) => value | Error }   what each invoke resolves (or rejects) with
 * Returns the live `ZGui.automation`, plus every invoke in call order.
 */
function boot(replies) {
  const calls = [];
  let token = 0;
  const table = Object.assign({
    // Defaults good enough for the verbs that do not care.
    list_dir: () => ({ dir: "/proj" }),
    txn_snapshot: () => `tok${++token}`,
    txn_restore: () => ({ restored: [], removed: [], failed: [] }),
    txn_discard: () => null,
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
  const ctx = { window: win, console, Promise, Object, Array, JSON, String, Number, Error, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(AUTOMATION, "utf8"), ctx);
  vm.runInContext(fs.readFileSync(VERBS, "utf8"), ctx);
  return { A: win.ZGui.automation, calls, win, of: (cmd) => calls.filter((c) => c.cmd === cmd) };
}

function verbById(surface, id) {
  return surface.verbs.find((v) => v.id === id);
}

test("the surface is zmax-gui's own, not just the shell's", () => {
  const { A } = boot();
  const s = A.surface();
  assert.equal(s.app, "zmax-gui");
  assert.ok(s.verbs.length >= 40, `only ${s.verbs.length} verbs published`);
  assert.ok(s.state.length >= 5, "no state queries published");
  assert.ok(s.events.length >= 3, "no events declared");
});

test("every verb declares a reversibility class the bus recognises, and no verb defaults into one", () => {
  const { A } = boot();
  for (const v of A.surface().verbs) {
    assert.ok(["pure", "inverse", "irreversible"].includes(v.rev), `${v.id} has rev ${v.rev}`);
  }
  // `revOf` downgrades a verb that claims "inverse" without an undo(). If any of the mutating verbs
  // had lost its undo, it would silently appear here as "irreversible" instead.
  const mutating = [
    "zmax.replace.apply", "zmax.rename.apply", "zmax.sort.apply", "zmax.cleanup.apply",
    "zmax.align.apply", "zmax.comment.apply", "zmax.encoding.apply", "zmax.doc.replace",
    "zmax.file.create", "zmax.file.rename", "zmax.file.copy", "zmax.file.delete", "zmax.git.discard",
  ];
  const surface = A.surface();
  for (const id of mutating) {
    const v = verbById(surface, id);
    assert.ok(v, `${id} is not published`);
    assert.equal(v.rev, "inverse", `${id} is not reversible — its undo() is missing or unrecognised`);
  }
});

test("reads and dry runs are pure, so a transaction runs them unjournalled", () => {
  const { A } = boot();
  const surface = A.surface();
  for (const id of ["zmax.project.search", "zmax.git.status", "zmax.replace.preview", "zmax.rename.preview"]) {
    assert.equal(verbById(surface, id).rev, "pure", `${id} must be pure`);
  }
});

test("a preview never applies — the dry-run verbs force apply:false", async () => {
  const seen = [];
  const { A } = boot({
    replace_project: (a) => { seen.push(a.opts); return { hits: [], applied: false }; },
    batch_rename: (a) => { seen.push(a.opts); return { plans: [], applied: false }; },
  });
  await A.call("zmax.replace.preview", { query: "a", replacement: "b", opts: { apply: true, regex: true } });
  await A.call("zmax.rename.preview", { find: "a", replace: "b", opts: { apply: true } });
  assert.deepEqual(seen.map((o) => o.apply), [false, false], "a preview asked the backend to APPLY");
  assert.equal(seen[0].regex, true, "the caller's other options must survive");
});

test("a project-wide replace snapshots exactly the files its own dry run named", async () => {
  const env = boot({
    replace_project: (a) =>
      a.opts.apply
        ? { hits: [], applied: true, total: 3, files: 2 }
        : {
            applied: false,
            truncated: false,
            hits: [
              { path: "/proj/a.rs", rel: "a.rs", line: 1, col: 1 },
              { path: "/proj/a.rs", rel: "a.rs", line: 9, col: 4 },
              { path: "/proj/b.rs", rel: "b.rs", line: 2, col: 1 },
            ],
            doc_hits: [{ path: "/proj/spec.docx" }],
          },
  });
  const res = await env.A.call("zmax.replace.apply", { query: "old", replacement: "new" });

  const snaps = env.of("txn_snapshot");
  assert.equal(snaps.length, 1, "the mutation ran without a snapshot");
  assert.deepEqual(
    snaps[0].args.paths.slice().sort(),
    ["/proj/a.rs", "/proj/b.rs", "/proj/spec.docx"],
    "the snapshot must cover every hit file once, documents included",
  );
  assert.equal(res.txn, "tok1", "the snapshot token must ride out in the result for undo()");
  // Order is the whole point: snapshot BEFORE the applying call, never after it.
  const order = env.calls.map((c) => c.cmd).filter((c) => c === "txn_snapshot" || c === "replace_project");
  assert.deepEqual(order, ["replace_project", "txn_snapshot", "replace_project"],
    "the dry run, then the snapshot, then the apply");
});

test("a truncated preview refuses to run rather than snapshot a partial file list", async () => {
  const env = boot({
    replace_project: (a) =>
      a.opts.apply ? { applied: true } : { applied: false, truncated: true, hits: [{ path: "/proj/a.rs" }] },
  });
  await assert.rejects(
    () => env.A.call("zmax.replace.apply", { query: "x", replacement: "y" }),
    /truncated/,
    "a capped preview must not be treated as the complete file list",
  );
  assert.equal(env.of("txn_snapshot").length, 0, "nothing may be snapshotted");
  assert.equal(env.of("replace_project").filter((c) => c.args.opts.apply).length, 0, "nothing may be applied");
});

test("a mutation that changed nothing releases its snapshot instead of arming a bogus undo", async () => {
  const env = boot({
    // `applied: false` is what the backend returns when the transform produced identical content.
    sort_file_lines: () => ({ applied: false, differs: false }),
  });
  const res = await env.A.call("zmax.sort.apply", { path: "/proj/a.txt" });
  assert.equal(res.txn, null, "a verb that wrote nothing must not carry a token");
  assert.equal(env.of("txn_discard").length, 1, "the unused snapshot must be released");

  await env.A.undo("zmax.sort.apply", { path: "/proj/a.txt" }, res);
  assert.equal(env.of("txn_restore").length, 0, "undoing a no-op must not rewrite the file");
});

test("a rename records both sides; a copy records only the destination", async () => {
  const env = boot({ rename_path: () => null, copy_path: () => null });
  await env.A.call("zmax.file.rename", { from: "/proj/old.rs", to: "/proj/new.rs" });
  await env.A.call("zmax.file.copy", { from: "/proj/src.rs", to: "/proj/dst.rs" });

  const snaps = env.of("txn_snapshot");
  assert.deepEqual(snaps[0].args.paths, ["/proj/old.rs", "/proj/new.rs"],
    "undoing a rename needs the source back AND the destination gone");
  assert.deepEqual(snaps[1].args.paths, ["/proj/dst.rs"],
    "a copy does not touch its source — snapshotting it would rewrite an unedited file on abort");
});

test("undo hands the verb's own token to txn_restore, then releases it", async () => {
  const env = boot({ convert_file: () => ({ applied: true }) });
  const res = await env.A.call("zmax.cleanup.apply", { path: "/proj/a.txt" });
  await env.A.undo("zmax.cleanup.apply", { path: "/proj/a.txt" }, res);

  assert.deepEqual(env.of("txn_restore").map((c) => c.args.token), [res.txn]);
  // Restoring twice off one token would double-apply a compensation, so the token is dropped after.
  assert.ok(env.of("txn_discard").some((c) => c.args.token === res.txn), "the token must be released after restore");
});

test("aborting a transaction compensates every step, newest first", async () => {
  const env = boot({
    sort_file_lines: () => ({ applied: true }),
    convert_file: () => ({ applied: true }),
    align_columns: () => ({ applied: true }),
  });
  const txn = env.A.txnBegin();
  await env.A.call("zmax.sort.apply", { path: "/proj/1.txt" });
  await env.A.call("zmax.cleanup.apply", { path: "/proj/2.txt" });
  await env.A.call("zmax.align.apply", { path: "/proj/3.txt", opts: { separator: "=" } });

  const report = await env.A.txnAbort(txn);
  assert.equal(report.compensated, 3, `only ${report.compensated} of 3 steps were compensated`);
  assert.deepEqual(report.failed, []);
  // Reverse order is not cosmetic: step 3 may depend on step 2's output, so unwinding forwards can
  // restore a file that a later step is about to overwrite again.
  assert.deepEqual(env.of("txn_restore").map((c) => c.args.token), ["tok3", "tok2", "tok1"]);
});

test("a transaction refuses the verbs that cannot be unwound, before they run", async () => {
  const env = boot({ git_checkout_branch: () => null });
  env.A.txnBegin();
  await assert.rejects(
    () => env.A.call("zmax.git.checkout", { name: "main" }),
    /not reversible/,
    "a branch checkout inside a transaction must be refused, not journaled",
  );
  assert.equal(env.of("git_checkout_branch").length, 0, "the refused verb must not have run");
});

test("a verb that throws leaves no snapshot behind and still reports the failure", async () => {
  const env = boot({ delete_path: () => new Error("permission denied") });
  await assert.rejects(() => env.A.call("zmax.file.delete", { path: "/proj/a.txt" }), /permission denied/);
  assert.equal(env.of("txn_snapshot").length, 1);
  assert.equal(env.of("txn_discard").length, 1, "the snapshot of a failed mutation must not leak");
});

test("state queries answer from the backend, and the root is resolved once", async () => {
  const env = boot({
    recent_list: () => ["/proj/a.rs"],
    git_branch: () => "main",
  });
  assert.deepEqual(await env.A.get("zmax.recent"), ["/proj/a.rs"]);
  assert.equal(await env.A.get("zmax.branch"), "main");
  assert.equal(await env.A.get("zmax.root"), "/proj");
  assert.equal(env.of("list_dir").length, 1, "the project root must be cached, not re-walked per verb");
});
