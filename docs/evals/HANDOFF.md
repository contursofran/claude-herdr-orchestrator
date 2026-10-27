# Evals handoff (#28), 2026-10-26

Where the eval suite stands, what the runs so far show, and what to run next. The full plan and the settled design answers are in [PLAN.md](PLAN.md). The scored runs are in [runs/](runs/): a `.txt` table and a `.json` file per results folder, re-scored with the scorer on main at a266676.

## The question

Should the mod fold the planner into the builder, following the article "Building agents: when to fold subagents into your main agent loop"? Its advice: merge tightly chained specialists into the main agent, and keep subagents for parallel work, fresh context and verification. The suite answers this by running the same tasks under different arms and grading the result with hidden tests.

## Arms (`scripts/hrd-eval/arms/`)

| Arm | What changes |
|---|---|
| A | Baseline: planner (Opus medium) → builder → reviewer (Opus low) |
| B | No planner. The builder plans for itself |
| B2 | No planner, builder on Opus medium |
| C | Fix rounds resume the same builder (not run yet) |
| R | Reviewer on Opus medium instead of low |

## Runs

| Results folder | Arms | Notes |
|---|---|---|
| 20261026-165812 | A | Acceptance run. 4/6. replay-14 was unfair then (fixed in #45) |
| 20261026-172215 | B, B2, R | **Not valid for conclusions.** The answer cap ended runs, workers read the installed mod, and contract merges conflicted. Fixed in #45. Kept for the record |
| 20261026-201836 | A, B, B2, R | First run after the fixes. Stopped by hand after 19 runs, so replay-15/R and **all of replay-26 are missing** |

Run 20261026-201836, one repeat each (✓ pass, ✗ fail, – not run):

```
            contract  decision  r-13  r-14  r-15  pass   cost
A              ✓        ✓        ✓     ✓     ✗    4/5   $3.78
B  no planner  ✓        ✓        ✓     ✗     ✓    4/5   $3.40
B2 Opus bldr   ✓        ✓        ✓     ✓     ✗    4/5   $5.07
R  rev. medium ✓        ✓        ✓     ✓     –    4/4   $3.57
```

## What the data shows so far (one repeat, so leads, not conclusions)

1. **The planner doesn't pay for itself yet.** It is ~43% of arm A's cost. B, with no planner, had the same pass rate and cost 10–30% less. B's one miss was replay-14, a subtle timing bug, which also needed a fix round. That is the case worth re-testing.
2. **An Opus builder (B2) costs 35–50% more for the same result.** Drop it.
3. **The reviewer is the weak link.** Every failing run was approved with 0 or few blockers. replay-15's failures in A and B2 are regressions: a test that passes at base and at the reference broke. Fix rounds are rare. R, the stronger reviewer, sent work back more often.
4. **The decision rule works without a planner.** Every arm stopped and asked the owner on decision-rule. On B, the builder asked, for $0.07.
5. **Only replay-14, -15 and -26 separate the arms.** contract, decision-rule and replay-13 pass on every arm, so they serve as smoke tests.

This fits the article: fold the planner, and put the savings into verification.

## Next runs, in order

1. **replay-26 on all arms** (~$5, ~15 min):
   `python3 scripts/hrd-eval.py --arms A,B,B2,R --scenarios replay-26 --repeats 1 --max-cost 8`
2. **A vs B, 3 repeats, on the hard scenarios** (~$19 estimated). Answers "fold the planner?":
   `python3 scripts/hrd-eval.py --arms A,B --scenarios replay-14,replay-15,replay-26 --repeats 3 --max-cost 30`
3. **Reviewer catch rate** (new scenario type, needs a PR). Give the reviewer PRs with a seeded bug, including a regression of an existing test. Compare reviewer configs (low vs medium, Opus vs Sonnet). Reviewer calls only, so it's cheap.
4. **2–4 more replay scenarios** from harder merged PRs. Three scenarios that separate the arms is too few.

Score a folder with `python3 scripts/hrd-eval/score.py <results folder>`. Add `--dry-run` to any run to see the matrix and the cost estimate first.

## Running on another machine

- Needs `claude` (logged in), `git`, `node`/`npm` (for the scenarios' `claude plugin test`) and `python3` ≥ 3.9. No gh login is needed: workers use the gh shim backed by a local bare remote.
- Results go to `~/.cache/hrd-eval/<timestamp>`, outside the repo. A full matrix takes several hundred MB.
- Run `python3 scripts/hrd-eval.py --check-isolation --scenarios replay-13` first (one call, ~$0.10). Every read of a blocked folder must say `refused`, and the git push and test command must work. The blocked folders are computed from the home folder, so they adapt to the machine. The check has only been run on a machine with the mod installed at `~/.claude/mods/herdr-agents`. Without it, the probe's reads of that folder may not be judged the same way.
- `--jobs N` (default 4) runs that many runs at once. Grades always run one at a time. Lower it if the machine is slow: grades time out under load.
- Workers run with `--permission-mode auto`, so the auto-mode classifier sometimes refuses a command before the sandbox does. The scorer counts that as blocked. It applies to every arm the same.
- Ctrl-C stops the runner and every worker it started. Finished runs stay in the folder, and the scorer reads a partial folder.

## Known gaps

- Workers can run whole-disk searches (`find / …`), which load the CPU for a few minutes. Not blocked yet.
- Within one matrix, a worker could read another run's `grade/` folder in the seconds before its hidden tests are removed.
- `npm run typecheck` has a TS2589 error on main, unrelated to the evals.
