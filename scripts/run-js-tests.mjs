#!/usr/bin/env node
/**
 * Run every zmax-gui JS test file via `node --test` without shell glob expansion (Windows `cmd` /
 * PowerShell do not expand globs the way bash does, so CI there would pass an unexpanded literal
 * to node). Ported from the sibling apps' runner.
 *
 * Discovers:
 *   - crates/zmax-gui-core/webui/*.test.cjs   the shared GUI surface (menu bridge, editor state)
 *   - frontend/**\/*.test.cjs, *.test.js      the app-local wiring, vocabulary, verbs and plan tests
 *
 * A run that discovers nothing EXITS NON-ZERO: `node --test` over an empty file list prints
 * "tests 0" and exits 0, so a moved directory or an unchecked-out submodule would otherwise read as
 * a clean pass.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'));

const isTest = (name) => name.endsWith('.test.cjs') || name.endsWith('.test.js');

/** Collect *.test.{cjs,js} under `dir`. `recursive` walks subdirs (skipping node_modules + vendored libs). */
function collect(dir, recursive) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // absent (submodule not checked out) — the emptiness check below is what fails
  }
  for (const d of entries) {
    // `frontend/lib` is vendored: zgui-core and the clip-engine ship their own suites, run in their
    // own repos. Running them here would report another repo's failures as this app's.
    if (d.name === 'node_modules' || d.name === 'lib') continue;
    const full = join(dir, d.name);
    if (d.isDirectory()) {
      if (recursive) out = out.concat(collect(full, true));
    } else if (d.isFile() && isTest(d.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...collect(join('crates', 'zmax-gui-core', 'webui'), false),
  ...collect('frontend', true),
]
  .filter((f, i, a) => a.indexOf(f) === i)
  .sort();

if (files.length === 0) {
  console.error('run-js-tests: no test files found — a path moved, or a submodule is not checked out');
  process.exit(1);
}
console.log(`run-js-tests: collected ${files.length} test file(s)`);

/** Stay well under the Windows ~8191 char command-line limit. */
const BATCH_SIZE = 28;
/** Per-test timeout so a stuck test cannot hang CI indefinitely. */
const TEST_TIMEOUT_MS = 300_000;

// Every batch runs even after one fails: bailing early turns the reported failure count into a
// floor rather than a total.
let failed = 0;
for (let i = 0; i < files.length; i += BATCH_SIZE) {
  const batch = files.slice(i, i + BATCH_SIZE);
  const r = spawnSync(process.execPath, ['--test', `--test-timeout=${TEST_TIMEOUT_MS}`, ...batch], {
    stdio: 'inherit',
    shell: false,
  });
  if ((r.status === null ? 1 : r.status) !== 0) failed += 1;
}

if (failed > 0) {
  console.error(`run-js-tests: ${failed} of ${Math.ceil(files.length / BATCH_SIZE)} batch(es) failed`);
  process.exit(1);
}
