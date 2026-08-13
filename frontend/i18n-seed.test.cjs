// The English seed layer (G3), headless.
//
// The property under test is the LAYER ORDER, and it is the one thing that cannot be seen by
// looking at the app in English: seed under, loaded catalog over. Registered the obvious way — as a
// `__i18nExtraBases` entry — the merge runs the other way round and the seed's English would
// silently override a real translation the moment zpwr-i18n shipped one. Nothing on an English
// screen would look different.
//
// Also pinned: the seed survives a live locale switch (loadLocale REPLACES window.__appStr rather
// than merging into it), an empty string in a catalog does not win over the seed (the runtime reads
// a present-but-empty value as a successful lookup and renders nothing), and the seed file itself is
// English-only and current with the sources it was derived from.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const SEED_JS = path.join(__dirname, "i18n-seed.js");
const SEED_DIR = path.join(__dirname, "i18n-seed");
const SEED_JSON = path.join(SEED_DIR, "en.json");
const I18N_RUNTIME = path.join(__dirname, "..", "crates", "zpwr-i18n", "webui", "i18n.js");
const EXTRACTOR = path.join(__dirname, "..", "scripts", "i18n-extract-seed.mjs");

const tick = () => new Promise((r) => setImmediate(r));

/// Boot the SHARED i18n runtime and then i18n-seed.js on top, against catalogs served from
/// `catalogs` ({ "i18n/fr.json": {...}, "i18n-seed/en.json": {...} }). Using the real runtime is
/// the point: the merge order being tested is a property of how loadLocale replaces __appStr.
function boot(catalogs) {
  const applied = [];
  const win = {
    __appStr: {},
    applyUiI18n() { applied.push(Object.assign({}, win.__appStr)); },
    prefs: null,
  };
  const ctx = {
    window: win,
    document: { querySelectorAll: () => [] },
    navigator: { language: "en", languages: ["en"] },
    localStorage: { getItem: () => null, setItem() {} },
    console,
    fetch(url) {
      const body = catalogs[url];
      return Promise.resolve(body === undefined
        ? { ok: false, json: () => Promise.resolve({}) }
        : { ok: true, json: () => Promise.resolve(body) });
    },
    setTimeout, clearTimeout,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(I18N_RUNTIME, "utf8"), ctx);
  // The runtime installs applyUiI18n over ours; keep a recording wrapper so a test can see it fire.
  const realApply = win.applyUiI18n;
  win.applyUiI18n = function () { applied.push(Object.assign({}, win.__appStr)); realApply(); };
  vm.runInContext(fs.readFileSync(SEED_JS, "utf8"), ctx);
  return { win, applied, t: (k) => win.t(k) };
}

const SEED = { "zmax.file.save": "Save", "zmax.file.open": "Open…", "zmax.only.in.seed": "Seeded" };

test("i18n seed: a real translation wins over the seed, never the other way round", async () => {
  const env = boot({
    "i18n-seed/en.json": SEED,
    "i18n/fr.json": { "zmax.file.save": "Enregistrer" },
  });
  await env.win.loadLocale("fr");
  await tick();

  assert.equal(env.t("zmax.file.save"), "Enregistrer",
    "the seed overrode a shipped translation — the layers are merged in the wrong order");
  assert.equal(env.t("zmax.only.in.seed"), "Seeded",
    "a key no catalog answers must still read, which is the seed's whole job");
});

test("i18n seed: an untranslated key falls back to English instead of rendering the raw key", async () => {
  const env = boot({ "i18n-seed/en.json": SEED, "i18n/fr.json": {} });
  await env.win.loadLocale("fr");
  await tick();
  assert.equal(env.t("zmax.file.open"), "Open…");
  assert.notEqual(env.t("zmax.file.open"), "zmax.file.open");
});

test("i18n seed: a locale switch does not drop the seed", async () => {
  const env = boot({
    "i18n-seed/en.json": SEED,
    "i18n/fr.json": { "zmax.file.save": "Enregistrer" },
    "i18n/de.json": { "zmax.file.save": "Speichern" },
  });
  await env.win.loadLocale("fr");
  await tick();
  await env.win.loadLocale("de");
  await tick();

  assert.equal(env.t("zmax.file.save"), "Speichern", "the second locale must win");
  assert.equal(env.t("zmax.only.in.seed"), "Seeded",
    "loadLocale REPLACES __appStr, so the seed has to be re-applied after every load");
});

test("i18n seed: an empty catalog value does not beat the seed", async () => {
  const env = boot({
    "i18n-seed/en.json": SEED,
    "i18n/fr.json": { "zmax.file.save": "" },
  });
  await env.win.loadLocale("fr");
  await tick();
  assert.equal(env.t("zmax.file.save"), "Save",
    "an empty string is a failed translation the runtime would render as nothing");
});

test("i18n seed: a missing seed file costs nothing — the app still boots and translates", async () => {
  const env = boot({ "i18n/fr.json": { "zmax.file.save": "Enregistrer" } });
  await env.win.loadLocale("fr");
  await tick();
  assert.equal(env.t("zmax.file.save"), "Enregistrer");
  assert.equal(env.t("zmax.only.in.seed"), "zmax.only.in.seed", "nothing to fall back to, honestly");
});

// ── the shipped seed file ───────────────────────────────────────────────────────────────────────

test("i18n seed: the shipped seed is current with the sources it is derived from", () => {
  // Runs the real extractor in --check mode: it fails on a stale file, on a key with two different
  // English strings, and on a referenced key with no literal to seed from.
  const out = execFileSync(process.execPath, [EXTRACTOR, "--check"], { encoding: "utf8" });
  assert.match(out, /seed is current/);
});

test("i18n seed: the seed directory is English-only", () => {
  const files = fs.readdirSync(SEED_DIR);
  assert.deepEqual(files, ["en.json"],
    "a locale file here would be machine-filled English rendered as that language, with nothing " +
    "to distinguish it from a real translation: " + JSON.stringify(files));
});

test("i18n seed: every seeded value is a non-empty string under this app's namespace", () => {
  const seed = JSON.parse(fs.readFileSync(SEED_JSON, "utf8"));
  const keys = Object.keys(seed);
  assert.ok(keys.length > 500, "the seed collapsed to " + keys.length + " keys");
  for (const k of keys) {
    assert.ok(k.startsWith("zmax."), k + " is not this app's to seed — ui.*/fb.* belong to the shared file browser");
    assert.equal(typeof seed[k], "string", k + " is not a string");
    assert.notEqual(seed[k].trim(), "", k + " seeds an empty string, which renders as nothing");
  }
  assert.deepEqual(keys, [...keys].sort(), "the seed must stay sorted so a regeneration diffs cleanly");
});

test("i18n seed: it never contradicts the shared catalog where both carry a key", () => {
  const seed = JSON.parse(fs.readFileSync(SEED_JSON, "utf8"));
  const sharedPath = path.join(__dirname, "..", "crates", "zpwr-i18n", "i18n", "en.json");
  const shared = JSON.parse(fs.readFileSync(sharedPath, "utf8"));
  const both = Object.keys(seed).filter((k) => k in shared);
  assert.ok(both.length > 0, "the two catalogs are expected to overlap");
  const differ = both.filter((k) => shared[k] !== seed[k]);
  assert.deepEqual(differ, [],
    "the shared catalog wins at runtime, so a difference here is a call site whose English literal " +
    "no longer matches the string translators were given");
});
