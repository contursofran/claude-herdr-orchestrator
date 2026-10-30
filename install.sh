#!/usr/bin/env bash
# Installs herdr-agents from this clone, or updates it: the two mods (with the
# planner/builder/reviewer subagents) and the Claude Code settings that load them.
# For working on the mod; everyone else installs it from the marketplace (README).
#
#   ./install.sh            # from a clone of this repo; run it again after a pull
#
# Needs node (to edit the JSON settings) and rsync; hc (herdr-core) runs the workers.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
claude=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
mods="$claude/mods"

command -v hc >/dev/null || echo "note: hc is not on PATH; workers only start when Claude Code runs in an hc terminal. hc is herdr-core: https://github.com/herdrdev/herdr-core"
mkdir -p "$mods/herdr-agents" "$mods/herdr-agents-view"

# A mod is its manifest, its hooks, its subagents and its type contract. The engine writes
# .claude-plugin/types into the installed folder; that stays.
install_mod() {
  local src=$1 dest=$2
  mkdir -p "$dest/.claude-plugin"
  cp "$src/.claude-plugin/plugin.json" "$dest/.claude-plugin/"
  rsync -a --delete "$src/hooks/" "$dest/hooks/"
  for dir in types agents; do
    if [[ -d $src/$dir ]]; then rsync -a --delete "$src/$dir/" "$dest/$dir/"; fi
  done
}
install_mod "$here" "$mods/herdr-agents"
install_mod "$here/view" "$mods/herdr-agents-view"
# The clone this ran from, at the top of the installed mod (not in a folder rsync clears): /hrd-update pulls it.
printf '%s\n' "$here" > "$mods/herdr-agents/clone"

[[ -f "$claude/herdr-agents.json" ]] || cp "$here/herdr-agents.example.json" "$claude/herdr-agents.json"

# settings.json: load both mods and allow their tools. keybindings.json: alt+d focuses the band.
node - "$claude" "$mods" <<'EOF'
const fs = require('fs')
const [claude, mods] = process.argv.slice(2)
const edit = (file, fn) => {
  const path = `${claude}/${file}`
  const json = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {}
  fn(json)
  fs.writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`)
}
edit('settings.json', s => {
  s.env ??= {}
  const dirs = (s.env.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(':').filter(Boolean)
  for (const name of ['herdr-agents', 'herdr-agents-view']) {
    const dir = `${mods}/${name}`
    if (!dirs.some(d => d.replace(/^~(?=\/)/, process.env.HOME) === dir)) dirs.push(dir)
  }
  s.env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(':')
  s.permissions ??= {}
  s.permissions.allow ??= []
  if (!s.permissions.allow.includes('mcp__herdr-agents')) s.permissions.allow.push('mcp__herdr-agents')
})
edit('keybindings.json', k => {
  k.bindings ??= []
  let chat = k.bindings.find(b => b.context === 'Chat')
  if (!chat) k.bindings.push((chat = { context: 'Chat', bindings: {} }))
  chat.bindings['alt+d'] ??= 'abovePrompt:focus'
})
EOF

# The Herdr app mod (app/): only when the app is there. It copies the mod, makes a "coordinator" layout beside "main"
# (never switching to it) and adds the mod's keys without replacing any bound key.
app_home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
if [[ -d $app_home ]]; then
  mkdir -p "$app_home/mods/herdr-agents"
  # The app writes jsconfig.json and gpui-kit.d.ts into mod folders.
  # version.json stays through the rsync: rewriting it each time would reload every copy of the mod.
  rsync -a --delete --exclude jsconfig.json --exclude gpui-kit.d.ts --exclude version.json "$here/app/mods/herdr-agents/" "$app_home/mods/herdr-agents/"
  # What the status bar shows: the plugin's version, and the short commit if git can give it (the app mod is sometimes
  # delivered between releases). Written beside it and renamed, and only when it changed.
  commit=$(git -C "$here" rev-parse --short HEAD 2>/dev/null || true)
  node - "$here/.claude-plugin/plugin.json" "$app_home/mods/herdr-agents" "$commit" <<'EOF' || echo "Version step failed; carrying on."
const fs = require('fs')
const [manifest, dir, commit] = process.argv.slice(2)
const { version } = JSON.parse(fs.readFileSync(manifest, 'utf8'))
const text = `${JSON.stringify(commit ? { version, commit } : { version })}\n`
const target = `${dir}/version.json`
if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) {
  fs.writeFileSync(`${dir}/.version.json.tmp`, text)
  fs.renameSync(`${dir}/.version.json.tmp`, target)
}
EOF
  # A layout or key problem is printed and does not stop the install.
  node "$here/app/layout.mjs" "$app_home" || echo "Layout step failed; carrying on."
  node "$here/app/keys.mjs" "$app_home" || echo "Keys step failed; carrying on."
fi

echo "Installed herdr-agents into $claude. A first install loads in sessions started from now on; running sessions reload updates by themselves."
