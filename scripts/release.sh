#!/usr/bin/env bash
# One-step release (#176). Main stays the working branch and the version only changes here.
#   scripts/release.sh X.Y.Z | --minor | --patch [--dry-run]   opens the "Version X.Y.Z" pull request, notes in its body
#   scripts/release.sh --finish X.Y.Z [--dry-run]              after it merges: tags that pull request's merge commit, pushes the tag, publishes the release
# --dry-run prints every step and changes nothing (the checks still run, since they only read; `git fetch` only updates origin/main).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
manifest=.claude-plugin/plugin.json
dry_run=0
cleanup_files=()

# Temporary notes files are removed on exit.
cleanup() {
  [[ ${#cleanup_files[@]} -eq 0 ]] || rm -f "${cleanup_files[@]}"
}

die() {
  echo "release: $*" >&2
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

# The version in a manifest file.
current_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

# next_version CURRENT X.Y.Z|--minor|--patch prints the version to release.
next_version() {
  local current=$1 want=$2 major minor patch
  IFS=. read -r major minor patch <<<"$current"
  case $want in
    --minor) echo "$major.$((minor + 1)).0" ;;
    --patch) echo "$major.$minor.$((patch + 1))" ;;
    *)
      [[ $want =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
      echo "$want"
      ;;
  esac
}

# set_version FILE VERSION rewrites the first "version" field, leaving the rest of the file alone.
set_version() {
  local tmp
  tmp=$(mktemp)
  awk -v v="$2" '!done && sub(/"version":[ \t]*"[^"]*"/, "\"version\": \"" v "\"") { done = 1 } { print }' "$1" >"$tmp"
  cat "$tmp" >"$1"
  rm -f "$tmp"
}

# format_notes reads "number<TAB>title" lines, writes "- title (#number)" lines in number order.
# Version pull requests are left out: they are the releases themselves.
format_notes() {
  sort -t$'\t' -k1,1n | awk -F'\t' '$2 !~ /^Version [0-9]/ { printf "- %s (#%s)\n", $2, $1 }'
}

# True when A.B.C is newer than D.E.F.
version_newer() {
  [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1) == "$1" ]]
}

last_tag() {
  git tag --list 'v[0-9]*' | sort -V | tail -n 1
}

# merged_prs TAG prints "number<TAB>title" for the pull requests merged into main after TAG.
merged_prs() {
  local epoch day
  epoch=$(git log -1 --format=%ct "$1")
  day=$(TZ=UTC git log -1 --format=%cd --date=format-local:%Y-%m-%d "$1")
  gh pr list --state merged --base main --limit 500 --search "merged:>=$day" --json number,title,mergedAt \
    --jq ".[] | select((.mergedAt | fromdateiso8601) > $epoch) | [.number, .title] | @tsv"
}

# The notes, written to a file: a heading line, then one line per merged pull request.
write_notes() {
  local version=$1 tag=$2 file=$3 lines
  lines=$(merged_prs "$tag" | format_notes)
  [[ -n $lines ]] || die "no pull requests merged since $tag"
  {
    echo "Changes since $tag:"
    echo
    echo "$lines"
  } >"$file"
}

check_main() {
  [[ $(git rev-parse --abbrev-ref HEAD) == main ]] || die "not on main"
  [[ -z $(git status --porcelain) ]] || die "the working tree is not clean"
  git fetch --quiet origin main
  [[ $(git rev-parse HEAD) == "$(git rev-parse origin/main)" ]] || die "main is not up to date with origin/main"
}

prepare() {
  local want=$1 current version tag notes branch
  cd "$root"
  check_main
  current=$(current_version "$manifest")
  version=$(next_version "$current" "$want") || die "not a version: $want"
  version_newer "$version" "$current" || die "$version is not newer than $current"
  git rev-parse -q --verify "refs/tags/v$version" >/dev/null && die "tag v$version already exists"
  tag=$(last_tag)
  [[ -n $tag ]] || die "no earlier tag to take the notes from"
  notes="${RELEASE_NOTES_FILE:-$(mktemp)}"
  [[ -n ${RELEASE_NOTES_FILE:-} ]] || cleanup_files+=("$notes")
  write_notes "$version" "$tag" "$notes"
  branch="version-$version"
  echo "Releasing $version (now $current, last tag $tag). Notes:"
  cat "$notes"
  run git switch -c "$branch"
  if [[ $dry_run == 1 ]]; then
    echo "+ set version $version in $manifest"
  else
    set_version "$manifest" "$version"
  fi
  run git commit -am "Version $version"
  run git push -u origin "$branch"
  run gh pr create --base main --title "Version $version" --body-file "$notes"
  run git switch main
  echo "Once the pull request has merged: scripts/release.sh --finish $version"
}

finish() {
  local version=$1 notes oid select
  cd "$root"
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a version: $version"
  [[ $(git rev-parse --abbrev-ref HEAD) == main ]] || die "not on main"
  [[ -z $(git status --porcelain) ]] || die "the working tree is not clean"
  git rev-parse -q --verify "refs/tags/v$version" >/dev/null && die "tag v$version already exists"
  # The Version pull request must have merged: its merge commit is what gets tagged, not whatever HEAD is.
  select="[.[] | select(.title == \"Version $version\")][0]"
  oid=$(gh pr list --state merged --base main --search "Version $version in:title" --json title,mergeCommit \
    --jq "$select.mergeCommit.oid // empty")
  [[ -n $oid ]] || die "the Version $version pull request has not merged (found no merged pull request with that title)"
  git fetch --quiet origin main
  git cat-file -e "$oid^{commit}" 2>/dev/null || die "merge commit $oid is not in this checkout"
  git merge-base --is-ancestor "$oid" origin/main || die "merge commit $oid is not on origin/main"
  notes="${RELEASE_NOTES_FILE:-$(mktemp)}"
  [[ -n ${RELEASE_NOTES_FILE:-} ]] || cleanup_files+=("$notes")
  gh pr list --state merged --base main --search "Version $version in:title" --json title,body \
    --jq "$select.body // empty" >"$notes"
  [[ -s $notes ]] || die "the Version $version pull request has no notes"
  run git tag -a "v$version" -m "Version $version" "$oid"
  run git push origin "v$version"
  run gh release create "v$version" --title "v$version" --notes-file "$notes"
}

main() {
  local want="" finishing=0 arg
  trap cleanup EXIT
  for arg in "$@"; do
    case $arg in
      --dry-run) dry_run=1 ;;
      --finish) finishing=1 ;;
      *) [[ -z $want ]] || die "one version only"; want=$arg ;;
    esac
  done
  [[ -n $want ]] || die "usage: scripts/release.sh X.Y.Z|--minor|--patch [--dry-run]; scripts/release.sh --finish X.Y.Z [--dry-run]"
  if [[ $finishing == 1 ]]; then finish "$want"; else prepare "$want"; fi
}

# Sourced (by the tests), it only defines the functions.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
