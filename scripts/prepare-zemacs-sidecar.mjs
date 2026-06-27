// Stage the `zemacs` editor binary as a Tauri externalBin sidecar so the shipped app is
// self-contained — zemacs-gui must NOT depend on `zemacs` being on the user's PATH. The editor source
// is vendored as the `crates/zemacs` submodule; this builds it (if needed) and copies the binary to
// app/src-tauri/binaries/zemacs-<host-triple>, the suffixed name Tauri's `bundle.externalBin` requires.
// Wired into beforeDevCommand/beforeBuildCommand. The runtime resolver (sidecar.rs::resolve_zemacs_bin)
// finds the sidecar beside the executable (or the dev staging dir) before falling back to PATH.
//
// Source: ZEMACS_SIDECAR_BIN / ZEMACS_BIN override → crates/zemacs/target/{release,debug}. If neither
// build exists it runs `cargo build --bin zemacs` in the submodule (debug; set ZEMACS_NO_BUILD=1 to
// skip and warn instead).
import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const exeExt = isWin ? '.exe' : '';
const name = `zemacs${exeExt}`;
const submodule = join(root, 'crates', 'zemacs');

function hostTriple() {
    try {
        const t = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
        if (t) return t;
    } catch {}
    try {
        const v = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
        const m = v.match(/host:\s*(\S+)/);
        if (m) return m[1];
    } catch {}
    return null;
}

function builtBinary() {
    for (const kind of ['release', 'debug']) {
        const p = join(submodule, 'target', kind, name);
        if (existsSync(p)) return p;
    }
    return null;
}

function resolveZemacs() {
    const override = process.env.ZEMACS_SIDECAR_BIN || process.env.ZEMACS_BIN;
    if (override && existsSync(override)) return override;
    let built = builtBinary();
    if (built) return built;
    if (!existsSync(join(submodule, 'Cargo.toml'))) {
        console.error('prepare-zemacs-sidecar: crates/zemacs submodule missing — run `git submodule update --init crates/zemacs`');
        return null;
    }
    if (process.env.ZEMACS_NO_BUILD) return null;
    console.log('prepare-zemacs-sidecar: building crates/zemacs (cargo build --bin zemacs)…');
    execFileSync('cargo', ['build', '--bin', 'zemacs'], { cwd: submodule, stdio: 'inherit' });
    return builtBinary();
}

const triple = hostTriple();
if (!triple) {
    console.error('prepare-zemacs-sidecar: could not determine host triple (rustc missing?)');
    process.exit(1);
}

const src = resolveZemacs();
if (!src) {
    console.warn(
        'prepare-zemacs-sidecar: zemacs not built. Sidecar NOT bundled; the app falls back to a ' +
            'system zemacs at runtime. Build it (`cargo build --bin zemacs` in crates/zemacs) or set ZEMACS_SIDECAR_BIN.'
    );
    process.exit(0);
}

const outDir = join(root, 'app', 'src-tauri', 'binaries');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `zemacs-${triple}${exeExt}`);
copyFileSync(src, out);
if (!isWin) chmodSync(out, 0o755);
console.log(`Staged zemacs sidecar: ${src} -> ${out}`);
