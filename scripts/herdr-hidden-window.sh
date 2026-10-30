#!/usr/bin/env bash
# A Herdr window for draw checks that never takes the front app or the keyboard
# and shows nothing on screen, on a throwaway copy of the app. docs/hidden-window.md
#
#   scripts/herdr-hidden-window.sh start          copy, hook and start; installs this checkout's mod
#   scripts/herdr-hidden-window.sh run <cmd...>   run a command against that window
#   scripts/herdr-hidden-window.sh sync           copy this checkout's mod over (hot reload)
#   scripts/herdr-hidden-window.sh demo [board]   a fake coordinator and a board (default app/fixtures/full.json)
#   scripts/herdr-hidden-window.sh stop           close it and remove every trace
#
# HERDR_HIDDEN_NAME picks the window (default hw), so several workers can have one each.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
name=${HERDR_HIDDEN_NAME:-hw}
if [[ ! $name =~ ^[a-z0-9-]{1,32}$ ]]; then
  echo "HERDR_HIDDEN_NAME takes lowercase letters, digits and dashes, at most 32." >&2
  exit 2
fi

real=/Applications/Herdr.app
# Short and in /tmp: the app's and the core's sockets must fit the Unix path limit.
dir=/private/tmp/hw-$name
copy=$dir/Herdr.app
binary=$copy/Contents/MacOS/Herdr
bundle_id=dev.herdr.app.hidden-test.$name
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# env -i: nothing from the caller's own window or terminal may leak in (HC_TERMINAL_ID and so on).
window_env=(
  env -i
  "HOME=$dir/home" "XDG_STATE_HOME=$dir/state" "HERDR_APP_HOME=$dir/app" "HC_SESSION=hw-$name"
  "PATH=$dir/bin:$HOME/.local/bin:$PATH" "TERM=xterm-256color" "LANG=${LANG:-en_US.UTF-8}"
  "TMPDIR=$dir/tmp" "DO_NOT_TRACK=1" "HERDR_TELEMETRY=0"
)
hooks=("HERDR_HIDDEN_LOG=$dir/hooks.log" "DYLD_INSERT_LIBRARIES=$dir/hooks.dylib")

die() {
  echo "$*" >&2
  exit 1
}

# True only for a process that really is this copy, even if the pid was reused.
running() {
  [[ -f $dir/pid ]] && [[ $(ps -o comm= -p "$(cat "$dir/pid")" 2>/dev/null) == "$binary" ]]
}

build() {
  [[ $(uname) == Darwin ]] || die "macOS only."
  [[ -d $real ]] || die "$real not found."
  rm -rf "$dir"
  mkdir -p "$dir/home" "$dir/state" "$dir/app" "$dir/bin" "$dir/tmp"
  ditto --norsrc --noextattr --noacl "$real" "$copy"
  /usr/libexec/PlistBuddy \
    -c "Set :CFBundleIdentifier $bundle_id" \
    -c "Set :CFBundleName HerdrHiddenTest" \
    -c "Set :CFBundleDisplayName HerdrHiddenTest" \
    -c "Add :LSBackgroundOnly bool true" \
    "$copy/Contents/Info.plist"
  # Ad-hoc signing drops the hardened runtime, which is what lets the hooks load.
  codesign --force --deep --sign - "$copy" 2>/dev/null
  clang -dynamiclib -arch arm64 -fno-objc-arc -framework AppKit -framework UserNotifications \
    -o "$dir/hooks.dylib" "$here/scripts/herdr-hidden-window.m"
  # Bare herdr-app would open this copy without the hooks, in front.
  cat >"$dir/bin/herdr-app" <<EOF
#!/bin/sh
[ \$# -gt 0 ] || { echo "Bare herdr-app would open a window in front: use herdr-hidden-window.sh start." >&2; exit 2; }
exec "$binary" "\$@"
EOF
  # Herdr and mods play sounds with afplay, found on PATH.
  printf '#!/bin/sh\nexit 0\n' >"$dir/bin/afplay"
  chmod +x "$dir/bin/herdr-app" "$dir/bin/afplay"
  # Prove the hooks load before anything can open a window: --version opens none.
  "${window_env[@]}" "${hooks[@]}" "$binary" --version >/dev/null
  grep -q ' loaded$' "$dir/hooks.log" || die "The hooks did not load; no window started."
  printf '{ "frame.welcomed": "finished" }\n' >"$dir/app/shared.json"
  printf '{ "sounds": { "enabled": false }, "clipboard_write": false, "telemetry": false }\n' >"$dir/app/settings.json"
}

sync_mod() {
  rsync -a --delete --exclude jsconfig.json --exclude gpui-kit.d.ts \
    "$here/app/mods/herdr-agents/" "$dir/app/mods/herdr-agents/"
}

start() {
  running && die "Window $name is already running: stop it first."
  build
  "${window_env[@]}" "${hooks[@]}" "$binary" </dev/null >"$dir/app.log" 2>&1 &
  echo $! >"$dir/pid"
  local i
  for i in {1..75}; do
    if "${window_env[@]}" herdr-app shot "$dir/first.png" >/dev/null 2>&1; then
      sync_mod
      "${window_env[@]}" node "$here/app/layout.mjs" "$dir/app" >/dev/null
      "${window_env[@]}" node "$here/app/keys.mjs" "$dir/app" >/dev/null
      "${window_env[@]}" herdr-app do layout.switch --name coordinator >/dev/null
      echo "Window $name is up (pid $(cat "$dir/pid"))."
      return
    fi
    running || break
    sleep 0.2
  done
  tail -5 "$dir/hooks.log" "$dir/app.log" >&2 || true
  stop
  die "No frame from the window; it was closed."
}

# The mod's bar, strip and pop-ups need a board whose coordinator is a live agent,
# and the file must be named after the board's session.
demo() {
  local fixture=${1:-$here/app/fixtures/full.json} space address
  ln -sf "$(command -v node)" "$dir/bin/claude" # a copy of node crashes on dyld
  cat >"$dir/fake-agent.js" <<'EOF'
process.stdout.write('\x1b]7501;state=idle:app=claude\x1b\\')
setInterval(() => {}, 1e6)
EOF
  "${window_env[@]}" herdr-app do space.new --name shop --folder "$dir/home" >/dev/null
  sleep 0.5
  space=$("${window_env[@]}" herdr-app ls | node -pe 'JSON.parse(require("fs").readFileSync(0)).spaces[0].id')
  "${window_env[@]}" hc run --bg --label "herdr.space=$space" --label herdr.tab=coordinator \
    claude "$dir/fake-agent.js" >/dev/null
  sleep 1
  address=$("${window_env[@]}" hc ls --json |
    node -pe 'JSON.parse(require("fs").readFileSync(0)).terminals.filter(t => t.agent !== "sh").pop().address')
  mkdir -p "$dir/home/.herdr-agents/board"
  node -e '
    const fs = require("fs")
    const [fixture, folder, address] = process.argv.slice(1)
    const board = JSON.parse(fs.readFileSync(fixture))
    board.coordinator.terminal = address
    fs.writeFileSync(`${folder}/${board.session}.json`, JSON.stringify(board))
  ' "$fixture" "$dir/home/.herdr-agents/board" "$address"
  "${window_env[@]}" herdr-app do pane.focus --terminal "$address" >/dev/null
  echo "Coordinator at $address."
}

stop() {
  if running; then
    local pid i
    pid=$(cat "$dir/pid")
    kill "$pid" 2>/dev/null || true
    for i in {1..20}; do
      running || break
      sleep 0.1
    done
    if running; then kill -9 "$pid" 2>/dev/null || true; fi
  fi
  # Its own core only: HC_SESSION names it.
  [[ -d $dir ]] && "${window_env[@]}" hc server stop >/dev/null 2>&1 || true
  [[ -d $copy ]] && "$lsregister" -u "$copy" 2>/dev/null || true
  # What macOS keeps per bundle id outside the folder; exact names, this window's id only.
  defaults delete "$bundle_id" >/dev/null 2>&1 || true
  rm -rf "$HOME/Library/Preferences/$bundle_id.plist" \
    "$HOME/Library/Caches/$bundle_id" \
    "$HOME/Library/HTTPStorages/$bundle_id" \
    "$HOME/Library/Saved Application State/$bundle_id.savedState" \
    "$(getconf DARWIN_USER_CACHE_DIR)$bundle_id" \
    "$(getconf DARWIN_USER_TEMP_DIR)$bundle_id"
  rm -rf "$dir"
}

case ${1:-} in
start) start ;;
stop) stop ;;
sync)
  running || die "Window $name is not running."
  sync_mod
  ;;
demo)
  shift
  running || die "Window $name is not running."
  demo "$@"
  ;;
run)
  shift
  [[ $# -gt 0 ]] || die "run needs a command."
  running || die "Window $name is not running: start it first."
  exec "${window_env[@]}" "$@"
  ;;
*)
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
  ;;
esac
