// Sync the shared i18n runtime + locale catalogs from the zpwr-i18n submodule into the served
// frontend before each dev/build. Source of truth: crates/zpwr-i18n (no hand-edits to the copies in
// frontend/ — they are regenerated here and gitignored). New translation keys go in the SUBMODULE's
// catalogs (crates/zpwr-i18n/i18n/<locale>.json), never the frontend copy.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../crates/zpwr-i18n");
const dstFrontend = resolve(here, "../frontend");

const runtime = resolve(src, "webui/i18n.js");
if (!existsSync(runtime)) {
  console.error(`copy-i18n: missing ${runtime} (run: git submodule update --init crates/zpwr-i18n)`);
  process.exit(1);
}
copyFileSync(runtime, resolve(dstFrontend, "i18n.js"));
console.log("copy-i18n: i18n.js");

const catSrc = resolve(src, "i18n");
const catDst = resolve(dstFrontend, "i18n");
mkdirSync(catDst, { recursive: true });
for (const f of readdirSync(catSrc).filter((f) => f.endsWith(".json"))) {
  copyFileSync(resolve(catSrc, f), resolve(catDst, f));
  console.log(`copy-i18n: i18n/${f}`);
}
