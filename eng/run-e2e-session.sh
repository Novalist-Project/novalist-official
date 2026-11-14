#!/usr/bin/env bash
# Run a command (normally `npx playwright test ...`) inside the isolated Linux
# desktop session the Electron E2E suite needs: a virtual display, a private
# D-Bus session and a disposable, unlocked GNOME keyring.
#
# Shared by .github/workflows/ci.yml and .github/workflows/e2e-stress.yml through
# .github/actions/e2e-run, so both run tests in exactly the same environment.
# Usage (from app/): bash ../eng/run-e2e-session.sh <command> [args...]
set -euo pipefail

if [ "${1:-}" = "--inside-session" ]; then
  shift
  # A fresh random password protects only this disposable CI keyring.
  openssl rand -hex 32 | gnome-keyring-daemon --foreground --unlock --components=secrets --control-directory "$GNOME_KEYRING_CONTROL" &
  keyring_pid=$!
  trap 'kill "$keyring_pid" 2>/dev/null || true; wait "$keyring_pid" 2>/dev/null || true' EXIT
  gdbus wait --session --timeout 20 org.freedesktop.secrets
  "$@"
  exit
fi

if [ "$#" -eq 0 ]; then
  echo "usage: run-e2e-session.sh <command> [args...]" >&2
  exit 2
fi

export NOVALIST_E2E_ALLOW_DESKTOP=1
credential_session=$(mktemp -d)
trap 'rm -rf "$credential_session"' EXIT
# Keep Playwright pointed at the browsers installed before cache isolation.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright}"
export XDG_CONFIG_HOME="$credential_session/config"
export XDG_DATA_HOME="$credential_session/data"
export XDG_CACHE_HOME="$credential_session/cache"
export XDG_RUNTIME_DIR="$credential_session/runtime"
export GNOME_KEYRING_CONTROL="$XDG_RUNTIME_DIR/keyring"
export XDG_CURRENT_DESKTOP=GNOME
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$GNOME_KEYRING_CONTROL"
chmod 700 "$XDG_RUNTIME_DIR" "$GNOME_KEYRING_CONTROL"
xvfb-run --auto-servernum dbus-run-session -- bash "${BASH_SOURCE[0]}" --inside-session "$@"
