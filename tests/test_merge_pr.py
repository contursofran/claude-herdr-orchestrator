"""scripts/merge-pr.sh and scripts/window-errors.sh, run with a fake gh, git, install and herdr-app on PATH."""

import isolation  # noqa: F401  (temp HOME and git ceiling, see tests/isolation.py)
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MERGE = os.path.join(ROOT, "scripts", "merge-pr.sh")
WINDOW = os.path.join(ROOT, "scripts", "window-errors.sh")

# Answers `gh pr checks` from the files $FAKE/checks.1, checks.2 ...: the nth look gets the nth file, the last one repeats.
# Like the real gh: a file starting with "!" is an error message on stderr with exit 1 and no output (no checks yet);
# failing checks print their JSON and exit 1, pending ones exit 8.
FAKE_GH = """#!/bin/sh
echo "gh $*" >> "$FAKE/log"
if [ "$1 $2" = "pr checks" ]; then
  n=$(cat "$FAKE/looks" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$FAKE/looks"
  f="$FAKE/checks.$n"; [ -f "$f" ] || f=$(ls "$FAKE"/checks.* | sort | tail -1)
  case "$(cat "$f")" in
    "!"*) tail -c +2 "$f" >&2; exit 1 ;;
  esac
  cat "$f"
  grep -q '"bucket":"fail"' "$f" && exit 1
  grep -q '"bucket":"pending"' "$f" && exit 8
  exit 0
fi
"""
FAKE_GIT = """#!/bin/sh
echo "git $*" >> "$FAKE/log"
case "$*" in
  "rev-parse --abbrev-ref HEAD") echo "${FAKE_BRANCH:-main}" ;;
esac
"""
FAKE_INSTALL = """#!/bin/sh
echo "install" >> "$FAKE/log"
echo "Window: no errors."
"""

NO_CHECKS = "!no checks reported on the 'feature' branch"
PASS = '[{"name":"test","bucket":"pass"},{"name":"lint","bucket":"skipping"}]'
PENDING = '[{"name":"test","bucket":"pending"}]'
FAIL = '[{"name":"test","bucket":"pass"},{"name":"lint","bucket":"fail"}]'


class MergePr(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="hrd-merge-test-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        for name, body in (("gh", FAKE_GH), ("git", FAKE_GIT), ("install", FAKE_INSTALL)):
            with open(os.path.join(self.dir, name), "w") as f:
                f.write(body)
            os.chmod(os.path.join(self.dir, name), 0o755)

    def checks(self, *looks):
        for i, text in enumerate(looks, 1):
            with open(os.path.join(self.dir, f"checks.{i}"), "w") as f:
                f.write(text)

    def run_merge(self, *args, branch="main", extra=None):
        env = dict(
            os.environ,
            FAKE=self.dir,
            FAKE_BRANCH=branch,
            PATH=self.dir + os.pathsep + os.environ["PATH"],
            MERGE_PR_EVERY="0",
            MERGE_PR_MAX="3",
            MERGE_PR_INSTALL=os.path.join(self.dir, "install"),
        )
        env.update(extra or {})
        return subprocess.run([MERGE, *args], capture_output=True, text=True, env=env, timeout=20)

    def log(self):
        path = os.path.join(self.dir, "log")
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return f.read().splitlines()

    def test_merges_then_pulls_then_installs_and_prints_the_window_errors(self):
        self.checks(PASS)
        ran = self.run_merge("12")
        self.assertEqual(ran.returncode, 0, ran.stderr)
        self.assertEqual(
            [l for l in self.log() if not l.startswith(("gh pr checks", "git rev-parse"))],
            ['gh pr merge 12 --squash --body  --delete-branch', "git pull --ff-only origin main", "install"],
        )
        self.assertIn("Window: no errors.", ran.stdout)

    def test_waits_while_there_are_no_checks_or_they_run(self):
        self.checks(NO_CHECKS, "[]", PENDING, PASS)
        ran = self.run_merge("12", extra={"MERGE_PR_MAX": "10"})
        self.assertEqual(ran.returncode, 0, ran.stderr)
        self.assertEqual(len([l for l in self.log() if l.startswith("gh pr checks")]), 4)
        self.assertTrue(any(l.startswith("gh pr merge") for l in self.log()))

    def test_no_checks_reported_yet_is_a_wait_never_a_pass_or_a_failure(self):
        self.checks(NO_CHECKS)
        ran = self.run_merge("12", extra={"MERGE_PR_MAX": "0"})
        self.assertNotEqual(ran.returncode, 0)
        self.assertIn("still none", ran.stderr)
        self.assertFalse(any(l.startswith("gh pr merge") for l in self.log()))

    def test_gives_up_after_the_timeout_when_no_checks_ever_register(self):
        self.checks(NO_CHECKS)
        ran = self.run_merge("12", extra={"MERGE_PR_EVERY": "1", "MERGE_PR_MAX": "2"})
        self.assertNotEqual(ran.returncode, 0)
        self.assertEqual(len([l for l in self.log() if l.startswith("gh pr checks")]), 3)

    def test_another_gh_error_stops_the_script(self):
        self.checks("!HTTP 502")
        ran = self.run_merge("12")
        self.assertNotEqual(ran.returncode, 0)
        self.assertIn("could not read the checks", ran.stderr)
        self.assertFalse(any(l.startswith("gh pr merge") for l in self.log()))

    def test_refuses_when_a_check_failed_and_merges_nothing(self):
        self.checks(FAIL)
        ran = self.run_merge("12")
        self.assertNotEqual(ran.returncode, 0)
        self.assertIn("failing checks (lint)", ran.stderr)
        self.assertFalse(any(l.startswith(("gh pr merge", "git pull", "install")) for l in self.log()))

    def test_a_failed_check_stops_the_wait_before_the_others_finish(self):
        self.checks('[{"name":"a","bucket":"fail"},{"name":"b","bucket":"pending"}]')
        ran = self.run_merge("12")
        self.assertNotEqual(ran.returncode, 0)
        self.assertIn("failing checks (a)", ran.stderr)

    def test_gives_up_when_the_checks_never_finish(self):
        self.checks(PENDING)
        ran = self.run_merge("12", extra={"MERGE_PR_MAX": "0"})
        self.assertNotEqual(ran.returncode, 0)
        self.assertIn("still pending", ran.stderr)
        self.assertFalse(any(l.startswith("gh pr merge") for l in self.log()))

    def test_dry_run_reads_the_checks_but_changes_nothing(self):
        self.checks(PASS)
        ran = self.run_merge("12", "--dry-run")
        self.assertEqual(ran.returncode, 0, ran.stderr)
        self.assertIn("+ gh pr merge 12 --squash --body  --delete-branch", ran.stdout)
        self.assertIn("+ git pull --ff-only origin main", ran.stdout)
        self.assertFalse(any(l.startswith(("gh pr merge", "git pull", "install")) for l in self.log()))

    def test_dry_run_still_refuses_failing_checks(self):
        self.checks(FAIL)
        self.assertNotEqual(self.run_merge("12", "--dry-run").returncode, 0)

    def test_needs_a_pr_number_and_the_main_branch(self):
        self.assertNotEqual(self.run_merge().returncode, 0)
        self.assertNotEqual(self.run_merge("abc").returncode, 0)
        self.checks(PASS)
        ran = self.run_merge("12", branch="feature")
        self.assertNotEqual(ran.returncode, 0)
        self.assertIn("main branch", ran.stderr)
        self.assertFalse(any(l.startswith("gh") for l in self.log()))


class WindowErrors(unittest.TestCase):
    def run_script(self, app_body):
        d = tempfile.mkdtemp(prefix="hrd-window-test-")
        self.addCleanup(shutil.rmtree, d, True)
        if app_body is not None:
            path = os.path.join(d, "herdr-app")
            with open(path, "w") as f:
                f.write("#!/bin/sh\n" + app_body + "\n")
            os.chmod(path, 0o755)
        # Only the fake's folder and the system tools node needs: no real herdr-app can be found.
        node = os.path.dirname(shutil.which("node"))
        env = dict(os.environ, PATH=os.pathsep.join([d, node, "/usr/bin", "/bin"]))
        return subprocess.run([WINDOW], capture_output=True, text=True, env=env, timeout=20)

    def test_prints_each_error(self):
        ran = self.run_script("""echo '{"errors":["a","b"]}'""")
        self.assertEqual(ran.stdout.splitlines(), ["Window errors (2):", "- a", "- b"])

    def test_says_nothing_without_the_app(self):
        ran = self.run_script(None)
        self.assertEqual((ran.returncode, ran.stdout), (0, ""))

    def test_says_nothing_when_the_app_is_not_running_or_answers_junk(self):
        self.assertEqual(self.run_script("exit 1").stdout, "")
        self.assertEqual(self.run_script("echo not json").stdout, "")


if __name__ == "__main__":
    unittest.main()
