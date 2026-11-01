#!/usr/bin/env bash
# Runs only the named test files, e.g. npm run test:file -- tests/bridge.test.tsx. `claude plugin test` takes a folder and
# runs every test under it (and a folder of links won't load), so this runs it on a temporary copy of the checkout, your
# uncommitted changes included, that holds just these tests.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/test-file.sh tests/one.test.tsx [more test files]" >&2
  exit 2
fi
for file in "$@"; do
  if [[ ! -f $here/${file#"$here"/} ]]; then
    echo "No such test file: $file" >&2
    exit 2
  fi
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -R "$here/.claude-plugin" "$tmp/"
for item in "$here"/*; do
  [[ $(basename "$item") == node_modules ]] || cp -R "$item" "$tmp/"
done
find "$tmp" \( -name '*.test.ts' -o -name '*.test.tsx' \) -delete
for file in "$@"; do
  file=${file#"$here"/}
  mkdir -p "$tmp/$(dirname "$file")"
  cp "$here/$file" "$tmp/$file"
done
# Low priority, so the run does not slow the window beside it.
nice -n 10 claude plugin test "$tmp"
