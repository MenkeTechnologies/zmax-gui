// Build the shared Monaco hooks editor (zpwr-hooks-editor) into the served frontend's lib/
// (frontend/lib), next to lib/zgui-core that index.html also loads. The crate's own
// build-hooks-editor.mjs lives in the submodule, so it can't resolve this project's
// esbuild/monaco-* devDeps from there — bridge a build-time node_modules symlink from the
// crate to the repo's, then invoke the crate's builder with cwd=repo root (so its explicit
// monaco paths resolve) and HOOKS_EDITOR_OUT set to frontend/lib (where the bundle + its
// worker land). Mirrors copy-embed-terminal.mjs / copy-file-browser.mjs.
import { existsSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const crate = resolve(root, "crates", "zpwr-hooks-editor");
const crateNm = resolve(crate, "node_modules");

if (!existsSync(crate)) {
  console.error(`copy-hooks-editor: missing ${crate} (run: git submodule update --init crates/zpwr-hooks-editor)`);
  process.exit(1);
}

if (!existsSync(crateNm)) {
  try {
    symlinkSync(resolve(root, "node_modules"), crateNm, "dir");
  } catch (e) {
    console.error("[copy-hooks-editor] could not link crate node_modules:", e.message);
  }
}

const out = resolve(root, "frontend", "lib");
execFileSync("node", [resolve(crate, "scripts", "build-hooks-editor.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, HOOKS_EDITOR_OUT: out },
});
