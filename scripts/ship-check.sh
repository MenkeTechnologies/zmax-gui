#!/usr/bin/env bash
# ship-check.sh — the pre-ship gate for zmax-gui. Every check is a real assertion about the tree, not
# a print statement: each one either passes, or fails with what it saw. A run that reports PASS means
# the app can be built and shipped from this checkout.
#
# Ported from Audio-Haxor, adapted to zmax-gui's layout (app/src-tauri, vendored submodules,
# sidecar-bundled zmax + stryke).
cd "$(dirname "$0")/.."
source scripts/cyberpunk.sh

cyber_banner
cyber_status "OPERATION" "SHIP CHECK // is this tree shippable"
echo

FAILED=0
WARNED=0
fail() { cyber_fail "$1"; FAILED=$((FAILED + 1)); }
warn() { cyber_warn "$1"; WARNED=$((WARNED + 1)); }

# ── submodules ────────────────────────────────────────────────────────────────────────────────
cyber_section "SUBMODULES"
MISSING=0
while read -r _ path _; do
    [ -z "$path" ] && continue
    if [ ! -e "$path/.git" ]; then
        fail "submodule not checked out: $path"
        MISSING=$((MISSING + 1))
    fi
done < <(git config -f .gitmodules --get-regexp '^submodule\..*\.path$' | awk '{print $1, $2, ""}' | sed 's/submodule\.//; s/\.path//')
[ "$MISSING" -eq 0 ] && cyber_ok "every submodule is checked out"

# A DETACHED submodule that is BEHIND the pointer this repo records reproduces stale sources at
# build time while `git status` looks clean — the failure mode that broke the vocabulary suite.
DRIFT=$(git submodule status --recursive 2>/dev/null | grep -c '^+' || true)
if [ "$DRIFT" -gt 0 ]; then
    warn "$DRIFT submodule worktree(s) differ from the recorded pointer (git submodule status | grep '^+')"
else
    cyber_ok "every submodule worktree matches its recorded pointer"
fi
echo

# ── frontend wiring ───────────────────────────────────────────────────────────────────────────
cyber_section "FRONTEND"
for f in frontend/index.html frontend/main.js frontend/panels.js frontend/verbs.js frontend/plan-panel.js frontend/plan-domain.js frontend/fb-backend.js; do
    [ -f "$f" ] || fail "missing $f"
done
# Every app-local script must be referenced by index.html, or it is dead code that tests still pass.
for f in main.js panels.js verbs.js plan-panel.js fb-backend.js tmux-config.js; do
    grep -q "src=\"$f\"" frontend/index.html || fail "frontend/index.html does not load $f"
done
# A single NUL byte makes the WebView parse an asset as binary and abort mid-file (see the
# GUI_APP_REQUIREMENTS pitfalls) — the UI then loses whole sections with no error.
NULFILES=$(find frontend -maxdepth 1 -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' \) -print0 \
    | perl -0 -ne 'chomp; next unless -f; open my $fh, "<:raw", $_ or next; local $/; print "$_\n" if <$fh> =~ /\0/;')
if [ -n "$NULFILES" ]; then
    fail "frontend asset(s) contain a NUL byte and will parse as binary: $(echo "$NULFILES" | tr '\n' ' ')"
else
    cyber_ok "frontend assets are clean text"
fi
echo

# ── tests ─────────────────────────────────────────────────────────────────────────────────────
cyber_section "JS TESTS"
if node scripts/run-js-tests.mjs > /tmp/zmax-gui-shipcheck-js.log 2>&1; then
    cyber_ok "$(grep -m1 'collected' /tmp/zmax-gui-shipcheck-js.log)"
else
    fail "JS tests failed (see /tmp/zmax-gui-shipcheck-js.log)"
fi
echo

cyber_section "RUST TESTS"
if cargo test --manifest-path app/src-tauri/Cargo.toml > /tmp/zmax-gui-shipcheck-rust.log 2>&1; then
    cyber_ok "$(grep -m1 'test result' /tmp/zmax-gui-shipcheck-rust.log)"
else
    fail "Rust tests failed (see /tmp/zmax-gui-shipcheck-rust.log)"
fi
echo

# ── localization ──────────────────────────────────────────────────────────────────────────────
# A WARNING, not a failure: the catalogs live in the shared zpwr-i18n submodule, so closing this gap
# is a change in that repo. Reported with its real number so it cannot quietly stay open.
cyber_section "I18N"
if node scripts/i18n-catalog-audit.mjs > /tmp/zmax-gui-shipcheck-i18n.log 2>&1; then
    cyber_ok "every referenced key exists and every locale is complete"
else
    warn "$(grep -m1 'absent from the en seed' /tmp/zmax-gui-shipcheck-i18n.log || echo 'i18n audit failed')"
fi
echo

cyber_line
if [ "$FAILED" -gt 0 ]; then
    cyber_fail "${FAILED} check(s) failed, ${WARNED} warning(s)"
    cyber_tagline "NOT SHIPPABLE."
    exit 1
fi
cyber_ok "all checks passed, ${WARNED} warning(s)"
cyber_tagline "SHIPPABLE."
cyber_line
