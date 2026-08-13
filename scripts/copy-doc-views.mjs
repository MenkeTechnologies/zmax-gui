// Stage the two embeddable DOCUMENT VIEWS into the served frontend before each dev/build.
//
// Source of truth is each engine submodule; the copies under `frontend/lib/doc-views/` are build
// output and gitignored, exactly like copy-webui.mjs / copy-i18n.mjs / copy-file-browser.mjs.
//
//   zoffice-core  webui/zoffice-{dom,view}.js + zoffice-view.css  → window.mountZoffice
//   zpdf-core     frontend/js/zpdf.js + frontend/css/app.css      → window.mountZpdf
//
// The FILE LIST is read from each engine's own `package.json` "zguiView" array rather than written
// here, so a view that grows a second module is picked up without editing this script.
//
// One exception is hard-coded and named as such: zpdf-core's manifest lists only the JS, but
// `mountZpdf` builds markup styled by `frontend/css/app.css` (`.zp-main`, `.zp-side`, `.pv-bar`, …).
// Without it the pane mounts unstyled. app.css is class-scoped — it declares no `:root`, `body`,
// `html` or `*` rule (its header says so, and `grep -E '^(body|html|:root|\*)'` finds none) — so it
// cannot restyle the host around the pane. See EXTRA_ASSETS below.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dst = resolve(root, "frontend", "lib", "doc-views");

/** Assets a view needs that its own `zguiView` manifest does not (yet) declare. */
const EXTRA_ASSETS = {
  // zpdf-core#6f84460a package.json lists frontend/js/zpdf.js and no stylesheet.
  "zpdf-core": ["frontend/css/app.css"],
};

/** The files one engine contributes: its declared `zguiView` plus anything in EXTRA_ASSETS. */
function assetsOf(name) {
  const dir = resolve(root, "crates", name);
  const manifest = resolve(dir, "package.json");
  if (!existsSync(manifest)) {
    console.error(`copy-doc-views: missing ${manifest} (run: git submodule update --init crates/${name})`);
    process.exit(1);
  }
  const declared = JSON.parse(readFileSync(manifest, "utf8")).zguiView;
  if (!Array.isArray(declared) || declared.length === 0) {
    console.error(`copy-doc-views: crates/${name}/package.json declares no zguiView assets`);
    process.exit(1);
  }
  return [...declared, ...(EXTRA_ASSETS[name] || [])].map((rel) => resolve(dir, rel));
}

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

// Flattened into one directory: index.html loads them by name, and the two engines' asset
// basenames do not collide (zoffice-*.{js,css} vs zpdf.js / app.css). A future collision would
// silently overwrite, so it is refused here rather than shipped.
const seen = new Set();
for (const engine of ["zoffice-core", "zpdf-core"]) {
  for (const from of assetsOf(engine)) {
    if (!existsSync(from)) {
      console.error(`copy-doc-views: missing ${from} (run: git submodule update --init crates/${engine})`);
      process.exit(1);
    }
    const name = engine === "zpdf-core" && basename(from) === "app.css" ? "zpdf-app.css" : basename(from);
    if (seen.has(name)) {
      console.error(`copy-doc-views: two engines both ship a '${name}' — one would overwrite the other`);
      process.exit(1);
    }
    seen.add(name);
    copyFileSync(from, resolve(dst, name));
    console.log(`copy-doc-views: ${engine}/${basename(from)} -> lib/doc-views/${name}`);
  }
}
