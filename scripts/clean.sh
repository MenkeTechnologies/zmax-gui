#!/usr/bin/env bash
# clean.sh — purge build artifacts. Ported from Audio-Haxor (adapted to the app/src-tauri layout).
cd "$(dirname "$0")/.."
source scripts/cyberpunk.sh

cyber_banner
cyber_status "OPERATION" "CLEAN // purge build artifacts"
echo

cyber_section "DESTROYING CACHES"
BEFORE=$(du -sh app/src-tauri/target 2>/dev/null | awk '{print $1}' || echo "0B")
# app/src-tauri/binaries holds the staged zmax + stryke sidecars; they are re-staged by the
# beforeBuildCommand, and keeping a stale sidecar across a clean is how a "fresh" build ships an old
# editor.
command rm -rf app/src-tauri/target app/src-tauri/binaries app/src-tauri/gen dist node_modules/.cache
cyber_ok "freed ${BEFORE} // target + sidecars + gen + node cache"

cyber_tagline "MEMORY WIPED. READY FOR FRESH BUILD."
cyber_line
