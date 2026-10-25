"""Tests for scripts/hrd-eval.py, the eval runner (issue #28, slice S1b). No model is called: a fake claude stands in
for `claude -p`. It records each call (argv, cwd, the files there, whether `gh` resolved to the shim), writes a session
transcript with a known cost, makes the commits and PRs its prompt asks for, and writes RESULT.md with the prompt's token.
The commands that really run are git, the gh shim and the runner itself.
Run: python3 -m unittest discover -s tests -p 'test_*.py' -v
"""

import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNNER = os.path.join(REPO, "scripts", "hrd-eval.py")
ARMS = os.path.join(REPO, "scripts", "hrd-eval", "arms")
SHIM_BIN = os.path.join(REPO, "scripts", "hrd-eval", "bin")
WORKERS_TS = os.path.join(REPO, "hooks", "workers.ts")

spec = importlib.util.spec_from_file_location("hrd_eval", RUNNER)
HR = importlib.util.module_from_spec(spec)
spec.loader.exec_module(HR)

GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@t"]

OWN_TEST = (
    "import unittest\nfrom shop import TOTAL\n\n\nclass OwnTest(unittest.TestCase):\n"
    "    def test_own(self):\n        self.assertIn(TOTAL, (0, 5))\n"
)
HIDDEN_TEST = (
    "import unittest\nfrom shop import TOTAL\n\n\nclass HiddenTest(unittest.TestCase):\n"
    "    def test_hidden(self):\n        self.assertEqual(TOTAL, 5)\n"
)
# A grader that prints plugin-test rows: the "hidden test" row only exists once tests/test_hidden.py does.
STUB = """import os, sys
sys.path.insert(0, os.getcwd())
import shop
rows = [("pass", "own test")]
if os.path.exists(os.path.join("tests", "test_hidden.py")):
    rows.append(("pass" if shop.TOTAL == 5 else "fail", "hidden test"))
for state, name in rows:
    print(f"({state}) {name} [1.0ms]")
print(f" {sum(s == 'pass' for s, _ in rows)} pass")
print(f" {sum(s == 'fail' for s, _ in rows)} fail")
sys.exit(1 if any(s == "fail" for s, _ in rows) else 0)
"""

# The fake claude. Behaviour per call comes from FAKE_CLAUDE_SCRIPT, one entry per call of that kind (the last repeats).
FAKE = r"""#!__PYTHON__
import json, os, re, shutil, subprocess, sys, time, uuid
from datetime import datetime, timezone

argv = sys.argv[1:]
prompt = sys.stdin.read()
KINDS = (("Plan issue", "plan"), ("Build issue", "build"), ("Review PR", "review"), ("Fix round", "fix"),
         ("Re-review PR", "rereview"), ("Answers to your DECISION", "answer"))
kind = next(k for start, k in KINDS if prompt.startswith(start))
resumed = "--resume" in argv
sid = argv[argv.index("--resume") + 1] if resumed else argv[argv.index("--session-id") + 1]
model_arg = argv[argv.index("--model") + 1]
cfg_dir = os.environ["CLAUDE_CONFIG_DIR"]
state_path = os.path.join(cfg_dir, "fake-state.json")
state = json.load(open(state_path)) if os.path.exists(state_path) else {"counts": {}, "cost": {}}
script = json.load(open(os.environ["FAKE_CLAUDE_SCRIPT"]))
count = state["counts"].get(kind, 0)
state["counts"][kind] = count + 1
cwd = os.getcwd()
by_dir = script.get("by_dir", {}).get(os.path.basename(cwd), {}).get(kind)
beh = by_dir if by_dir is not None else script[kind][min(count, len(script[kind]) - 1)]
job = re.search(r"write your final report to (\S+)/RESULT\.md", prompt).group(1)
token = re.search(r"<!-- report (\w+) -->", prompt).group(1)
files = []
for root, dirs, names in os.walk(cwd):
    dirs[:] = [d for d in dirs if d != ".git"]
    files += [os.path.relpath(os.path.join(root, n), cwd) for n in names]
with open(os.environ["FAKE_CLAUDE_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"kind": kind, "sid": sid, "resumed": resumed, "argv": argv, "cwd": cwd, "files": sorted(files),
                        "gh": shutil.which("gh"), "git_config": os.environ.get("GIT_CONFIG_GLOBAL"), "prompt": prompt}) + "\n")
if beh.get("sleep"):
    time.sleep(beh["sleep"])
if beh.get("plan") is not None:
    open(os.path.join(job, "PLAN.md"), "w").write(beh["plan"])
if beh.get("branch"):
    subprocess.run(["git", "checkout", "-q", "-b", beh["branch"]], cwd=cwd, check=True)
if beh.get("commit"):
    c = beh["commit"]
    open(os.path.join(cwd, c["file"]), "w").write(c["text"])
    subprocess.run(["git", "add", "-A"], cwd=cwd, check=True)
    subprocess.run(["git", "-c", "user.name=f", "-c", "user.email=f@f", "commit", "-q", "-m", "Change"], cwd=cwd, check=True)
    subprocess.run(["git", "push", "-q", "origin", "HEAD"], cwd=cwd, check=True)
elif beh.get("branch"):
    subprocess.run(["git", "push", "-q", "origin", "HEAD"], cwd=cwd, check=True)
if beh.get("pr"):
    subprocess.run(["gh", "pr", "create", "--title", beh["pr"], "--body", "Body"], cwd=cwd, check=True,
                   stdout=subprocess.DEVNULL)
if not beh.get("no_result"):
    open(os.path.join(job, "RESULT.md"), "w").write(f"<!-- report {token} -->\n{beh.get('report', '')}\n")
cost = float(beh.get("cost", 0.1))
total = float(state["cost"].get(sid, 0.0)) + cost
state["cost"][sid] = total
model = "claude-haiku-5-5" if "haiku" in model_arg else ("claude-sonnet-5-5" if "sonnet" in model_arg else "claude-opus-5-5")
price_out = {"claude-opus-5-5": 20, "claude-sonnet-5-5": 10, "claude-haiku-5-5": 0.5}[model]
proj = os.path.join(cfg_dir, "projects", "-fake-project")
os.makedirs(proj, exist_ok=True)
now = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
with open(os.path.join(proj, sid + ".jsonl"), "a", encoding="utf-8") as f:
    f.write(json.dumps({"type": "user", "timestamp": now, "cwd": cwd, "message": {"role": "user", "content": prompt}}) + "\n")
    f.write(json.dumps({"type": "assistant", "timestamp": now, "cwd": cwd, "uuid": uuid.uuid4().hex,
                        "message": {"id": "msg_" + uuid.uuid4().hex, "model": model, "role": "assistant",
                                    "content": [{"type": "text", "text": "ok"}],
                                    "usage": {"input_tokens": 0, "output_tokens": round(cost * 1e6 / price_out),
                                              "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}}) + "\n")
json.dump(state, open(state_path, "w"))
print(json.dumps({"type": "result", "subtype": beh.get("subtype", "success"), "is_error": bool(beh.get("is_error")),
                  "result": beh.get("result", beh.get("report", "")), "session_id": sid, "total_cost_usd": total}))
sys.exit(beh.get("exit", 0))
"""

# What the fake does for each call kind unless a test says otherwise. Each kind is a list (one entry per call).
DEFAULTS = {
    "plan": {"plan": "# Plan\n\nMake the total 5.\n", "report": "Plan is in PLAN.md."},
    "build": {"commit": {"file": "shop.py", "text": "TOTAL = 5\n"}, "pr": "Make the total 5", "report": "Built the PR."},
    "review": {"report": "Looks fine.\n\nVERDICT: approve"},
    "fix": {"report": "Fixed the blocker."},
    "rereview": {"report": "Fixed.\n\nVERDICT: approve"},
    "answer": {"report": "Carrying on."},
}
CONFIG = {
    "profiles": {
        "planner": {"kind": "claude", "args": ["--agent", "planner", "--model", "opus", "--effort", "medium", "--permission-mode", "auto"]},
        "builder": {"kind": "claude", "args": ["--agent", "builder", "--model", "haiku", "--effort", "xhigh", "--permission-mode", "auto"]},
        "reviewer": {"kind": "claude", "args": ["--agent", "reviewer", "--model", "opus", "--effort", "low", "--permission-mode", "auto"]},
    }
}


def git(cwd, *args):
    return subprocess.run(GIT + list(args), cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def write_json(path, obj):
    write(os.path.dirname(path), os.path.basename(path), json.dumps(obj, indent=2) + "\n")


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def make_source(tmp):
    """A source repo: a parent commit (the workers' snapshot) and a merge commit (the PR's merged state, with the
    hidden test tests/test_hidden.py). Returns (path, parent sha, merge sha)."""
    src = os.path.join(tmp, "source")
    os.makedirs(src)
    git(src, "init", "-q", "-b", "main")
    write(src, "shop.py", "TOTAL = 0\n")
    write(src, "tests/test_own.py", OWN_TEST)
    write(src, "grade_stub.py", STUB)
    git(src, "add", "-A")
    git(src, "commit", "-q", "-m", "Parent")
    parent = git(src, "rev-parse", "HEAD")
    write(src, "shop.py", "TOTAL = 5\n")
    write(src, "tests/test_hidden.py", HIDDEN_TEST)
    git(src, "add", "-A")
    git(src, "commit", "-q", "-m", "Merge")
    return src, parent, git(src, "rev-parse", "HEAD")


def transcript_lines(costs, stamp):
    """Assistant and user records whose output tokens price to each cost (opus: $20 per million output tokens)."""
    out = []
    for cost in costs:
        out.append(json.dumps({"type": "user", "timestamp": stamp, "message": {"role": "user", "content": "go"}}))
        out.append(
            json.dumps(
                {
                    "type": "assistant",
                    "timestamp": stamp,
                    "message": {
                        "id": "msg_" + os.urandom(4).hex(),
                        "model": "claude-opus-5-5",
                        "content": [{"type": "text", "text": "ok"}],
                        "usage": {"input_tokens": 0, "output_tokens": round(cost * 1e6 / 20)},
                    },
                }
            )
        )
    return "\n".join(out) + "\n"


class RunnerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="hrd-eval-runner-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src, self.parent, self.merge = make_source(self.tmp)
        self.scen = os.path.join(self.tmp, "scenarios")
        self.cfgdir = os.path.join(self.tmp, "claude-config")
        self.config = os.path.join(self.tmp, "herdr-agents.json")
        self.log = os.path.join(self.tmp, "fake.log")
        self.script_path = os.path.join(self.tmp, "script.json")
        self.fake = os.path.join(self.tmp, "fake-claude")
        self.results = os.path.join(self.tmp, "results")
        os.makedirs(self.cfgdir)
        write(self.tmp, "fake-claude", FAKE.replace("__PYTHON__", os.path.realpath(sys.executable)))
        os.chmod(self.fake, 0o755)
        write_json(self.config, CONFIG)
        patcher = mock.patch.dict(
            os.environ,
            {"CLAUDE_CONFIG_DIR": self.cfgdir, "FAKE_CLAUDE_LOG": self.log, "FAKE_CLAUDE_SCRIPT": self.script_path},
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.behave()
        self.make_scenario()

    def behave(self, **kinds):
        """Writes the fake's script: each kind's default, or the given entries (a dict, or a list of dicts)."""
        by_dir = kinds.pop("by_dir", {})
        script = {"by_dir": {}}
        for kind, default in DEFAULTS.items():
            items = kinds.get(kind, [{}])
            if isinstance(items, dict):
                items = [items]
            script[kind] = [{**default, **item} for item in items]
        for folder, per_kind in by_dir.items():
            script["by_dir"][folder] = {k: {**DEFAULTS[k], **v} for k, v in per_kind.items()}
        write_json(self.script_path, script)

    def make_scenario(self, sid="replay-test", source=None, hidden=None, on_decision="recommended", grade=None, slices=None, setup=None):
        folder = os.path.join(self.scen, sid)
        os.makedirs(folder, exist_ok=True)
        write_json(
            os.path.join(folder, "issue.json"),
            {
                "number": 12,
                "title": "Make the total 5",
                "body": "The total is wrong.",
                "state": "OPEN",
                "labels": [],
                "comments": [],
                "url": f"https://github.com/hrd-eval/{sid}/issues/12",
                "author": {"login": "owner"},
                "createdAt": "2026-10-01T00:00:00Z",
            },
        )
        sc = {
            "title": "Test replay",
            "kind": "replay",
            "issue": {"number": 12, "file": "issue.json"},
            "source": {"commit": source or self.parent},
            "setup": setup or [],
            "grade": grade
            or {"cmd": ["python3", "-m", "unittest", "discover", "-s", "tests", "-v"], "parser": "unittest", "timeout": 120},
            "allowed": ["**"],
            "expect": {"decision": None, "testsChanged": False},
            "onDecision": on_decision,
            "estimateScale": 1,
        }
        if hidden is not False:
            sc["hidden"] = {"commit": hidden or self.merge, "paths": ["tests"]}
        if slices:
            sc["slices"] = slices
        write_json(os.path.join(folder, "scenario.json"), sc)

    def matrix(self, *extra, arms="A", arms_dir=ARMS, scenarios="replay-test", source=None):
        argv = [
            "--claude", self.fake, "--scenarios-dir", self.scen, "--arms-dir", arms_dir, "--arms", arms,
            "--config", self.config, "--source-repo", source or self.src, "--results", self.results,
            "--scenarios", scenarios, "--repeats", "1",
        ] + list(extra)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = HR.main(argv)
        return code, out.getvalue(), err.getvalue()

    def run_dir(self, arm="A", k=1, sid="replay-test"):
        return os.path.join(self.results, sid, arm, f"r{k}")

    def run_json(self, arm="A", k=1):
        return read_json(os.path.join(self.run_dir(arm, k), "run.json"))

    def calls(self, arm="A", k=1):
        with open(os.path.join(self.run_dir(arm, k), "calls.jsonl"), encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def fake_calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def kinds(self, arm="A", k=1):
        return [c["kind"] for c in self.calls(arm, k)]


class ArmsTest(RunnerCase):
    def load(self, names, config=None):
        return HR.load_arms(ARMS, names, config or self.config)

    def test_arm_b2_replaces_the_builder_profile_and_drops_the_planner(self):
        b2 = self.load(["B2"])["B2"]
        self.assertEqual(b2["disable"], ["planner"])
        self.assertNotIn("planner", b2["profiles"])
        self.assertEqual(
            b2["profiles"]["builder"]["args"],
            ["--agent", "builder", "--model", "opus", "--effort", "medium", "--permission-mode", "auto"],
        )
        # the reviewer is the user's profile, merged in unchanged
        self.assertEqual(b2["profiles"]["reviewer"]["args"], CONFIG["profiles"]["reviewer"]["args"])

    def test_arm_a_keeps_the_users_profiles_and_its_runner_keys(self):
        a = self.load(["A"])["A"]
        self.assertEqual(a["fixRound"], "fresh")
        self.assertEqual(a["maxFixRounds"], 2)
        self.assertEqual(a["note"], "baseline")
        self.assertEqual(a["profiles"]["planner"]["args"], CONFIG["profiles"]["planner"]["args"])

    def test_disabling_the_reviewer_is_an_error(self):
        path = os.path.join(self.tmp, "arms")
        write_json(os.path.join(path, "R.json"), {"disable": ["reviewer"]})
        with self.assertRaisesRegex(HR.RunnerError, "reviewer cannot be disabled"):
            HR.load_arms(path, ["R"], self.config)

    def test_a_codex_profile_is_an_error(self):
        cfg = {"profiles": {**CONFIG["profiles"], "builder": {"kind": "codex", "args": ["-m", "gpt-6-luna"]}}}
        write_json(self.config, cfg)
        with self.assertRaisesRegex(HR.RunnerError, 'kind is "codex"'):
            self.load(["A"])

    def test_a_profile_without_effort_is_an_error(self):
        cfg = {"profiles": {**CONFIG["profiles"], "builder": {"kind": "claude", "args": ["--model", "haiku"]}}}
        write_json(self.config, cfg)
        with self.assertRaisesRegex(HR.RunnerError, "needs --effort"):
            self.load(["A"])

    def test_an_herdr_agents_agent_is_an_error(self):
        cfg = {
            "profiles": {
                **CONFIG["profiles"],
                "reviewer": {"kind": "claude", "args": ["--agent", "herdr-agents:reviewer", "--model", "opus", "--effort", "low"]},
            }
        }
        write_json(self.config, cfg)
        with self.assertRaisesRegex(HR.RunnerError, "herdr-agents:reviewer"):
            self.load(["A"])

    def test_a_disabled_planner_is_not_checked(self):
        cfg = {"profiles": {**CONFIG["profiles"], "planner": {"kind": "codex", "args": []}}}
        write_json(self.config, cfg)
        self.assertNotIn("planner", self.load(["B"])["B"]["profiles"])

    def test_keys_the_runner_does_not_use_are_warned_about(self):
        path = os.path.join(self.tmp, "arms")
        write_json(os.path.join(path, "W.json"), {"target": 4, "playbook": ["x"], "fixRound": "fresh"})
        arm = HR.load_arms(path, ["W"], self.config)["W"]
        self.assertEqual(len(arm["warnings"]), 2)
        self.assertIn("'playbook'", " ".join(arm["warnings"]))

    def test_a_bad_fix_round_is_an_error(self):
        path = os.path.join(self.tmp, "arms")
        write_json(os.path.join(path, "X.json"), {"fixRound": "sometimes"})
        with self.assertRaisesRegex(HR.RunnerError, "fixRound must be"):
            HR.load_arms(path, ["X"], self.config)


class ArgvEnvTest(unittest.TestCase):
    PROFILE = {"kind": "claude", "args": ["--agent", "builder", "--model", "haiku", "--effort", "xhigh"], "env": {"X_EXTRA": "1"}}

    def setUp(self):
        self.run = tempfile.mkdtemp(prefix="hrd-eval-env-")
        self.addCleanup(shutil.rmtree, self.run, True)
        owner = os.path.join(self.run, "owner.gitconfig")
        write(self.run, "owner.gitconfig", "")
        patcher = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": owner})  # keeps the test off the owner's config
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_role_argv_has_the_plugin_settings_the_permissions_and_the_webfetch_denial(self):
        argv = HR.role_argv(self.PROFILE, "sid-1", False, 2.5)
        self.assertEqual(argv[0], "claude")
        self.assertEqual(argv[1], "-p")
        self.assertIn('--settings={"env":{"CLAUDE_CODE_PLUGIN_DIRS":""}}', argv)
        self.assertEqual(argv[argv.index("--permission-prompts") + 1], "none")
        self.assertIn("--disallowedTools=WebFetch(domain:github.com)", argv)
        self.assertEqual(argv[argv.index("--output-format") + 1], "json")
        self.assertEqual(argv[argv.index("--max-budget-usd") + 1], "2.5")
        self.assertEqual(argv[argv.index("--session-id") + 1], "sid-1")
        self.assertNotIn("--resume", argv)

    def test_role_argv_resumes_a_session_without_a_new_id(self):
        argv = HR.role_argv(self.PROFILE, "sid-1", True, 1)
        self.assertEqual(argv[argv.index("--resume") + 1], "sid-1")
        self.assertNotIn("--session-id", argv)

    def test_run_env_puts_the_shim_first_and_sets_the_gh_state(self):
        env_patch = {"GH_TOKEN": "t", "GITHUB_TOKEN": "t", "CLAUDECODE": "1", "HERDR_SOCKET": "s", "KEEP_ME": "k"}
        with mock.patch.dict(os.environ, env_patch):
            env = HR.run_env(self.run, self.PROFILE)
        self.assertTrue(env["PATH"].startswith(SHIM_BIN + os.pathsep))
        self.assertEqual(env["HRD_EVAL_GH_STATE"], os.path.join(self.run, "gh"))
        self.assertEqual(env["GH_CONFIG_DIR"], os.path.join(self.run, "gh-config"))
        self.assertEqual(env["CLAUDE_ENV_FILE"], os.path.join(self.run, "env.sh"))
        self.assertEqual(env["X_EXTRA"], "1")
        for dropped in ("GH_TOKEN", "GITHUB_TOKEN", "CLAUDECODE", "HERDR_SOCKET"):
            self.assertNotIn(dropped, env)
        self.assertEqual(env["KEEP_ME"], "k")

    def test_run_env_points_git_at_the_run_gitconfig(self):
        env = HR.run_env(self.run, self.PROFILE)
        self.assertEqual(env["GIT_CONFIG_GLOBAL"], os.path.join(self.run, "gitconfig"))
        self.assertEqual(env["GIT_CONFIG_NOSYSTEM"], "1")
        self.assertEqual(env["GIT_TERMINAL_PROMPT"], "0")
        self.assertTrue(os.path.exists(os.path.join(self.run, "gitconfig")))


# The owner's global and system git config in the tests: a credential helper in each, which a run must not see.
OWNER_CONFIG = "[user]\n\tname = Owner Name\n\temail = owner@example.com\n[credential]\n\thelper = osxkeychain\n"
SYSTEM_CONFIG = "[credential]\n\thelper = system-helper\n"


class GitConfigTest(unittest.TestCase):
    """A run's git reads only folder/gitconfig: the owner's name and email, no credential helper, and every github.com
    URL rewritten to a path under /dev/null, so a push or clone fails at once with no network call."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="hrd-eval-git-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.run = os.path.join(self.tmp, "r1")
        os.makedirs(self.run)
        self.owner = os.path.join(self.tmp, "owner.gitconfig")
        self.system = os.path.join(self.tmp, "system.gitconfig")
        write(self.tmp, "owner.gitconfig", OWNER_CONFIG)
        write(self.tmp, "system.gitconfig", SYSTEM_CONFIG)
        # Ambient git config variables a worker's env could carry: a helper injected through GIT_CONFIG_COUNT, and more.
        ambient = {
            "GIT_CONFIG_GLOBAL": self.owner,
            "GIT_CONFIG_SYSTEM": self.system,
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "credential.helper",
            "GIT_CONFIG_VALUE_0": "env-helper",
        }
        patcher = mock.patch.dict(os.environ, ambient)
        patcher.start()
        self.addCleanup(patcher.stop)

    def git_in(self, env, cwd, *args):
        return subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=60)

    def test_the_run_env_points_git_at_the_run_config_and_drops_the_ambient_git_config(self):
        env = HR.clean_env(self.run)
        self.assertEqual(env["GIT_CONFIG_GLOBAL"], os.path.join(self.run, "gitconfig"))
        self.assertEqual(env["GIT_CONFIG_NOSYSTEM"], "1")
        self.assertEqual(env["GIT_TERMINAL_PROMPT"], "0")
        for key in ("GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"):
            self.assertNotIn(key, env)

    def test_the_run_config_keeps_only_the_identity_and_the_github_rewrites(self):
        HR.clean_env(self.run)
        cfg = os.path.join(self.run, "gitconfig")
        listed = self.git_in(None, self.tmp, "config", "--file", cfg, "--list").stdout.splitlines()
        keys = {line.split("=", 1)[0] for line in listed}
        self.assertEqual(keys, {"user.name", "user.email", f"url.{HR.BLOCKED_BASE}.insteadof"})
        self.assertIn("user.name=Owner Name", listed)
        self.assertIn("user.email=owner@example.com", listed)
        rewrites = [line.split("=", 1)[1] for line in listed if ".insteadof=" in line]
        self.assertEqual(rewrites, HR.BLOCKED_PREFIXES)

    def test_github_urls_are_rewritten_to_the_blocked_path_and_fail_at_once(self):
        env = HR.clean_env(self.run)
        for url in ("https://github.com/x/y", "http://github.com/x/y", "ssh://git@github.com/x/y", "git@github.com:x/y"):
            with self.subTest(url=url):
                got = self.git_in(env, self.run, "ls-remote", "--get-url", url)
                self.assertEqual(got.stdout.strip(), HR.BLOCKED_BASE + "x/y")
                p = self.git_in(env, self.run, "ls-remote", url)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn("'/dev/null/blocked/x/y' does not appear to be a git repository", p.stderr)

    def test_no_credential_helper_is_seen_from_the_run_env(self):
        # The owner's helper is there to be seen without the run's env, so the empty answer below is the run's doing.
        owner_helper = subprocess.run(["git", "config", "--global", "--get", "credential.helper"], capture_output=True, text=True)
        self.assertEqual(owner_helper.stdout.strip(), "osxkeychain")
        env = HR.clean_env(self.run)
        p = self.git_in(env, self.run, "config", "credential.helper")
        self.assertEqual((p.returncode, p.stdout), (1, ""))

    def test_worker_commits_have_the_owners_identity(self):
        env = HR.clean_env(self.run)
        repo = os.path.join(self.run, "repo")
        os.makedirs(repo)
        self.assertEqual(self.git_in(env, repo, "init", "-q", "-b", "main").returncode, 0)
        p = self.git_in(env, repo, "commit", "-q", "--allow-empty", "-m", "Work")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.git_in(env, repo, "log", "-1", "--format=%an <%ae>").stdout.strip(), "Owner Name <owner@example.com>")

    def test_worker_commits_have_the_fallback_identity_when_the_owner_has_none(self):
        empty = os.path.join(self.tmp, "empty.gitconfig")
        write(self.tmp, "empty.gitconfig", "")
        with mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": empty}):
            env = HR.clean_env(self.run)
        repo = os.path.join(self.run, "repo")
        os.makedirs(repo)
        self.assertEqual(self.git_in(env, repo, "init", "-q", "-b", "main").returncode, 0)
        p = self.git_in(env, repo, "commit", "-q", "--allow-empty", "-m", "Work")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.git_in(env, repo, "log", "-1", "--format=%an <%ae>").stdout.strip(), "hrd-eval <hrd-eval@localhost>")

    def test_the_run_config_is_written_again_on_every_call_and_no_temp_file_is_left(self):
        HR.clean_env(self.run)
        cfg = os.path.join(self.run, "gitconfig")
        os.remove(cfg)
        HR.clean_env(self.run)
        self.assertTrue(os.path.exists(cfg))
        self.assertEqual([n for n in os.listdir(self.run) if n.startswith(".gitconfig-")], [])


class ReportRuleTest(unittest.TestCase):
    def setUp(self):
        with open(WORKERS_TS, encoding="utf-8") as f:
            self.ts = f.read()

    def test_each_report_rule_sentence_is_word_for_word_in_workers_ts(self):
        for part in HR.REPORT_RULE_PARTS:
            self.assertIn(part, self.ts)

    def test_the_wait_json_sentences_are_left_out(self):
        self.assertFalse(any("WAIT.json" in part or "sleep or poll" in part for part in HR.REPORT_RULE_PARTS))

    def test_report_rule_fills_in_the_job_folder_and_the_token(self):
        rule = HR.report_rule("/run/jobs/01-planner", "abcd1234")
        self.assertIn("write your final report to /run/jobs/01-planner/RESULT.md,", rule)
        self.assertIn("first line must be exactly: <!-- report abcd1234 -->.", rule)
        self.assertNotIn("${job", rule)

    def test_the_decision_regexes_are_the_ones_in_workers_ts(self):
        # the whole JS literal, flags included: a prefix of the pattern is not enough
        self.assertIn("/" + HR.DECISION_SRC + "/gm", self.ts)
        self.assertIn("/" + HR.NONE_SRC.replace("/", r"\/") + "/i", self.ts)

    def test_decision_none_is_not_a_question(self):
        self.assertEqual(HR.decisions("Done.\nDECISION: none. No owner decision is needed."), [])
        self.assertEqual(HR.decisions("DECISION: n/a"), [])

    def test_decision_lines_are_found_with_their_bullets_and_bold(self):
        text = "Report.\n- DECISION: Stack? | Yes (recommended) | No\n**DECISION:** Ship it? | Yes\n"
        self.assertEqual(HR.decisions(text), ["Stack? | Yes (recommended) | No", "Ship it? | Yes"])

    def test_split_decision_takes_the_recommended_option_and_the_title_off(self):
        q, options, rec = HR.split_decision("[Stack] Do the discounts stack? | Yes, stack (recommended) | No")
        self.assertEqual((q, options, rec), ("Do the discounts stack?", ["Yes, stack", "No"], "Yes, stack"))

    def test_split_decision_without_a_recommended_option_takes_the_first(self):
        self.assertEqual(HR.split_decision("Which? | A | B")[2], "A")

    def test_split_decision_without_options_says_best_judgement(self):
        self.assertEqual(HR.split_decision("Which way?")[2], "your best judgement")


class VerdictTest(unittest.TestCase):
    def test_a_verdict_line_gives_the_count(self):
        self.assertEqual(HR.parse_verdict("text\nVERDICT: changes needed, 2 blockers"), ("changes", 2, "line"))
        self.assertEqual(HR.parse_verdict("VERDICT: approve"), ("approve", 0, "line"))

    def test_changes_needed_without_a_count_is_one_blocker(self):
        self.assertEqual(HR.parse_verdict("VERDICT: changes needed"), ("changes", 1, "line"))

    def test_free_text_ready_with_no_blockers_is_approve(self):
        self.assertEqual(HR.parse_verdict("Ready. No blockers."), ("approve", 0, "heuristic"))

    def test_free_text_changes_needed_with_one_blocker(self):
        self.assertEqual(HR.parse_verdict("Changes needed, 1 blocker in shop.py."), ("changes", 1, "heuristic"))

    def test_a_numbered_list_under_blockers_counts_its_items(self):
        text = "Review.\n\n**Blockers**\n1. shop.py is wrong\n2. the test is missing\n\n**Nits**\n- spacing\n"
        self.assertEqual(HR.parse_verdict(text), ("changes", 2, "heuristic"))

    def test_text_with_no_verdict_is_none(self):
        self.assertEqual(HR.parse_verdict("I looked at it."), (None, None, "none"))


class CostTest(unittest.TestCase):
    def test_a_resumed_calls_cost_is_the_difference_from_the_session_before(self):
        tmp = tempfile.mkdtemp(prefix="hrd-eval-cost-")
        self.addCleanup(shutil.rmtree, tmp, True)
        path = os.path.join(tmp, "s.jsonl")
        stamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        with open(path, "w", encoding="utf-8") as f:
            f.write(transcript_lines([1.0], stamp))
        first = HR.call_cost(path)
        self.assertAlmostEqual(first["cost_transcript"], 1.0)
        with open(path, "a", encoding="utf-8") as f:
            f.write(transcript_lines([0.5], stamp))
        second = HR.call_cost(path, first["state"])
        self.assertAlmostEqual(second["cost_transcript"], 0.5)
        self.assertEqual(second["tokens"]["out"], 25000)
        self.assertEqual(list(second["models"]), ["claude-opus-5-5"])
        self.assertEqual(HR.call_cost(None)["cost_transcript"], 0)


class PluginRowsTest(unittest.TestCase):
    def test_rows_are_tests_and_the_summary_is_not(self):
        text = (
            "tests/side.test.tsx:\n(pass) workers join through shared numbers [0.84ms]\n"
            "(fail) a row that failed\n(pass) the file ran to its end\n 2 pass\n 1 fail\nRan 3 tests across 1 files. [1.0s]\n"
        )
        self.assertEqual(
            HR.plugin_rows(text),
            {"workers join through shared numbers": "pass", "a row that failed": "fail", "the file ran to its end": "pass"},
        )


class SetupTest(RunnerCase):
    def test_setup_builds_the_bare_remote_the_clone_and_the_worktree_without_hidden_tests(self):
        self.make_scenario(setup=[["touch", "setup-ran"]])
        sc = HR.load_scenario(os.path.join(self.scen, "replay-test"))
        arm = HR.load_arms(ARMS, ["A"], self.config)["A"]
        ctx = HR.Ctx(self.results, self.fake, 60, HR.Budget(30, 5), self.src)
        run = HR.Run(ctx, sc, arm, 1)
        os.makedirs(run.dir)
        run.setup()
        self.assertEqual(git(run.dir, "--git-dir", run.remote, "rev-parse", "--is-bare-repository"), "true")
        self.assertEqual(git(run.work, "rev-list", "--count", "HEAD"), "1")
        self.assertEqual(git(run.work, "log", "-1", "--format=%s", run.base), "Base")
        self.assertEqual(read_text(os.path.join(run.work, "shop.py")), "TOTAL = 0\n")
        wt = run.slices[0]["wt"]
        self.assertEqual(git(wt, "branch", "--show-current"), "issue-12-eval")
        for folder_path in (run.work, wt):
            self.assertTrue(os.path.exists(os.path.join(folder_path, "setup-ran")))
            self.assertFalse(os.path.exists(os.path.join(folder_path, "tests", "test_hidden.py")))
        gh = read_json(os.path.join(run.dir, "gh", "repo.json"))
        self.assertEqual(gh, {"remote": run.remote, "name": "replay-test", "owner": "hrd-eval"})
        self.assertTrue(os.path.exists(os.path.join(run.dir, "gh", "issues", "12.json")))
        with open(os.path.join(run.dir, "env.sh"), encoding="utf-8") as f:
            self.assertIn(SHIM_BIN, f.read())

    def test_setup_commands_run_with_the_run_git_config(self):
        self.make_scenario(setup=[["sh", "-c", 'printf %s "$GIT_CONFIG_GLOBAL" > global.txt']])
        sc = HR.load_scenario(os.path.join(self.scen, "replay-test"))
        arm = HR.load_arms(ARMS, ["A"], self.config)["A"]
        ctx = HR.Ctx(self.results, self.fake, 60, HR.Budget(30, 5), self.src)
        run = HR.Run(ctx, sc, arm, 1)
        os.makedirs(run.dir)
        run.setup()
        wt = run.slices[0]["wt"]
        for folder_path in (run.work, wt):
            self.assertEqual(read_text(os.path.join(folder_path, "global.txt")), os.path.join(run.dir, "gitconfig"))


class MatrixTest(RunnerCase):
    def test_arm_a_runs_plan_build_review_fix_and_rereview_with_the_hidden_tests_only_in_the_grade(self):
        self.behave(review=[{"report": "VERDICT: changes needed, 1 blocker"}, {"report": "VERDICT: approve"}])
        code, out, _ = self.matrix()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.kinds(), ["plan", "build", "review", "fix", "rereview"])
        run = self.run_json()
        self.assertEqual(run["status"], "done")
        self.assertIsNone(run["error"])
        self.assertTrue(run["pr_opened"])
        slice_rec = run["slices"][0]
        self.assertEqual(slice_rec["pr"], 13)  # issue #12 is the highest number, so the PR is 13
        self.assertEqual(slice_rec["fix_rounds"], 1)
        self.assertEqual(
            [(r["verdict"], r["blockers"], r["how"]) for r in slice_rec["reviews"]], [("changes", 1, "line"), ("approve", 0, "line")]
        )
        self.assertFalse(slice_rec["review_unparsed"])
        self.assertNotIn("unparsed review", out)
        remote = os.path.join(self.run_dir(), "remote.git")
        self.assertEqual(slice_rec["head"], git(self.run_dir(), "--git-dir", remote, "rev-parse", "refs/heads/issue-12-eval"))
        self.assertEqual(git(os.path.join(self.run_dir(), "work"), "log", "-1", "--format=%s", run["base"]), "Base")
        self.assertTrue(run["grade"]["merged"])
        self.assertTrue(run["grade"]["ran"])
        self.assertEqual(run["grade"]["kind"], "unittest")
        self.assertEqual((run["grade"]["exit"], run["grade"]["own_exit"]), (0, 0))
        self.assertEqual(read_text(os.path.join(self.run_dir(), "grade", "hidden.exit")), "0")
        self.assertIn("shop.py", run["changed_files"])
        self.assertIn(self.merge, run["leak_patterns"])
        self.assertIn(self.src, run["leak_patterns"])
        # no worker folder ever held the hidden test; every worker call reads the run's git config
        for entry in self.fake_calls():
            self.assertNotIn("tests/test_hidden.py", entry["files"], entry["kind"])
            self.assertEqual(entry["git_config"], os.path.join(self.run_dir(), "gitconfig"), entry["kind"])
        # the builder's gh resolves to the shim
        builder = [e for e in self.fake_calls() if e["kind"] == "build"][0]
        self.assertTrue(builder["gh"].startswith(SHIM_BIN))

    def test_the_grade_command_runs_with_the_run_git_config(self):
        # the grade runs twice (own tests, then with the hidden tests), so the probe appends one line per run
        probe = os.path.join(self.run_dir(), "grade-config.txt")
        cmd = ["sh", "-c", f'printf "%s\\n" "$GIT_CONFIG_GLOBAL" >> "{probe}"']
        self.make_scenario(grade={"cmd": cmd, "parser": "unittest", "timeout": 60})
        code, out, _ = self.matrix()
        self.assertEqual(code, 0, out)
        config = os.path.join(self.run_dir(), "gitconfig")
        self.assertEqual(read_text(probe).splitlines(), [config, config])

    def test_a_review_with_no_verdict_ends_the_loop_and_is_recorded_as_unparsed(self):
        self.behave(review={"report": "I looked at it."})
        code, out, _ = self.matrix()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.kinds(), ["plan", "build", "review"])
        run = self.run_json()
        self.assertEqual(run["status"], "done")
        slice_rec = run["slices"][0]
        self.assertEqual(slice_rec["fix_rounds"], 0)
        self.assertEqual([(r["verdict"], r["blockers"], r["how"]) for r in slice_rec["reviews"]], [(None, None, "none")])
        self.assertTrue(slice_rec["review_unparsed"])
        self.assertIn("unparsed review", out)

    def test_a_rereview_with_no_verdict_is_recorded_as_unparsed_too(self):
        self.behave(review={"report": "VERDICT: changes needed, 1 blocker"}, rereview={"report": "Fixed, I think."})
        code, out, _ = self.matrix()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.kinds(), ["plan", "build", "review", "fix", "rereview"])
        slice_rec = self.run_json()["slices"][0]
        self.assertEqual(slice_rec["fix_rounds"], 1)
        self.assertEqual(slice_rec["reviews"][-1]["how"], "none")
        self.assertTrue(slice_rec["review_unparsed"])
        self.assertIn("unparsed review", out)

    def test_calls_jsonl_and_run_json_have_the_contract_fields(self):
        self.behave(review=[{"report": "VERDICT: changes needed, 1 blocker"}, {"report": "VERDICT: approve"}])
        self.matrix()
        call = self.calls()[0]
        for key in ("n", "role", "slice", "kind", "profile", "argv", "session_id", "resumed", "cwd", "started", "ended",
                    "exit", "timed_out", "is_error", "report_source", "job", "cost_transcript", "cost_reported", "tokens",
                    "models", "unpriced"):
            self.assertIn(key, call)
        self.assertEqual(call["report_source"], "result_md")
        run = self.run_json()
        for key in ("scenario", "scenario_dir", "arm", "repeat", "status", "error", "started", "ended", "base", "pr_opened",
                    "slices", "decisions", "plan_decisions", "grade", "changed_files", "leak_patterns"):
            self.assertIn(key, run)
        job = os.path.join(self.run_dir(), call["job"])
        for name in ("prompt.txt", "out.json", "stderr.txt", "RESULT.md", "report.md", "transcript.jsonl"):
            self.assertTrue(os.path.exists(os.path.join(job, name)), name)
        self.assertEqual(os.path.basename(os.path.dirname(job)), "jobs")

    def test_arm_b_has_no_plan_call_and_tells_the_builder_to_plan_first(self):
        code, _, _ = self.matrix(arms="B")
        self.assertEqual(code, 0)
        self.assertEqual(self.kinds("B"), ["build", "review"])
        build = [e for e in self.fake_calls() if e["kind"] == "build"][0]
        self.assertIn("plan it before you build it", build["prompt"])
        self.assertNotIn("from the plan at", build["prompt"])

    def test_arm_c_fix_resumes_the_first_builder_session_and_costs_only_the_fix(self):
        self.behave(
            build={"cost": 0.3},
            fix={"cost": 0.2},
            review=[{"report": "VERDICT: changes needed, 1 blocker"}, {"report": "VERDICT: approve"}],
        )
        self.matrix(arms="C", arms_dir=ARMS)
        calls = self.calls("C")
        build = next(c for c in calls if c["kind"] == "build")
        fix = next(c for c in calls if c["kind"] == "fix")
        self.assertEqual(fix["argv"][fix["argv"].index("--resume") + 1], build["session_id"])
        self.assertTrue(fix["resumed"])
        self.assertNotIn("--session-id", fix["argv"])
        self.assertAlmostEqual(build["cost_transcript"], 0.3)
        self.assertAlmostEqual(fix["cost_transcript"], 0.2)
        self.assertAlmostEqual(fix["cost_reported"], 0.2)

    def test_arm_a_fix_starts_a_fresh_session(self):
        self.behave(review=[{"report": "VERDICT: changes needed, 1 blocker"}, {"report": "VERDICT: approve"}])
        self.matrix()
        fix = next(c for c in self.calls() if c["kind"] == "fix")
        self.assertIn("--session-id", fix["argv"])
        self.assertNotIn("--resume", fix["argv"])

    def test_a_decision_with_onDecision_stop_ends_the_run_with_status_decision(self):
        self.make_scenario(on_decision="stop")
        self.behave(build={"report": "Built.\nDECISION: [Stack] Do member and bulk discounts stack? | Yes (recommended) | No"})
        code, _, _ = self.matrix()
        self.assertEqual(code, 0)
        self.assertEqual(self.kinds(), ["plan", "build"])
        run = self.run_json()
        self.assertEqual(run["status"], "decision")
        self.assertEqual(len(run["decisions"]), 1)
        self.assertEqual(run["decisions"][0]["role"], "builder")
        self.assertIsNone(run["decisions"][0]["answered"])
        self.assertRegex(run["decisions"][0]["text"], r"(?i)stack")

    def test_a_decision_with_onDecision_recommended_resumes_the_asker_with_the_recommended_option(self):
        self.behave(build=[{"report": "Built.\nDECISION: Do member and bulk discounts stack? | Yes (recommended) | No"}, {}])
        self.matrix()
        self.assertEqual(self.kinds(), ["plan", "build", "answer", "review"])
        build = next(c for c in self.calls() if c["kind"] == "build")
        answer = next(c for c in self.calls() if c["kind"] == "answer")
        self.assertEqual(answer["argv"][answer["argv"].index("--resume") + 1], build["session_id"])
        prompt = next(e["prompt"] for e in self.fake_calls() if e["kind"] == "answer")
        self.assertIn("Answers to your DECISION questions: Do member and bulk discounts stack? -> Yes. Carry on.", prompt)
        run = self.run_json()
        self.assertEqual(run["decisions"][0]["answered"], "Yes")
        self.assertEqual(run["status"], "done")

    def test_a_third_decision_after_two_answers_stops_the_run(self):
        self.behave(
            build={"report": "DECISION: First? | A (recommended) | B"},
            answer=[{"report": "DECISION: Second? | C (recommended) | D"}, {"report": "DECISION: Third? | E (recommended) | F"}],
        )
        self.matrix()
        self.assertEqual(self.kinds(), ["plan", "build", "answer", "answer"])
        run = self.run_json()
        self.assertEqual(run["status"], "decision")
        self.assertEqual([d["answered"] for d in run["decisions"]], ["A", "C", None])

    def test_decision_none_is_ignored(self):
        self.behave(build={"report": "Built.\nDECISION: none. No owner decision is needed."})
        self.matrix()
        self.assertEqual(self.kinds(), ["plan", "build", "review"])
        self.assertEqual(self.run_json()["decisions"], [])

    def test_a_call_that_stops_at_its_own_budget_cap_ends_the_run_as_budget(self):
        self.behave(build={"is_error": True, "exit": 1, "subtype": "error_max_budget_usd", "result": "cap"})
        self.matrix()
        self.assertEqual(self.run_json()["status"], "budget")

    def test_runs_that_start_after_a_budget_stop_get_budget_and_make_no_call(self):
        # arm A: plan (2.5, estimate 0.60) then the build (0.08) fit under 2.65; the reviewer (0.60) does not.
        # arm B starts after that and is refused before any setup.
        self.behave(plan={"cost": 2.5}, build={"cost": 0.01})
        code, _, _ = self.matrix("--arms", "A,B", "--max-cost", "2.65")
        self.assertEqual(code, 2)
        self.assertEqual(self.run_json("A")["status"], "budget")
        self.assertEqual(self.run_json("B")["status"], "budget")
        self.assertEqual([e["kind"] for e in self.fake_calls()], ["plan", "build"])
        self.assertFalse(os.path.exists(os.path.join(self.run_dir("B"), "work")))

    def test_the_builder_with_no_pr_ends_the_run_as_no_pr(self):
        self.behave(build={"pr": None})
        self.matrix()
        run = self.run_json()
        self.assertEqual(run["status"], "no_pr")
        self.assertIsNone(run["slices"][0]["pr"])
        self.assertEqual(self.kinds(), ["plan", "build"])

    def test_review_that_never_clears_ends_as_rounds_exhausted(self):
        arms = os.path.join(self.tmp, "arms")
        write_json(os.path.join(arms, "M1.json"), {"fixRound": "fresh", "maxFixRounds": 1})
        self.behave(
            review={"report": "VERDICT: changes needed, 1 blocker"},
            rereview={"report": "VERDICT: changes needed, 2 blockers"},
        )
        self.matrix(arms="M1", arms_dir=arms)
        self.assertEqual(self.kinds("M1"), ["plan", "build", "review", "fix", "rereview"])
        run = self.run_json("M1")
        self.assertEqual(run["status"], "rounds_exhausted")
        self.assertEqual(run["slices"][0]["fix_rounds"], 1)
        self.assertEqual(len(run["slices"][0]["reviews"]), 2)

    def test_a_budget_that_refuses_the_start_exits_2_and_invokes_nothing(self):
        code, _, err = self.matrix("--max-cost", "0.01")
        self.assertEqual(code, 2)
        self.assertIn("over --max-cost", err)
        self.assertEqual(self.fake_calls(), [])
        self.assertFalse(os.path.exists(self.results))

    def test_a_budget_reached_mid_run_stops_the_run_with_status_budget(self):
        # plan (opus, estimate 0.60) then build (haiku, 0.08) fit under 1.63; the plan really cost 1.5, so review (0.60) does not
        self.behave(plan={"cost": 1.5}, build={"cost": 0.01})
        code, _, _ = self.matrix("--max-cost", "1.63")
        self.assertEqual(code, 2)
        self.assertEqual(self.kinds(), ["plan", "build"])
        self.assertEqual(self.run_json()["status"], "budget")

    def test_a_call_past_the_timeout_ends_the_run_as_timeout(self):
        self.behave(build={"sleep": 60})
        code, _, _ = self.matrix("--call-timeout", "0.05", arms="B")
        self.assertEqual(code, 0)
        run = self.run_json("B")
        self.assertEqual(run["status"], "timeout")
        build = next(c for c in self.calls("B") if c["kind"] == "build")
        self.assertTrue(build["timed_out"])

    def test_a_failed_call_ends_the_run_as_error_with_its_message(self):
        self.behave(build={"is_error": True, "exit": 1, "result": "boom: no repo"})
        self.matrix()
        run = self.run_json()
        self.assertEqual(run["status"], "error")
        self.assertIn("boom: no repo", run["error"])

    def test_the_grade_skips_when_two_slices_conflict(self):
        slices = [{"id": "S1", "brief": "the total"}, {"id": "S2", "brief": "the same total again"}]
        self.make_scenario(slices=slices)
        self.behave(by_dir={
            "wt-S1": {"build": {"commit": {"file": "shop.py", "text": "TOTAL = 5\n"}}},
            "wt-S2": {"build": {"commit": {"file": "shop.py", "text": "TOTAL = 7\n"}}},
        })
        self.matrix()
        run = self.run_json()
        self.assertFalse(run["grade"]["merged"])
        self.assertIn("issue-12-s", run["grade"]["merge_error"])
        self.assertFalse(run["grade"]["ran"])
        self.assertFalse(os.path.exists(os.path.join(self.run_dir(), "grade", "hidden.txt")))

    def test_two_slices_build_in_parallel_with_one_pr_each(self):
        slices = [{"id": "S1", "brief": "the total"}, {"id": "S2", "brief": "the client"}]
        self.make_scenario(slices=slices)
        self.matrix()
        run = self.run_json()
        self.assertEqual([s["branch"] for s in run["slices"]], ["issue-12-s1", "issue-12-s2"])
        self.assertEqual(sorted(s["pr"] for s in run["slices"]), [13, 14])
        self.assertEqual(run["status"], "done")
        build_prompts = [e["prompt"] for e in self.fake_calls() if e["kind"] == "build"]
        self.assertTrue(any("slice S1 only (the total); another builder builds S2" in p for p in build_prompts))
        plan_prompt = next(e["prompt"] for e in self.fake_calls() if e["kind"] == "plan")
        self.assertIn("Split it into these slices, one PR each: S1: the total; S2: the client.", plan_prompt)

    def test_two_arms_at_once_each_get_their_run(self):
        code, _, _ = self.matrix("--parallel", "2", arms="A,B")
        self.assertEqual(code, 0)
        self.assertEqual(self.run_json("A")["status"], "done")
        self.assertEqual(self.run_json("B")["status"], "done")

    def test_results_inside_the_repo_are_refused(self):
        code, _, err = self.matrix("--results", os.path.join(self.src, "out"))
        self.assertEqual(code, 1)
        self.assertIn("inside the repo", err)
        self.assertFalse(os.path.exists(os.path.join(self.src, "out")))

    def test_a_pr_from_another_branch_is_found_through_the_calls_log(self):
        self.behave(build={"branch": "other-branch"})
        self.matrix()
        run = self.run_json()
        self.assertEqual(run["slices"][0]["branch"], "issue-12-eval")
        self.assertEqual(run["slices"][0]["pr"], 13)
        self.assertEqual(run["status"], "done")
        # the head of the PR is not the slice branch, so the grade has nothing to merge
        self.assertFalse(run["grade"]["merged"])

    def test_a_decision_only_in_plan_md_is_recorded_and_not_answered(self):
        self.behave(plan={"plan": "# Plan\n\nDECISION: Which store? | SQL | Files (recommended)\n", "report": "Plan done."})
        self.matrix()
        self.assertEqual(self.kinds(), ["plan", "build", "review"])
        run = self.run_json()
        self.assertEqual(run["decisions"], [])
        self.assertEqual(run["plan_decisions"], ["Which store? | SQL | Files (recommended)"])

    def test_dry_run_calls_nothing_and_prints_the_model_and_effort_per_role(self):
        code, out, _ = self.matrix("--dry-run")
        self.assertEqual(code, 0)
        self.assertEqual(self.fake_calls(), [])
        self.assertFalse(os.path.exists(self.results))
        self.assertIn("--model opus --effort medium", out)
        self.assertIn("--model haiku --effort xhigh", out)
        self.assertIn("arm A", out)
        self.assertIn("fits", out)

    def test_dry_run_reports_a_refusal_as_exit_2(self):
        code, out, _ = self.matrix("--dry-run", "--max-cost", "0.1")
        self.assertEqual(code, 2)
        self.assertIn("REFUSED", out)


class OverlayTest(unittest.TestCase):
    """The hidden tests over a grade folder: a commit's paths replaced, or a folder copied over."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="hrd-eval-overlay-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src, _, self.merge = make_source(self.tmp)
        self.grade = os.path.join(self.tmp, "grade")
        write(self.grade, "tests/old_test.py", "x = 1\n")

    def test_a_commit_overlay_replaces_the_paths_with_the_commits_tree(self):
        sc = {"dir": self.tmp, "hidden": {"commit": self.merge, "paths": ["tests"]}}
        HR.apply_hidden(sc, self.src, self.grade)
        self.assertFalse(os.path.exists(os.path.join(self.grade, "tests", "old_test.py")))
        self.assertTrue(os.path.exists(os.path.join(self.grade, "tests", "test_hidden.py")))
        self.assertTrue(os.path.exists(os.path.join(self.grade, "tests", "test_own.py")))

    def test_a_folder_overlay_copies_its_files_into_the_to_folder(self):
        write(self.tmp, "hidden/test_extra.py", "y = 2\n")
        sc = {"dir": self.tmp, "hidden": {"dir": "hidden", "to": "tests"}}
        HR.apply_hidden(sc, self.src, self.grade)
        self.assertEqual(read_text(os.path.join(self.grade, "tests", "test_extra.py")), "y = 2\n")
        self.assertTrue(os.path.exists(os.path.join(self.grade, "tests", "old_test.py")))


class ScenarioValidationTest(unittest.TestCase):
    def scenario(self, **changes):
        tmp = tempfile.mkdtemp(prefix="hrd-eval-scen-")
        self.addCleanup(shutil.rmtree, tmp, True)
        folder = os.path.join(tmp, "s1")
        os.makedirs(folder)
        write_json(os.path.join(folder, "issue.json"), {"number": 3, "title": "t", "body": "b"})
        sc = {"kind": "replay", "issue": {"number": 3, "file": "issue.json"}, "source": {"commit": "abc"}}
        sc.update(changes)
        write_json(os.path.join(folder, "scenario.json"), sc)
        return folder

    def test_a_scenario_with_an_unknown_kind_is_an_error(self):
        with self.assertRaisesRegex(HR.RunnerError, "kind must be"):
            HR.load_scenario(self.scenario(kind="movie"))

    def test_a_source_needs_exactly_one_of_commit_or_dir(self):
        with self.assertRaisesRegex(HR.RunnerError, "exactly one of commit or dir"):
            HR.load_scenario(self.scenario(source={"commit": "abc", "dir": "x"}))

    def test_a_multi_slice_scenario_needs_a_brief_per_slice(self):
        slices = [{"id": "S1", "brief": "one"}, {"id": "S2", "brief": ""}]
        with self.assertRaisesRegex(HR.RunnerError, "needs a brief"):
            HR.load_scenario(self.scenario(slices=slices))

    def test_defaults_fill_in_slices_setup_and_on_decision(self):
        sc = HR.load_scenario(self.scenario())
        self.assertEqual(sc["slices"], [{"id": "S1", "brief": ""}])
        self.assertEqual(sc["setup"], [])
        self.assertEqual(sc["onDecision"], "recommended")
        self.assertEqual(sc["estimateScale"], 1)


class CheckScenariosTest(RunnerCase):
    def check(self, *extra, sid="replay-test"):
        argv = ["--check-scenarios", "--scenarios-dir", self.scen, "--scenarios", sid, "--source-repo", self.src] + list(extra)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = HR.main(argv)
        return code, out.getvalue()

    def stub_scenario(self, sid="replay-test", hidden=None):
        self.make_scenario(sid=sid, hidden=hidden, grade={"cmd": ["python3", "grade_stub.py"], "parser": "plugin-test", "timeout": 60})

    def test_base_fails_and_reference_passes_then_expected_json_is_written_and_matches(self):
        self.stub_scenario()
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("drift: no expected.json", out)
        code, out = self.check("--update-expected")
        self.assertEqual(code, 0, out)
        self.assertIn("expected.json written", out)
        expected = read_json(os.path.join(self.scen, "replay-test", "expected.json"))
        self.assertEqual(expected, {"tests": ["hidden test", "own test"], "discriminating": ["hidden test"]})
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("expected.json matches", out)

    def test_hidden_tests_that_do_not_discriminate_are_a_problem(self):
        self.stub_scenario("replay-weak", hidden=self.parent)
        code, out = self.check(sid="replay-weak")
        self.assertEqual(code, 1)
        self.assertIn("base + overlay must fail", out)

    def test_a_drifted_expected_json_is_reported(self):
        self.stub_scenario()
        write_json(os.path.join(self.scen, "replay-test", "expected.json"), {"tests": ["own test"], "discriminating": []})
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("drift: tests", out)


    def test_a_fixture_is_checked_with_its_solution_patch_as_the_reference(self):
        folder = os.path.join(self.scen, "fix-test")
        write(folder, "source/shop.py", "TOTAL = 0\n")
        write(folder, "source/grade_stub.py", STUB)
        write(folder, "source/tests/test_own.py", OWN_TEST)
        write(folder, "hidden/test_hidden.py", HIDDEN_TEST)
        write(folder, "solution.patch", "--- a/shop.py\n+++ b/shop.py\n@@ -1 +1 @@\n-TOTAL = 0\n+TOTAL = 5\n")
        write_json(os.path.join(folder, "issue.json"), {"number": 12, "title": "t", "body": "b"})
        write_json(
            os.path.join(folder, "scenario.json"),
            {
                "title": "fixture",
                "kind": "fixture",
                "issue": {"number": 12, "file": "issue.json"},
                "source": {"dir": "source"},
                "hidden": {"dir": "hidden", "to": "tests"},
                "setup": [],
                "grade": {"cmd": ["python3", "grade_stub.py"], "parser": "plugin-test", "timeout": 60},
                "allowed": ["**"],
                "expect": {"decision": None, "testsChanged": False},
            },
        )
        code, out = self.check("--update-expected", sid="fix-test")
        self.assertEqual(code, 0, out)
        self.assertEqual(
            read_json(os.path.join(folder, "expected.json")),
            {"tests": ["hidden test", "own test"], "discriminating": ["hidden test"]},
        )


if __name__ == "__main__":
    unittest.main()
