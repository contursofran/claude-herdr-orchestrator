# A test window that doesn't take the screen

Draw checks catch what `herdr-app check` and the tests can't, but a normal second Herdr window comes to the front and takes the keyboard. `scripts/herdr-hidden-window.sh` starts a window that draws real frames while the front app and the keyboard stay where they are and nothing shows on screen.

macOS on Apple Silicon only. It needs Xcode's command line tools (`clang`), Herdr in `/Applications` and `herdr-core` on your PATH or in `~/.local/bin`, which `start` copies.

## Use

```sh
w=scripts/herdr-hidden-window.sh

$w start                                 # installs this checkout's mod, in the coordinator layout
$w demo                                  # optional: a fake coordinator and app/fixtures/full.json
$w run herdr-app shot "$PWD/before.png"
$w run herdr-app do herdr-agents.pick1   # drive it with commands
$w run herdr-app shot "$PWD/after.png"
$w sync                                  # after editing the mod: hot reload
$w stop                                  # closes it and removes every trace
```

`run` runs any command against this window: its own home, app folder and copy of `herdr-core`, with `~/.local/bin` off its PATH, so `herdr-app` and `hc` never reach your real window or its core. Save shots outside the window's folder, which `stop` deletes, and give `shot` an absolute path. Set `HERDR_HIDDEN_NAME` for a window of your own when others may be running one; each has its own copy of the app (about 70 MB until `stop`). A name has at most 13 characters, so the longest socket path fits the 103 macOS allows.

Only one `start` or `stop` runs per window: another one refuses and leaves the first alone. `start` over a window that died closes what it left first. A `start` that fails at any step leaves no process or folder.

To draw your own board, pass it to `demo`. By hand, its file must be `.herdr-agents/board/<session>.json` in the window's home and its `coordinator.terminal` a live agent, or the bar and strip stay empty and the pop-up has no content.

## What it does

The copy of the app has its own bundle id and `LSBackgroundOnly`, and is ad-hoc signed, which drops the hardened runtime so `scripts/herdr-hidden-window.m` can load into it. `start` proves the hooks load, with `--version`, before anything can open a window. The hooks:

- refuse every way to activate the app (Herdr asks once at each start) or make its window key, and quit at once if it becomes active anyway;
- keep the window on its screen at alpha 0, under normal windows, ignoring the mouse;
- tell GPUI the window is never covered. **This is what keeps frames coming**: without it `render()` stops and `shot` returns the same frame forever.

At the end of `start`, the window server must report every window of the copy at alpha 0 on layer -1. If not, `start` closes the copy and exits non-zero. It also warns when Herdr's version isn't the one the hooks were tested on (`tested_version` in the script).

What else is blocked, and how far that goes:

- **Network:** the app process can't open internet connections, which stops its updater and telemetry. The hook does not reach the core, `hc` or programs in its terminals: they have network. An update run there can only replace the copy's `herdr-core`, not yours.
- **Clipboard:** the copy's `clipboard_write` setting is off. Nothing blocks the clipboard itself, so a program in its terminals can still use `pbcopy`.
- **Links:** the app's `openURL:` call does nothing, and `open` and `afplay` found on PATH are silent shims. A program calling `/usr/bin/open` by its full path is not stopped.
- **Sounds and prompts:** beeps, the notification prompt and hiding other apps are refused. A crash exits quietly, without the crash dialog.

## Measured

herdr-app 0.1.10, macOS 26.6, with another app's full-size window on top. JS is a mod's 100 ms timer (10 a second at best), and `render()` redraws after each tick. Shots are 12 taken over about 4 s, while the mod's counter changes.

| How it's hidden                          | "Never covered" hook | JS ticks/s | `render()`/s | Different shots |
| ---------------------------------------- | -------------------- | ---------- | ------------ | --------------- |
| **Alpha 0, under normal windows (this)** | yes                  | 9.4        | 9.4          | 12 of 12        |
| Same                                     | no                   | 9.5        | 0            | 1 of 12         |
| Alpha 0 only                             | yes                  | 9.5        | 9.5          | 12 of 12        |
| Alpha 0 only                             | no                   | 9.5        | 0            | 1 of 12         |
| Opaque, under normal windows             | yes                  | 9.5        | 9.5          | 12 of 12        |
| Opaque, under normal windows             | no                   | 9.5        | 0            | 1 of 12         |
| Opaque, off screen                       | yes                  | 9.1        | 0            | 1 of 12         |
| Opaque, off screen                       | no                   | 9.5        | 0            | 1 of 12         |

So a covered window's timers keep running, but it stops drawing, and numbers taken in `render()` read as zero. Off screen doesn't draw even with the hook, so the window stays on its screen.

A change reached `shot` within about 180-340 ms, one or two shots: layout switch 222, new space 212, zoom 178-192, terminal output 253-260, mod hot reload 335. A first frame came 0.2-0.9 s after launch and `start` takes about 2.5 s. An idle window used 0.2-0.4% CPU.

The front app, sampled about every 270 ms through every run (21 runs, 920 samples), never changed during a run and was never the test window, and the test window was never the top one. The window server reported it at alpha 0 on layer -1. `stop` left no process, LaunchServices entry, preferences or cache, and the real app, its `herdr-app` link and other cores were untouched.

`open -g` alone was not run: it can't stop the activation Herdr asks for itself, so it would only take the focus, and it would not fix the frames.

## Limits

- Keys and the mouse can't reach it: hover, clicks and key handling still need a real window. Use `herdr-app do` for the rest.
- The window is never really active, so whatever asks if the person is looking at it gets no.
- It has the default size on the main display; one display was tested.
- It needs the display awake. While the display sleeps, the app logs `could not create display link` and `shot` keeps returning the same frame, even though `do` commands succeed. A window started during sleep stayed stale; waking the display with a window already running was not tested. `start` and `run herdr-app shot` warn when that line is in the window's log; the line stays there after the display wakes, and a display that sleeps later may not add one, so the warning is a hint, not proof either way.
- "Nothing on screen" rests on what the window server reports, not on looking at the screen. Mission Control and Stage Manager were not checked.
- The hooks fit this app version; `start` warns on another. After an update, if the front app ever moves, the app exits instead of staying in front and `run` says the window is not running; check the numbers above again before relying on it.
