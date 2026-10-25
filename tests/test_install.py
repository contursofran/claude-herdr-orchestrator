"""install.sh, run from this clone into a temporary CLAUDE_CONFIG_DIR: the clone it ran from is recorded in the mod, and what it prints.

Run: python3 -m unittest discover -s tests -p 'test_*.py'
"""

import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CLONE = os.path.abspath(os.path.join(HERE, ".."))
INSTALL = os.path.join(CLONE, "install.sh")


class Install(unittest.TestCase):
    def setUp(self):
        self.config = tempfile.mkdtemp(prefix="hrd-install-test-")
        self.addCleanup(shutil.rmtree, self.config, True)

    def install(self):
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.config)
        return subprocess.run([INSTALL], capture_output=True, text=True, env=env, check=True)

    def recorded(self):
        with open(os.path.join(self.config, "mods", "herdr-agents", "clone")) as f:
            return f.read()

    def test_the_clone_is_recorded_at_the_top_of_the_installed_mod(self):
        self.install()
        self.assertEqual(self.recorded(), CLONE + "\n")

    def test_a_second_install_keeps_the_record(self):
        # The mod's hooks, types and agents folders are rsynced with --delete; the record sits beside them.
        self.install()
        self.install()
        self.assertEqual(self.recorded(), CLONE + "\n")

    def test_the_last_line_no_longer_asks_for_a_restart(self):
        last = self.install().stdout.strip().splitlines()[-1]
        self.assertEqual(last, f"Installed herdr-agents into {self.config}.")


if __name__ == "__main__":
    unittest.main()
