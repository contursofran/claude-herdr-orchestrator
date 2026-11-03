#!/usr/bin/env bash
# A Herdr window for draw checks that never takes the front app or the keyboard
# and shows nothing on screen, on a throwaway copy of the app. docs/hidden-window.md
#
#   scripts/herdr-hidden-window.sh start          copy, hook and start; installs this checkout's mod
#   scripts/herdr-hidden-window.sh run <cmd...>   run a command against that window
#   scripts/herdr-hidden-window.sh sync           copy this checkout's mod over (hot reload)
#   scripts/herdr-hidden-window.sh demo [board]   a fake coordinator and a board (default app/fixtures/full.json)
#   scripts/herdr-hidden-window.sh stop           close it and remove every trace
#   scripts/herdr-hidden-window.sh smoke [board]  start, demo, shots of strip, board, sheet and an arrival, stop
#
# HERDR_HIDDEN_NAME picks the window (default hw; smoke uses smoke), so several workers can have one each.
# HERDR_HIDDEN_APP picks the herdr-app that start copies (default /Applications/Herdr.app).
# HERDR_HIDDEN_CALL_TIMEOUT is the seconds one call to the app or the core may take (default 15).
# smoke: HERDR_SMOKE_TIMEOUT is the seconds the whole run may take (default 240); HERDR_SMOKE_OUT is
# where shots and status files go (default ./.herdr-agents/smoke).
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
default_name=hw
[[ ${1:-} == smoke || ${1:-} == smoke-inner ]] && default_name=smoke
name=${HERDR_HIDDEN_NAME:-$default_name}
# The longest socket, $dir/state/herdr-core/hw-$name/hw-$name.holder.<8 hex>.sock, is
# 62 characters plus three names, and macOS allows 103: so 13 at most.
if [[ ! $name =~ ^[a-z0-9-]{1,13}$ ]]; then
  echo "HERDR_HIDDEN_NAME takes lowercase letters, digits and dashes, at most 13: a longer name won't fit the Unix socket path limit." >&2
  exit 2
fi

call_timeout=${HERDR_HIDDEN_CALL_TIMEOUT:-15}
if [[ ! $call_timeout =~ ^[0-9]+$ || $call_timeout -eq 0 ]]; then
  echo "HERDR_HIDDEN_CALL_TIMEOUT takes a whole number of seconds above 0, not '$call_timeout'." >&2
  exit 2
fi

real=${HERDR_HIDDEN_APP:-/Applications/Herdr.app}
# The app the hooks and the mod are for. Homebrew's herdr-gpui cask is a different app
# that installs at the same path, with no --version, shot, do or mods.
herdr_app_id=dev.herdr.app
# Short and in /tmp: the app's and the core's sockets must fit the Unix path limit.
dir=/private/tmp/hw-$name
lock=$dir.lock
copy=$dir/Herdr.app
binary=$copy/Contents/MacOS/Herdr
bundle_id=dev.herdr.app.hidden-test.$name
# The app version the hooks were last measured on; start warns on any other.
tested_version=0.1.12
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# The caller's PATH without the owner's own Herdr tools: $dir/bin has the copy's.
window_path=$dir/bin
IFS=: read -ra caller_path <<<"$PATH"
for entry in "${caller_path[@]}"; do
  [[ ${entry%/} == "$HOME/.local/bin" ]] || window_path+=:$entry
done

# env -i: nothing from the caller's own window or terminal may leak in (HC_TERMINAL_ID and so on).
window_env=(
  env -i
  "HOME=$dir/home" "XDG_STATE_HOME=$dir/state" "HERDR_APP_HOME=$dir/app" "HC_SESSION=hw-$name"
  "PATH=$window_path" "TERM=xterm-256color" "LANG=${LANG:-en_US.UTF-8}"
  "TMPDIR=$dir/tmp" "DO_NOT_TRACK=1" "HERDR_TELEMETRY=0"
)
hooks=("HERDR_HIDDEN_LOG=$dir/hooks.log" "DYLD_INSERT_LIBRARIES=$dir/hooks.dylib")

die() {
  echo "$*" >&2
  exit 1
}

# Runs a command for at most N seconds; exit 142 (SIGALRM) when it ran out. macOS has no timeout(1).
limit() {
  local n=$1
  shift
  perl -e 'alarm shift; exec @ARGV or exit 127' "$n" "$@"
}

# One call to the app or the core, in the window's environment, with the call timeout. A call
# that outlasts it (a mod blocking the app's main thread, say) fails with the log tails, not a hang.
call() {
  local status=0
  limit "$call_timeout" "${window_env[@]}" "$@" || status=$?
  if [[ $status == 142 ]]; then
    echo "Timed out after ${call_timeout}s: $*" >&2
    tail -5 "$dir/app.log" "$dir/hooks.log" >&2 2>/dev/null || true
  fi
  return "$status"
}

# True only for a process that really is this copy, even if the pid was reused.
running() {
  [[ -f $dir/pid ]] && [[ $(ps -o comm= -p "$(cat "$dir/pid")" 2>/dev/null) == "$binary" ]]
}

# Identifies a process across pid reuse.
process_id() {
  local started
  started=$(ps -o lstart= -p "$1" 2>/dev/null) && echo "$1 $started"
}

# start and stop change the folder, so only one runs per window. The owner file
# says who holds the lock. A lock is only removed once its owner is dead, inside a
# second mkdir, so two runs can't both clear it and take a live run's lock away.
# Anything unclear is refused, never cleared.
take_lock() {
  local owner=
  if ! mkdir "$lock" 2>/dev/null; then
    owner=$(cat "$lock/owner" 2>/dev/null) || true
    if [[ -z $owner || $(process_id "${owner%% *}" || true) == "$owner" ]] ||
      ! mkdir "$lock.clearing" 2>/dev/null; then
      die "Window $name is busy: another start or stop holds $lock. If none is running, remove that folder and $lock.clearing."
    fi
    if [[ $(cat "$lock/owner" 2>/dev/null) == "$owner" ]]; then
      rm -f "$lock/owner"
      rmdir "$lock"
    fi
    if ! mkdir "$lock" 2>/dev/null; then
      rmdir "$lock.clearing"
      die "Window $name is busy: another start or stop just took $lock."
    fi
    rmdir "$lock.clearing"
  fi
  process_id $$ >"$lock/owner"
  have_lock=1
}

on_exit() {
  local status=$?
  if [[ $closing_on_failure == 1 ]]; then close_window; fi
  if [[ $have_lock == 1 ]]; then
    rm -f "$lock/owner"
    rmdir "$lock" 2>/dev/null || true
  fi
  exit "$status"
}

have_lock=0
closing_on_failure=0
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Every process running a binary from this window's folder: its core and helpers.
own_processes() {
  local pid path
  while read -r pid path; do
    if [[ $path == "$dir/"* ]]; then echo "$pid"; fi
  done < <(ps -axo pid=,comm=)
}

build() {
  [[ $(uname) == Darwin ]] || die "macOS only."
  [[ -d $real ]] || die "$real not found."
  local id core
  id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$real/Contents/Info.plist" 2>/dev/null) || id=unknown
  if [[ $id != "$herdr_app_id" ]]; then
    die "$real is $id, not herdr-app ($herdr_app_id): no window can draw there. Install herdr-app from https://herdr.dev or set HERDR_HIDDEN_APP to a copy of it. See docs/hidden-window.md."
  fi
  core=$(command -v herdr-core || echo "$HOME/.local/bin/herdr-core")
  [[ -x $core ]] || die "herdr-core not found on PATH or in ~/.local/bin."
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
  # A core of its own: anything that updates it replaces this copy, not the real one.
  cp -L "$core" "$dir/bin/herdr-core"
  ln -s herdr-core "$dir/bin/hc"
  clang -DWINDOW_CHECK -fno-objc-arc -framework CoreGraphics -framework Foundation \
    -o "$dir/window-check" "$here/scripts/herdr-hidden-window.m"
  # Bare herdr-app would open this copy without the hooks, in front.
  cat >"$dir/bin/herdr-app" <<EOF
#!/bin/sh
[ \$# -gt 0 ] || { echo "Bare herdr-app would open a window in front: use herdr-hidden-window.sh start." >&2; exit 2; }
exec "$binary" "\$@"
EOF
  # Herdr and mods play sounds with afplay and open links with open, found on PATH.
  printf '#!/bin/sh\nexit 0\n' >"$dir/bin/afplay"
  cp "$dir/bin/afplay" "$dir/bin/open"
  # The updater downloads with curl, in a child the network hook doesn't reach. A copy older
  # than the latest release would stage the update and show its toast over the strip.
  printf '#!/bin/sh\nexit 1\n' >"$dir/bin/curl"
  chmod +x "$dir/bin/herdr-app" "$dir/bin/afplay" "$dir/bin/open" "$dir/bin/curl"
  # Prove the hooks load before anything can open a window: --version opens none.
  "${window_env[@]}" "${hooks[@]}" "$binary" --version >/dev/null
  grep -q ' loaded$' "$dir/hooks.log" || die "The hooks did not load; no window started."
  printf '{ "frame.welcomed": "finished" }\n' >"$dir/app/shared.json"
  printf '{ "sounds": { "enabled": false }, "clipboard_write": false, "telemetry": false }\n' >"$dir/app/settings.json"
  # Not a first run of this version: the "Updated to" pill would cover the end of the strip.
  printf '{ "last_run": "%s", "presented": [] }\n' \
    "$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$copy/Contents/Info.plist")" >"$dir/app/update-notes.json"
}

sync_mod() {
  rsync -a --delete --exclude jsconfig.json --exclude gpui-kit.d.ts \
    "$here/app/mods/herdr-agents/" "$dir/app/mods/herdr-agents/"
}

# Fail closed: only the window server can say the window really is out of sight.
check_hidden() {
  local windows
  windows=$("$dir/window-check" "$(cat "$dir/pid")")
  [[ -n $windows ]] || die "The window server shows no window for the copy; it was closed."
  if grep -qv '^0 -1$' <<<"$windows"; then
    die "The window is not hidden (alpha and layer: $(tr '\n' ',' <<<"$windows") wanted 0 -1); it was closed."
  fi
}

warn_if_no_display_link() {
  if grep -q 'could not create display link' "$dir/app.log" 2>/dev/null; then
    echo "Warning: the display is asleep or locked: shots will be stale until it wakes." >&2
  fi
}

warn_on_other_version() {
  local version
  version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$real/Contents/Info.plist")
  if [[ $version != "$tested_version" ]]; then
    echo "Warning: herdr-app is $version, but the hooks were tested on $tested_version. See docs/hidden-window.md." >&2
  fi
}

start() {
  take_lock
  running && die "Window $name is already running: stop it first."
  closing_on_failure=1
  # A window that died leaves its core running: close that before the folder goes.
  if [[ -d $dir ]]; then close_window; fi
  build
  warn_on_other_version
  "${window_env[@]}" "${hooks[@]}" "$binary" </dev/null >"$dir/app.log" 2>&1 &
  echo $! >"$dir/pid"
  local i
  for i in {1..75}; do
    if limit "$call_timeout" "${window_env[@]}" herdr-app shot "$dir/first.png" >/dev/null 2>&1; then
      sync_mod
      "${window_env[@]}" node "$here/app/layout.mjs" "$dir/app" >/dev/null
      "${window_env[@]}" node "$here/app/keys.mjs" "$dir/app" >/dev/null
      call herdr-app do layout.switch --name coordinator >/dev/null
      check_hidden
      warn_if_no_display_link
      closing_on_failure=0
      echo "Window $name is up (pid $(cat "$dir/pid"))."
      return
    fi
    running || break
    sleep 0.2
  done
  tail -5 "$dir/hooks.log" "$dir/app.log" >&2 || true
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
  local reply i status
  # The core can take a few seconds to answer after start ("the window did not answer"): retry for up to 15 s.
  for ((i = 0; i < 75; i++)); do
    status=0
    reply=$(call herdr-app do space.new --name shop --folder "$dir/home") || status=$?
    [[ $status == 0 ]] && break
    [[ $status == 142 ]] && die "space.new timed out."
    sleep 0.2
  done
  [[ $i -lt 75 ]] || die "space.new failed: ${reply:-no answer}"
  space=$(node -pe 'JSON.parse(require("fs").readFileSync(0)).space' <<<"$reply" 2>/dev/null) || space=
  if [[ -z $space || $space == undefined ]]; then die "space.new gave no space: $reply"; fi
  sleep 0.5
  call hc run --bg --label "herdr.space=$space" --label herdr.tab=coordinator \
    claude "$dir/fake-agent.js" >/dev/null || die "hc run failed."
  # The agent announces itself a moment after it starts: wait for it, within the call timeout.
  address=
  for ((i = 0; i < call_timeout * 5; i++)); do
    address=$(call hc ls --json | node -pe '
      const t = JSON.parse(require("fs").readFileSync(0)).terminals.filter(t => t.agent !== "sh").pop()
      t ? t.address : ""' 2>/dev/null) || address=
    [[ -n $address ]] && break
    sleep 0.2
  done
  [[ -n $address ]] || die "The fake coordinator didn't start (hc ls shows no agent)."
  mkdir -p "$dir/home/.herdr-agents/board"
  node -e '
    const fs = require("fs")
    const [fixture, folder, address] = process.argv.slice(1)
    const board = JSON.parse(fs.readFileSync(fixture))
    board.coordinator.terminal = address
    fs.writeFileSync(`${folder}/${board.session}.json`, JSON.stringify(board))
  ' "$fixture" "$dir/home/.herdr-agents/board" "$address"
  # The app attaches the pane a moment after the terminal exists ("no such pane"): retry for up to 15 s.
  local focused=0
  for ((i = 0; i < 75; i++)); do
    if call herdr-app do pane.focus --terminal "$address" >/dev/null 2>&1; then
      focused=1
      break
    fi
    sleep 0.2
  done
  [[ $focused == 1 ]] || die "pane.focus on $address kept failing (no such pane) for 15s."
  echo "Coordinator at $address."
}

close_window() {
  closing_on_failure=0
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
  # A core that doesn't answer is killed below with everything else from this folder.
  [[ -d $dir ]] && limit "$call_timeout" "${window_env[@]}" hc server stop >/dev/null 2>&1 || true
  # Whatever that missed runs from this folder, so it can only be this window's.
  local leftovers
  leftovers=$(own_processes)
  if [[ -n $leftovers ]]; then
    kill $leftovers 2>/dev/null || true
    sleep 0.3
    leftovers=$(own_processes)
    if [[ -n $leftovers ]]; then kill -9 $leftovers 2>/dev/null || true; fi
  fi
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

# The whole smoke run under a watchdog. The run is a process group of its own: on timeout the
# group is killed (a stuck call or a held lock can't outlive it), then stop cleans up.
smoke_timeout=${HERDR_SMOKE_TIMEOUT:-240}
smoke() {
  if [[ ! $smoke_timeout =~ ^[0-9]+$ || $smoke_timeout -eq 0 ]]; then
    echo "HERDR_SMOKE_TIMEOUT takes a whole number of seconds above 0, not '$smoke_timeout'." >&2
    exit 2
  fi
  local status=0 out=${HERDR_SMOKE_OUT:-$PWD/.herdr-agents/smoke}
  export HERDR_HIDDEN_NAME=$name # the subcommands it runs take the same window
  perl -e '
    my ($n, @cmd) = @ARGV;
    my $p = fork;
    if (!$p) { setpgrp(0, 0); exec @cmd or exit 127 }
    $SIG{ALRM} = sub { kill "KILL", -$p; waitpid($p, 0); exit 142 };
    alarm $n;
    waitpid($p, 0);
    exit($? >> 8)' "$smoke_timeout" bash "$0" smoke-inner "$@" || status=$?
  if [[ $status == 142 ]]; then
    echo "smoke: timed out after ${smoke_timeout}s" >&2
    keep_logs "$out"
    bash "$0" stop >/dev/null 2>&1 || true
    exit 124
  fi
  exit "$status"
}

keep_logs() {
  mkdir -p "$1"
  cp "$dir"/*.log "$1/" 2>/dev/null || true
}

smoke_failures=()
smoke_seen=" "

smoke_fail() {
  echo "smoke: $*" >&2
  smoke_failures+=("$*")
}

# Fails the run when the app reports errors or the mod reports a draw failure.
smoke_check() {
  local step=$1 status_file=$2 line key
  if ! call herdr-app status >"$status_file" 2>/dev/null; then
    smoke_fail "status error: no answer after $step"
    return
  fi
  line=$(node -e '
    const e = JSON.parse(require("fs").readFileSync(process.argv[1])).errors
    if (Array.isArray(e) && e.length) console.log(JSON.stringify(e))' "$status_file" 2>&1) ||
    line="unreadable status: $(head -c 200 "$status_file")"
  [[ -z $line ]] || smoke_fail "status error: $line"
  while IFS= read -r line; do
    key=${line%%=*}
    # Once per key: the same failure stays in shared.json through every later step.
    [[ $smoke_seen == *" $key "* ]] && continue
    smoke_seen+="$key "
    smoke_fail "draw failed: $line"
  done < <(node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    for (const [k, v] of Object.entries(s)) if (k.startsWith("hrd.drawFailed.") && v) console.log(`${k}=${v}`)
  ' "$dir/app/shared.json" 2>/dev/null || true)
}

# One command to the window; a failure is recorded under the step's name.
smoke_do() {
  local step=$1 status=0
  shift
  call "$@" >/dev/null || status=$?
  if [[ $status == 142 ]]; then
    smoke_fail "$step timed out"
  elif [[ $status != 0 ]]; then
    smoke_fail "$step failed"
  fi
}

smoke_shot() {
  local file=$1.png step=$2
  smoke_do "$step" herdr-app shot "$out/$file"
  [[ -s $out/$file ]] || smoke_fail "$step failed: no shot at $out/$file"
}

smoke_inner() {
  local fixture=${1:-$here/app/fixtures/full.json}
  local settle=${HERDR_SMOKE_SETTLE:-4} later=1
  [[ $settle == 0 ]] && later=0
  out=${HERDR_SMOKE_OUT:-$PWD/.herdr-agents/smoke}
  mkdir -p "$out"
  rm -f "$out"/[0-9][0-9]-*.png "$out"/status-*.json "$out"/*.log
  # stop always runs, and a failed run keeps the window's logs beside the shots.
  trap 'smoke_exit' EXIT
  smoke_exit() {
    local status=$?
    if [[ $status != 0 || ${#smoke_failures[@]} -gt 0 ]]; then keep_logs "$out"; fi
    bash "$0" stop >/dev/null 2>&1 || true
    if [[ $status == 0 && ${#smoke_failures[@]} -gt 0 ]]; then status=1; fi
    exit "$status"
  }
  # HERDR_SMOKE_USE_RUNNING is for the tests, which stand in for the app.
  if [[ ${HERDR_SMOKE_USE_RUNNING:-} != 1 ]]; then bash "$0" start || exit 1; fi
  bash "$0" demo "$fixture" || exit 1
  smoke_check demo "$out/status-demo.json"
  # The first frames come a moment after the window is up; an early shot is blank.
  sleep "$settle"
  smoke_shot 01-strip strip
  smoke_check strip "$out/status-strip.json"
  smoke_do board herdr-app do herdr-agents.board
  sleep "$later"
  smoke_shot 02-board board
  smoke_check board "$out/status-board.json"
  smoke_do overlay herdr-app do overlay.close
  smoke_do sheet herdr-app do herdr-agents.sheet
  sleep "$later"
  smoke_shot 03-sheet sheet
  smoke_check sheet "$out/status-sheet.json"
  smoke_do overlay herdr-app do overlay.close
  # A new to-do on the board is an arrival: the mod announces it and the strip changes.
  node -e '
    const fs = require("fs")
    const folder = process.argv[1]
    const file = fs.readdirSync(folder).filter(f => f.endsWith(".json"))[0]
    const board = JSON.parse(fs.readFileSync(`${folder}/${file}`))
    board.needs.push({ key: "T99", kind: "do", text: "Smoke arrival: check the strip shows this.", from: "w-api", at: Date.now(), isOpen: true, title: "Smoke arrival" })
    board.summary.needs += 1
    board.at = Date.now()
    fs.writeFileSync(`${folder}/${file}`, JSON.stringify(board))
  ' "$dir/home/.herdr-agents/board" || smoke_fail "arrivals failed: could not write the arrival"
  sleep "$settle"
  smoke_shot 04-arrivals arrivals
  smoke_check arrivals "$out/status-arrivals.json"
  if [[ ${#smoke_failures[@]} -gt 0 ]]; then exit 1; fi
  echo "smoke: passed; shots in $out"
}

case ${1:-} in
smoke) shift; smoke "$@" ;;
smoke-inner) shift; smoke_inner "$@" ;;
start) start ;;
stop)
  take_lock
  close_window
  ;;
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
  if [[ ${1:-} == herdr-app && ${2:-} == shot ]]; then warn_if_no_display_link; fi
  exec "${window_env[@]}" "$@"
  ;;
*)
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
  ;;
esac
