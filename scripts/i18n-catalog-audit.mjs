#!/usr/bin/env node
/**
 * Read-only completeness audit of zmax-gui's localization (G3).
 *
 * Answers two questions the copy step cannot:
 *   1. Does every key the app actually references exist in the English seed? A missing key renders
 *      the raw key (or the English fallback) at runtime and is invisible until someone switches
 *      language, so it has to be caught here.
 *   2. Does every other locale carry every English key with a NON-EMPTY value? An empty string is
 *      worse than a missing key: the runtime treats it as a successful lookup and renders nothing.
 *
 * Sources are the SHARED `zpwr-i18n` catalogs (`crates/zpwr-i18n/i18n/*.json`) — the copies under
 * `frontend/i18n/` are build output — PLUS this app's own English seed
 * (`frontend/i18n-seed/en.json`), which `frontend/i18n-seed.js` merges under every loaded locale.
 * Question 1 has to consider both or it reports a gap the runtime does not have: a `zmax.*` key the
 * seed answers renders correctly in every locale, and calling it "absent" would bury the keys that
 * genuinely have no English anywhere under 800 that do. The two sources are reported separately, and
 * question 2 is unchanged — per-locale completeness is measured against the SHARED seed alone,
 * because the app seed is English-only by design and translating it is not this app's job.
 *
 * What the residual gap is expected to be: the `ui.*` / `menu.*` keys this app's markup carries for
 * the shared file browser (`zpwr-file-browser`). Those are that component's vocabulary to define and
 * to ship a catalog for, so they stay reported here rather than being seeded locally.
 *
 * Nothing is written; the exit code is the result.
 *
 * Key references are read from the app's own surfaces only: `data-i18n*` attributes in
 * `frontend/*.html`, and `t("…")` / `T("…", …)` calls in the app's JS. Vendored libraries under
 * `frontend/lib/` are excluded — they carry their own catalogs and their keys are not this app's to
 * provide.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const i18nDir = join(root, 'crates', 'zpwr-i18n', 'i18n');
if (!existsSync(i18nDir)) {
  console.error(`i18n-audit: ${i18nDir} is missing (run: git submodule update --init crates/zpwr-i18n)`);
  process.exit(1);
}

const catalogs = {};
for (const f of readdirSync(i18nDir).filter((f) => f.endsWith('.json')).sort()) {
  catalogs[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(i18nDir, f), 'utf8'));
}
const en = catalogs.en;
if (!en) {
  console.error('i18n-audit: no en.json seed');
  process.exit(1);
}

// ── the keys this app references ───────────────────────────────────────────────────────────────
const sources = [];
for (const dir of [join(root, 'frontend'), join(root, 'crates', 'zmax-gui-core', 'webui')]) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const d of entries) {
    if (!d.isFile()) continue;                       // `lib/` and `i18n/` are vendored, not ours
    if (d.name.endsWith('.test.cjs') || d.name.endsWith('.test.js')) continue;
    if (/\.(html|js)$/.test(d.name)) sources.push(join(dir, d.name));
  }
}

const referenced = new Set();
for (const file of sources) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) referenced.add(m[1]);
  for (const m of src.matchAll(/\b[tT]\(\s*"([a-z0-9_.]+)"/g)) referenced.add(m[1]);
}

// The app's own English seed, loaded at runtime UNDER the shared catalog (frontend/i18n-seed.js).
// Absent on a tree where it has not been generated, which is not an error here — every key it holds
// is then reported as missing, which is exactly what the situation is.
const seedPath = join(root, 'frontend', 'i18n-seed', 'en.json');
const appSeed = existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, 'utf8')) : {};

const seededOnly = [...referenced].filter((k) => !(k in en) && k in appSeed).sort();
const missing = [...referenced].filter((k) => !(k in en) && !(k in appSeed)).sort();

// ── per-locale completeness ────────────────────────────────────────────────────────────────────
const enKeys = Object.keys(en);
const gaps = [];
for (const [locale, cat] of Object.entries(catalogs)) {
  if (locale === 'en') continue;
  const absent = enKeys.filter((k) => !(k in cat));
  const empty = enKeys.filter((k) => k in cat && String(cat[k]).trim() === '');
  if (absent.length || empty.length) gaps.push({ locale, absent: absent.length, empty: empty.length });
}

console.log(`i18n-audit: ${Object.keys(catalogs).length} locales · ${enKeys.length} keys in the shared en seed`);
console.log(`i18n-audit: ${Object.keys(appSeed).length} keys in this app's English seed (frontend/i18n-seed/en.json)`);
console.log(`i18n-audit: ${referenced.size} keys referenced across ${sources.length} app source file(s)`);
if (seededOnly.length) {
  console.log(`i18n-audit: ${seededOnly.length} of them read from the app seed only — English everywhere, translated nowhere`);
}

let rc = 0;
if (missing.length) {
  rc = 1;
  console.error(`i18n-audit: ${missing.length} referenced key(s) in NO English catalog — they render as the raw key:`);
  for (const k of missing.slice(0, 40)) console.error(`  ${k}`);
  if (missing.length > 40) console.error(`  … and ${missing.length - 40} more`);
}
if (gaps.length) {
  rc = 1;
  console.error(`i18n-audit: ${gaps.length} locale(s) incomplete against the en seed:`);
  for (const g of gaps) console.error(`  ${g.locale}: ${g.absent} missing, ${g.empty} empty`);
}
if (rc === 0) console.log('i18n-audit: every referenced key exists and every locale is complete');
process.exit(rc);
