#!/usr/bin/env bash
# // ZMAX-GUI CYBERPUNK WRAPPER // shared styling for all scripts (ported from Audio-Haxor)
#
# The banner names THIS app. A wrapper carrying a sibling app's wordmark makes every script in the
# repo report the wrong product, which is worse than no banner — it reads as a correct build of
# something else.

C='\033[1;36m'  # cyan
M='\033[1;35m'  # magenta
G='\033[1;32m'  # green
R='\033[1;31m'  # red
Y='\033[1;33m'  # yellow
D='\033[0;90m'  # dim
W='\033[1;37m'  # white
N='\033[0m'

cyber_banner() {
  echo
  echo -e " ${C}███████╗███╗   ███╗ █████╗ ██╗  ██╗      ██████╗ ██╗   ██╗██╗${N}"
  echo -e " ${C}╚══███╔╝████╗ ████║██╔══██╗╚██╗██╔╝     ██╔════╝ ██║   ██║██║${N}"
  echo -e " ${C}  ███╔╝ ██╔████╔██║███████║ ╚███╔╝█████╗██║  ███╗██║   ██║██║${N}"
  echo -e " ${M} ███╔╝  ██║╚██╔╝██║██╔══██║ ██╔██╗╚════╝██║   ██║██║   ██║██║${N}"
  echo -e " ${M}███████╗██║ ╚═╝ ██║██║  ██║██╔╝ ██╗     ╚██████╔╝╚██████╔╝██║${N}"
  echo -e " ${M}╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝      ╚═════╝  ╚═════╝ ╚═╝${N}"
}

cyber_status() {
  local label="$1" msg="$2"
  echo -e " ${D}┌──────────────────────────────────────────────────────┐${N}"
  echo -e " ${D}│${N} ${W}${label}:${N} ${C}${msg}${N}"
  echo -e " ${D}└──────────────────────────────────────────────────────┘${N}"
}

cyber_section() {
  echo -e "  ${D}── ${C}$1${D} ─────────────────────────────────────${N}"
}

cyber_line() {
  echo -e " ${D}░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░${N}"
}

cyber_ok() {
  echo -e "  ${G}[DONE]${N} ${D}// $1${N}"
}

cyber_fail() {
  echo -e "  ${R}[FAIL]${N} ${D}// $1${N}"
}

cyber_warn() {
  echo -e "  ${Y}[WARN]${N} ${D}// $1${N}"
}

cyber_tagline() {
  echo
  echo -e "  ${C}>>> $1 <<<${N}"
  echo
}
