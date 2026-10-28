# Evals handoff (#28), 2026-10-27

Where the eval suite stands, what the runs show, and what to run next. The full plan and the settled design answers are in [PLAN.md](PLAN.md). The scored runs are in [runs/](runs/): a `.txt` table and a `.json` file per results folder.

## The question

Should the mod fold the planner into the builder, following the article "Building agents: when to fold subagents into your main agent loop"? Its advice: merge tightly chained specialists into the main agent, and keep subagents for parallel work, fresh context and verification. The suite answers this by running the same tasks under different arms and grading the result with hidden tests.

## Arms (`scripts/hrd-eval/arms/`)

| Arm | What changes |
|---|---|
| A | Baseline: planner → builder → reviewer |
| B | No planner. The builder plans for itself |
| B2 | No planner, builder on Opus medium |
| BH | No planner, builder on Haiku xhigh (the mod's default builder; not run yet) |
| C | Fix rounds resume the same builder (not run yet) |
| R | Reviewer on Opus medium instead of low |

Every run so far used the profiles in [`scripts/hrd-eval/config.json`](../../scripts/hrd-eval/config.json): builder Sonnet medium, planner Opus low, reviewer Opus low. Pass it with `--config scripts/hrd-eval/config.json`, so a run does not depend on the machine's `~/.claude/herdr-agents.json`. The runner rejects profiles without `--model`, such as the mod's own `herdr-agents:` profiles. These are **not** the mod's defaults (`agents/*.md`: builder Haiku xhigh, planner and reviewer Opus high).

`--agent builder` loads `~/.claude/agents/builder.md` (the mod is off in workers), not the repo's `agents/builder.md`. Today both have the same text. To eval a change to `agents/*.md`, copy it to `~/.claude/agents/` first.

## Runs

| Results folder | Arms | Notes |
|---|---|---|
| 20261026-165812 | A | Acceptance run. 4/6. replay-14 was unfair then (fixed in #45) |
| 20261026-172215 | B, B2, R | **Not valid for conclusions.** The answer cap ended runs, workers read the installed mod, and contract merges conflicted. Fixed in #45. Kept for the record |
| 20261026-201836 | A, B, B2, R | All scenarios but replay-26. Stopped by hand after 19 runs |
| 20261027-173615 | A, B, B2, R | replay-26, one repeat. Fills the gap of 20261026-201836 |
| 20261027-175250 | A, B | replay-14, -15, -26, three repeats. The A vs B run |

A vs B over the three valid runs (all scenarios, so not one repeat each):

```
                 pass    cost    per run
A  planner      12/15  $15.07    $1.00
B  no planner   14/15  $10.45    $0.70
```

20261027-175250, three repeats each:

```
            r-14  r-15  r-26   pass   cost    planner  builder  reviewer
A            3/3   3/3   1/3   7/9   $9.73    $3.76    $3.89    $2.08
B            3/3   3/3   3/3   9/9   $6.02    $0.00    $3.98    $2.03
```

## What the data shows

1. **Fold the planner.** B passed as often as A or more, for ~30% less. The planner is ~40% of A's cost, and B's builder costs no more than A's. B's one miss on 10-26 (replay-14) passed 3/3 on 10-27, so it was noise.
2. **Why A fails on replay-26.** Three runs with a planner failed it (A twice, R once). The jobs show two causes:
   - **The planner splits one issue into two stacked PRs** (A/r1 of 175250, R/r1 of 173615: S1 board, S2 `HERDR_AGENTS_ROLE=worker`). The runner builds one PR per scenario slice, so S2 was never built. Partly a harness gap, fixed in this PR: a one-slice plan prompt now asks for one PR. But it also shows the cost of a planner: two builders, two reviews and a stacked PR for an issue one builder did whole in B.
   - **A plan hides the code from the builder** (A/r3). The plan said to replace the 3 s timer. That timer also takes the bridge inbox. The builder saw it, asked, and followed the plan; the hidden bridge test failed. The B builders (r1, r3) read the code, saw the same thing and kept the timer.
3. **The reviewer checks the PR against the plan, not the issue.** The A/r1 reviewer approved half of the issue: "Contract met, no blockers. Next: merge, then S2 stacks on it." Across both days, every failing run was approved with 0 blockers at the first review. On 10-27, 18 of 18 first reviews had 0 blockers. R (reviewer on medium) did not do better on replay-26.
4. **An Opus builder (B2) costs 50–60% more than B for the same result.** Drop it.
5. **The decision rule works without a planner.** Every arm stopped and asked the owner on decision-rule (10-26).
6. **Only replay-14, -15 and -26 separate the arms**, and on 10-27 only replay-26 did. contract, decision-rule and replay-13 are smoke tests.

What this means for the mod: the builder plans for itself, the planner is kept for work that needs several PRs or leaves the approach open, and the savings go to verification. The open risk: B is proven with a Sonnet builder, and the mod ships Haiku. Run BH before the mod drops the planner by default.

## What this means for v2 (#23)

- **#20 (mod-written state block, race fixes), #21 (mod-owned worktrees, non-blocking spawn), #33 (early delivery gaps):** not touched by these findings. They cut coordinator turns, which level 1 does not measure. Still relevant.
- **#22 (pipeline rules without coordinator turns):** still relevant, and simpler: with no planner the chain is builder → reviewer → fix, one hop and one report less per issue. But its rule "reviewer `approved` → mark ready" trusts the step these runs show is weakest. Until the reviewer catch rate (next run 3) is measured and good, an approval must not be enough: keep CI green and the owner's merge as the gates.
- **Arm C (resume the builder for fixes):** low priority. Fix rounds were 0 in all 18 runs of 175250, so how they run matters less than whether the reviewer starts one.
- **The epic's goal (fewer Opus coordinator turns):** folding the planner helps it. It removes a spawn, a report and the plan's DECISION answers per issue.

## Next runs, in order

1. **BH vs B: does the Haiku builder plan for itself?** (~$5, ~30 min). Decides whether the mod drops the planner by default:
   `python3 scripts/hrd-eval.py --config scripts/hrd-eval/config.json --arms B,BH --scenarios replay-14,replay-15,replay-26 --repeats 3 --max-cost 15`
   (B is already in 20261027-175250; run `--arms BH` alone to save ~$6.)
2. **Reviewer catch rate** (new scenario type, needs a PR). Give the reviewer PRs with a seeded bug: half an issue built, a removed duty (like A/r3's bridge inbox), a regression of an existing test. Compare reviewer configs (low vs medium, the reviewer prompt before and after its change). Reviewer calls only, so it's cheap.
3. **2–4 more replay scenarios** from harder merged PRs. One scenario that separates the arms is too few.

Score a folder with `python3 scripts/hrd-eval/score.py <results folder>`. Add `--dry-run` to any run to see the matrix and the cost estimate first.

## Running on another machine

- Needs `claude` (logged in), `git`, `node`/`npm` (for the scenarios' `claude plugin test`) and `python3` ≥ 3.9. No gh login is needed: workers use the gh shim backed by a local bare remote.
- Results go to `~/.cache/hrd-eval/<timestamp>`, outside the repo. A full matrix takes several hundred MB.
- Run `python3 scripts/hrd-eval.py --config scripts/hrd-eval/config.json --check-isolation --scenarios replay-13` first (one call, ~$0.10). Every read of a blocked folder must say `refused`, and the git push and test command must work. The blocked folders are computed from the home folder, so they adapt to the machine. It held on both machines used so far, each with the mod installed at `~/.claude/mods/herdr-agents`.
- `--jobs N` (default 4) runs that many runs at once. Grades always run one at a time. Lower it if the machine is slow: grades time out under load.
- Workers run with `--permission-mode auto`, so the auto-mode classifier sometimes refuses a command before the sandbox does. The scorer counts that as blocked. It applies to every arm the same.
- Ctrl-C stops the runner and every worker it started. Finished runs stay in the folder, and the scorer reads a partial folder.

## Known gaps

- Workers can run whole-disk searches (`find / …`), which load the CPU for a few minutes. Not blocked yet.
- Within one matrix, a worker could read another run's `grade/` folder in the seconds before its hidden tests are removed.
- `npm run typecheck` has a TS2589 error on main, unrelated to the evals.
- `tests/test_hrd_eval_runner.py` failed once in three full runs on 10-27 and passed the other two: a timing-sensitive test, not yet named.
