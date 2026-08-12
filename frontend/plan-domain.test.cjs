// The Batch Plan's domain (R9) and the meaning of a painted cell.
//
// The grid engine is shared and already tested in zpwr-clip-engine; what is zmax-gui's to get right
// is the translation between "what the user painted" and "what gets run against their files". Two
// failures there are silent and destructive rather than loud: running steps in an order the grid
// does not read in, and letting a stale index — a plan persists across sessions, the project's file
// list does not — retarget an operation at whatever file now sits at that position. Both are
// asserted below.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DOMAIN = pathToFileURL(path.join(__dirname, "plan-domain.js")).href;

const OPS = [
  { id: "cleanup", verb: "zmax.cleanup.apply", label: "Clean up", args: { opts: { trim_trailing: true } } },
  { id: "sort", verb: "zmax.sort.apply", label: "Sort lines", args: { opts: {} } },
];
const FILES = [
  { path: "/proj/a.rs", rel: "a.rs" },
  { path: "/proj/b.rs", rel: "b.rs" },
  { path: "/proj/c.rs", rel: "c.rs" },
];

/** The subset of the grid model's API a domain's serialize/deserialize touches. */
function fakeModel() {
  const lanes = new Map();
  return {
    set(laneId, key, value) {
      if (!lanes.has(laneId)) lanes.set(laneId, new Map());
      lanes.get(laneId).set(String(key), value);
    },
    laneCells(laneId) { return lanes.get(laneId) || new Map(); },
  };
}

test("the axis is one cell per file, grouped, labelled by base name", async () => {
  const { fileAxis } = await import(DOMAIN);
  const axis = fileAxis({ getFiles: () => FILES });
  const ta = axis.timeAxis();
  assert.equal(ta.totalUnits, 3);
  assert.deepEqual(ta.cells.map((c) => c.key), ["0", "1", "2"]);
  assert.equal(axis.label(1), "b.rs", "a column is named by its file, not by its index");
  assert.equal(ta.groups.length, 1, "three files fit in one group of ten");
});

test("an empty file list still yields a drawable axis", async () => {
  const { fileAxis } = await import(DOMAIN);
  const ta = fileAxis({ getFiles: () => [] }).timeAxis();
  // A zero-unit axis divides by zero in the renderer's unit→pixel mapping; one placeholder cell is
  // an empty grid, which is what an empty project should look like.
  assert.equal(ta.totalUnits, 1);
});

test("lanes are the operations, in the order they will be applied within a file", async () => {
  const { createPlanDomain, fileAxis } = await import(DOMAIN);
  const d = createPlanDomain({ axis: fileAxis({ getFiles: () => FILES }), getOps: () => OPS });
  assert.deepEqual(d.lanes().map((l) => l.id), ["cleanup", "sort"]);
  assert.equal(d.value.type, "bool", "a plan cell is on or off");
  assert.equal(d.capabilities.valueDrag, false, "there is no partial application of an operation");
});

test("serialize round-trips through deserialize", async () => {
  const { createPlanDomain, fileAxis } = await import(DOMAIN);
  const d = createPlanDomain({ axis: fileAxis({ getFiles: () => FILES }), getOps: () => OPS });
  const m = fakeModel();
  m.set("cleanup", "2", 1);
  m.set("cleanup", "0", 1);
  m.set("sort", "1", 1);
  const plan = d.serialize(m);
  assert.deepEqual(plan, { cleanup: [0, 2], sort: [1] }, "indices must come out ascending");

  const m2 = fakeModel();
  d.deserialize(plan, m2);
  assert.deepEqual(d.serialize(m2), plan);
});

test("an unpainted lane is absent, not an empty array", async () => {
  const { createPlanDomain, fileAxis } = await import(DOMAIN);
  const d = createPlanDomain({ axis: fileAxis({ getFiles: () => FILES }), getOps: () => OPS });
  const m = fakeModel();
  m.set("sort", "0", 1);
  assert.deepEqual(d.serialize(m), { sort: [0] });
});

test("an erased cell (value 0) is not a step", async () => {
  const { createPlanDomain, fileAxis } = await import(DOMAIN);
  const d = createPlanDomain({ axis: fileAxis({ getFiles: () => FILES }), getOps: () => OPS });
  const m = fakeModel();
  m.set("sort", "0", 1);
  m.set("sort", "1", 0);   // painted then erased — the model keeps the key with a falsy value
  assert.deepEqual(d.serialize(m), { sort: [0] });
});

test("steps run column-major: everything for one file, then the next", async () => {
  const { planSteps } = await import(DOMAIN);
  const steps = planSteps({ cleanup: [0, 2], sort: [0, 1] }, OPS, FILES);
  assert.deepEqual(
    steps.map((s) => s.file + ":" + s.op),
    ["0:cleanup", "0:sort", "1:sort", "2:cleanup"],
    "the grid reads left to right by file; the runner must execute in that same order",
  );
});

test("each step carries the file path and the lane's fixed arguments", async () => {
  const { planSteps } = await import(DOMAIN);
  const [first] = planSteps({ cleanup: [1] }, OPS, FILES);
  assert.equal(first.verb, "zmax.cleanup.apply");
  assert.equal(first.args.path, "/proj/b.rs");
  assert.deepEqual(first.args.opts, { trim_trailing: true });
});

test("a lane's args cannot overwrite the step's own path", async () => {
  const { planSteps } = await import(DOMAIN);
  const ops = [{ id: "x", verb: "v", args: { path: "/elsewhere", opts: {} } }];
  const [step] = planSteps({ x: [0] }, ops, FILES);
  // Object.assign order puts the lane's args last, so a lane declaring `path` would redirect every
  // step at one file. That must not be possible from a lane definition.
  assert.notEqual(step.args.path, "/elsewhere", "a lane must not be able to retarget the plan's file");
});

test("a painted index past the end of the file list is dropped, and counted", async () => {
  const { planSteps, staleCells } = await import(DOMAIN);
  // A plan saved when the project had ten files, reopened when it has three.
  const plan = { cleanup: [0, 7], sort: [9] };
  const steps = planSteps(plan, OPS, FILES);
  assert.deepEqual(steps.map((s) => s.path), ["/proj/a.rs"],
    "a stale index must not silently retarget the operation at a different file");
  assert.equal(staleCells(plan, FILES), 2, "the dropped cells must be reportable, not invisible");
  assert.equal(staleCells(plan, []), 3);
});

test("an empty or malformed plan yields no steps rather than throwing", async () => {
  const { planSteps } = await import(DOMAIN);
  assert.deepEqual(planSteps(null, OPS, FILES), []);
  assert.deepEqual(planSteps({}, OPS, FILES), []);
  assert.deepEqual(planSteps({ cleanup: "nope" }, OPS, FILES), []);
  assert.deepEqual(planSteps({ unknownLane: [0] }, OPS, FILES), []);
});

test("every operation lane the panel offers names a reversible verb", async () => {
  // The panel's transactional runner only works because each lane's verb is `rev: "inverse"`. A lane
  // pointing at an irreversible verb would be refused mid-chain, stranding the steps before it.
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(__dirname, "verbs.js"), "utf8");
  const panel = fs.readFileSync(path.join(__dirname, "plan-panel.js"), "utf8");
  const laneVerbs = [...panel.matchAll(/verb:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(laneVerbs.length >= 4, `only ${laneVerbs.length} lanes found`);
  for (const v of new Set(laneVerbs)) {
    // The verb must be built by `reversible(...)`, which is the only constructor that attaches undo.
    const decl = new RegExp(`reversible\\(\\{[^}]*?id:\\s*"${v.replace(/\./g, "\\.")}"`, "s");
    assert.match(src, decl, `${v} is a plan lane but is not a reversible verb`);
  }
});
