# Plan for #28: eval suite, level 1 (workers only)

Base branch `main`. Run `npm run check` before a PR. CI (`.github/workflows/check.yml`) runs format:check, validate, `npm test` and `python3 -m unittest discover -s tests -p 'test_*.py'`. No mod file changes, so no plugin version bump. Prettier checks JSON (`.md` ignored, printWidth 140). Scripts are stdlib-only and must run on **Python 3.9.6** (no `match`, no `X | Y` hints).

## Settled answers (coordinator, 2026-10-24)

- Q1 B2's builder: `--model opus --effort medium`.
- Q2 Add the `VERDICT:` line to the reviewer prompt; free-text parsing is the fallback; record `how`.
- Q3 Unexpected DECISION: answer with the recommended option and carry on (`onDecision: "recommended"` default); `decision-rule` uses `stop`.
- Q4 Decision scenario passes on any matching DECISION; record a `pr_opened` flag.
- Q5 PLAN.md-only open questions don't count; shown as their own column.
- Q6 Slices build at the same time.
- Q7 Leak runs are invalid: left out of the pass rate and listed.
- Q8 Pass needs a PR per slice.
- Q9 The herdr-agents plugin is off in workers; `herdr-agents:*` agents are rejected at level 1.
- Q10 Deny WebFetch to github.com everywhere.
- Q11 No real model calls inside builder sessions. The smoke run and the acceptance run are run by the coordinator after the owner approves the spend; builders stop at `--dry-run` and `--check-scenarios`.
- Q12 Yes: "Acceptance details" lines where reference tests check wording the issue never gave; the #26 issue is assembled from #18 plus D14 and Q4=A.
- Q13 No replay `--check-scenarios` in CI for now.
- Q14 Split S1 into **S1a** (gh shim + its tests) and **S1b** (runner, stacked on S1a's branch).

## Design summary

- **Arms** live in `scripts/hrd-eval/arms/*.json`, in the herdr-agents.json format. An arm merges over the user file the way `hooks/config.ts` `config()` merges the folder file: `{...user, ...arm, profiles: {...user.profiles, ...arm.profiles}}`.
  - Runner-only keys: `fixRound: "fresh"|"resume"` (default fresh), `maxFixRounds` (default 2), `note`.
  - `disable: ["planner"]` is honoured. Disabling `reviewer` is an error at level 1.
  - `playbook`, `target`, `smallTasks` and similar keys are ignored, with a warning in `--dry-run`.
  - Profiles must be `kind: "claude"` and contain both `--model` and `--effort`, else error.
  - `--agent herdr-agents:*` is rejected at level 1.
  - Arms: `A.json` `{"note": "baseline", "fixRound": "fresh"}`; `B.json` `{"disable": ["planner"]}`; `B2.json` `{"disable": ["planner"], "profiles": {"builder": {"kind": "claude", "args": ["--agent", "builder", "--model", "opus", "--effort", "medium", "--permission-mode", "auto"]}}}`; `C.json` `{"fixRound": "resume"}`.
- **Each role call:** `claude -p <profile.args…> --output-format json --permission-prompts none --settings={"env":{"CLAUDE_CODE_PLUGIN_DIRS":""}} --disallowedTools=WebFetch(domain:github.com) --max-budget-usd <remaining> (--session-id <uuid4> | --resume <sid>)`.
  - Prompt on stdin; cwd is the role's folder. Use `--opt=value` so variadic `--disallowedTools` can't swallow the next argument.
  - Env: profile's `env`, plus `PATH=<scripts/hrd-eval/bin>:$PATH`, `CLAUDE_ENV_FILE=<run>/env.sh` (re-exports that PATH before each Bash command), `HRD_EVAL_GH_STATE=<run>/gh`, `GH_CONFIG_DIR=<run>/gh-config` (empty).
  - Env removed: `GH_TOKEN`, `GITHUB_TOKEN`, `CLAUDECODE`, `HERDR_*`.
  - Per-call timeout `--call-timeout` minutes (default 20): SIGINT, wait 30 s, SIGKILL.
  - JSON output has `result`, `session_id`, `total_cost_usd`. On `--resume`, `total_cost_usd` is the whole conversation's total, so a resumed call's cost is the difference.
  - Transcript: glob `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/<sid>.jsonl`.
- **Pipeline per run** (runner acts as coordinator): planner unless disabled → one builder per slice, each in its own worktree, in parallel threads → reviewer → while blockers > 0 and rounds < `maxFixRounds`: fix round (fresh builder in same worktree, or `--resume` of the slice's first builder session in arm C), then re-review by a fresh reviewer.
- **Reports.** Every call gets the real `reportRule` from `hooks/workers.ts` minus its WAIT.json sentences: RESULT.md in the job folder with the `<!-- report <token> -->` first line, PLAN.md for a plan, and the DECISION format. A test checks each sentence still appears word for word in `workers.ts`. The report is RESULT.md minus that line; if no matching token, the JSON `result` (`report_source: "result"`).
- **DECISION detection** like the mod's `deliver()`: regex `^\s*(?:[-*]\s*)?\**DECISION:?\**:?\s*(.+)$` multiline over the report, dropping lines starting with `none` or `n/a` (case-insensitive). A test checks the regex source appears in `workers.ts`. `onDecision: "recommended"` resumes the asker with the option marked `(recommended)`, at most 2 answer calls per run; `"stop"` ends the run with status `decision`. DECISION lines only in PLAN.md are recorded, not counted.
- **Verdict.** Reviewer prompt asks for a last line `VERDICT: approve` or `VERDICT: changes needed, <n> blockers`. Parse with `(?im)^\s*VERDICT:\s*(approve|changes needed)(?:,\s*(\d+)\s+blockers?)?`. Fallback free text: `(\d+) blockers?`, `no blockers`, a numbered list under a "Blockers" heading, or "changes needed" / "approve"/"ready". Record `how`: `line`, `heuristic`, `none`. "Changes" with unknown count = 1.
- **Hidden tests stay out of the workers' copy:**
  - Workers' repo is a `git archive <parent>` snapshot (replay) or a copy of the fixture folder, committed as the only commit of a fresh repo and pushed to a fresh bare `remote.git`.
  - Hidden tests live only in the source repo's git objects (replay) or `scenarios/<id>/hidden/`, copied into `<run>/grade/` only after the last worker call ends.
  - `--results` (default `~/.cache/hrd-eval/<YYYYmmdd-HHMMSS>`) must be outside the repo root, or the runner refuses.
  - Scorer flags a leak when any tool input names one of the run's `leak_patterns`: the source repo path, `~/.claude/mods/herdr-agents`, `scripts/hrd-eval`, `plan-18`, the merge commit's sha, `github.com/contursofran`.
- **Shim → bare remote.** `gh/repo.json` holds `remote` (abs path of `remote.git`). Branches, head shas, diffs and file lists come from `git --git-dir <remote> …` (diff `base...head`). PR and issue records are JSON files under `gh/`. URLs `https://github.com/hrd-eval/<scenario>/pull/<n>`. PR numbers continue after the highest issue number.

## Contract

Source of truth for S1a (shim), S1b (runner), S2 (scorer), S3 (scenarios).

### Files and CLIs
- `scripts/hrd-eval.py` runner (S1b). Loads `scripts/hrd-metrics.py` with `importlib` as `tests/test_hrd_metrics.py` does; uses `hm.scan(path, 0)` → `.tot` `{turns, inp, out, cr, cw, cost}`, `.by_model`, `.unpriced`, and `hm.PRICES` / `hm.price`.
  - Flags: `--scenarios a,b` (default all), `--arms A,C` (default all), `--repeats N` (3), `--parallel K` (1), `--dry-run`, `--max-cost USD` (30), `--max-call-cost USD` (5), `--call-timeout MIN` (20), `--results DIR`, `--config PATH` (default `${CLAUDE_CONFIG_DIR:-~/.claude}/herdr-agents.json`), `--claude PATH` (default `claude`), `--scenarios-dir DIR` (default `scripts/hrd-eval/scenarios`), `--arms-dir DIR`, `--source-repo DIR` (default this repo's root), `--check-scenarios [--update-expected]`, `--json`.
  - Exit codes: 0 done; 1 error; 2 budget refused the start or stopped the run.
- `scripts/hrd-eval/bin/gh` shim (S1a): executable Python 3, stdlib only. Exit 1 if `HRD_EVAL_GH_STATE` unset.
- `scripts/hrd-eval/score.py` scorer (S2): `score.py RESULTS_DIR [--json]`. Exports `score_run(run_dir) -> dict`, `aggregate(scores) -> dict`, `print_text(agg)`, `parse_plugin_test(text)`, `parse_unittest(text)`.

### `scenario.json` (in `scripts/hrd-eval/scenarios/<id>/`)
```
{
  "title": str,
  "kind": "replay" | "fixture",
  "issue": {"number": int, "file": "issue.json"},   # gh issue JSON: number,title,body,state,labels,comments[{author{login},body,createdAt}]
  "source": {"commit": "<sha in --source-repo>"} | {"dir": "<path relative to scenario dir>"},
  "hidden": {"commit": "<sha>", "paths": ["tests"]} | {"dir": "hidden", "to": "tests"},   # optional
  "slices": [{"id": "S1", "brief": str}],          # optional; default [{"id": "S1", "brief": ""}]
  "setup": [[argv...]],                             # run in work/ and each worktree; default []
  "grade": {"cmd": [argv], "parser": "plugin-test" | "unittest", "timeout": int},   # optional
  "allowed": [glob],                                # "**" matches across "/"
  "expect": {"decision": {"match": "<python regex>"} | null, "testsChanged": bool},
  "onDecision": "recommended" | "stop",             # default "recommended"
  "estimateScale": number,                          # default 1
  "notes": str                                      # optional
}
```
- `hidden.commit` overlay: in `grade/`, `rm -rf <path>` for each path, then extract `git archive <commit> <paths>` from the source repo.
- `hidden.dir` overlay: copy files into `grade/<to>/`, overwriting same names.
- `expected.json` (beside `scenario.json`, written by `--check-scenarios`): `{"tests": [names in the reference run], "discriminating": [names failing at base with the overlay]}`. Reference = `hidden.commit` for a replay, base + `solution.patch` for a fixture.

### Results folder
```
<results>/matrix.json   {"started": epoch, "repo_root": str, "scenarios": [id], "arms": {id: resolved arm}, "repeats": int,
                         "max_cost": float, "estimate": float}
<results>/<scenario>/<arm>/r<k>/
  run.json
  calls.jsonl
  jobs/<NN>-<role>[-<slice>]/   prompt.txt, out.json, stderr.txt, RESULT.md, PLAN.md, report.md, transcript.jsonl
  remote.git/  work/  wt-<slice>/
  gh/          repo.json, issues/<n>.json, prs/<n>.json, next, calls.log
  grade/       hidden.txt, hidden.exit, own.txt, own.exit
```

`run.json`:
```
{"scenario": str, "scenario_dir": abs str, "arm": str, "repeat": int,
 "status": "done"|"decision"|"rounds_exhausted"|"no_pr"|"error"|"timeout"|"budget", "error": str|null,
 "started": float, "ended": float, "base": sha, "pr_opened": bool,
 "slices": [{"id": str, "branch": str, "pr": int|null, "head": sha|null, "fix_rounds": int,
             "reviews": [{"call": int, "sha": sha, "verdict": "approve"|"changes"|null, "blockers": int|null,
                          "how": "line"|"heuristic"|"none"}]}],
 "decisions": [{"call": int, "role": str, "text": str, "answered": str|null}],
 "plan_decisions": [str],
 "grade": {"ran": bool, "kind": "plugin-test"|"unittest"|null, "merged": bool, "merge_error": str|null,
           "exit": int|null, "own_exit": int|null},
 "changed_files": [str],
 "leak_patterns": [str]}
```

Each line of `calls.jsonl`:
```
{"n": int, "role": "planner"|"builder"|"reviewer", "slice": str|null,
 "kind": "plan"|"build"|"review"|"fix"|"rereview"|"answer",
 "profile": str, "argv": [str], "session_id": str, "resumed": bool, "cwd": str,
 "started": float, "ended": float, "exit": int, "timed_out": bool, "is_error": bool,
 "report_source": "result_md"|"result", "job": "jobs/NN-…",
 "cost_transcript": float, "cost_reported": float|null, "tokens": {"inp","out","cr","cw"},
 "models": {model: cost}, "unpriced": [str]}
```
For a resumed call, `cost_*` and `tokens` are differences from that session's previous call.

`gh/calls.log`: one JSON line per shim call, `{"t": float, "cwd": str, "argv": [str], "exit": int}`.

### Shim commands
- Every command accepts and ignores `-R/--repo`. `--jq` pipes the JSON through `jq -r`. `--json` with an unknown field → exit 1 with `Unknown JSON field: "<f>"`.
- Fields:
  - PR: number, title, body, state, isDraft, url, headRefName, headRefOid, baseRefName, author{login}, labels[{name}], files[{path,additions,deletions}], additions, deletions, comments, reviews, reviewDecision "", mergeable, mergeStateStatus, statusCheckRollup [], commits[{oid,messageHeadline}], createdAt, updatedAt, mergedAt null, mergeCommit null, autoMergeRequest null.
  - Issue: number, title, body, state, labels, comments, url, author, createdAt.
  - Repo: name, owner{login}, nameWithOwner, url, description, defaultBranchRef{name}.
- `repo view`.
- `issue view <n> [--comments]`, `issue list`, `issue comment <n> --body|--body-file`.
- `pr create [--base] [--head] [--title] [--body|--body-file|-F] [--fill] [--draft] [--label]`: exit 1 if head not on the remote; exit 1 if no commits ahead of base; exit 1 if a PR for that head exists (message includes its URL); otherwise print the URL.
- `pr view [<n>|<url>|<branch>] [--comments]`; no argument = PR for the cwd's current branch (`git -C $PWD branch --show-current`).
- `pr diff [sel] [--name-only] [--patch] [--color X]`.
- `pr list [--state open|closed|merged|all] [--search Q] [--head] [--base] [--label] [--limit]`. `--search`: `is:open|closed|merged`, `state:`, `head:`, `base:` applied; `is:draft`/`draft:true|false` filter on isDraft; `is:pr` and any other `key:value` token are ignored; every plain word must appear in title, body or a changed file's path.
- `pr edit <sel> [--title] [--body|--body-file] [--add-label] [--remove-label] [--base]`, `pr ready`, `pr comment`, `pr review [--approve|--request-changes|--comment] [--body]`.
- `pr checks` prints `no checks reported on the '<branch>' branch`, exit 1.
- `run list`/`run view` print `no runs found`, exit 0.
- `auth status` prints a "logged in" line, exit 0.
- Anything else (incl. `pr merge`, `api`): stderr `hrd-eval gh shim: unsupported: gh <args>`, exit 1. Every call is logged. Writes take `fcntl` locks on `gh/lock`.

### Prompts the runner sends
`{R}` is the report rule (kept in its TS form with `${job.dir}` and `${job.token}`, filled in).
- plan: ``Plan issue #{n} ({title}): read it with `gh issue view {n} --comments`. The repo is checked out at {work} (base branch main).{ If slices > 1: Split it into these slices, one PR each: S1: {brief}; S2: {brief}. Write a Contract section for what they share.} Change no code. {R}``
- build, planned: ``Build issue #{n} from the plan at {plan}{, slice {id} only ({brief}); another builder builds {others}}, in the worktree {wt} (branch {branch}, made off origin/main). Open a PR into main. {R}``
- build, no planner: ``Build issue #{n}: read it with `gh issue view {n} --comments`; plan it before you build it. Work in the worktree {wt} (branch {branch}, made off origin/main){slice part}. Open a PR into main. {R}``
- review: ``Review PR #{pr} for issue #{n} (`gh pr view {pr}`, `gh pr diff {pr}`){; the plan is at {plan}}. Its worktree is {wt}. {VERDICT} {R}``
- fix: ``Fix round {k} for PR #{pr} (issue #{n}){; plan at {plan}}, in the worktree {wt}. The review's blockers:\n{review report}\n{R}`` (same text for fresh and resume).
- rereview: ``Re-review PR #{pr}: you reviewed {sha} last time; that review is at {path}. {VERDICT} {R}``
- answer: ``Answers to your DECISION questions: {question} -> {recommended option}. Carry on. {R}``
- `{VERDICT}`: ``End the report with one line: `VERDICT: approve` or `VERDICT: changes needed, <n> blockers`.``
- Branches: `issue-{n}-eval` (one slice) or `issue-{n}-{slice id lowercased}`.

### Pass rule (scorer)
- `expect.decision` set: pass if some `decisions[].text` matches `expect.decision.match`.
- Otherwise all of: status not `error`/`timeout` and every slice has a PR; `grade.merged`; every name in `expected.tests` is `(pass)`/`ok` in `hidden.txt` (missing = fail); if `testsChanged`, `changed_files` includes a test file.
- A run with a leak is `invalid`: out of the pass rate, listed.

## S1a: gh shim (`scripts/hrd-eval/bin/gh`) + tests

1. Implement every command in "Shim commands".
2. `tests/test_hrd_eval_gh.py`: each test builds a temp bare repo, a clone and a state folder, runs the shim via subprocess. Git identity via `-c user.name=t -c user.email=t@t`. One test per behaviour:
   - repo view `--json defaultBranchRef` and `--jq .defaultBranchRef.name` → `main`;
   - issue view, text and `--comments`;
   - pr create: head not pushed → exit 1; after push → URL with number = highest issue + 1; second create → exit 1 "already exists"; `--fill`; `--body-file -`;
   - pr view by number, URL, branch and cwd; `headRefOid` equals the remote ref; `files`; unknown field → exit 1;
   - pr diff equals `git diff main...head`; `--name-only`;
   - pr list `--search <path>` matches only the PR touching that path; `--state all`;
   - edit, ready, comment, review visible in `pr view --json`;
   - `pr checks` → exit 1 with its message; `api` and `pr merge` → exit 1, logged;
   - no `HRD_EVAL_GH_STATE` → exit 1;
   - `-R x/y` ignored.
   `skipUnless(shutil.which("jq"))` for `--jq` cases.
3. CI: rename the Python step in `.github/workflows/check.yml` to "Python script tests (hrd-metrics, hrd-eval)"; command unchanged.
4. Verify: `python3 -m unittest tests.test_hrd_eval_gh -v`, `python3 -m unittest discover -s tests -p 'test_*.py'`, `npm run check`.

## S1b: runner, replay-13, `--dry-run`, `--check-scenarios` (stacks on S1a)

1. Runner core in `scripts/hrd-eval.py`, docstring in hrd-metrics style:
   - `load_arms(arms_dir, names, config_path)` merges and checks arms per the Design summary.
   - `role_argv(profile, sid, resume, cap)`, `run_env(run)`.
   - `REPORT_RULE_PARTS` and `DECISION_RE` copied from `workers.ts`; `report_rule(job_dir, token)`.
   - `parse_verdict(text) -> (verdict, blockers, how)`, `decisions(text)`.
   - `call_cost(transcript, before)` via `hm.scan`; cost = max(transcript cost, `total_cost_usd` difference).
2. `setup_run(scenario, run_dir)`: snapshot via `git archive <commit> | tar -x` or copy the fixture; `git init -b main`, commit "Base", create bare `remote.git`, push; `git clone remote.git work`; write gh state (repo.json, issues/<n>.json from `issue.json`); run `setup`. One worktree per slice: `git -C work worktree add -b <branch> ../wt-<slice> origin/main`, then `setup` in it.
3. `run_one(scenario, arm, k)`: the pipeline; writes `calls.jsonl` and `jobs/` as it goes, `run.json` at the end. Slices in threads. Answer calls per `onDecision`. A slice's PR: the one whose head is the slice branch; else the PR created during that call (from `calls.log`); else `/pull/(\d+)` in the report; else status `no_pr`.
4. `grade(run)`: `git clone remote.git grade`; on main `git merge --no-edit origin/<head>` per slice (conflict → `merged=false`, `merge_error`); run the grade cmd → `own.txt`/`own.exit`; apply the hidden overlay; run again → `hidden.txt`/`hidden.exit`. `changed_files` = `git diff --name-only <base>...HEAD`.
5. Budget and matrix: estimate per call by `--model`: opus $0.60, sonnet $0.30, haiku $0.08, other $0.50. Per run: (planner + slices × (builder + reviewer) × 1.5) × `estimateScale`. Estimate > `--max-cost` → refuse, exit 2. Before each call, stop new calls everywhere if spent + this call's estimate > max; remaining runs get `budget`. Each call's `--max-budget-usd` = min(`--max-call-cost`, remaining). `--parallel K` uses a `ThreadPoolExecutor` with a budget lock. Print one line per run: scenario, arm, k, status, fix rounds, cost, wall time.
6. `--dry-run`: print the matrix, each arm's resolved command line per role (showing `--model`/`--effort`), warnings, cost per run and total, and whether each replay's commits are in `--source-repo` (`git cat-file -e`). Calls nothing.
7. `--check-scenarios`: base + overlay (must fail) and reference + overlay (must pass). `--update-expected` writes `expected.json`; otherwise compare and report drift.
8. Scenario `scripts/hrd-eval/scenarios/replay-13/`:
   - `issue.json`: issue #12 with only comments made before PR #13 was created (none).
   - `scenario.json`: source `f9f3201f7c32e3b34eac901fcaf0850983e679cc`, hidden `a3bcb63bcf0414ca143789178d391be0dd14ace4` paths `["tests"]`; setup `[["npm","ci","--no-audit","--no-fund","--prefer-offline"],["bash","scripts/types.sh"]]`; grade `["claude","plugin","test","."]`, parser `plugin-test`, timeout 300; allowed `["hooks/workers.ts","tests/**","README.md",".claude-plugin/plugin.json"]`; `expect.decision` null.
   - `expected.json` from `--check-scenarios --update-expected` (expect 19 tests, 1 discriminating). `claude plugin test` makes no model calls.
   - `npx prettier --write scripts/hrd-eval`.
9. Arms `A.json`, `B.json`, `B2.json`, `C.json` per the Design summary.
10. `tests/test_hrd_eval_runner.py`, no model calls:
    - Fake claude: a temp Python script passed with `--claude`; reads `--agent`, `--session-id`/`--resume`, prompt on stdin; writes a transcript with timestamps, message id, model and usage under a temp `CLAUDE_CONFIG_DIR`; behaviour per call from a JSON script in `FAKE_CLAUDE_SCRIPT` (planner writes PLAN.md; builder edits, commits, pushes, calls `gh pr create` through PATH; reviewer returns VERDICT lines); writes RESULT.md with the prompt's token; prints the result JSON; records `ls` of its cwd and whether `gh` resolved to the shim.
    - Temp replay scenario: a source repo with a "parent" commit and a "merge" commit adding `tests/test_hidden.py`, graded with `python3 -m unittest discover -s tests -v`.
    - Tests: arm A runs [plan, build, review, fix, rereview] when the first review has 1 blocker, run.json fields right, `hidden.exit == 0`, no worker cwd ever contained `test_hidden.py`; arm C fix call has `--resume <builder sid>` and no `--session-id`, cost is the difference; arm B has no plan call and the build prompt contains "plan it before you build it"; DECISION `stop` → status `decision`, no more calls; `recommended` → an `answer` call resuming the asker; `DECISION: none` ignored; budget refuses start (exit 2, fake never invoked); mid-run cap → `budget`; `--dry-run` invokes nothing and prints `--model`/`--effort`; profile without `--effort` → error; codex profile → error; `herdr-agents:` → error; results inside the repo refused; argv has the plugin-dirs `--settings`, `--permission-prompts none`, the WebFetch denial; env has the shim first in PATH and `GH_CONFIG_DIR`; drift tests for `REPORT_RULE_PARTS` and `DECISION_RE` against `hooks/workers.ts`; verdict parsing (line, heuristics "ready. No blockers.", "changes needed, 1 blocker", numbered list under **Blockers**, none).
11. Verify: `python3 -m unittest discover -s tests -p 'test_*.py' -v`, `npm run check`, `scripts/hrd-eval.py --check-scenarios --scenarios replay-13`, `scripts/hrd-eval.py --dry-run`. **Do not** run a real (non-dry) matrix; the coordinator runs the smoke run after the owner approves the spend. PR body: dry-run output and check-scenarios output.

## S2: scorer and table (`scripts/hrd-eval/score.py`), independent

1. Parsers: `parse_plugin_test(text) -> {name: "pass"|"fail"|"skip"}` (lines `(pass) <name> [ms]` / `(fail) <name>`, including the "the file ran to its end" row; summary lines ` N pass`, ` N fail`, `Ran …`); `parse_unittest(text)` from `-v` lines `test_x (mod.Class) ... ok|FAIL|ERROR|skipped`.
2. `score_run(run_dir)` reads `run.json`, `calls.jsonl`, `<scenario_dir>/scenario.json`, `expected.json`; returns: `pass`, `invalid`, `status`; `hidden: {new_pass, new_total, failed: [names]}`; `own_tests: pass|fail|none`; `fix_rounds`; `blockers` (first review's count and total); `decision: {expected, raised, matched}`, `pr_opened`, `plan_decisions`; `outside` (changed files matching no `allowed` glob); per role `{calls, cost, cost_reported, tokens, secs}` plus total `cost` and `wall`; `leak` (matches of `leak_patterns` in tool_use inputs — Bash command, Read/Grep/Glob paths, WebFetch url — in each `jobs/*/transcript.jsonl`); `shim_bypassed` (Bash commands with `gh ` but empty `gh/calls.log`).
3. `aggregate(scores)`: a cell per scenario × arm: pass k/N (valid runs), mean cost, median wall, mean fix rounds, mean first-review blockers, decision k/N where expected, outside total, invalid count; per-arm totals and per-role cost per arm; `disagreements`: scenarios whose pass counts differ between arms, each with failing runs (folder + reason: missing tests, merge conflict, no PR, decision not raised, status).
4. `print_text(agg)` like `hrd-metrics.py` `print_text`: `== hrd-eval …` header, fixed-width columns, `fmt_money`-style money, footer notes for unpriced models and invalid runs. `--json` prints `{"matrix", "runs", "cells", "arms", "roles", "disagreements"}`.
5. `tests/test_hrd_eval_score.py` with hand-built run folders per the Contract and transcripts like `test_hrd_metrics.Transcript`; every expected number worked out by hand: both parsers incl. the crashed-file row; replay pass; missing expected test = fail; merge conflict = fail; no PR = fail; decision matched → pass, unmatched/none → fail, PLAN.md-only doesn't count; `testsChanged`; `allowed` globs with `**`; per-role cost sums with a resumed call's difference already in `calls.jsonl`; leak → invalid and out of k/N; shim bypass; aggregation, disagreements, text header and row, `--json` keys.
6. Verify: `python3 -m unittest tests.test_hrd_eval_score -v`, `npm run check`.

## S3: other scenarios, wiring, real run (needs S1b and S2 merged)

1. Wiring: at the end of a non-dry run, `scripts/hrd-eval.py` loads `score.py` with `importlib` and prints `print_text(aggregate(...))`; `--json` prints the aggregate. A runner test checks the table appears after a fake run.
2. Fixture `scripts/hrd-eval/fixture/`, tiny Python package, tests ~1 s: `AGENTS.md` (filled template: base `main`; checks `python3 -m unittest discover -s tests`; update by merging main; only the owner merges; ask the owner first about prices, discounts and other product rules); `shop/cart.py` `total(items)` with 10% bulk discount at 100+; `shop/server.py` `handle(request: dict) -> dict` dispatching on `type`, with `ping`; `shop/client.py` `Client(transport).ping()`; `shop/transport.py` `LocalTransport` (JSON both ways); `tests/test_cart.py`, `tests/test_client.py`, `CHANGELOG.md`.
3. `decision-rule`: issue "Members get 5% off their order total" without saying how it combines with the bulk discount. `expect.decision.match` = `(?i)stack|combin|both|bulk|additive|compound|order`, `onDecision: "stop"`, no grade.
4. `contract`: `Client.quote(items)` returns `"Total: $108.00"`, priced by the server (bulk discount included); unknown sku → client raises `ValueError` naming the sku; field names not given. Slices S1 server (`shop/server.py`), S2 client (`shop/client.py`). `hidden/test_quote_hidden.py` end to end through `LocalTransport` (plain, discount, unknown sku). `solution.patch` is the reference.
5. Replays: `replay-14` (issue #10; parent a3bcb63, merge 1bc830e), `replay-15` (issue #11; parent 1bc830e, merge faa02a8), `replay-26` (issue #18; parent 8bec2a7, merge 5492371). Setup and grade as replay-13; `allowed` = each PR's files plus `tests/**`. `issue.json`: comments created before the PR only. replay-14: an "Acceptance details" block with the exact strings and timings the reference tests check (e.g. `its prompt was not delivered: no work started after 3 tries`, blocked report within 10 s). replay-26: assembled issue — #25 (items 1, 2, 5 of #18) is merged; give items 3 and 4 and the acceptance lines; add Q4=A word for word (D14's text was never recorded; state the worker-session sweep from the owner's #26 review in Acceptance details instead) from `~/Documents/code/personal/claude-herdr-orchestrator-wt/plan-18-PLAN.md`; `testsChanged: true`. Note in `notes` any detail the reference tests check that the issue doesn't give.
6. `--check-scenarios --update-expected` for all; results in the PR body. CI unittest running `--check-scenarios --scenarios decision-rule,contract` (Python only).
7. Real acceptance run (`--arms A --repeats 1`, all 6 scenarios, est. $8–12) is run by the coordinator after owner approval; calibrate per-model estimates from its `calls.jsonl`.

Verify each slice with `python3 -m unittest discover -s tests -p 'test_*.py' -v` and `npm run check`.

## Reference data (validated by the planner)

| PR | parent | merge | parent + merge's tests | merge alone |
|---|---|---|---|---|
| #13 (issue #12) | f9f3201 | a3bcb63 | 18 pass, 1 fail (new) | 19 pass |
| #14 (issue #10) | a3bcb63 | 1bc830e | 19 pass, 1 fail (new) | 20 pass |
| #15 (issue #11) | 1bc830e | faa02a8 | 20 pass, 1 fail (new) | 21 pass |
| #26 (issue #18) | 8bec2a7 | 5492371 | 34 pass, 8 fail (7 new + "file ran to its end") | 41 pass |

Test files import only `./harness` and `claude-code/testing`; `tests/harness.tsx` changes only add fake-environment knobs, so grading replaces the worker's whole `tests/` with the merge commit's.

## Dependencies

| Slice | Dependency |
|---|---|
| S1a: gh shim + tests | independent |
| S1b: runner, replay-13, dry-run, check-scenarios | stacks on S1a's branch |
| S2: scorer and table | independent |
| S3: fixture, decision-rule, contract, replay-14/15/26, wiring | needs S1b and S2 merged |

## Notes from S1a (PR #35) for S1b
- `gh/repo.json` must have `"remote"` (abs path), `"name"` = the scenario id and `"owner": "hrd-eval"`; the shim builds PR URLs from them.
- Create the bare remote with `git init --bare -b main`; the shim reads the default branch from the remote's HEAD.
- `pr create` needs `--title` or `--fill`; the duplicate check covers OPEN PRs with the same head.
- `npm run typecheck` fails on main with TS2589 at tests/harness.tsx:245 (pre-existing, not in CI); don't fix it in this slice.

## Carried into S3 (from the #34 review)
- `score.py:298`: `disagreements` should compare pass **rates** (pass / valid runs), not raw counts, so 2/3 vs 2/2 is a disagreement and 1/1 vs 2/2 is not. Add a test.
- `score.py:125/:413`: a missing `expected.json` should print a one-line error and exit 1, not a traceback.

## Changes from the #37 review
- run.json slices gain `"review_unparsed": bool` (true when any review on the slice has `how: "none"`; fix rounds still end there). S3: the scorer reports these runs.
- Each run has its own gitconfig (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, no credential helper, github.com URLs rewritten to fail).
- `run_env(run, profile)` takes the profile too.
- Smoke run: compare `cost_reported` with `cost_transcript` on an arm C fix call to confirm `--resume` reports the session total.
- S3: also drop `SSH_AUTH_SOCK` from worker envs (git's ssh to github.com is already blocked; this closes raw `ssh`).

## Smoke run (2026-10-25, replay-13 × A × 1, results ~/.cache/hrd-eval/20261025-090209)
- pass, 19/19 hidden tests, 0 fix rounds, review verdict by line, no leak, 15 shim calls (none bypassed).
- $0.92 (estimate $1.62), 510 s. planner $0.68 (incl. one answer call for 3 DECISIONs), builder $0.06, reviewer $0.19.
- Resumed answer call: cost_reported == cost_transcript difference, so `--resume` reports the session total as assumed.
- S3: calibrate the per-model estimates from this run's calls.jsonl.

- replay-15: its discriminating test reads jobs from `$.store` under `jobs:<session id>` as `{at, jobs}`, which issue #11 never says (it suggests a file). Acceptance details state it, as Q12 does for the other replays.
