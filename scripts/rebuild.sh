#!/usr/bin/env bash
# rebuild.sh — bust + clean + build. Ported from Audio-Haxor (adapted to the app/src-tauri layout).
cd "$(dirname "$0")/.."
source scripts/cyberpunk.sh

cyber_banner
cyber_status "OPERATION" "REBUILD // bust + clean + build"
echo

cyber_section "CACHE BUST"
VER=$(node -e "const fs=require('fs');const v=Date.now()%100000;for(const p of['frontend/index.html']){let h=fs.readFileSync(p,'utf8');h=h.replace(/\?v=\d+/g,'?v='+v);fs.writeFileSync(p,h);}console.log(v)")
cyber_ok "assets busted to v${VER}"
echo

cyber_section "CLEAN"
command rm -rf app/src-tauri/target app/src-tauri/binaries app/src-tauri/gen dist node_modules/.cache
cyber_ok "build caches purged"
echo

cyber_section "BUILD"
cyber_line
echo
START=$(date +%s)
pnpm install
pnpm run build 2>&1 | tail -12
BUILD_RC=${PIPESTATUS[0]}
END=$(date +%s)
ELAPSED=$((END - START))
echo
cyber_line

if [ "$BUILD_RC" -ne 0 ]; then
  cyber_fail "build failed after ${ELAPSED}s"
  cyber_tagline "RECONSTRUCTION FAILED."
  exit "$BUILD_RC"
fi

BUNDLE_MAC="app/src-tauri/target/release/bundle/macos/zmax-gui.app"
if [ -d "$BUNDLE_MAC" ]; then
  APP_SIZE=$(du -sh "$BUNDLE_MAC" | awk '{print $1}')
  cyber_ok "built in ${ELAPSED}s // ${APP_SIZE}"
else
  cyber_warn "build finished in ${ELAPSED}s; .app bundle not found (non-macOS target?)"
fi
cyber_tagline "RECONSTRUCTION COMPLETE."
cyber_line
