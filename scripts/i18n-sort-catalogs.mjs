#!/usr/bin/env node
/**
 * Sort every locale catalog's top-level keys lexicographically (Node, not python — house rule).
 *
 * zmax-gui does NOT own its catalogs: they live in the shared `zpwr-i18n` submodule
 * (`crates/zpwr-i18n/i18n/<locale>.json`) and are copied into the gitignored `frontend/i18n/` by
 * `copy-i18n.mjs`. Sorting the copies would be undone by the next build, so this operates on the
 * SOURCE — and says so loudly, because the resulting diff has to be committed in that submodule,
 * not here.
 *
 *   node scripts/i18n-sort-catalogs.mjs           sort in place (edits crates/zpwr-i18n)
 *   node scripts/i18n-sort-catalogs.mjs --check   read-only; exit 1 if any catalog is unsorted
 *
 * Output format is `JSON.stringify(sorted, null, 2) + "\n"` — 2-space indent, trailing newline,
 * non-ASCII left literal — so re-sorting an already-sorted catalog is a byte-level no-op.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const i18nDir = join(root, 'crates', 'zpwr-i18n', 'i18n');
const check = process.argv.includes('--check');

if (!existsSync(i18nDir)) {
  console.error(`i18n-sort: ${i18nDir} is missing (run: git submodule update --init crates/zpwr-i18n)`);
  process.exit(1);
}

const files = readdirSync(i18nDir).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error('i18n-sort: no catalogs found');
  process.exit(1);
}

const unsorted = [];
for (const name of files) {
  const path = join(i18nDir, name);
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  const sorted = {};
  for (const key of Object.keys(data).sort()) sorted[key] = data[key];
  const text = JSON.stringify(sorted, null, 2) + '\n';
  if (raw === text) continue;
  unsorted.push(name);
  if (check) continue;
  writeFileSync(path, text, 'utf8');
  console.log(`sorted keys → ${name}`);
}

if (check) {
  if (unsorted.length) {
    console.error(`unsorted catalogs: ${unsorted.join(', ')}\nRun: pnpm run i18n:sort`);
    process.exit(1);
  }
  console.log(`all ${files.length} zpwr-i18n catalogs already sorted`);
} else if (unsorted.length === 0) {
  console.log(`all ${files.length} zpwr-i18n catalogs already sorted`);
} else {
  console.log(`i18n-sort: ${unsorted.length} catalog(s) rewritten IN crates/zpwr-i18n — commit them there, not in zmax-gui`);
}
