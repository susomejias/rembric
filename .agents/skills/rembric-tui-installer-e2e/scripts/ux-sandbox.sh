# shellcheck shell=sh
# Rembric TUI installer — UX sandbox.
#
# SOURCE this (don't execute it) so the `rbx` function persists in your shell:
#   source .agents/skills/rembric-tui-installer-e2e/scripts/ux-sandbox.sh
#   rbx                              # launch the installer (interactive menu)
#   rbx --server --action=install    # or drive it headless with flags
#   rbx_clean                        # remove the sandbox when done
#
# Everything runs in a throwaway dir: HOME and the working dir are isolated, so
# plugin installs and server files never touch your real ~/.config, ~/.hermes,
# ~/.claude. REMBRIC_SRC points at this clone (reads from disk, no network).

REMBRIC_REPO=$(git rev-parse --show-toplevel 2>/dev/null) || REMBRIC_REPO="$PWD"
REMBRIC_SANDBOX=$(mktemp -d)
mkdir -p "$REMBRIC_SANDBOX/home" "$REMBRIC_SANDBOX/work"
# `docker compose` is a CLI plugin under the real ~/.docker; share it so the
# dependency check + optional `up` work, while installs stay sandboxed.
ln -s "$HOME/.docker" "$REMBRIC_SANDBOX/home/.docker" 2>/dev/null || true

rbx() {
  ( cd "$REMBRIC_SANDBOX/work" \
    && HOME="$REMBRIC_SANDBOX/home" REMBRIC_SRC="$REMBRIC_REPO" \
       sh "$REMBRIC_REPO/install.sh" "$@" )
}

rbx_clean() {
  ( cd "$REMBRIC_SANDBOX/work" 2>/dev/null && docker compose down >/dev/null 2>&1 )
  rm -rf "$REMBRIC_SANDBOX"
  unset REMBRIC_SANDBOX REMBRIC_REPO
  unset -f rbx rbx_clean 2>/dev/null || true
  echo "rembric UX sandbox removed"
}

printf '\n  \033[38;2;198;242;78m✓ Rembric UX sandbox ready\033[0m\n'
printf '    repo:    %s\n' "$REMBRIC_REPO"
printf '    sandbox: %s\n' "$REMBRIC_SANDBOX"
printf '    \033[1mrbx\033[0m          launch the installer (↑/↓ · Enter · q)\n'
printf '    \033[1mrbx --help\033[0m   headless flags\n'
printf '    \033[1mrbx_clean\033[0m    remove the sandbox when done\n\n'
