#!/usr/bin/env bash
# bust.sh — rotate frontend asset cache-busting query strings (?v=N). Ported from Audio-Haxor.
cd "$(dirname "$0")/.."
source scripts/cyberpunk.sh

cyber_banner
cyber_status "OPERATION" "CACHE BUST // invalidate frontend assets"
echo

cyber_section "BUSTING CACHE SIGNATURES"
VER=$(node -e "const fs=require('fs');const v=Date.now()%100000;for(const p of['frontend/index.html']){let h=fs.readFileSync(p,'utf8');h=h.replace(/\?v=\d+/g,'?v='+v);fs.writeFileSync(p,h);}console.log(v)")
cyber_ok "all assets busted to v${VER}"

cyber_tagline "CACHE SIGNATURES ROTATED."
cyber_line
