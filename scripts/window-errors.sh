#!/usr/bin/env bash
# Prints the errors the Herdr window reports (`herdr-app status`, its "errors" list): a mod that failed to reload shows
# up here and nowhere else. Says nothing when the app is not installed or not running. Always exits 0.
command -v herdr-app >/dev/null 2>&1 || exit 0
status=$(herdr-app status 2>/dev/null) || exit 0
printf '%s' "$status" | node -e '
let text = ""
process.stdin.on("data", chunk => (text += chunk))
process.stdin.on("end", () => {
  let errors
  try {
    errors = JSON.parse(text).errors
  } catch {
    return
  }
  if (!Array.isArray(errors)) return
  if (errors.length === 0) return console.log("Window: no errors.")
  console.log(`Window errors (${errors.length}):`)
  for (const e of errors) console.log(`- ${typeof e === "string" ? e : JSON.stringify(e)}`)
})
' || true
exit 0
