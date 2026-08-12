#!/usr/bin/env bash
# // ZMAX-GUI DEPLOY // build + clear caches + launch (ported from Audio-Haxor)
cd "$(dirname "$0")/.."
source scripts/cyberpunk.sh

cyber_banner
cyber_status "OPERATION" "DEPLOY // build + clear caches + launch"
echo

APP_PATH="app/src-tauri/target/release/bundle/macos/zmax-gui.app"

cyber_section "BUILD"
START=$(date +%s)
pnpm run build 2>&1 | tail -5
END=$(date +%s)
ELAPSED=$((END - START))

if [ ! -d "$APP_PATH" ]; then
  cyber_fail "build failed after ${ELAPSED}s"
  cyber_tagline "DEPLOYMENT ABORTED."
  exit 1
fi
APP_SIZE=$(du -sh "$APP_PATH" | awk '{print $1}')
cyber_ok "built in ${ELAPSED}s // ${APP_SIZE}"
echo

cyber_section "CLEAR WEBVIEW CACHES"
command rm -rf ~/Library/WebKit/zmax-gui ~/Library/WebKit/com.menketechnologies.zmax-gui \
               ~/Library/Caches/zmax-gui ~/Library/Caches/com.menketechnologies.zmax-gui 2>/dev/null
cyber_ok "caches purged"
echo

cyber_section "LAUNCH"
open "$APP_PATH"
cyber_ok "app launched"

cyber_tagline "SYSTEM ONLINE. JACK IN."
cyber_line
