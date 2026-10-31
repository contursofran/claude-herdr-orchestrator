#!/usr/bin/env bash
# Runs the Discord bot in the background on macOS, starting at login and restarting if it stops.
#   app/discord/service.sh install | uninstall | restart | status
set -euo pipefail

label=dev.herdr-agents.discord
plist=$HOME/Library/LaunchAgents/$label.plist
here=$(cd "$(dirname "$0")" && pwd)
target=gui/$(id -u)

case ${1:-} in
  install)
    [[ -f $HOME/.herdr-agents/discord-token && -f $HOME/.herdr-agents/discord.json ]] ||
      { echo "Needs ~/.herdr-agents/discord-token and discord.json first." >&2; exit 1; }
    node=$(command -v node)
    mkdir -p "$(dirname "$plist")"
    cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$node</string><string>$here/bot.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$node"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME/.herdr-agents/discord.log</string>
  <key>StandardErrorPath</key><string>$HOME/.herdr-agents/discord.log</string>
</dict></plist>
PLIST
    launchctl bootout "$target/$label" 2>/dev/null || true
    launchctl bootstrap "$target" "$plist"
    echo "Running. Log: ~/.herdr-agents/discord.log"
    ;;
  uninstall)
    launchctl bootout "$target/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "Stopped and removed. The token and settings stay in ~/.herdr-agents."
    ;;
  restart)
    launchctl kickstart -k "$target/$label"
    ;;
  status)
    launchctl print "$target/$label" 2>/dev/null | grep -E '^\s+(state|pid|last exit code)' || echo "Not running."
    ;;
  *)
    echo "Usage: $0 install | uninstall | restart | status" >&2
    exit 2
    ;;
esac
