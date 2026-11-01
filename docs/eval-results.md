# What the evals showed

A suite in this repo compared playbook variants by running workers on replayed issues, with hidden tests to score them. It was removed in #261 because it was a third of the repo and hadn't produced a scored run since 2026-10-28. To run it again, get it back from commit `a5d9f53` (`scripts/hrd-eval.py`, `scripts/hrd-eval/`, `docs/evals/`, `tests/test_hrd_eval_*.py`).

Results from 2026-10-26 to 2026-10-28:

- **Planner:** the builder passed more often without one (14/15 against 12/15) and cost about 30% less ($10.45 against $15.07). So the builder plans for itself, and the planner is only for work that needs several PRs or leaves the approach open.
- **Why plans hurt:** a planner split one issue into two stacked PRs, and in another run its plan hid a duty of the code it replaced. Builders without a plan read the code and saw that duty.
- **Reviewer:** it checked the PR against the plan, not the issue. Every failing run was approved with no blockers at the first review.
- **Builder model:** Opus cost 50–60% more than Sonnet for the same result. Haiku passed 3/9, cost no less per run than Sonnet, and took 2–4 times as long.
- **Decision rule:** every variant stopped and asked the owner, with or without a planner.
- **Scenarios:** only three replayed issues separated the variants, and in the later run only one did, so these results rest on few scenarios.
