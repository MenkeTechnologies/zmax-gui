// zmax-gui — the ENGLISH SEED layer (G3).
//
// The shared zpwr-i18n catalog is the translation source of truth for the whole GUI fleet, and it
// carries 51 of the 868 `zmax.*` keys this app references. The other 817 exist only as the English
// literal at their call site (`T("zmax.file.save", "Save")`), which reads correctly but is invisible
// to the catalog: nothing can translate a string that was never extracted, `applyUiI18n` cannot
// translate `data-i18n` markup for a key no catalog holds, and a call site added without a literal
// would render the raw key.
//
// scripts/i18n-extract-seed.mjs derives `i18n-seed/en.json` from those call sites, and this file is
// what puts it into the runtime — as a layer BENEATH the shared catalog:
//
//     window.__appStr  =  { …English seed… }  overlaid by  { …the loaded locale… }
//
// The direction matters and is the whole reason this is not just another `__i18nExtraBases` entry.
// `loadLocale` merges extra bases ON TOP of the app catalog, so a seed registered that way would
// override a real French translation with English the moment zpwr-i18n shipped one. Under, a
// translation always wins and the seed only fills what no catalog answers.
//
// English-only, deliberately. Generating the other 26 locales from an English string is not
// translation, and a fabricated catalog is worse than a missing one: the runtime treats any present
// value as a successful lookup, so a machine-filled `fr.json` would render silently-wrong French
// with nothing to distinguish it from the real thing. `i18n-extract-seed.mjs --check` fails if a
// second file appears in that directory.
(function () {
  "use strict";

  var BASE = "i18n-seed/en.json";
  var seed = null;

  // One fetch per session. Failure is not fatal and not reported to the user: every call site still
  // carries its own English literal, so a missing seed costs the `data-i18n` markup and nothing else.
  var loading = (typeof fetch === "function"
    ? fetch(BASE, { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : {}; })
    : Promise.resolve({})
  ).catch(function () { return {}; });

  loading.then(function (obj) {
    seed = (obj && typeof obj === "object") ? obj : {};
    apply();
  });

  /// Put the seed under whatever is loaded now. Idempotent: re-running after a locale switch
  /// re-fills only the keys the new catalog does not answer.
  function apply() {
    if (!seed) return;
    var cur = window.__appStr || {};
    var merged = {};
    Object.keys(seed).forEach(function (k) { merged[k] = seed[k]; });
    Object.keys(cur).forEach(function (k) {
      // An empty string is a *failed* translation the runtime would treat as a successful lookup
      // and render as nothing, so the seed keeps the key rather than letting the blank win.
      if (cur[k] !== "" && cur[k] != null) merged[k] = cur[k];
    });
    window.__appStr = merged;
    window.__toastStr = merged;
    if (typeof window.applyUiI18n === "function") window.applyUiI18n();
  }

  // `loadLocale` REPLACES window.__appStr wholesale (it does not merge into it), so the seed has to
  // be re-applied after every load — including the first one at boot and every live locale switch
  // from the menu. Wrapping is what makes that automatic; a call site that remembered to re-apply
  // would be a call site that eventually forgets.
  var inner = window.loadLocale;
  if (typeof inner === "function") {
    window.loadLocale = function (locale, opts) {
      return Promise.resolve(inner(locale, opts)).then(function () {
        return loading.then(function () { apply(); return window.__appStr; });
      });
    };
  }

  window.ZmaxI18nSeed = { apply: apply, ready: loading, base: BASE };

  if (typeof module !== "undefined" && module.exports) module.exports = window.ZmaxI18nSeed;
})();
