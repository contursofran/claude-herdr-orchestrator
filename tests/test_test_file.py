import os
import stat
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "test-file.sh")
# Stands for `claude plugin test <dir>`: lists the tests and the mod's files it was given, reports its priority, and exits 7.
FAKE_CLAUDE = """#!/bin/sh
cd "$3" || exit 1
find . -name '*.test.ts*' | sort
ls hooks/hooks.json tests/harness.tsx .claude-plugin/plugin.json
echo "niceness=$(ps -o nice= -p $$ | tr -d ' ')"
exit 7
"""


class TestFile(unittest.TestCase):
    def run_script(self, *args):
        return self.run_with_fake_claude([SCRIPT, *args])

    def run_with_fake_claude(self, command):
        with tempfile.TemporaryDirectory() as bin_dir:
            fake = os.path.join(bin_dir, "claude")
            with open(fake, "w") as f:
                f.write(FAKE_CLAUDE)
            os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
            env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}
            return subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True)

    def test_the_runner_gets_only_the_named_tests_and_the_mod(self):
        ran = self.run_script("tests/bridge.test.tsx", "tests/ci.test.ts")
        lines = ran.stdout.split()
        self.assertEqual([l for l in lines if ".test." in l], ["./tests/bridge.test.tsx", "./tests/ci.test.ts"])
        self.assertIn("hooks/hooks.json", lines)
        self.assertIn("tests/harness.tsx", lines)
        self.assertIn(".claude-plugin/plugin.json", lines)

    def test_the_runner_exit_code_comes_through(self):
        self.assertEqual(self.run_script("tests/ci.test.ts").returncode, 7)

    def test_the_runner_runs_at_low_priority(self):
        expected = min(os.nice(0) + 10, 19)
        self.assertIn(f"niceness={expected}", self.run_script("tests/ci.test.ts").stdout.split())

    def test_npm_test_runs_at_low_priority_and_keeps_the_exit_code(self):
        ran = self.run_with_fake_claude(["npm", "test"])
        self.assertIn(f"niceness={min(os.nice(0) + 10, 19)}", ran.stdout.split())
        self.assertEqual(ran.returncode, 7)

    def test_a_full_path_works_too(self):
        ran = self.run_script(os.path.join(ROOT, "tests", "ci.test.ts"))
        self.assertEqual([l for l in ran.stdout.split() if ".test." in l], ["./tests/ci.test.ts"])

    def test_a_missing_file_or_none_stops_before_the_runner(self):
        for args in (["tests/nope.test.tsx"], []):
            ran = self.run_script(*args)
            self.assertEqual(ran.returncode, 2, args)
            self.assertEqual(ran.stdout, "", args)


if __name__ == "__main__":
    unittest.main()
