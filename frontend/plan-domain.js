// plan-domain.js — zmax-gui's DOMAIN for the shared zpwr-clip-engine arrangement grid (R9).
//
// The family's timeline substrate is content-agnostic: one canvas renderer, one model, one
// interaction model, N domains (`GUI_APP_REQUIREMENTS.md` R9). Nothing in the grid engine is forked
// or copied here — this file supplies only the content-specific half.
//
// zmax-gui's sequence-ordered content is a **batch plan**: an ordered run of project files, and for
// each of them the reversible workbench operations to apply. Lanes are the operations, cells are
// the files in run order, and a painted cell means "apply this lane's operation to this file". The
// grid is the composer; `verbs.js` is the executor, and because every lane is a `rev: "inverse"`
// bus verb the whole painted plan runs inside ONE transaction that compensates on failure.
//
//   const axis = fileAxis({ getFiles });
//   createPlanDomain({ axis, getOps })   // bool — op × file: run this operation on this file?
//
// Column-major execution order (all of file 0's ops, then file 1's) is the shape `planSteps` emits,
// because that is how the plan reads on screen: a column IS a file.
//
// The serialized shape is the runner's argument shape, not a private encoding:
//   serialize → { opId: [fileIndex, …] }        → `planSteps(plan, ops, files)`
// so what the user painted IS what gets run — no translation layer to drift.
//
// ES module (the grid engine is one), DOM-free and deterministic.

/** Files per ruler group — the header then reads as blocks of ten rather than as cell indices. */
const GROUP = 10;

/**
 * The run-order ruler: one cell per project file, in the order the plan will visit them.
 *
 *   fileAxis({ getFiles })
 *     getFiles() -> [{ path, rel? }]   the plan's file list, in run order
 */
export function fileAxis(opts = {}) {
  const getFiles = opts.getFiles || (() => []);
  const files = () => getFiles() || [];
  const count = () => Math.max(1, files().length);

  /** A cell's label is the file's short name — the plan is read by file, not by index. */
  const label = (i) => {
    const f = files()[i];
    if (!f) return String(i);
    const p = String(f.rel || f.path || "");
    return p.slice(p.lastIndexOf("/") + 1) || p;
  };

  function timeAxis() {
    const n = count();
    const cells = [];
    for (let i = 0; i < n; i++) {
      cells.push({ key: String(i), lo: i, hi: i + 1, group: "g" + Math.floor(i / GROUP), beat: i % GROUP === 0 });
    }
    const groups = [];
    for (let g = 0; g * GROUP < n; g++) {
      const lo = g * GROUP;
      groups.push({ name: "g" + g, label: label(lo), lo, hi: Math.min(n, lo + GROUP) });
    }
    return { totalUnits: n, cells, groups };
  }

  return { timeAxis, label, count, files };
}

/**
 * PLAN — lanes are reversible operations, cells are files, a painted cell means "apply this
 * operation to this file". The bool value type is the shared triggers domain's; what differs is the
 * axis (a file run order, not abstract slots) and the serialized shape (the runner's argument).
 *
 *   createPlanDomain({ axis, getOps })
 *     getOps() -> [{ id, label?, color? }]   one per operation lane, in apply order within a file
 */
export function createPlanDomain(opts = {}) {
  const axis = opts.axis || fileAxis(opts);
  const getOps = opts.getOps || (() => []);
  const DEFAULT_COLOR = { fill: "rgba(5, 217, 232, 0.45)", stroke: "#05d9e8" };

  const domain = {
    id: "zmax-plan",
    lanes() {
      return (getOps() || []).map((o) => ({
        id: String(o.id),
        label: o.label || o.id,
        color: o.color || DEFAULT_COLOR,
        op: o,
      }));
    },
    timeAxis: axis.timeAxis,
    value: { type: "bool", min: 0, max: 1, step: 1, default: 1 },
    capabilities: {
      paint: true,
      erase: true,
      // A plan cell is on or off — there is no partial "apply 40% of a cleanup", so the height-drag
      // and ramp gestures are off rather than silently rounding to a bool.
      valueDrag: false,
      scroll: true,
      rangeSelect: true,
      ramp: false,
      resizableRegions: false,
    },
    /** `{ opId: [fileIndex, …] }`, indices ascending — the runner's argument verbatim. */
    serialize(model) {
      const out = {};
      domain.lanes().forEach((ln) => {
        const on = [];
        model.laneCells(ln.id).forEach((v, key) => {
          if (v) on.push(parseInt(key, 10));
        });
        if (on.length) out[ln.id] = on.sort((a, b) => a - b);
      });
      return out;
    },
    deserialize(json, model) {
      if (!json || typeof json !== "object") return;
      Object.keys(json).forEach((opId) => {
        const list = json[opId];
        if (!Array.isArray(list)) return;
        list.forEach((i) => model.set(opId, String(i), 1));
      });
    },
    labels: { laneAxis: "operation", timeAxis: "file", gutterPx: 150 },
  };
  return domain;
}

/**
 * Flatten a painted plan into the ordered step list the runner executes.
 *
 * Column-major: every operation painted on file 0 (in lane order), then file 1, and so on — the
 * reading order of the grid. A file with no painted cell contributes nothing rather than an empty
 * step, so the step count matches what the user can see.
 *
 *   planSteps(plan, ops, files) -> [{ file, path, op, verb, label }]
 *     plan  { opId: [fileIndex, …] }   `domain.serialize(model)`
 *     ops   [{ id, verb, label?, args? }]  lane order = apply order within one file
 *     files [{ path, rel? }]           the same list `fileAxis` was given
 *
 * An index that does not address a file in `files` is dropped: a plan is persisted across sessions,
 * and the project's file list changes under it, so a stale index must not silently retarget the
 * operation at whatever file now sits at that position.
 */
export function planSteps(plan, ops, files) {
  const byOp = plan || {};
  const opList = ops || [];
  const fileList = files || [];
  const steps = [];
  for (let i = 0; i < fileList.length; i++) {
    for (const op of opList) {
      const painted = byOp[String(op.id)];
      if (!Array.isArray(painted) || painted.indexOf(i) < 0) continue;
      steps.push({
        file: i,
        path: fileList[i].path,
        op: op.id,
        verb: op.verb,
        label: op.label || op.id,
        // The plan's file wins over anything the lane declares: a lane's `args` are its FIXED
        // options (`{ opts: … }`, `{ to: … }`), and one carrying a `path` would silently redirect
        // every step painted on it at that single file instead of at the column's.
        args: Object.assign({}, op.args || {}, { path: fileList[i].path }),
      });
    }
  }
  return steps;
}

/**
 * How many painted cells address a file that no longer exists in `files`. Reported to the user
 * rather than dropped in silence, because a plan that visibly has 12 cells and runs 9 steps is a
 * plan that lies.
 */
export function staleCells(plan, files) {
  const n = (files || []).length;
  let stale = 0;
  Object.keys(plan || {}).forEach((opId) => {
    const list = plan[opId];
    if (!Array.isArray(list)) return;
    list.forEach((i) => { if (!(i >= 0 && i < n)) stale++; });
  });
  return stale;
}
