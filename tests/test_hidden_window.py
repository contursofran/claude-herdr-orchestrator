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
import tempfile
import unittest

SCRIPT = os.path.join(isolation.ROOT, "scripts", "herdr-hidden-window.sh")
NAME = "t348x"
DIR = f"/private/tmp/hw-{NAME}"


class FakeWindow(unittest.TestCase):
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


@unittest.skipUnless(sys.platform == "darwin", "the script is macOS only")
class HiddenWindowTimeouts(FakeWindow):
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


@unittest.skipUnless(sys.platform == "darwin", "the script is macOS only")
class HiddenWindowSmoke(FakeWindow):
    """`smoke` against stubs: the window is "already running" (HERDR_SMOKE_USE_RUNNING), so start is skipped."""

    def setUp(self):
        super().setUp()
        self.out = tempfile.mkdtemp(prefix="smoke-out-")
        self.addCleanup(shutil.rmtree, self.out, True)
        os.makedirs(f"{DIR}/app", exist_ok=True)
        self.status = '{"errors":[]}'
        self.shot = 'echo png >"$2"'
        self.write_stubs()

    def write_stubs(self):
        self.stub(
            "herdr-app",
            f"""case "$1" in
status) echo '{self.status}' ;;
shot) {self.shot} ;;
do) [ "$2" = space.new ] && echo '{{"space":"s1"}}'; exit 0 ;;
esac""",
        )
        self.stub("hc", """[ "$1" = ls ] && echo '{"terminals":[{"agent":"claude","address":"t1"}]}'; exit 0""")

    def smoke(self, **env):
        self.write_stubs()
        return self.run_script(
            "smoke",
            timeout=20,
            HERDR_SMOKE_USE_RUNNING="1",
            HERDR_SMOKE_SETTLE="0",
            HERDR_SMOKE_OUT=self.out,
            **env,
        )

    def test_smoke_passes_and_leaves_shots(self):
        r = self.smoke()
        self.assertEqual(r.returncode, 0, r.stderr)
        for f in ("01-strip.png", "02-board.png", "03-sheet.png", "04-arrivals.png", "status-strip.json"):
            self.assertTrue(os.path.getsize(os.path.join(self.out, f)) > 0, f)
        self.assertFalse(os.path.exists(DIR))

    def test_smoke_fails_on_status_error(self):
        self.status = '{"errors":["x"]}'
        r = self.smoke()
        self.assertEqual(r.returncode, 1)
        self.assertIn('smoke: status error: ["x"]', r.stderr)
        self.assertFalse(os.path.exists(DIR))

    def test_smoke_fails_on_draw_failed(self):
        with open(f"{DIR}/app/shared.json", "w") as f:
            f.write('{"hrd.drawFailed.strip":"boom"}')
        r = self.smoke()
        self.assertEqual(r.returncode, 1)
        self.assertIn("smoke: draw failed: hrd.drawFailed.strip=boom", r.stderr)

    def test_smoke_fails_when_a_shot_is_missing(self):
        self.shot = "exit 0"
        r = self.smoke()
        self.assertEqual(r.returncode, 1)
        self.assertIn("smoke: strip failed: no shot", r.stderr)

    def test_smoke_keeps_the_logs_of_a_failed_run(self):
        self.status = '{"errors":["x"]}'
        with open(f"{DIR}/app.log", "w") as f:
            f.write("log line\n")
        self.smoke()
        self.assertTrue(os.path.exists(os.path.join(self.out, "app.log")))

    def test_smoke_watchdog(self):
        self.shot = "exec sleep 600"
        r = self.smoke(HERDR_SMOKE_TIMEOUT="3")
        self.assertEqual(r.returncode, 124)
        self.assertIn("smoke: timed out after 3s", r.stderr)
        self.assertFalse(os.path.exists(DIR))

    def test_bad_smoke_timeout_is_refused(self):
        r = self.smoke(HERDR_SMOKE_TIMEOUT="abc")
        self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
