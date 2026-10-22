## Working with agents

Workers (planner, builder, reviewer) and the coordinator read this section. Fill in each line for this repo.

- **Base branch:** `main`. Branch names: `issue-<n>-<short-slug>`.
- **While working:** the fast checks, e.g. `npm run lint && npm test -- --changed`. Never the full suite in a loop.
- **Before a PR is ready:** the full check, e.g. `npm run validate`, once, on the final result.
- **Updating a branch:** merge the base branch in (or: rebase and `--force-with-lease` your own branch only).
- **Commits and PRs:** the author identity, e.g. `Your Name <you@example.com>`; Conventional Commits; what the PR body holds (what changed, how it was verified, what was not).
- **Merging:** who merges, e.g. "any ready PR merges once its checks are green" or "only the owner merges".
- **Ask the owner first:** e.g. releases, deploys, schema or API changes, deleting data, product or design choices.
- **Heavy jobs:** where long builds or test stacks run, e.g. "let CI run them".
