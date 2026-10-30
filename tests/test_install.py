"""install.sh, run from this clone into a temporary CLAUDE_CONFIG_DIR: the clone it ran from is recorded in the mod, and what it prints.

Run: python3 -m unittest discover -s tests -p 'test_*.py'
"""

import json
import os
import shutil
import subprocess
import tempfile
import time
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
        self.assertEqual([c["id"] for c in card], ["hrd-card"])
        self.assertEqual((card[0]["edge"], card[0]["align"]), ("bottom", "center"))
        self.assertTrue(os.path.isfile(os.path.join(self.app, "mods", "herdr-agents", "main.js")))

    def test_an_install_from_a_checkout_dated_differently_writes_no_mod_file(self):
        # The app hot-reloads the mod on any write there, so a file that did not change must stay untouched (#158).
        os.makedirs(self.app)
        self.install()
        mod = os.path.join(self.app, "mods", "herdr-agents")
        main = os.path.join(mod, "main.js")
        os.utime(main, (1000000000, 1000000000))
        before = os.stat(main)
        time.sleep(1.1)  # st_ctime has whole seconds here
        self.install()
        after = os.stat(main)
        # ctime too: a chmod to the same mode (rsync -p) changes nothing else, and still wakes the app's watcher.
        self.assertEqual((after.st_ino, after.st_mtime, after.st_ctime), (before.st_ino, before.st_mtime, before.st_ctime))

    def test_an_install_writes_a_mod_file_that_changed_and_removes_one_that_went(self):
        os.makedirs(self.app)
        self.install()
        mod = os.path.join(self.app, "mods", "herdr-agents")
        main = os.path.join(mod, "main.js")
        with open(main, encoding="utf-8") as f:
            shipped = f.read()
        with open(main, "w", encoding="utf-8") as f:
            f.write("// an older version\n")
        with open(os.path.join(mod, "gone.js"), "w", encoding="utf-8") as f:
            f.write("// no longer shipped\n")
        self.install()
        with open(main, encoding="utf-8") as f:
            self.assertEqual(f.read(), shipped)
        self.assertFalse(os.path.exists(os.path.join(mod, "gone.js")))

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
