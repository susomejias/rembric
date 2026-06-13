#!/bin/sh
# rembric unified installer — one entry point for the server + all four
# client plugins (Claude Code, Codex CLI, Hermes Agent, opencode).
#
# This is an ORCHESTRATOR: it delegates to the per-client install.sh /
# uninstall.sh (opencode, Hermes) and to the marketplace CLIs (Claude, Codex).
# It never reimplements a client's install logic.
#
# Public one-liner:
#   curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/install.sh | sh
#
# Inspect-first (recommended):
#   curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/install.sh -o rembric-install.sh
#   less rembric-install.sh && sh rembric-install.sh
#
# Local-clone testing (no network — reads everything from the working tree):
#   REMBRIC_SRC="$(pwd)" sh apps/plugin/install.sh
#
# Non-interactive (CI / no TTY):
#   REMBRIC_NONINTERACTIVE=1 sh install.sh --agent=opencode --action=install
#   sh install.sh --server
#
# Flags: --server | --agent=<a,b,..> | --action=install|update|uninstall
#        --ref=<tag>  (pin the git ref; default main)

set -eu

# ── source + ref resolution ────────────────────────────────────────────────
# REMBRIC_SRC, when set, is a local checkout root: every artifact is read from
# disk (cp), no network. Otherwise artifacts come from raw.githubusercontent
# at REMBRIC_REF (default main); --ref overrides.
REMBRIC_SRC="${REMBRIC_SRC:-}"
REF="${REMBRIC_REF:-main}"
NONINTERACTIVE="${REMBRIC_NONINTERACTIVE:-0}"
RAW_BASE="https://raw.githubusercontent.com/susomejias/rembric"

ARG_SERVER=0
ARG_AGENTS=''
ARG_ACTION=''
ARG_UP=0
ARG_STATUS=0
ARG_JSON=0
ARG_TOKEN=''
ARG_TOKEN_SET=0
ARG_PORT=''
ARG_HELP=0

for arg in "$@"; do
  case "$arg" in
    --server) ARG_SERVER=1 ;;
    --agent=*) ARG_AGENTS="${arg#--agent=}" ;;
    --action=*) ARG_ACTION="${arg#--action=}" ;;
    --ref=*) REF="${arg#--ref=}" ;;
    --up) ARG_UP=1 ;;
    --status) ARG_STATUS=1 ;;
    --json) ARG_JSON=1 ;;
    --token=*) ARG_TOKEN="${arg#--token=}"; ARG_TOKEN_SET=1 ;;
    --port=*) ARG_PORT="${arg#--port=}" ;;
    --noninteractive) NONINTERACTIVE=1 ;;
    -h|--help) ARG_HELP=1 ;;
    *) printf '[rembric] error: unknown argument %s\n' "$arg" >&2; exit 2 ;;
  esac
done

# ── colours (truecolor → 256 → plain; honour NO_COLOR / non-tty stdout) ─────
LIME='' DIM='' WARN='' DANGER='' BOLD='' RESET=''
setup_colors() {
  [ -n "${NO_COLOR:-}" ] && return 0
  [ -t 1 ] || return 0
  RESET=$(printf '\033[0m'); BOLD=$(printf '\033[1m')
  case "${COLORTERM:-}" in
    truecolor|24bit)
      LIME=$(printf '\033[38;2;198;242;78m')
      DIM=$(printf '\033[38;2;154;154;154m')
      WARN=$(printf '\033[38;2;255;140;0m')
      DANGER=$(printf '\033[38;2;255;51;68m') ;;
    *) case "${TERM:-}" in
         *256color*)
           LIME=$(printf '\033[38;5;154m'); DIM=$(printf '\033[38;5;245m')
           WARN=$(printf '\033[38;5;208m'); DANGER=$(printf '\033[38;5;203m') ;;
         *) LIME=$BOLD; WARN=$BOLD; DANGER=$BOLD ;;
       esac ;;
  esac
}
setup_colors

say() { printf '%s\n' "$*"; }
hr()  { printf '%s────────────────────────────────────────────────────%s\n' "$DIM" "$RESET"; }

# Block-letter REMBRIC wordmark rows + display width (hardcoded — the rows are
# multibyte █, so we can't measure width portably).
WM1='██████  ███████ ███    ███ ██████  ██████  ██  ██████'
WM2='██   ██ ██      ████  ████ ██   ██ ██   ██ ██ ██'
WM3='██████  █████   ██ ████ ██ ██████  ██████  ██ ██'
WM4='██   ██ ██      ██  ██  ██ ██   ██ ██   ██ ██ ██'
WM5='██   ██ ███████ ██      ██ ██████  ██   ██ ██  ██████'
WM_W=54
BANNER_DONE=0
_wm_static() { printf '  %s\n  %s\n  %s\n  %s\n  %s\n' "$WM1" "$WM2" "$WM3" "$WM4" "$WM5"; }
# Horizontal left-to-right reveal: each frame reprints the full lime banner then
# overlays plain spaces on the right of every row (1-byte, so no multibyte
# truncation), shrinking the overlay so the banner wipes in from the left. The
# final frame has zero overlay = full banner. Plays once, interactive TTY only.
_wm_anim() {
  printf '\033[?25l'
  _w=0
  while :; do
    printf '%s' "$LIME"; _wm_static; printf '%s' "$RESET"
    printf '\033[5A'                                   # back up to row 1
    _i=0
    while [ "$_i" -lt 5 ]; do
      [ $((WM_W - _w)) -gt 0 ] && printf '\033[%dG%*s' "$((3 + _w))" "$((WM_W - _w))" ''
      printf '\033[1E'                                 # next row, column 1
      _i=$((_i + 1))
    done
    [ "$_w" -ge "$WM_W" ] && break
    sleep 0.03 2>/dev/null || true
    printf '\033[5A'                                   # back up to redraw next frame
    _w=$((_w + 6))
  done
  printf '\033[?25h'
}
wordmark() {
  # Block-letter REMBRIC + hero tagline in lime when colour is active; plain
  # one-liner otherwise (headless / NO_COLOR / non-tty). Animate the reveal only
  # on the first interactive render; later redraws are instant.
  if [ -z "$LIME" ]; then printf '\n  rembric installer\n'; return; fi
  printf '\n'
  if [ "$BANNER_DONE" = "0" ] && [ "$HAVE_TTY" = "1" ]; then
    _wm_anim
  else
    printf '%s' "$LIME"; _wm_static; printf '%s' "$RESET"
  fi
  printf '\n'
  printf '%s  Persistent memory for AI coding agents — self-hosted, MCP-native, append-only.%s\n' "$DIM" "$RESET"
  printf '%s  One Docker image, one SQLite file.%s\n' "$DIM" "$RESET"
  BANNER_DONE=1
}
banner() {
  wordmark
  printf '\n'
  # Always announce the source (supply-chain transparency): the local clone path,
  # or the remote ref artifacts are fetched from.
  printf '%s  source: %s%s\n' "$DIM" "$([ -n "$REMBRIC_SRC" ] && echo "local:$REMBRIC_SRC" || echo "ref:$REF")" "$RESET"
  hr
}

# screen: clear the terminal and redraw the banner so each navigation step
# replaces the previous one (a framed "screen" feel rather than a growing list).
# No-op clear when stdout is not a terminal (headless never reaches here).
screen() {
  [ -t 1 ] && printf '\033[2J\033[3J\033[H'
  banner
}

# pause: wait for Enter before clearing, so action output stays readable.
pause() {
  printf '\n%s  Press Enter to continue…%s' "$DIM" "$RESET" >/dev/tty
  IFS= read -r _p </dev/tty || true
}

# ── tty handling ────────────────────────────────────────────────────────────
# Interactive requires a writable /dev/tty AND a real terminal on stdin or
# stdout. Under `curl | sh`, stdin is the pipe but stdout is the terminal, so
# `[ -t 1 ]` carries it. In output-capture contexts (no terminal on either fd)
# we fall to headless instead of blocking on a key read that never comes.
HAVE_TTY=0
if { true >/dev/tty; } 2>/dev/null && { [ -t 0 ] || [ -t 1 ]; }; then HAVE_TTY=1; fi

ask() { # $1 prompt → stdout answer (read from the terminal, not piped stdin)
  printf '%s%s%s ' "$LIME" "$1" "$RESET" >/dev/tty
  IFS= read -r _a </dev/tty || _a=''
  printf '%s' "$_a"
}

# read_key → echoes UP | DOWN | ENTER | QUIT | OTHER (one keypress from the tty,
# tty already in raw mode). Arrow keys arrive as ESC [ A/B; Enter as CR/LF.
read_key() {
  _esc=$(printf '\033'); _cr=$(printf '\r')
  _c1=$(dd bs=1 count=1 2>/dev/null </dev/tty)
  if [ -z "$_c1" ] || [ "$_c1" = "$_cr" ]; then echo ENTER; return; fi
  if [ "$_c1" = "$_esc" ]; then
    _c2=$(dd bs=1 count=1 2>/dev/null </dev/tty)   # '['
    _c3=$(dd bs=1 count=1 2>/dev/null </dev/tty)   # A/B/...
    case "$_c2$_c3" in
      "[A") echo UP ;; "[B") echo DOWN ;; *) echo OTHER ;;
    esac
    return
  fi
  case "$_c1" in
    k|K) echo UP ;; j|J) echo DOWN ;; q|Q) echo QUIT ;; *) echo OTHER ;;
  esac
}

# arrow_menu "Title" opt1 opt2 ... → sets MENU_INDEX (0-based; -1 = quit).
# Arrow-key navigation in raw mode; numbered-prompt fallback when raw mode
# cannot be entered.
MENU_INDEX=0
arrow_menu() {
  _title="$1"; shift
  _n=$#; _sel=0
  _raw=0; _saved=''
  if [ "$HAVE_TTY" = "1" ] && command -v stty >/dev/null 2>&1; then
    _saved=$(stty -g </dev/tty 2>/dev/null) || _saved=''
    if [ -n "$_saved" ]; then _raw=1; fi
  fi

  if [ "$_raw" = "0" ]; then
    # Numbered fallback.
    printf '%s%s%s\n' "$BOLD" "$_title" "$RESET" >/dev/tty
    _i=1
    for _o in "$@"; do printf '  %s%d%s) %s\n' "$LIME" "$_i" "$RESET" "$_o" >/dev/tty; _i=$((_i+1)); done
    _ans=$(ask "  Select [1-$_n]:")
    case "$_ans" in
      ''|*[!0-9]*) MENU_INDEX=-1 ;;
      *) if [ "$_ans" -ge 1 ] && [ "$_ans" -le "$_n" ]; then MENU_INDEX=$((_ans-1)); else MENU_INDEX=-1; fi ;;
    esac
    return
  fi

  stty -echo -icanon min 1 time 0 </dev/tty 2>/dev/null
  printf '\033[?25l' >/dev/tty   # hide cursor
  # Restore terminal no matter how we leave.
  trap 'stty "$_saved" </dev/tty 2>/dev/null; printf "\033[?25h" >/dev/tty' EXIT INT TERM

  printf '%s%s%s\n' "$BOLD" "$_title" "$RESET" >/dev/tty
  printf '%s  ↑/↓ move · Enter select · q quit%s\n' "$DIM" "$RESET" >/dev/tty
  _first=1
  while :; do
    if [ "$_first" = "1" ]; then _first=0; else printf '\033[%dA' "$_n" >/dev/tty; fi
    _i=0
    for _o in "$@"; do
      if [ "$_i" = "$_sel" ]; then
        printf '\r\033[K  %s▸ %s%s\n' "$LIME" "$_o" "$RESET" >/dev/tty
      else
        printf '\r\033[K  %s  %s%s\n' "$DIM" "$_o" "$RESET" >/dev/tty
      fi
      _i=$((_i+1))
    done
    case "$(read_key)" in
      UP)    if [ "$_sel" -gt 0 ]; then _sel=$((_sel-1)); else _sel=$((_n-1)); fi ;;
      DOWN)  if [ "$_sel" -lt $((_n-1)) ]; then _sel=$((_sel+1)); else _sel=0; fi ;;
      ENTER) MENU_INDEX=$_sel; break ;;
      QUIT)  MENU_INDEX=-1; break ;;
    esac
  done

  stty "$_saved" </dev/tty 2>/dev/null
  printf '\033[?25h' >/dev/tty
  trap - EXIT INT TERM
}

# ── fetch: local cp when REMBRIC_SRC set, else curl from the ref ────────────
fetch() { # $1 repo-relative path, $2 dest
  _rel="$1"; _dest="$2"
  if [ -n "$REMBRIC_SRC" ]; then
    if [ -f "$REMBRIC_SRC/$_rel" ]; then cp "$REMBRIC_SRC/$_rel" "$_dest"; return 0; fi
    printf '[rembric] error: missing local file %s\n' "$REMBRIC_SRC/$_rel" >&2; return 1
  fi
  if ! curl -fsSL "$RAW_BASE/$REF/$_rel" -o "$_dest"; then
    printf '[rembric] error: failed to fetch %s\n' "$RAW_BASE/$REF/$_rel" >&2; return 1
  fi
}

read_remote() { # $1 repo-relative path → stdout file contents
  _t=$(mktemp); if fetch "$1" "$_t"; then cat "$_t"; rm -f "$_t"; else rm -f "$_t"; return 1; fi
}

# ── version helpers ─────────────────────────────────────────────────────────
# Available versions all live in one .release-please-manifest.json fetched at
# the same ref we install from (so "update available" never lies).
MANIFEST=''
load_manifest() { MANIFEST=$(read_remote ".release-please-manifest.json" 2>/dev/null || echo ''); }

available_version() { # $1 component key (e.g. apps/plugin/.hermes-plugin)
  # Key contains '/', so use '|' as the sed delimiter.
  printf '%s' "$MANIFEST" | sed -n "s|.*\"$1\"[[:space:]]*:[[:space:]]*\"\([0-9][0-9.]*\)\".*|\1|p" | head -1
}

# _rembric_cache_version <cache-base> <manifest-subpath> → highest installed
# rembric version found under <cache-base>/*/*/*/<manifest-subpath>, filtered to
# the manifest whose "name" is "rembric". Empty if none.
_rembric_cache_version() {
  _base="$1"; _sub="$2"
  for _f in "$_base"/*/*/*/"$_sub"; do
    [ -f "$_f" ] || continue
    grep -q '"name"[[:space:]]*:[[:space:]]*"rembric"' "$_f" 2>/dev/null || continue
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p' "$_f" | head -1
  done | sort -V | tail -1
}

installed_version() { # $1 client → installed semver or empty
  case "$1" in
    opencode)
      f="${HOME}/.config/opencode/plugins/rembric.ts"
      [ -f "$f" ] && sed -n 's/.*@rembric-plugin-version[[:space:]]*\([0-9][0-9.]*\).*/\1/p' "$f" | head -1 ;;
    hermes)
      f="${HERMES_HOME:-${HOME}/.hermes}/plugins/rembric/plugin.yaml"
      [ -f "$f" ] && sed -n 's/^version:[[:space:]]*["'\'']*\([0-9][0-9.]*\).*/\1/p' "$f" | head -1 ;;
    claude)
      # Claude caches the installed plugin at
      # ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.claude-plugin/plugin.json
      # (version also in the path). Glob the cache, keep only the rembric
      # manifest, return the highest version present.
      _rembric_cache_version "${HOME}/.claude/plugins/cache" ".claude-plugin/plugin.json" ;;
    codex)
      _rembric_cache_version "${HOME}/.codex/plugins/cache" ".codex-plugin/plugin.json" ;;
  esac
}

client_present() { # $1 client → 0 present, 1 absent
  case "$1" in
    claude)   command -v claude   >/dev/null 2>&1 ;;
    codex)    command -v codex    >/dev/null 2>&1 ;;
    opencode) command -v opencode >/dev/null 2>&1 ;;
    hermes)   [ -d "${HERMES_HOME:-${HOME}/.hermes}" ] ;;
  esac
}

component_key() { # $1 client → manifest component key
  case "$1" in
    claude)   echo "apps/plugin/.claude-plugin" ;;
    codex)    echo "apps/plugin/.codex-plugin" ;;
    hermes)   echo "apps/plugin/.hermes-plugin" ;;
    opencode) echo "apps/plugin/.opencode-plugin" ;;
  esac
}

# vercmp $1 installed $2 available → echo: none|update|ahead|unknown
vercmp() {
  [ -z "$2" ] && { echo unknown; return; }
  [ -z "$1" ] && { echo install; return; }
  [ "$1" = "$2" ] && { echo none; return; }
  hi=$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)
  [ "$hi" = "$2" ] && echo update || echo ahead
}

# ── status table ────────────────────────────────────────────────────────────
print_table() {
  load_manifest
  # Caption makes clear the rows are about the Rembric PLUGIN per agent — the
  # action installs/updates the plugin, not the agent itself.
  printf '%s  Rembric plugin per agent — "install"/"update" target the plugin, not the agent%s\n' "$DIM" "$RESET"
  # Columns: DETECTED = agent found on this machine · PLUGIN = installed rembric
  # plugin version · LATEST = latest plugin version · ACTION = what to do.
  # Pad on plain text only — ANSI escapes count toward printf field width and
  # would skew the columns; colour wraps the pre-padded cells.
  printf '%s  %-10s %-9s %-11s %-11s %s%s\n' "$BOLD" "AGENT" "DETECTED" "PLUGIN" "LATEST" "ACTION" "$RESET"
  for c in claude codex hermes opencode; do
    if client_present "$c"; then detc="${LIME}$(printf '%-9s' yes)${RESET}"; else detc="${DIM}$(printf '%-9s' no)${RESET}"; fi
    inst=$(installed_version "$c" 2>/dev/null || true)
    avail=$(available_version "$(component_key "$c")")
    state=$(vercmp "$inst" "$avail")
    case "$state" in
      none)    act="${DIM}up to date${RESET}" ;;
      update)  act="${WARN}update${RESET}" ;;
      install) act="${LIME}install${RESET}" ;;
      ahead)   act="${DIM}ahead${RESET}" ;;
      *)       act="${DIM}-${RESET}" ;;
    esac
    printf '  %-10s %s %-11s %-11s %s\n' "$c" "$detc" "${inst:--}" "${avail:--}" "$act"
  done
  hr
}

# ── server detection (best-effort, via docker) ──────────────────────────────
# server_state echoes a single token: running | exited | paused | created |
# dead | absent (no container) | unknown (no docker / daemon unreachable).
server_state() {
  command -v docker >/dev/null 2>&1 || { echo unknown; return; }
  docker ps >/dev/null 2>&1 || { echo unknown; return; }
  _st=$(docker container inspect rembric --format '{{.State.Status}}' 2>/dev/null) || { echo absent; return; }
  echo "${_st:-absent}"
}
# Version the running/stopped container was built from = its image tag (e.g.
# 0.21.9, or 'latest'). Empty when there is no rembric container.
server_image_version() { docker inspect rembric --format '{{.Config.Image}}' 2>/dev/null | sed -n 's/.*://p'; }

# Latest published server release from GitHub Releases (tag `server-v<semver>`),
# same source the dashboard's update-check uses. Best-effort: empty on offline /
# rate-limit / no curl / REMBRIC_UPDATE_CHECK=off. REMBRIC_RELEASES_URL overrides
# the endpoint (for tests). NOTE: a running `:latest` image can't be compared to
# this without a digest, so it's informational, not a hard "you're behind".
server_latest_release() {
  [ "${REMBRIC_UPDATE_CHECK:-on}" = "off" ] && return 0
  command -v curl >/dev/null 2>&1 || return 0
  _rurl="${REMBRIC_RELEASES_URL:-https://api.github.com/repos/susomejias/rembric/releases}"
  _rbody=$(curl -fsSL --max-time 4 "$_rurl" 2>/dev/null) || return 0
  printf '%s' "$_rbody" \
    | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"server-v[0-9]+\.[0-9]+\.[0-9]+"' \
    | sed -E 's/.*server-v([0-9.]+)".*/\1/' | sort -V | tail -1
}

# NOTE: no "available" for the server — the installer pulls the `:latest`
# image (or a pinned REMBRIC_VERSION), so the authoritative "is there a newer
# release" check is the dashboard's (GitHub Releases), not the repo manifest.
# We report only the docker-observable state + the running image tag.
server_status_print() {
  _ss=$(server_state); _sv=$(server_image_version); _lr=$(server_latest_release)
  case "$_ss" in
    running) _sc="$LIME"; _msg=running ;;
    exited|paused|created|dead) _sc="$WARN"; _msg="$_ss" ;;
    absent) _sc="$DIM"; _msg="not installed" ;;
    *) _sc="$DIM"; _msg="unknown (docker unavailable)" ;;
  esac
  _extra=''
  [ -n "$_sv" ] && _extra=" · version $_sv"
  if [ -n "$_lr" ]; then
    _extra="$_extra · latest release $_lr"
    case "$_sv" in
      [0-9]*.[0-9]*.[0-9]*)
        if [ "$_sv" != "$_lr" ] && [ "$(printf '%s\n%s\n' "$_sv" "$_lr" | sort -V | tail -1)" = "$_lr" ]; then
          _extra="$_extra ${WARN}(update available)${RESET}"
        fi ;;
    esac
  fi
  printf '  %sSERVER%s  %s%s%s%s\n' "$BOLD" "$RESET" "$_sc" "$_msg" "$RESET" "$_extra"
}

# do_status: headless, machine-friendly view of the server + per-agent plugin
# versions for agents driving the installer as a CLI. Text shows a SERVER line
# then the agent table; --json emits {server, agents}. Payload only (no banner).
json_str() { if [ -z "$1" ]; then printf 'null'; else printf '"%s"' "$1"; fi; }
do_status() {
  load_manifest
  if [ "$ARG_JSON" = "1" ]; then
    printf '{"server":{"state":"%s","version":%s,"latest_release":%s},"agents":[' \
      "$(server_state)" "$(json_str "$(server_image_version)")" "$(json_str "$(server_latest_release)")"
    _f=1
    for c in claude codex hermes opencode; do
      if client_present "$c"; then _p=true; else _p=false; fi
      _inst=$(installed_version "$c" 2>/dev/null || true)
      _avail=$(available_version "$(component_key "$c")")
      _state=$(vercmp "$_inst" "$_avail")
      if [ "$_f" = "1" ]; then _f=0; else printf ','; fi
      printf '{"agent":"%s","present":%s,"installed":%s,"available":%s,"action":"%s"}' \
        "$c" "$_p" "$(json_str "$_inst")" "$(json_str "$_avail")" "$_state"
    done
    printf ']}\n'
    return 0
  fi
  server_status_print
  say ""
  print_table
}

# write_token: set REMBRIC_ADMIN_TOKEN in ./.env to an arbitrary value safely
# (awk -v avoids sed delimiter/regex issues with user-supplied tokens).
write_token() {
  if grep -q '^REMBRIC_ADMIN_TOKEN=' ./.env; then
    _tmp=$(mktemp); awk -v v="$1" '/^REMBRIC_ADMIN_TOKEN=/{print "REMBRIC_ADMIN_TOKEN=" v; next} {print}' ./.env > "$_tmp" && mv "$_tmp" ./.env
  else
    printf 'REMBRIC_ADMIN_TOKEN=%s\n' "$1" >> ./.env
  fi
}

# gen_token → a 64-char hex admin token (openssl, or /dev/urandom via od).
gen_token() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; return; fi
  if [ -r /dev/urandom ]; then od -An -tx1 -N32 /dev/urandom 2>/dev/null | tr -d ' \n'; echo; return; fi
  printf '[rembric] error: no openssl and no /dev/urandom to generate a token\n' >&2
  return 1
}

# bring_up: offer to `docker compose pull && up -d`, gated on docker compose
# being available AND user confirmation (interactive [y/N] or --up). Shared by
# install and update so both behave the same. Reads $tok for the login line.
bring_up() {
  if ! docker_compose_ok; then
    has docker && say "  ${WARN}docker present but 'docker compose' (v2) not available${RESET} — skipping auto-up."
    say "  Files ready. ${BOLD}Run it:${RESET} docker compose pull && docker compose up -d"
    return 0
  fi
  _run=0
  if [ "$ARG_UP" = "1" ]; then
    _run=1
  elif [ "$NONINTERACTIVE" = "0" ] && [ "$HAVE_TTY" = "1" ]; then
    case "$(ask "  Run 'docker compose pull && up -d' now? [y/N]")" in y|Y) _run=1 ;; esac
  fi
  if [ "$_run" != "1" ]; then
    say "  Ready. ${BOLD}Run it:${RESET} docker compose pull && docker compose up -d"
    return 0
  fi
  # Pull first so a stale local `latest` tag can't shadow the published image
  # (and to actually fetch the new version on update); skipped silently offline,
  # or explicitly via REMBRIC_NO_PULL=1 (air-gapped / use the local image as-is).
  if [ "${REMBRIC_NO_PULL:-0}" = "1" ]; then
    say "  ${DIM}(pull skipped — REMBRIC_NO_PULL)${RESET}"
  else
    docker compose pull 2>/dev/null || say "  ${DIM}(pull skipped — using local image)${RESET}"
  fi
  # Capture so a daemon error (e.g. a name conflict) becomes a friendly message
  # instead of a raw dump; `up -d` output is short, so we re-print it on success.
  # `if x=$(…); then` keeps the capture set -e-safe (a bare `x=$(failing)` aborts).
  if _up=$(docker compose up -d 2>&1); then _rc=0; else _rc=$?; fi
  if [ "$_rc" = "0" ]; then
    say "  ${LIME}Up.${RESET} Dashboard: ${BOLD}http://127.0.0.1:${ARG_PORT:-8787}/dashboard${RESET}  (adjust host to your setup)"
    [ -n "${tok:-}" ] && say "  Log in with admin token: ${BOLD}${tok}${RESET}"
  else
    case "$_up" in
      *"already in use"*|*Conflict*)
        say "  ${WARN}A Rembric container named 'rembric' is already running${RESET} — left untouched."
        say "  ${DIM}Refusing to clobber an existing install.${RESET} You can either:"
        say "    • keep using it — open its dashboard, or"
        say "    • replace it: ${BOLD}docker rm -f rembric${RESET}  (or 'docker compose down' in its install dir), then re-run."
        ;;
      *)
        printf '%s\n' "$_up" | tail -4
        say "  ${DANGER}docker compose up failed${RESET} — files are ready to retry."
        ;;
    esac
  fi
}

# ── server flow: prepare + generate token + optional `up` (gated) ──────────
do_server() {
  action="${1:-install}"
  say "${BOLD}Server (${action})${RESET}"
  server_deps_report
  fetch "docker-compose.yml" "./docker-compose.yml" || return 1

  if [ "$action" = "update" ]; then
    say "  Refetched ${LIME}docker-compose.yml${RESET}."
    if [ ! -f ./.env ]; then
      say "  ${WARN}No ./.env here${RESET} — run server install first (this dir has no configured server)."
      return 0
    fi
    tok=$(sed -n 's/^REMBRIC_ADMIN_TOKEN=//p' ./.env | head -1)
    bring_up
    return 0
  fi

  # Ensure .env exists, then read its current token. An empty token means
  # either a brand-new .env or one left half-written by an interrupted run —
  # both are filled here. A non-empty token is left untouched.
  if [ ! -f ./.env ]; then
    fetch ".env.example" "./.env" || return 1
    env_new=1
  else
    env_new=0
  fi
  tok=$(sed -n 's/^REMBRIC_ADMIN_TOKEN=//p' ./.env | head -1)

  if [ "$ARG_TOKEN_SET" = "1" ]; then
    if [ "${#ARG_TOKEN}" -lt 16 ]; then
      say "  ${DANGER}--token too short${RESET} — REMBRIC_ADMIN_TOKEN needs at least 16 characters (the server refuses to boot otherwise)."
      return 1
    fi
    tok="$ARG_TOKEN"; write_token "$tok"
    say "  Admin token (provided): ${BOLD}${tok}${RESET}"
  elif [ -n "$tok" ]; then
    say "  ./.env already configured — left untouched."
    say "  Admin token (from ./.env): ${BOLD}${tok}${RESET}"
  else
    [ "$env_new" = "0" ] && say "  ${WARN}./.env exists but REMBRIC_ADMIN_TOKEN is empty${RESET} — setting it now."
    if [ "$NONINTERACTIVE" = "0" ] && [ "$HAVE_TTY" = "1" ]; then
      tok=$(ask "  Paste REMBRIC_ADMIN_TOKEN, or leave blank to auto-generate:")
    fi
    if [ -n "$tok" ] && [ "${#tok}" -lt 16 ]; then
      say "  ${DANGER}Token too short${RESET} — REMBRIC_ADMIN_TOKEN needs at least 16 characters."
      return 1
    fi
    gen=0
    if [ -z "$tok" ]; then
      if ! token_capable; then
        say "  ${DANGER}Cannot auto-generate a token${RESET} (no openssl and no /dev/urandom)."
        say "  Edit ./.env, set REMBRIC_ADMIN_TOKEN by hand, then: docker compose up -d"
        return 1
      fi
      tok=$(gen_token) || return 1
      gen=1
    fi
    write_token "$tok"
    if [ "$gen" = "1" ]; then say "  Generated admin token: ${BOLD}${tok}${RESET}"
    else say "  Admin token (yours): ${BOLD}${tok}${RESET}"; fi
    say "  ${DIM}(saved in ./.env — needed to log into the dashboard)${RESET}"
  fi

  if [ -n "$ARG_PORT" ]; then
    if grep -q '^REMBRIC_PORT=' ./.env; then
      _tmp=$(mktemp); awk -v v="$ARG_PORT" '/^REMBRIC_PORT=/{print "REMBRIC_PORT=" v; next} {print}' ./.env > "$_tmp" && mv "$_tmp" ./.env
    else
      printf 'REMBRIC_PORT=%s\n' "$ARG_PORT" >> ./.env
    fi
    say "  Port: ${BOLD}${ARG_PORT}${RESET}  ${DIM}(REMBRIC_PORT in ./.env)${RESET}"
  fi

  bring_up
}

# ── plugin actions ──────────────────────────────────────────────────────────
# opencode/Hermes: delegate to the client's own install.sh/uninstall.sh.
# Claude/Codex: print marketplace CLI commands (run-through gated on binary).
run_client_script() { # $1 client, $2 install|uninstall
  c="$1"; verb="$2"
  case "$c" in
    opencode) dir=".opencode-plugin"; has_uninstall=1 ;;
    hermes)   dir=".hermes-plugin";   has_uninstall=1 ;;
    *) return 1 ;;
  esac
  script="install.sh"; [ "$verb" = "uninstall" ] && script="uninstall.sh"
  [ "$verb" = "uninstall" ] && [ "$has_uninstall" != "1" ] && { say "  no uninstaller for $c"; return 1; }

  if [ -n "$REMBRIC_SRC" ]; then
    # Local: run the script in place, pointing it at the local tree.
    if [ "$c" = "opencode" ]; then
      PLUGIN_SRC="$REMBRIC_SRC/apps/plugin/$dir" BIN_SRC="$REMBRIC_SRC/apps/plugin/bin" \
        sh "$REMBRIC_SRC/apps/plugin/$dir/$script"
    else
      PLUGIN_SRC="$REMBRIC_SRC/apps/plugin/$dir" sh "$REMBRIC_SRC/apps/plugin/$dir/$script"
    fi
  else
    # Remote: fetch the script and point it at the same ref.
    t=$(mktemp); fetch "apps/plugin/$dir/$script" "$t" || { rm -f "$t"; return 1; }
    base="$RAW_BASE/$REF/apps/plugin"
    if [ "$c" = "opencode" ]; then
      PLUGIN_SRC="$base/$dir" BIN_SRC="$base/bin" sh "$t"
    else
      PLUGIN_SRC="$base/$dir" sh "$t"
    fi
    rm -f "$t"
  fi
}

marketplace_cmds() { # $1 client, $2 action → print (and optionally run) CLI
  c="$1"; action="$2"
  case "$c" in
    claude)
      add="claude plugin marketplace add https://github.com/susomejias/rembric.git"
      ins="claude plugin install rembric@rembric"
      rem="claude plugin uninstall rembric@rembric" ;;
    codex)
      add="codex plugin marketplace add https://github.com/susomejias/rembric.git"
      ins="codex plugin install rembric"
      rem="codex plugin uninstall rembric" ;;
  esac
  case "$action" in
    install|update) say "  Run:"; say "    ${BOLD}$add${RESET}"; say "    ${BOLD}$ins${RESET}"; cmd="$ins" ;;
    uninstall)      say "  Run:"; say "    ${BOLD}$rem${RESET}"; cmd="$rem"; add='' ;;
  esac
  if [ "$NONINTERACTIVE" = "0" ] && [ "$HAVE_TTY" = "1" ] && client_present "$c"; then
    yn=$(ask "  Run these now? [y/N]")
    case "$yn" in
      y|Y)
        [ -n "${add:-}" ] && eval "$add" || true
        eval "$cmd" || true ;;
    esac
  fi
  if [ "$action" = "uninstall" ]; then say "  ${DIM}Left in place: your stored credentials and any .rembric files.${RESET}"; fi
  return 0
}

# Required post-install/upgrade steps per agent (the platform bits the installer
# can't do for you). Surfaced after a successful install/update so the user
# isn't left with a half-wired plugin. Full walkthrough: docs/agents.md.
post_install_notes() {
  case "$1" in
    claude)
      say "  ${BOLD}Next:${RESET} Claude prompts for the server URL + token during install (stored in your keychain). Restart Claude Code." ;;
    codex)
      say "  ${BOLD}Next${RESET} (one-time — required or hooks won't fire):"
      say "    1) ${BOLD}codex features enable plugin_hooks${RESET}"
      say "    2) open ${BOLD}/hooks${RESET} in Codex and trust the 5 rembric hooks"
      say "    3) export ${BOLD}REMBRIC_SERVER_URL${RESET} + ${BOLD}REMBRIC_API_TOKEN${RESET} in your shell (Codex clears MCP env)"
      say "    ${DIM}details: docs/agents.md${RESET}" ;;
    hermes)
      say "  ${BOLD}Next:${RESET}"
      say "    1) ${BOLD}hermes plugins install rembric${RESET}  ${DIM}— prompts for SERVER_URL / API_TOKEN / PROJECT_SLUG → ~/.hermes/.env${RESET}"
      say "    2) ${BOLD}hermes plugins enable rembric${RESET}"
      say "    3) ${BOLD}hermes gateway restart${RESET}  ${DIM}— so the gateway loads the (new) plugin${RESET}" ;;
    opencode)
      say "  ${BOLD}Next:${RESET} paste the printed MCP block into ~/.config/opencode/opencode.json, export ${BOLD}REMBRIC_SERVER_URL${RESET} + ${BOLD}REMBRIC_API_TOKEN${RESET}, then restart opencode." ;;
  esac
}

do_client() { # $1 client, $2 action
  c="$1"; action="$2"
  say "${BOLD}${c} (${action})${RESET}"
  case "$c" in
    opencode|hermes)
      run_client_script "$c" "$([ "$action" = uninstall ] && echo uninstall || echo install)"
      if [ "$action" = "uninstall" ]; then say "  ${DIM}Left in place: operator config, credentials, and .rembric files.${RESET}"; fi ;;
    claude|codex) marketplace_cmds "$c" "$action" ;;
  esac
  if [ "$action" != "uninstall" ]; then post_install_notes "$c"; fi
  return 0
}

usage() {
  cat >&2 <<EOF
rembric installer — interactive TUI, or a headless CLI for agents/automation.

Interactive:   sh install.sh
Status:        sh install.sh --status [--json]
Server:        sh install.sh --server [--token=<tok>] [--port=<n>] [--up]
Plugins:       sh install.sh --agent=opencode,hermes --action=install|update|uninstall

Flags:
  --status            print the agent/version table headless (no menu); exit
  --json              machine-readable output for --status
  --server            prepare the server (docker-compose.yml + .env + token)
  --agent=<a,b,..>   one or more of: claude codex hermes opencode
  --action=<a>        install | update | uninstall
  --token=<tok>       admin token for --server (default: auto-generate)
  --port=<n>          REMBRIC_PORT for --server (default: 8787)
  --up                run 'docker compose pull && up -d' after --server (needs docker)
  --ref=<tag>         git ref to install from (default: main)
  -h, --help          this help

Env: REMBRIC_NONINTERACTIVE=1 (force headless) · REMBRIC_SRC=<clone> (read from
     disk, no network) · REMBRIC_REF=<tag> · NO_COLOR · REMBRIC_NO_PULL=1
     (skip 'docker compose pull' on --up) · REMBRIC_UPDATE_CHECK=off (skip the
     GitHub release lookup in --status).
EOF
}

# preflight: the tools the installer needs before it can install/update. curl
# is only required in remote mode (REMBRIC_SRC reads from disk with cp). Aborts
# with a clear, actionable error listing everything missing at once.
preflight() {
  _missing=''
  for _t in sed awk grep sort mktemp; do
    command -v "$_t" >/dev/null 2>&1 || _missing="$_missing $_t"
  done
  if [ -z "$REMBRIC_SRC" ]; then
    command -v curl >/dev/null 2>&1 || _missing="$_missing curl"
  fi
  if [ -n "$_missing" ]; then
    printf '[rembric] error: missing required tool(s):%s\n' "$_missing" >&2
    printf '          install them (your OS package manager) and re-run.\n' >&2
    return 1
  fi
  return 0
}

has() { command -v "$1" >/dev/null 2>&1; }
# Docker Compose v2 is a `docker` subcommand; v1 `docker-compose` is not enough
# for the compose file shape we ship. Verify the real `docker compose`.
docker_compose_ok() { has docker && docker compose version >/dev/null 2>&1; }
# Token generation needs openssl or a readable /dev/urandom.
token_capable() { has openssl || [ -r /dev/urandom ]; }

mark() { if "$@" >/dev/null 2>&1; then printf '%s✓%s' "$LIME" "$RESET"; else printf '%s✗%s' "$DANGER" "$RESET"; fi; }
server_deps_report() {
  say "  ${DIM}Dependency check:${RESET}"
  printf '    docker          %s\n' "$(mark has docker)"
  printf '    docker compose  %s %s\n' "$(mark docker_compose_ok)" "${DIM}(only needed to auto-run 'up')${RESET}"
  if has openssl; then printf '    openssl         %s\n' "$(mark has openssl)";
  else printf '    openssl         %s %s\n' "$(mark token_capable)" "${DIM}(absent — using /dev/urandom)${RESET}"; fi
}

# ── dispatch ────────────────────────────────────────────────────────────────
if [ "$ARG_HELP" = "1" ]; then usage; exit 0; fi

# Verify the universally-required tools up front (curl only in remote mode).
preflight || exit 1

# --status is a read-only query (CLI / agent use): print and exit, no banner,
# regardless of TTY. With --json the output is the JSON payload only.
if [ "$ARG_STATUS" = "1" ]; then do_status; exit 0; fi

# Non-interactive / no-TTY → require explicit flags, never guess.
if [ "$NONINTERACTIVE" = "1" ] || [ "$HAVE_TTY" = "0" ]; then
  banner
  did=0
  [ "$ARG_SERVER" = "1" ] && { do_server "${ARG_ACTION:-install}"; did=1; }
  if [ -n "$ARG_AGENTS" ]; then
    [ -z "$ARG_ACTION" ] && { printf '[rembric] error: --agent requires --action\n' >&2; usage; exit 2; }
    load_manifest
    OLDIFS=$IFS; IFS=','
    for c in $ARG_AGENTS; do
      case "$c" in claude|codex|hermes|opencode) do_client "$c" "$ARG_ACTION"; did=1 ;;
        *) printf '[rembric] error: unknown agent %s\n' "$c" >&2; IFS=$OLDIFS; exit 2 ;; esac
    done
    IFS=$OLDIFS
  fi
  [ "$did" = "0" ] && { usage; exit 2; }
  exit 0
fi

# Interactive menu (arrow-key navigation; numeric fallback inside arrow_menu).
# Each step clears + redraws so navigating in/out of sections feels like
# moving between screens, not a growing list.
while :; do
  screen
  arrow_menu "What do you want to do?" \
    "Server   — prepare docker-compose + .env" \
    "Plugins  — detect, install / update / uninstall" \
    "Quit"
  case "$MENU_INDEX" in
    0)
      screen
      server_status_print
      say ""
      arrow_menu "Server action" "install" "update"
      case "$MENU_INDEX" in
        0) screen; do_server install; pause ;;
        1) screen; do_server update;  pause ;;
      esac ;;
    1)
      screen
      print_table
      arrow_menu "Which agent?" "claude" "codex" "hermes" "opencode"
      case "$MENU_INDEX" in
        0) c=claude ;; 1) c=codex ;; 2) c=hermes ;; 3) c=opencode ;; *) c='' ;;
      esac
      if [ -n "$c" ]; then
        screen
        arrow_menu "Action for $c" "install" "update" "uninstall"
        case "$MENU_INDEX" in
          0) screen; do_client "$c" install;   pause ;;
          1) screen; do_client "$c" update;    pause ;;
          2) screen; do_client "$c" uninstall; pause ;;
        esac
      fi ;;
    *) screen; say "  bye"; break ;;
  esac
done
