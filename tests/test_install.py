"""install.sh, run from this clone into a temporary CLAUDE_CONFIG_DIR: the clone it ran from is recorded in the mod, and what it prints.

Run: python3 -m unittest discover -s tests -p 'test_*.py'
"""

import json
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
        self.app = os.path.join(self.config, "no-app")

    def install(self):
        # No app home unless a test makes one: install.sh must not touch the real Herdr app.
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.config, HERDR_APP_HOME=self.app)
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

    def test_the_last_line_asks_only_new_sessions_to_load_a_first_install(self):
        last = self.install().stdout.strip().splitlines()[-1]
        self.assertEqual(
            last,
            f"Installed herdr-agents into {self.config}. A first install loads in sessions started from now on;"
            " running sessions reload updates by themselves.",
        )

    def test_without_the_app_nothing_of_it_is_made(self):
        self.install()
        self.assertFalse(os.path.exists(self.app))

    def test_with_the_app_the_mod_and_a_coordinator_layout_land_and_main_stays(self):
        os.makedirs(os.path.join(self.app, "layouts"))
        main = {"id": "root", "children": [{"id": "work", "children": [{"id": "tabs"}, {"id": "work-body", "children": [{"id": "main"}]}]}]}
        with open(os.path.join(self.app, "layouts", "main.json"), "w") as f:
            json.dump(main, f)
        self.install()
        self.install()  # a second run leaves the layout and the keys as they are
        with open(os.path.join(self.app, "layouts", "main.json")) as f:
            self.assertEqual(json.load(f), main)
        with open(os.path.join(self.app, "layouts", "coordinator.json")) as f:
            work = json.load(f)["children"][0]["children"]
        self.assertEqual([c["id"] for c in work], ["tabs", "hrd-pins", "work-body", "hrd-strip"])
        card = work[2]["children"][0]["floating"]
        self.assertEqual([c["id"] for c in card], ["hrd-card", "hrd-sheet"])
        self.assertEqual((card[0]["edge"], card[0]["align"]), ("bottom", "center"))
        self.assertTrue(os.path.isfile(os.path.join(self.app, "mods", "herdr-agents", "main.js")))

    def version_file(self):
        return os.path.join(self.app, "mods", "herdr-agents", "version.json")

    def plugin_version(self):
        with open(os.path.join(CLONE, ".claude-plugin", "plugin.json")) as f:
            return json.load(f)["version"]

    def test_with_the_app_the_install_writes_the_version_and_commit_into_the_installed_mod_only(self):
        os.makedirs(self.app)
        self.install()
        commit = subprocess.run(["git", "-C", CLONE, "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        with open(self.version_file()) as f:
            self.assertEqual(json.load(f), {"version": self.plugin_version(), "commit": commit})
        self.assertFalse(os.path.exists(os.path.join(CLONE, "app", "mods", "herdr-agents", "version.json")))

    def test_a_second_install_leaves_an_unchanged_version_file_alone(self):
        # Any file written in a mod folder reloads every copy of the mod.
        os.makedirs(self.app)
        self.install()
        before = os.stat(self.version_file())
        self.install()
        after = os.stat(self.version_file())
        self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns))

    def test_a_stale_version_file_is_replaced(self):
        os.makedirs(os.path.join(self.app, "mods", "herdr-agents"))
        with open(self.version_file(), "w") as f:
            f.write('{"version":"0.0.0"}')
        self.install()
        with open(self.version_file()) as f:
            self.assertEqual(json.load(f)["version"], self.plugin_version())

    def test_without_git_the_version_file_has_no_commit(self):
        os.makedirs(self.app)
        copy = os.path.join(self.config, "clone")
        shutil.copytree(CLONE, copy, ignore=shutil.ignore_patterns(".git", "node_modules", ".herdr-agents"))
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.config, HERDR_APP_HOME=self.app)
        subprocess.run([os.path.join(copy, "install.sh")], capture_output=True, text=True, env=env, check=True)
        with open(self.version_file()) as f:
            self.assertEqual(json.load(f), {"version": self.plugin_version()})

    def test_a_missing_or_odd_main_layout_prints_a_message_and_the_install_carries_on(self):
        os.makedirs(os.path.join(self.app, "layouts"))
        for content in (None, '{"id": "root", "children": []}'):
            main = os.path.join(self.app, "layouts", "main.json")
            if content is None:
                if os.path.exists(main):
                    os.remove(main)
            else:
                with open(main, "w") as f:
                    f.write(content)
            done = self.install()  # check=True: a failing install.sh raises
            self.assertIn('Layout "coordinator" not made', done.stdout)
            self.assertTrue(done.stdout.strip().endswith("running sessions reload updates by themselves."))
            self.assertFalse(os.path.exists(os.path.join(self.app, "layouts", "coordinator.json")))


if __name__ == "__main__":
    unittest.main()
