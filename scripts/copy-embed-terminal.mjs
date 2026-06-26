// Sync the shared embedded-terminal frontend from the zpwr-embed-terminal submodule into the served
// frontend before each dev/build. Source of truth: crates/zpwr-embed-terminal/webui (no hand-edits to
// the copies in frontend/ — they are regenerated here and gitignored).
import { copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../crates/zpwr-embed-terminal/webui");
const dst = resolve(here, "../frontend");

for (const f of ["terminal.js", "terminal.css", "xterm.js", "xterm.css"]) {
  const from = resolve(src, f);
  if (!existsSync(from)) {
    console.error(`copy-embed-terminal: missing ${from} (run: git submodule update --init)`);
    process.exit(1);
  }
  copyFileSync(from, resolve(dst, f));
  console.log(`copy-embed-terminal: ${f}`);
}
