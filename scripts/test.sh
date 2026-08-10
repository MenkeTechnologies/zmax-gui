#!/usr/bin/env bash
# Test runner for zmax-gui: the headless JS bridge tests (always) + the Rust unit tests. The Rust
# bin embeds tauri::generate_context!(), which validates the externalBin sidecars exist at compile
# time — so we stage them first (cheap when already built/cached) before the Rust pass.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== JS bridge tests =="
# The shared GUI surface (menu bridge + the PTY-stream editor reconstruction and its HUD) plus the
# app-local wiring tests (frontend/) — globs, so a new surface test is picked up without editing this.
# Enumerated first: `node --test` over a glob matching nothing exits 0 and prints "tests 0", so a
# moved directory would read as a clean pass instead of a broken checkout.
JS_FILES=(crates/zmax-gui-core/webui/*.test.cjs frontend/*.test.cjs)
for f in "${JS_FILES[@]}"; do
    [ -e "$f" ] || { echo "test.sh: no test file at $f — submodule not checked out, or the path moved" >&2; exit 1; }
done
echo "test.sh: collected ${#JS_FILES[@]} JS test file(s)"
node --test "${JS_FILES[@]}"

echo "== staging sidecars (needed to compile the Rust bin) =="
node scripts/prepare-stryke-sidecar.mjs || echo "test.sh: prepare-stryke-sidecar.mjs failed" >&2
ZMAX_NO_BUILD="${ZMAX_NO_BUILD:-}" node scripts/prepare-zmax-sidecar.mjs || echo "test.sh: prepare-zmax-sidecar.mjs failed" >&2

triple="$(rustc -vV | perl -ne 'print $1 if /^host: (.*)/')"
if [ -f "app/src-tauri/binaries/zmax-${triple}" ] && [ -f "app/src-tauri/binaries/stryke-${triple}" ]; then
    echo "== Rust unit tests =="
    cargo test --manifest-path app/src-tauri/Cargo.toml
elif [ -n "${ZMAX_GUI_ALLOW_RUST_SKIP:-}" ]; then
    echo "== Rust unit tests SKIPPED (ZMAX_GUI_ALLOW_RUST_SKIP set): sidecars not staged for ${triple} =="
else
    # app/src-tauri/binaries/ is gitignored build output, so on any machine that has not built
    # crates/zmax this branch was reached on every run — and it used to just print and exit 0.
    # The whole Rust suite then contributed nothing while `pnpm test` reported success. Skipping
    # is still available, but it has to be asked for.
    echo "test.sh: sidecars not staged for ${triple} — the Rust suite did not run." >&2
    echo "test.sh: build crates/zmax and stage stryke, or set ZMAX_GUI_ALLOW_RUST_SKIP=1 to accept a JS-only run." >&2
    exit 1
fi
