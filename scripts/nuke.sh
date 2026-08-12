#!/usr/bin/env bash
# nuke.sh — total annihilation rebuild: purge WebView caches + bust + clean + rebuild.
# Ported from Audio-Haxor (adapted to the app/src-tauri layout).
#
# Both cache roots are purged (product name AND bundle identifier) because release WebKit writes
# under whichever the OS resolved; clearing only one leaves the build looking unchanged.
cd "$(dirname "$0")/.."
source scripts/cyberpunk.sh

cyber_banner
cyber_status "OPERATION" "NUKE // total annihilation rebuild"
echo

cyber_section "PURGE WEBVIEW CACHES"
find ~/Library/WebKit/zmax-gui \
     ~/Library/WebKit/com.menketechnologies.zmax-gui \
     ~/Library/Caches/zmax-gui \
     ~/Library/Caches/com.menketechnologies.zmax-gui \
     -delete 2>/dev/null
cyber_ok "WebView caches obliterated"
echo

cyber_section "CACHE BUST"
node -e "const fs=require('fs');const v=Date.now()%100000;for(const p of['frontend/index.html']){let h=fs.readFileSync(p,'utf8');h=h.replace(/\?v=\d+/g,'?v='+v);fs.writeFileSync(p,h);}console.log('  busted to v'+v)"
echo

cyber_section "CLEAN BUILD ARTIFACTS"
command rm -rf app/src-tauri/target app/src-tauri/binaries app/src-tauri/gen dist node_modules/.cache
cyber_ok "build caches destroyed"
echo

cyber_section "REBUILD FROM SCRATCH"
cyber_line
echo
START=$(date +%s)
pnpm install
# Full log on failure (do not pipe to tail — that hides beforeBuildCommand / cargo errors).
if ! pnpm run build; then
  END=$(date +%s)
  echo
  cyber_fail "tauri build failed after $((END - START))s (see log above)"
  cyber_tagline "LAUNCH ABORTED"
  exit 1
fi
END=$(date +%s)
ELAPSED=$((END - START))
echo
cyber_line

BUNDLE_MAC="app/src-tauri/target/release/bundle/macos/zmax-gui.app"
if [ -d "$BUNDLE_MAC" ]; then
  APP_SIZE=$(du -sh "$BUNDLE_MAC" | awk '{print $1}')
  cyber_ok "binary deployed // ${APP_SIZE} // ${ELAPSED}s"
else
  cyber_warn "build finished in ${ELAPSED}s; .app bundle not found (non-macOS target?)"
fi
cyber_tagline "NUCLEAR LAUNCH SUCCESSFUL"
cyber_line
