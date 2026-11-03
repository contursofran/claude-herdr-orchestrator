#!/usr/bin/env bash
# Copies the plugin API's type declarations into this checkout so `npm run typecheck`
# works (view/ uses the same copy). Claude Code writes them into an installed mod when
# it loads it, so run ./install.sh and start a Claude Code session once first.
#
#   scripts/types.sh          copy the installed mod's types into .claude-plugin/types (ignored by git)
#   scripts/types.sh --pin    refresh types-pinned/, the copy CI typechecks against, from the same source
#   scripts/types.sh --pinned copy types-pinned/ into .claude-plugin/types (what CI runs)
#   scripts/types.sh --if-missing  copy types-pinned/ only when .claude-plugin/types has no tsconfig.json
#                             (npm run typecheck runs this, so a fresh worktree works; an existing copy is kept)
#
# CI can't write the types itself: they come from a signed-in Claude Code session loading the mod.
# So types-pinned/ is committed. Refresh it with --pin after a Claude Code update and commit the result.
# claude-code-mcp is left out: it is generated from the MCP servers connected on the machine, and the root
# tsconfig.json only uses claude-code and claude-code-tools. Its line is dropped from the pinned tsconfig.json.
# types-pinned/VERSION records the Claude Code version the copy came from; CI warns when its own differs.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
src=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/mods/herdr-agents/.claude-plugin/types
mode=${1:-}

if [[ $mode == --if-missing ]]; then
  [[ -f $here/.claude-plugin/types/tsconfig.json ]] && exit 0
  echo "No .claude-plugin/types here: using the pinned copy (scripts/types.sh gets your local types)." >&2
  mode=--pinned
fi

if [[ $mode == --pinned ]]; then
  if [[ -d $here/.claude-plugin/types && -z ${CI:-} ]]; then
    echo "Replacing .claude-plugin/types with the pinned copy (rerun scripts/types.sh to get your local types back)." >&2
  fi
  rm -rf "$here/.claude-plugin/types" && cp -R "$here/types-pinned" "$here/.claude-plugin/types"
  echo "Copied the pinned plugin API types."
  exit 0
fi

if [[ ! -d $src ]]; then
  echo "No types in $src yet: run ./install.sh, then start Claude Code once so it loads the mod." >&2
  exit 1
fi
rm -rf "$here/.claude-plugin/types" && cp -R "$src" "$here/.claude-plugin/types"
echo "Copied the plugin API types from $src."
if [[ $mode == --pin ]]; then
  rm -rf "$here/types-pinned" && mkdir "$here/types-pinned"
  cp -R "$src/claude-code" "$src/claude-code-tools" "$src/tsconfig.json" "$here/types-pinned/"
  # Drop the claude-code-mcp entry (and the comma before it) from the copied tsconfig.json.
  perl -0pi -e 's/,\s*"claude-code-mcp"//' "$here/types-pinned/tsconfig.json"
  claude --version | awk '{print $1}' > "$here/types-pinned/VERSION"
  echo "Refreshed types-pinned/ (commit it)."
fi
