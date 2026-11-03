# Herdr quirks

Behaviours of Herdr (and GitHub) that cost a debugging session each. Read this before app-mod or hook work, and add any new quirk here in the same PR. One entry each: symptom, cause, what our code does, link.

## Old mod generations are never freed

- **Symptom:** after enough reloads the window's JS heap (a fixed 256 MB) is full. Reloads fail with `out of memory`, then `Null"null"`, until the window restarts. Before that the window can stop answering for 10-20 s after a delivery.
- **Cause:** Herdr keeps every load of a mod for the life of the window (herdrdev/herdr-app#88), and loads the mod again for each copy (every layout slot, every pop-up open, every copy on each hot reload). About 43 deliveries filled the heap.
- **Our code:** keep each copy's import graph small, so a reload costs less. Loading each role's code with `import()` is proposed in #335 and not done yet. The real fix is upstream.
- **Links:** #158, #335.

## A space's panel is restored 1-2 frames after a switch

- **Symptom:** arriving at an orchestrator's space left the board closed.
- **Cause:** Herdr's built-in `tabs` mod remembers a panel per space (Files, Changes, the board or closed) and puts it back a frame or two after the switch. A decision made in the switch frame sees the previous space's panel.
- **Our code:** `panelMove` waits `PANEL_SETTLE_MS` (200 ms) after a space switch, then decides on the panel that space put back. Tab switches inside a space still move at once.
- **Link:** #341.

## A mod's hooks don't run on prompts the mod itself submits

- **Symptom:** a note the mod puts in a prompt (such as the worker-count hint) shows on the owner's screen and cannot be hidden or rewritten by a hook.
- **Cause:** the host does not run the mod's own hooks on prompts that mod submits.
- **Our code:** the hint is kept out of report prompts and the report row; the coordinator learns it from the playbook and its next prompt instead.
- **Links:** #171, #174 (S3, PR #331).

## Auto mode refuses a tool call whose input a hook changed

- **Symptom:** the first Bash call of a worker in auto mode failed with "a hook changed this call's input after auto mode reviewed it"; a retry went through, so every worker lost calls.
- **Cause:** a `tool.call` hook that rewrites the input (here, prefixing the command with `export TMPDIR=...`) invalidates auto mode's review of the call.
- **Our code:** the rewrite was reverted. Workers get `TMPDIR` through `CLAUDE_ENV_FILE`, which the sandbox sources before each command, so no tool input changes. Do not rewrite tool input in a hook.
- **Links:** #337, #340 (part of #161).

## GitHub search lags behind merges

- **Symptom:** `scripts/release.sh --finish` said the Version pull request had not merged, seconds after `gh pr merge`; a minute later it worked.
- **Cause:** `gh pr list --search` reads GitHub's search index, which lags behind a merge.
- **Our code:** `--finish` looks the pull request up by its branch (`gh pr view version-X.Y.Z`), which reads it directly. Do not rely on search right after a state change.
- **Link:** #332.
