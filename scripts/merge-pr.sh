#!/usr/bin/env bash
# Lands a pull request (#343): waits for its checks, squash-merges it, updates main, reinstalls and prints the window's errors.
#   scripts/merge-pr.sh N [--dry-run]    run from the clone, on an up-to-date main
# Steps: wait until the PR has checks and none is pending (`gh pr checks --watch` can return before they register);
# refuse if any failed; `gh pr merge --squash --body "" --delete-branch`; `git pull --ff-only`; ./install.sh, which
# ends by printing the window's errors (scripts/window-errors.sh).
# --dry-run prints every step that changes something and changes nothing (the check wait still reads).
# MERGE_PR_EVERY (seconds between looks, default 20) and MERGE_PR_MAX (seconds before giving up, default 1800) tune the wait.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dry_run=0
pr=

die() {
  echo "merge-pr: $*" >&2
  exit 1
}

# Runs a command that changes something, or only prints it with --dry-run.
run() {
  if [[ $dry_run == 1 ]]; then
    echo "+ $*"
  else
    "$@"
  fi
}

# Prints "none" when the PR has no check yet, "pending" while any runs, "failed:<names>" when any failed, else "passed".
checks_state() {
  gh pr checks "$1" --json name,bucket | node -e '
let text = ""
process.stdin.on("data", chunk => (text += chunk))
process.stdin.on("end", () => {
  const checks = JSON.parse(text || "[]")
  const bad = checks.filter(c => c.bucket === "fail" || c.bucket === "cancel").map(c => c.name)
  if (checks.length === 0) console.log("none")
  else if (bad.length) console.log(`failed:${bad.join(", ")}`)
  else if (checks.some(c => c.bucket === "pending")) console.log("pending")
  else console.log("passed")
})
'
}

wait_for_checks() {
  local every=${MERGE_PR_EVERY:-20} max=${MERGE_PR_MAX:-1800} waited=0 state
  while true; do
    state=$(checks_state "$1") || die "could not read the checks of PR #$1"
    case $state in
      passed) return 0 ;;
      failed:*) die "PR #$1 has failing checks (${state#failed:}): not merging" ;;
    esac
    ((waited < max)) || die "PR #$1: checks still $state after ${max}s: not merging"
    echo "PR #$1: checks $state; looking again in ${every}s"
    sleep "$every"
    waited=$((waited + every))
  done
}

main() {
  while (($#)); do
    case $1 in
      --dry-run) dry_run=1 ;;
      -*) die "unknown option $1" ;;
      *) pr=$1 ;;
    esac
    shift
  done
  [[ $pr =~ ^[0-9]+$ ]] || die "usage: scripts/merge-pr.sh N [--dry-run]"
  cd "$root"
  [[ $(git rev-parse --abbrev-ref HEAD) == main ]] || die "run it from the clone's main branch"

  wait_for_checks "$pr"
  echo "PR #$pr: checks passed"
  run gh pr merge "$pr" --squash --body "" --delete-branch
  run git pull --ff-only origin main
  run "${MERGE_PR_INSTALL:-$root/install.sh}"
}

# Sourced by the tests, which call the functions; run from a shell, it does the work.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
