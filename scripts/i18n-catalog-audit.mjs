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
 * `frontend/i18n/` are build output. Nothing is written; the exit code is the result.
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

const missing = [...referenced].filter((k) => !(k in en)).sort();

// ── per-locale completeness ────────────────────────────────────────────────────────────────────
const enKeys = Object.keys(en);
const gaps = [];
for (const [locale, cat] of Object.entries(catalogs)) {
  if (locale === 'en') continue;
  const absent = enKeys.filter((k) => !(k in cat));
  const empty = enKeys.filter((k) => k in cat && String(cat[k]).trim() === '');
  if (absent.length || empty.length) gaps.push({ locale, absent: absent.length, empty: empty.length });
}

console.log(`i18n-audit: ${Object.keys(catalogs).length} locales · ${enKeys.length} keys in the en seed`);
console.log(`i18n-audit: ${referenced.size} keys referenced across ${sources.length} app source file(s)`);

let rc = 0;
if (missing.length) {
  rc = 1;
  console.error(`i18n-audit: ${missing.length} referenced key(s) absent from the en seed:`);
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
