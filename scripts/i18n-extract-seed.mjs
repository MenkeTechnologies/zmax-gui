#!/usr/bin/env node
/**
 * Extract zmax-gui's ENGLISH SEED from its own source (G3).
 *
 * Every translatable string in this app is already written twice: once as a key and once as the
 * English literal the call site falls back to — `T("zmax.file.save", "Save")`. That makes the
 * English catalog *derivable*, and deriving it is the only way it stays true: a hand-maintained
 * copy drifts from the call sites the moment someone edits a label.
 *
 * Output is `frontend/i18n-seed/en.json`, loaded at runtime by `frontend/i18n-seed.js` UNDER the
 * shared zpwr-i18n catalog (a shared translation always wins). It is the English layer only, and
 * deliberately so: inventing the other 26 locales from an English string is not translation, and a
 * fabricated catalog is worse than a missing one because the runtime treats a present value as a
 * successful lookup. `frontend/i18n-seed/` may therefore contain exactly one file.
 *
 *   node scripts/i18n-extract-seed.mjs           rewrite the seed from source
 *   node scripts/i18n-extract-seed.mjs --check    exit non-zero if the seed is not what source says
 *
 * TWO KINDS OF DRIFT ARE REFUSED OUTRIGHT rather than resolved by picking a winner:
 *
 *   * one key with two different English strings. The key is then a lie in at least one place: a
 *     translator sees one string, and one of the two call sites renders the wrong prompt in every
 *     language but English. (This found three: `zmax.macros.letter_msg` was Record / Replay /
 *     Target register, `zmax.file.open` was both a menu item that opens a dialog and a button that
 *     does not, and `zmax.panel.filter` was both the generic filter and the branch filter.)
 *   * a referenced key with no English literal anywhere. Nothing can be seeded for it.
 *
 * Only the `zmax.` namespace is extracted. The `ui.*` / `menu.*` / `fb.*` keys that also appear in
 * this app's markup belong to the shared file browser (zpwr-file-browser), whose vocabulary is not
 * this app's to define or to ship a catalog for.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(root, 'frontend', 'i18n-seed');
const OUT = join(OUT_DIR, 'en.json');
const NAMESPACE = 'zmax.';

/** The app's own surfaces. `frontend/lib` and the generated copies are excluded by construction. */
const SOURCE_DIRS = [join(root, 'frontend'), join(root, 'crates', 'zmax-gui-core', 'webui')];

/** Generated copies of files that live elsewhere — extracting them would double-count. */
const GENERATED = new Set(['menu.js', 'editor-state.js', 'editor-hud.js', 'i18n.js', 'terminal.js',
  'xterm.js', 'file-browser.js', 'file-browser.html']);

function sources() {
  const out = [];
  for (const dir of SOURCE_DIRS) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      if (!d.isFile()) continue;                                  // lib/ and i18n/ are vendored
      if (!/\.(html|js)$/.test(d.name)) continue;
      if (/\.test\.(cjs|js)$/.test(d.name)) continue;
      // The frontend copy of a file whose source is in crates/ is skipped; the source is read
      // directly, so a stale copy cannot contribute a stale string.
      if (dir.endsWith('frontend') && GENERATED.has(d.name)) continue;
      out.push(join(dir, d.name));
    }
  }
  return out.sort();
}

// `T("key", "English")` / `t("key", "English")`. The English half allows escapes so a literal
// containing \" or \n is captured whole rather than truncated at the escape.
//
// It also allows the literal to be BUILT BY CONCATENATION — `"first half " + "second half"` —
// because a default long enough to wrap is written that way, and capturing only the first literal
// seeded the catalogue a truncated sentence. English was unaffected (the JS engine concatenates at
// runtime), so the damage was invisible until a translator shipped a string ending mid-clause.
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/;
const CALL = new RegExp(
  String.raw`\b[tT]\(\s*"([a-z0-9_.]+)"\s*,\s*(` +
  STRING_LITERAL.source + String.raw`(?:\s*\+\s*` + STRING_LITERAL.source + String.raw`)*)`,
  'g',
);
// Any reference at all, with or without a literal — used to report keys nothing can seed.
const REF = /\b[tT]\(\s*"([a-z0-9_.]+)"|data-i18n(?:-[a-z]+)?="([^"]+)"/g;

const seeded = new Map();      // key → English
const origin = new Map();      // key → first file that defined it
const conflicts = [];
const referenced = new Set();

for (const file of sources()) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(root, file);
  for (const m of src.matchAll(REF)) {
    const k = m[1] || m[2];
    if (k && k.startsWith(NAMESPACE)) referenced.add(k);
  }
  for (const m of src.matchAll(CALL)) {
    const [, key, english] = m;
    if (!key.startsWith(NAMESPACE)) continue;
    // JSON.parse gives the same unescaping the JS parser applies to each source literal; joining
    // the pieces is what the JS engine does with `+` at runtime.
    const value = (english.match(new RegExp(STRING_LITERAL.source, 'g')) || [])
      .map((lit) => JSON.parse(lit)).join('');
    if (seeded.has(key) && seeded.get(key) !== value) {
      conflicts.push({ key, a: seeded.get(key), aFile: origin.get(key), b: value, bFile: rel });
      continue;
    }
    seeded.set(key, value);
    if (!origin.has(key)) origin.set(key, rel);
  }
}

const unseedable = [...referenced].filter((k) => !seeded.has(k)).sort();

let rc = 0;
if (conflicts.length) {
  rc = 1;
  console.error(`i18n-extract-seed: ${conflicts.length} key(s) carry two different English strings —`);
  console.error('  split them; one key cannot mean two things in a translated build:');
  for (const c of conflicts) {
    console.error(`  ${c.key}\n    ${JSON.stringify(c.a)}  (${c.aFile})\n    ${JSON.stringify(c.b)}  (${c.bFile})`);
  }
}
if (unseedable.length) {
  rc = 1;
  console.error(`i18n-extract-seed: ${unseedable.length} referenced key(s) carry no English literal:`);
  for (const k of unseedable.slice(0, 20)) console.error(`  ${k}`);
  if (unseedable.length > 20) console.error(`  … and ${unseedable.length - 20} more`);
}
if (rc !== 0) process.exit(rc);

// Sorted, so a regeneration produces a byte-identical file and a diff shows only real changes.
const catalog = {};
for (const k of [...seeded.keys()].sort()) catalog[k] = seeded.get(k);
const text = JSON.stringify(catalog, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const have = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (have !== text) {
    console.error('i18n-extract-seed: frontend/i18n-seed/en.json is stale — run `pnpm i18n:seed`');
    process.exit(1);
  }
  // A locale file nobody translated would be read as a complete catalog by the runtime and would
  // render English under a foreign locale with no sign anything is missing.
  const extra = readdirSync(OUT_DIR).filter((f) => f !== 'en.json');
  if (extra.length) {
    console.error(`i18n-extract-seed: frontend/i18n-seed/ holds ${extra.join(', ')} — this is the ENGLISH seed;`);
    console.error('  translations belong in the shared zpwr-i18n catalogs, not here.');
    process.exit(1);
  }
  console.log(`i18n-extract-seed: seed is current — ${Object.keys(catalog).length} key(s)`);
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, text);
console.log(`i18n-extract-seed: wrote ${relative(root, OUT)} — ${Object.keys(catalog).length} key(s) from ${sources().length} source file(s)`);
