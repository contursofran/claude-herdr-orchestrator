#!/usr/bin/env bash
# Copies the plugin API's type declarations into this checkout so `npm run typecheck`
# works (view/ uses the same copy). Claude Code writes them into an installed mod when
# it loads it, so run ./install.sh and start a Claude Code session once first.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
src=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/mods/herdr-agents/.claude-plugin/types

if [[ ! -d $src ]]; then
  echo "No types in $src yet: run ./install.sh, then start Claude Code once so it loads the mod." >&2
  exit 1
fi
rm -rf "$here/.claude-plugin/types" && cp -R "$src" "$here/.claude-plugin/types"
echo "Copied the plugin API types from $src."
