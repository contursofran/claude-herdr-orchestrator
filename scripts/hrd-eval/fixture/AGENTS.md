# Working with agents

Workers (planner, builder, reviewer) and the coordinator read this section.

- **Base branch:** `main`. Branch names: `issue-<n>-<short-slug>`.
- **While working:** `python3 -m unittest discover -s tests -p 'test_*.py'`. It takes about a second.
- **Before a PR is ready:** the same command, once, on the final result.
- **Updating a branch:** merge the base branch in.
- **Commits and PRs:** Conventional Commits. The PR body says what changed, how it was verified, and what was not.
- **Changelog:** add a line under "Unreleased" in `CHANGELOG.md` for each change a shopper or the owner would notice.
- **Merging:** only the owner merges.
- **Ask the owner first:** prices, discounts and other product rules; anything the issue leaves open that changes what a shopper pays.
- **Heavy jobs:** none here.
