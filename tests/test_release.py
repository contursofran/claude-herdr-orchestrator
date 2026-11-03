import json
import os
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "release.sh")

MANIFEST = """{
  "name": "herdr-agents",
  "version": "0.23.0",
  "dependencies": { "x": { "version": "9.9.9" } }
}
"""


def call(snippet, stdin=""):
    return subprocess.run(
        ["bash", "-c", f'source "{SCRIPT}"; {snippet}'], input=stdin, capture_output=True, text=True
    )


class Release(unittest.TestCase):
    def test_next_version(self):
        self.assertEqual(call("next_version 0.23.0 --minor").stdout, "0.24.0\n")
        self.assertEqual(call("next_version 0.23.4 --patch").stdout, "0.23.5\n")
        self.assertEqual(call("next_version 0.23.0 1.0.0").stdout, "1.0.0\n")
        self.assertNotEqual(call("next_version 0.23.0 banana").returncode, 0)

    def test_version_newer(self):
        self.assertEqual(call("version_newer 0.24.0 0.23.0").returncode, 0)
        self.assertEqual(call("version_newer 0.10.0 0.9.0").returncode, 0)
        self.assertNotEqual(call("version_newer 0.23.0 0.23.0").returncode, 0)
        self.assertNotEqual(call("version_newer 0.22.0 0.23.0").returncode, 0)

    def test_set_version_changes_only_the_first_version_field(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "plugin.json")
            with open(path, "w") as f:
                f.write(MANIFEST)
            self.assertEqual(call(f'current_version "{path}"').stdout, "0.23.0\n")
            self.assertEqual(call(f'set_version "{path}" 0.24.0').returncode, 0)
            with open(path) as f:
                self.assertEqual(f.read(), MANIFEST.replace('"0.23.0"', '"0.24.0"'))

    def test_format_notes_sorts_by_number_and_skips_version_prs(self):
        fixture = "320\tTests: stop git finding the repo\n318\tHold work from outside authors\n322\tVersion 0.23.0\n"
        out = call("format_notes", fixture).stdout
        self.assertEqual(out, "- Hold work from outside authors (#318)\n- Tests: stop git finding the repo (#320)\n")

    def test_dry_run_prints_the_steps_and_changes_nothing(self):
        # Fake gh and git so nothing touches the network or the checkout.
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "log")
            for name, body in {
                "gh": 'echo "gh $*" >> "$LOG"; printf "5\\tFix a thing\\n"',
                "git": 'echo "git $*" >> "$LOG"\n'
                'case "$1" in rev-parse) case "$2" in --abbrev-ref) echo main;; -q) exit 1;; *) echo abc;; esac;;'
                " tag) echo v0.23.0;; log) echo 100;; status) ;; esac",
            }.items():
                p = os.path.join(d, name)
                with open(p, "w") as f:
                    f.write("#!/bin/sh\n" + body + "\n")
                os.chmod(p, 0o755)
            env = {**os.environ, "PATH": f"{d}:{os.environ['PATH']}", "LOG": log}
            with open(os.path.join(ROOT, ".claude-plugin", "plugin.json")) as f:
                now = json.load(f)["version"]
            major, minor, _ = now.split(".")
            want = f"{major}.{int(minor) + 1}.0"
            r = subprocess.run([SCRIPT, "--minor", "--dry-run"], env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn(f"Releasing {want}", r.stdout)
            self.assertIn("- Fix a thing (#5)", r.stdout)
            self.assertIn(f"+ gh pr create --base main --title Version {want}", r.stdout)
            with open(log) as f:
                logged = f.read()
            self.assertNotIn("commit", logged)
            self.assertNotIn("push", logged)
            self.assertNotIn("pr create", logged)
            with open(os.path.join(ROOT, ".claude-plugin", "plugin.json")) as f:
                self.assertEqual(json.load(f)["version"], now)

    def finish(self, merged=True, dry_run=False, ancestor=True):
        """Runs --finish 0.24.0 with fake gh and git; returns the result and what they were asked."""
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "log")
            fakes = {
                "gh": 'echo "gh $*" >> "$LOG"\n'
                'case "$*" in *mergeCommit.oid*) if [ "$MERGED" = 1 ]; then echo MERGECOMMIT; fi;; '
                '*"pr list"*) if [ "$MERGED" = 1 ]; then echo "- Notes (#5)"; fi;; esac',
                "git": 'echo "git $*" >> "$LOG"\n'
                'case "$1" in rev-parse) case "$2" in --abbrev-ref) echo main;; -q) exit 1;; esac;;'
                " merge-base) [ \"$ANCESTOR\" = 1 ];; esac",
            }
            for name, body in fakes.items():
                path = os.path.join(d, name)
                with open(path, "w") as f:
                    f.write("#!/bin/sh\n" + body + "\n")
                os.chmod(path, 0o755)
            env = {
                **os.environ,
                "PATH": f"{d}:{os.environ['PATH']}",
                "LOG": log,
                "MERGED": "1" if merged else "0",
                "ANCESTOR": "1" if ancestor else "0",
            }
            args = [SCRIPT, "--finish", "0.24.0"] + (["--dry-run"] if dry_run else [])
            r = subprocess.run(args, env=env, capture_output=True, text=True)
            with open(log) as f:
                return r, f.read()

    def test_finish_tags_the_version_prs_merge_commit_not_head(self):
        r, logged = self.finish()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("git tag -a v0.24.0 -m Version 0.24.0 MERGECOMMIT", logged)
        self.assertIn("git push origin v0.24.0", logged)
        self.assertIn("gh release create v0.24.0", logged)
        self.assertNotIn("git pull", logged)

    def test_finish_refuses_when_the_version_pr_is_not_merged(self):
        r, logged = self.finish(merged=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("has not merged", r.stderr)
        self.assertNotIn("git tag", logged)
        self.assertNotIn("push", logged)

    def test_finish_refuses_a_merge_commit_that_is_not_on_origin_main(self):
        r, logged = self.finish(ancestor=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not on origin/main", r.stderr)
        self.assertNotIn("git tag", logged)

    def test_finish_dry_run_changes_nothing(self):
        r, logged = self.finish(dry_run=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("+ git tag -a v0.24.0 -m Version 0.24.0 MERGECOMMIT", r.stdout)
        for forbidden in ("git pull", "git tag", "git push", "release create"):
            self.assertNotIn(forbidden, logged)


if __name__ == "__main__":
    unittest.main()
