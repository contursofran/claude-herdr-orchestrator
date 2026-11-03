"""scripts/herdr-hidden-window.sh: demo and stop can't hang on an app or core that never answers.

A fake window folder stands in for the real one: `sleep` is the app's binary (so the script sees it
running) and herdr-app and hc are shell stubs. Mac only, like the script.
"""

import isolation  # noqa: F401  (must be first)

import os
import shutil
import signal
import subprocess
import sys
import unittest

SCRIPT = os.path.join(isolation.ROOT, "scripts", "herdr-hidden-window.sh")
NAME = "t348x"
DIR = f"/private/tmp/hw-{NAME}"


@unittest.skipUnless(sys.platform == "darwin", "the script is macOS only")
class HiddenWindowTimeouts(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(DIR, ignore_errors=True)
        os.makedirs(f"{DIR}/Herdr.app/Contents/MacOS")
        os.makedirs(f"{DIR}/bin")
        os.makedirs(f"{DIR}/home")
        binary = f"{DIR}/Herdr.app/Contents/MacOS/Herdr"
        # A copy of a system binary is killed by macOS, so the stand-in is compiled here.
        src = f"{DIR}/sleeper.c"
        with open(src, "w") as f:
            f.write("#include <unistd.h>\nint main(void) { sleep(600); return 0; }\n")
        subprocess.run(["clang", "-o", binary, src], check=True)
        self.proc = subprocess.Popen([binary])
        with open(f"{DIR}/pid", "w") as f:
            f.write(str(self.proc.pid))
        self.addCleanup(self.cleanup)

    def cleanup(self):
        try:
            self.proc.kill()
        except OSError:
            pass
        self.proc.wait()
        shutil.rmtree(DIR, ignore_errors=True)
        shutil.rmtree(DIR + ".lock", ignore_errors=True)

    def stub(self, name, body):
        path = f"{DIR}/bin/{name}"
        with open(path, "w") as f:
            f.write("#!/bin/sh\n" + body + "\n")
        os.chmod(path, 0o755)

    def run_script(self, *args, timeout=10, **env):
        full = dict(os.environ, HERDR_HIDDEN_NAME=NAME, **env)
        return subprocess.run(
            ["bash", SCRIPT, *args], capture_output=True, text=True, timeout=timeout, env=full
        )

    def test_demo_times_out_when_the_app_never_answers(self):
        self.stub("herdr-app", "exec sleep 600")
        self.stub("hc", "exit 0")
        r = self.run_script("demo", HERDR_HIDDEN_CALL_TIMEOUT="2")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Timed out after 2s: herdr-app do space.new", r.stderr)

    def test_stop_finishes_when_the_core_never_answers(self):
        self.stub("herdr-app", "exit 0")
        self.stub("hc", "exec sleep 600")
        r = self.run_script("stop", HERDR_HIDDEN_CALL_TIMEOUT="2")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(os.path.exists(DIR))

    def test_demo_says_when_no_agent_started(self):
        self.stub("herdr-app", """echo '{"space":"s1"}'""")
        self.stub("hc", """[ "$1" = ls ] && echo '{"terminals":[]}'; exit 0""")
        r = self.run_script("demo", HERDR_HIDDEN_CALL_TIMEOUT="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("The fake coordinator didn't start", r.stderr)

    def test_demo_says_when_no_space_came_back(self):
        self.stub("herdr-app", "echo '{}'")
        self.stub("hc", "exit 0")
        r = self.run_script("demo", HERDR_HIDDEN_CALL_TIMEOUT="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("space.new gave no space", r.stderr)

    def test_bad_call_timeout_is_refused(self):
        for value in ("abc", "0"):
            r = self.run_script("demo", HERDR_HIDDEN_CALL_TIMEOUT=value)
            self.assertEqual(r.returncode, 2, value)
            self.assertIn("HERDR_HIDDEN_CALL_TIMEOUT", r.stderr)


if __name__ == "__main__":
    unittest.main()
