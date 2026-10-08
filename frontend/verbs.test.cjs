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

test("line filters: previews never apply, applies snapshot exactly the one file and arm an undo", async () => {
  const seen = [];
  const env = boot({
    filter_file_lines: (a) => { seen.push(["filter", a.opts.apply]); return { applied: a.opts.apply, differs: true, removed: 2 }; },
    dedupe_file_lines: (a) => { seen.push(["dedupe", a.opts.apply]); return { applied: a.opts.apply, differs: true, removed: 1 }; },
  });
  const s = env.A.surface();
  for (const id of ["zmax.lines.filterPreview", "zmax.lines.dedupePreview"]) assert.equal(verbById(s, id).rev, "pure", id);
  for (const id of ["zmax.lines.filterApply", "zmax.lines.dedupeApply"]) assert.equal(verbById(s, id).rev, "inverse", id);

  await env.A.call("zmax.lines.filterPreview", { path: "/proj/a.txt", opts: { pattern: "x", keep: false, apply: true } });
  await env.A.call("zmax.lines.dedupePreview", { path: "/proj/a.txt", opts: { apply: true } });
  assert.equal(env.of("txn_snapshot").length, 0, "a preview must not take a snapshot");

  const f = await env.A.call("zmax.lines.filterApply", { path: "/proj/a.txt", opts: { pattern: "x", keep: false } });
  const d = await env.A.call("zmax.lines.dedupeApply", { path: "/proj/b.txt" });
  assert.deepEqual(seen, [["filter", false], ["dedupe", false], ["filter", true], ["dedupe", true]]);
  assert.equal(env.of("filter_file_lines")[1].args.opts.pattern, "x", "the caller's pattern must survive");
  assert.deepEqual(env.of("txn_snapshot").map((c) => c.args.paths), [["/proj/a.txt"], ["/proj/b.txt"]]);
  assert.ok(f.txn && d.txn, "an applied filter must carry its compensation token");
});

test("a tag created over the bus is undone by deleting that tag in the same repository", async () => {
  const env = boot({ git_tag_create: () => null, git_tag_delete: () => null });
  const surface = env.A.surface();
  assert.equal(verbById(surface, "zmax.git.tagCreate").rev, "inverse");
  assert.equal(verbById(surface, "zmax.git.tagDelete").rev, "irreversible",
    "deleting an annotated tag loses its message — it must not claim an undo");

  const res = await env.A.call("zmax.git.tagCreate", { name: "v1.0", message: "rel" });
  assert.deepEqual(env.of("git_tag_create")[0].args, { root: "/proj", name: "v1.0", message: "rel", rev: null });
  await env.A.undo("zmax.git.tagCreate", { name: "v1.0" }, res);
  assert.deepEqual(env.of("git_tag_delete").map((c) => c.args), [{ root: "/proj", name: "v1.0" }]);
});

test("a commit is irreversible, refused inside a transaction, and announced when it lands", async () => {
  const env = boot({ git_commit: () => ({ hash: "abc123", short: "abc123", subject: "fix" }) });
  assert.equal(verbById(env.A.surface(), "zmax.git.commit").rev, "irreversible");

  const events = [];
  env.A.on("zmax.git.committed", (p) => events.push(p));
  const r = await env.A.call("zmax.git.commit", { message: "fix", amend: true });
  assert.equal(r.hash, "abc123");
  assert.deepEqual(env.of("git_commit")[0].args, { root: "/proj", message: "fix", amend: true, signOff: false });
  assert.deepEqual(events, [{ root: "/proj", hash: "abc123", subject: "fix" }]);

  env.A.txnBegin();
  await assert.rejects(() => env.A.call("zmax.git.commit", { message: "again" }), /not reversible/);
  assert.equal(env.of("git_commit").length, 1, "the refused commit must not have run");
});

test("conflict resolution: the preview never writes, the resolve snapshots the one file and keeps the hunk address", async () => {
  const env = boot({
    resolve_conflicts: (a) => ({ applied: !!a.opts.apply, differs: true, remaining: 1, resolved: 1, hunks_before: 2 }),
  });
  const s = env.A.surface();
  for (const id of ["zmax.conflicts.scan", "zmax.conflicts.file", "zmax.conflicts.preview"]) assert.equal(verbById(s, id).rev, "pure", id);
  assert.equal(verbById(s, "zmax.conflicts.resolve").rev, "inverse");

  await env.A.call("zmax.conflicts.preview", { path: "/proj/a.rs", take: "theirs", hunk: 0 });
  assert.equal(env.of("txn_snapshot").length, 0, "a preview must not take a snapshot");
  const r = await env.A.call("zmax.conflicts.resolve", { path: "/proj/a.rs", take: "ours", hunk: 1 });
  // Hunk 0 is a real address, not "every hunk": it must not collapse to null on the way through.
  assert.deepEqual(env.of("resolve_conflicts").map((c) => c.args.opts), [
    { take: "theirs", hunk: 0, apply: false },
    { take: "ours", hunk: 1, apply: true },
  ]);
  await env.A.call("zmax.conflicts.resolve", { path: "/proj/b.rs", take: "both" });
  assert.equal(env.of("resolve_conflicts")[2].args.opts.hunk, null, "no hunk means every hunk");
  assert.deepEqual(env.of("txn_snapshot").map((c) => c.args.paths), [["/proj/a.rs"], ["/proj/b.rs"]]);
  assert.ok(r.txn, "an applied resolution must carry its compensation token");
});

test("a branch made at a revision is undone by a compare-and-delete against the hash it was made at", async () => {
  const env = boot({
    git_branch_at: (a) => ({ name: a.name, hash: "f".repeat(40) }),
    git_branch_delete_at: () => null,
  });
  assert.equal(verbById(env.A.surface(), "zmax.git.branchAt").rev, "inverse");
  const res = await env.A.call("zmax.git.branchAt", { name: "rescue", rev: "HEAD@{2}" });
  assert.deepEqual(env.of("git_branch_at")[0].args, { root: "/proj", name: "rescue", rev: "HEAD@{2}" });
  await env.A.undo("zmax.git.branchAt", { name: "rescue", rev: "HEAD@{2}" }, res);
  assert.deepEqual(env.of("git_branch_delete_at").map((c) => c.args),
    [{ root: "/proj", name: "rescue", hash: "f".repeat(40) }],
    "the undo must name the commit, or it could delete work landed on the branch since");
});

test("cherry-pick / revert are irreversible; a landed pick is a commit, a conflict stop is announced as a stop", async () => {
  let stop = false;
  const pick = () => (stop
    ? { stopped: true, op: "cherry-pick", unmerged: ["f.txt"], hash: null, subject: null }
    : { stopped: false, op: null, unmerged: [], hash: "abc123", subject: "add b" });
  const env = boot({ git_cherry_pick: pick, git_revert: pick, git_op_abort: () => null, git_op_continue: () => ({ op: null, unmerged: [] }) });
  const s = env.A.surface();
  for (const id of ["zmax.git.cherryPick", "zmax.git.revert", "zmax.git.opAbort", "zmax.git.opContinue"]) {
    assert.equal(verbById(s, id).rev, "irreversible", id);
  }
  assert.equal(verbById(s, "zmax.git.reflog").rev, "pure");
  assert.equal(verbById(s, "zmax.git.logSearch").rev, "pure");

  const committed = [], stopped = [];
  env.A.on("zmax.git.committed", (p) => committed.push(p));
  env.A.on("zmax.git.stopped", (p) => stopped.push(p));
  await env.A.call("zmax.git.cherryPick", { rev: "abc", recordOrigin: true });
  assert.deepEqual(env.of("git_cherry_pick")[0].args, { root: "/proj", rev: "abc", noCommit: false, recordOrigin: true });
  stop = true;
  const r = await env.A.call("zmax.git.revert", { rev: "def", recordOrigin: true });
  assert.equal(r.stopped, true, "a conflict stop resolves, it does not reject");
  assert.deepEqual(env.of("git_revert")[0].args, { root: "/proj", rev: "def", noCommit: false },
    "revert has no -x: the option must not reach the host");
  assert.deepEqual(committed, [{ root: "/proj", hash: "abc123", subject: "add b" }]);
  assert.deepEqual(stopped, [{ root: "/proj", op: "cherry-pick", unmerged: ["f.txt"] }]);

  env.A.txnBegin();
  await assert.rejects(() => env.A.call("zmax.git.cherryPick", { rev: "abc" }), /not reversible/);
  assert.equal(env.of("git_cherry_pick").length, 1, "the refused pick must not have run");
});

test("history search carries the mode into the host's opts and keeps the caller's flags", async () => {
  const env = boot({ git_log_search: () => [] });
  await env.A.call("zmax.git.logSearch", { query: "fn alpha", mode: "regex", opts: { ignore_case: true, path: "src" } });
  assert.deepEqual(env.of("git_log_search")[0].args, {
    root: "/proj", query: "fn alpha", opts: { ignore_case: true, path: "src", mode: "regex" },
  });
});

test("remotes, bisect, line history and worktrees: reads are pure, network and checkout steps refuse a transaction", async () => {
  const env = boot({ git_push: () => ({ output: "", status: { upstream: "origin/main" } }), git_bisect_mark: () => ({ active: true, first_bad: null }) });
  const s = env.A.surface();
  for (const id of ["zmax.git.remotes", "zmax.git.upstream", "zmax.git.bisectState", "zmax.git.lineLog", "zmax.git.worktrees"]) {
    assert.equal(verbById(s, id).rev, "pure", id);
  }
  for (const id of ["zmax.git.remoteAdd", "zmax.git.worktreeAdd"]) assert.equal(verbById(s, id).rev, "inverse", id);
  for (const id of ["zmax.git.remoteRemove", "zmax.git.fetch", "zmax.git.pull", "zmax.git.push", "zmax.git.bisectStart",
    "zmax.git.bisectMark", "zmax.git.bisectRun", "zmax.git.bisectReset", "zmax.git.worktreeRemove", "zmax.git.worktreePrune"]) {
    assert.equal(verbById(s, id).rev, "irreversible", id);
  }
  env.A.txnBegin();
  await assert.rejects(() => env.A.call("zmax.git.push", {}), /not reversible/);
  await assert.rejects(() => env.A.call("zmax.git.bisectMark", { verdict: "good" }), /not reversible/);
  assert.equal(env.of("git_push").length + env.of("git_bisect_mark").length, 0, "a refused step must not have run");
});

test("a remote add is undone only while the remote still points at the URL it was added with", async () => {
  const env = boot({
    git_remote_add: (a) => ({ name: a.name, fetch_url: a.url, push_url: a.url }),
    git_remote_remove: () => null,
  });
  const res = await env.A.call("zmax.git.remoteAdd", { name: "up", url: "/srv/up.git" });
  await env.A.undo("zmax.git.remoteAdd", { name: "up", url: "/srv/up.git" }, res);
  assert.deepEqual(env.of("git_remote_remove").map((c) => c.args), [{ root: "/proj", name: "up", expectUrl: "/srv/up.git" }],
    "without the URL the undo could remove a remote someone re-pointed since");
  await env.A.call("zmax.git.remoteRemove", { name: "old" });
  assert.deepEqual(env.of("git_remote_remove")[1].args, { root: "/proj", name: "old", expectUrl: null });
});

test("a worktree add is undone by an unforced remove, then the branch it created is deleted at its commit", async () => {
  const head = "c".repeat(40);
  const env = boot({
    git_worktree_add: (a) => ({ path: "/real" + a.path, branch: a.branch, head }),
    git_worktree_remove: () => null,
    git_branch_delete_at: () => null,
  });
  const made = await env.A.call("zmax.git.worktreeAdd", { path: "/w1", branch: "hotfix", newBranch: true });
  await env.A.undo("zmax.git.worktreeAdd", {}, made);
  assert.deepEqual(env.of("git_worktree_remove").map((c) => c.args), [{ root: "/proj", path: "/real/w1", force: false }],
    "the undo removes the path git reported, and never forces");
  assert.deepEqual(env.of("git_branch_delete_at").map((c) => c.args), [{ root: "/proj", name: "hotfix", hash: head }]);

  // An existing branch was only checked out: the undo must not delete it.
  const existing = await env.A.call("zmax.git.worktreeAdd", { path: "/w2", branch: "main" });
  await env.A.undo("zmax.git.worktreeAdd", {}, existing);
  assert.equal(env.of("git_worktree_remove").length, 2);
  assert.equal(env.of("git_branch_delete_at").length, 1, "a pre-existing branch survives the undo");

  // A failed remove (the checkout holds work) stops the undo before any branch is touched.
  const env2 = boot({
    git_worktree_add: (a) => ({ path: a.path, branch: a.branch, head }),
    git_worktree_remove: () => new Error("contains modified or untracked files"),
    git_branch_delete_at: () => null,
  });
  const r2 = await env2.A.call("zmax.git.worktreeAdd", { path: "/w3", branch: "x", newBranch: true });
  await assert.rejects(() => env2.A.undo("zmax.git.worktreeAdd", {}, r2), /modified/);
  assert.equal(env2.of("git_branch_delete_at").length, 0);
});

test("pull, push and bisect announce what happened", async () => {
  let pull = { stopped: false, before: "a", after: "b", unmerged: [] };
  let step = { active: true, first_bad: null };
  const env = boot({
    git_pull: () => pull,
    git_push: () => ({ output: "", status: { upstream: "origin/dev" } }),
    git_bisect_mark: () => step,
  });
  const seen = [];
  for (const ev of ["zmax.git.pulled", "zmax.git.stopped", "zmax.git.pushed", "zmax.git.bisectFound"]) {
    env.A.on(ev, (p) => seen.push([ev, p]));
  }
  await env.A.call("zmax.git.pull", {});
  assert.equal(env.of("git_pull")[0].args.mode, "ff-only", "the default pull never makes a merge commit");
  pull = { stopped: false, before: "b", after: "b", unmerged: [] };
  await env.A.call("zmax.git.pull", { mode: "rebase" });
  pull = { stopped: true, op: "rebase", unmerged: ["f"], before: "b", after: "b" };
  await env.A.call("zmax.git.pull", { mode: "rebase" });
  await env.A.call("zmax.git.push", { remote: "origin", setUpstream: true });
  assert.deepEqual(env.of("git_push")[0].args, { root: "/proj", remote: "origin", branch: null, setUpstream: true, forceWithLease: false });
  await env.A.call("zmax.git.bisectMark", { verdict: "bad" });
  step = { active: true, first_bad: { hash: "h", short: "h", subject: "broke it" } };
  await env.A.call("zmax.git.bisectMark", { verdict: "bad" });
  assert.deepEqual(seen, [
    ["zmax.git.pulled", { root: "/proj", before: "a", after: "b" }],
    ["zmax.git.stopped", { root: "/proj", op: "rebase", unmerged: ["f"] }],
    ["zmax.git.pushed", { root: "/proj", upstream: "origin/dev" }],
    ["zmax.git.bisectFound", { root: "/proj", hash: "h", subject: "broke it" }],
  ], "an up-to-date pull and an unfinished bisect step announce nothing");
});
