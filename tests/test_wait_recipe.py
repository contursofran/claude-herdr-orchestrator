"""The CI recipe the report rule gives for WAIT.json, run with a fake gh and the same jq filter."""

import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FAKE_GH = """#!/bin/sh
# Stands in for `gh pr view 123 --json mergeable --jq FILTER` and `gh pr checks 123 --json bucket --jq FILTER`;
# anything else is an error. Like gh, --jq prints a string without quotes.
call="$1 $2 $3"
while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && filter=$2; shift; done
case "$call" in
"pr view 123")
  [ -n "$FAKE_GH_VIEW_ERROR" ] && { echo "$FAKE_GH_VIEW_ERROR" >&2; exit 1; }
  printf '{"mergeable":"%s"}' "$FAKE_GH_MERGEABLE" | jq -r "$filter"
  ;;
"pr checks 123")
  [ -n "$FAKE_GH_ERROR" ] && { echo "$FAKE_GH_ERROR" >&2; exit 1; }
  printf '%s' "$FAKE_GH_CHECKS" | jq -r "$filter"
  ;;
*) echo "wrong call: $call" >&2; exit 2 ;;
esac
"""


def recipe():
    """The example's check, as a worker gets it after reading WAIT.json."""
    with open(os.path.join(REPO, "hooks", "workers.ts"), encoding="utf-8") as f:
        line = next(line for line in f if '"CI on PR #123"' in line)
    example = line[line.index('{"for"') : line.rindex("}") + 1]
    return json.loads(example.replace("\\\\", "\\"))["check"]


@unittest.skipUnless(shutil.which("jq"), "needs jq")
class WaitRecipeTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        gh = os.path.join(folder.name, "gh")
        with open(gh, "w", encoding="utf-8") as f:
            f.write(FAKE_GH)
        os.chmod(gh, os.stat(gh).st_mode | stat.S_IEXEC)
        self.path = f"{folder.name}{os.pathsep}{os.environ['PATH']}"

    def exit_code(self, *buckets, error="", mergeable="MERGEABLE", view_error=""):
        checks = json.dumps([{"bucket": b} for b in buckets])
        env = {
            **os.environ,
            "PATH": self.path,
            "FAKE_GH_CHECKS": checks,
            "FAKE_GH_ERROR": error,
            "FAKE_GH_MERGEABLE": mergeable,
            "FAKE_GH_VIEW_ERROR": view_error,
        }
        return subprocess.run(["/bin/bash", "-c", recipe()], env=env, capture_output=True).returncode

    def test_ready_once_every_check_passed(self):
        self.assertEqual(self.exit_code("pass", "skipping"), 0)

    def test_a_failed_or_cancelled_ci_is_ready_so_it_wakes_the_worker(self):
        self.assertEqual(self.exit_code("fail", "pass"), 0)
        self.assertEqual(self.exit_code("cancel"), 0)

    def test_not_ready_while_any_check_is_pending_even_after_a_failure(self):
        self.assertNotEqual(self.exit_code("pending"), 0)
        self.assertNotEqual(self.exit_code("fail", "pending", "pass"), 0)

    def test_not_ready_before_any_check_has_registered(self):
        self.assertNotEqual(self.exit_code(), 0)
        self.assertNotEqual(self.exit_code(error="no checks reported on the 'x' branch"), 0)

    def test_a_conflicting_pr_is_ready_at_once_as_github_runs_no_ci_on_it(self):
        self.assertEqual(self.exit_code(mergeable="CONFLICTING"), 0)
        self.assertEqual(self.exit_code(mergeable="CONFLICTING", error="no checks reported on the 'x' branch"), 0)
        self.assertEqual(self.exit_code("pending", mergeable="CONFLICTING"), 0)

    def test_unknown_mergeable_keeps_waiting_on_the_checks(self):
        self.assertNotEqual(self.exit_code(mergeable="UNKNOWN"), 0)
        self.assertNotEqual(self.exit_code("pending", mergeable="UNKNOWN"), 0)
        self.assertEqual(self.exit_code("pass", mergeable="UNKNOWN"), 0)

    def test_a_failing_pr_view_falls_back_to_the_checks(self):
        self.assertNotEqual(self.exit_code("pending", view_error="HTTP 502"), 0)
        self.assertEqual(self.exit_code("pass", view_error="HTTP 502"), 0)

    def test_the_check_names_the_same_pr_as_the_for_text(self):
        self.assertRegex(recipe(), re.compile(r"^gh pr view 123 .* \|\| gh pr checks 123 "))


if __name__ == "__main__":
    unittest.main()
