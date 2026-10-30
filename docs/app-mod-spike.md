# Spike S0 for issue #93: what the Herdr app lets a mod do

Result of slice S0 of the app mod plan. Nothing here is product code; the throwaway mod was not merged. Date: 2026-10-30, herdr-app 0.1.9 / herdr-core 0.1.14.

## R2: a second window for builders

**Plain `HERDR_APP_HOME` is not enough.** It moves only the config folder. Spaces, tabs and splits live in the core's `herdr-app` document (`docs.json`), so a second window on the same core shows and edits the owner's layout. Not tried on purpose.

**`HERDR_CORE_DIRS` does nothing for `hc`.** `hc server status` with it set still reached the owner's core.

**What isolates (tried, holds):** `HC_SESSION=s0-spike`, `XDG_STATE_HOME=<short folder>`, `HERDR_APP_HOME=<short folder>`, and unset `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, `HC_SCOPE` (they point `hc` at the owner's core). Checks: a different core id, the socket under the given state folder, nothing new in `~/.local/state/herdr-core/`, the second window listed no spaces from the owner's core, the owner's terminal count and config hashes unchanged.
- Unix socket paths are limited to 103 bytes, for both the core socket and `herdr-app.sock`. Long job-folder paths fail (`hc` says so; the app only logs a warning and loses `status`/`ls`). Use a short symlink to the real folder.
- `herdr-app status`, `ls`, `do` and `check` work against the second window.
- Stop it with `kill <pid of herdr-app you started>` and `HC_SESSION=s0-spike hc server stop`. Never run a stop without `HC_SESSION`.

**`shot` is unreliable here.** It returned a PNG, but the frame never changed after the first one: it kept showing the welcome dialog and no spaces while `status` showed two spaces and a different layout. The window was behind the owner's windows, the process ran at low priority (`SN`), and a mod's `render` never ran (a mod that starts its watcher on first render did nothing). So a window that is not in front is not redrawn. The welcome dialog also did not close with `overlay.close`. Verdict: **PNGs are not usable by a builder unless someone brings the window to the front and dismisses the welcome (clicks Next/close).** Per the plan's kill line for R2, builders rely on `herdr-app check` and the owner reviews each slice, unless that step is acceptable.

## R5: `pane.focus {terminal}` across spaces

Tried: two spaces, one terminal each; `pane.focus {terminal: t2}` from space A, then `{terminal: t1}`. `status` showed the space, tab and pane change each time. **Proves R5** (the command switches space and tab). `space.select` + `tab.select` is not needed. Checked through `status`, not by eye.

## R1, R3, R4: not tested

Needs the window in front and a person (a mod that opens an overlay never rendered in the hidden window; real keypresses and clicks are not allowed to be automated on the owner's display).
- Card method for S5 for now: **candidate A** (full-window transparent popup, `frame: "none"`, `width: 1, height: 1`) is unverified; plan the fallback (card directly above the strip) as the safe default until the owner has done the checklist.

## Checklist for the owner (about 5 minutes)

Use a second window set up as above, then bring it to the front and close the welcome.
1. R1: a mod opens `openOverlay({kind:"popup", frame:"none", width:1, height:1})` with a card at the bottom. Is the terminal behind visible and not dimmed? Does a click outside the card close it, and does that click also reach the terminal (first click swallowed)? Do a 1-line and a 5-line prompt, then resize the window, and see whether the card stays clear of the prompt.
2. R3: with the card open, type a printable letter. Does it reach the terminal prompt or is it dropped? Does Esc close the card?
3. R4: press `alt-1` .. `alt-6` bound to a mod command on your keyboard layout (Spanish?). Do they fire, or type a character? If not, use `cmd-shift-1`..`6`.
4. R2: confirm a second window looks different from the main one and shows none of your spaces.

## Notes for the plan

- Document the isolation recipe above in the plan's section 3 and make `herdr-app shot` a manual step.
- Unresolved: a way to dismiss the welcome (`seen.json` already lists `frame-welcome`, yet it showed) and to keep an isolated window drawn while behind other windows.
