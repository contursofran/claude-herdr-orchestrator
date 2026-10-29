import os
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoEmittedJs(unittest.TestCase):
    def test_no_tsc_output_is_tracked(self):
        """.gitignore hides hooks/*.js and tests/*.js, but a force-added file would pass: tsc writes them by mistake."""
        ran = subprocess.run(
            ["git", "ls-files", "hooks/*.js", "tests/*.js", "view/hooks/*.js"], cwd=ROOT, capture_output=True, text=True
        )
        self.assertEqual(ran.returncode, 0, ran.stderr)
        self.assertEqual(ran.stdout.split(), [])


if __name__ == "__main__":
    unittest.main()
