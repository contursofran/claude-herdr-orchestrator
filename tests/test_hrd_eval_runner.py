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
import signal
import subprocess
import sys
import tempfile
import time
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
import fcntl, json, os, re, shutil, subprocess, sys, time, uuid
from datetime import datetime, timezone

argv = sys.argv[1:]
prompt = sys.stdin.read()
KINDS = (("Plan issue", "plan"), ("Build issue", "build"), ("Review PR", "review"), ("Fix round", "fix"),
         ("Re-review PR", "rereview"), ("Answers to your DECISION", "answer"), ("Sandbox check", "probe"))
kind = next(k for start, k in KINDS if prompt.startswith(start))
resumed = "--resume" in argv
sid = argv[argv.index("--resume") + 1] if resumed else argv[argv.index("--session-id") + 1]
model_arg = argv[argv.index("--model") + 1]
cfg_dir = os.environ["CLAUDE_CONFIG_DIR"]
state_path = os.path.join(cfg_dir, "fake-state.json")


# The call counts and costs, which every run's fakes share: change(state) runs under a lock, so a parallel run's fake
# never reads the file while it is half written, and no call's update is lost.
def update_state(change):
    with open(state_path + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.load(open(state_path)) if os.path.exists(state_path) else {"counts": {}, "cost": {}}
        out = change(state)
        with open(state_path, "w") as f:
            json.dump(state, f)
        return out


def take_count(state):
    count = state["counts"].get(kind, 0)
    state["counts"][kind] = count + 1
    return count


script = json.load(open(os.environ["FAKE_CLAUDE_SCRIPT"]))
count = update_state(take_count)
cwd = os.getcwd()
by_dir = script.get("by_dir", {}).get(os.path.basename(cwd), {}).get(kind)
beh = by_dir if by_dir is not None else script[kind][min(count, len(script[kind]) - 1)]
job_m = re.search(r"write (?:your final report to )?(\S+)/RESULT\.md", prompt)  # the full rule or the reminder
job = job_m.group(1) if job_m else cwd
token_m = re.search(r"<!-- report (\w+) -->", prompt)
token = token_m.group(1) if token_m else ""
files = []
for root, dirs, names in os.walk(cwd):
    dirs[:] = [d for d in dirs if d != ".git"]
    files += [os.path.relpath(os.path.join(root, n), cwd) for n in names]
with open(os.environ["FAKE_CLAUDE_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"kind": kind, "sid": sid, "resumed": resumed, "argv": argv, "cwd": cwd, "files": sorted(files),
                        "pid": os.getpid(), "gh": shutil.which("gh"), "git_config": os.environ.get("GIT_CONFIG_GLOBAL"), "prompt": prompt}) + "\n")
if beh.get("sleep"):
    t0 = time.time()
    time.sleep(beh["sleep"])
    with open(os.environ["FAKE_CLAUDE_LOG"] + ".spans", "a", encoding="utf-8") as f:
        f.write(json.dumps([t0, time.time()]) + "\n")
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
if beh.get("shim_pr"):  # a PR already in the shim's state, written here, so no gh call (no calls.log line) made it
    rec = beh["shim_pr"]
    path = os.path.join(os.environ["HRD_EVAL_GH_STATE"], "prs", f"{rec['number']}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(rec))
if beh.get("shell"):  # the probe's symlink and builder-flow commands, run as the prompt gives them
    for cmd in re.findall(r"^\d+\. Bash: ((?:ln -s|cd ).*)$", prompt, re.M):
        subprocess.run(["sh", "-c", cmd], cwd=cwd)
if beh.get("write"):
    open(re.search(r"echo ok > (\S+)", prompt).group(1), "w").write("ok\n")
if not beh.get("no_result"):
    open(os.path.join(job, "RESULT.md"), "w").write(f"<!-- report {token} -->\n{beh.get('report', '')}\n")
cost = float(beh.get("cost", 0.1))


def add_cost(state):
    state["cost"][sid] = float(state["cost"].get(sid, 0.0)) + cost
    return state["cost"][sid]


total = update_state(add_cost)
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
    paths = re.findall(r"(?:ls|cat|Read:|in) (/\S+)", prompt)
    for i, (name, field, path_i, text, err, *tmpl) in enumerate(beh.get("tools", [])):
        value = tmpl[0].replace("PATH", paths[path_i]) if tmpl else paths[path_i]
        use = {"type": "tool_use", "id": f"u{i}", "name": name, "input": {field: value}}
        f.write(json.dumps({"type": "assistant", "timestamp": now, "message": {"role": "assistant", "content": [use]}}) + "\n")
        res = {"type": "tool_result", "tool_use_id": f"u{i}", "content": text.replace("PATH", paths[path_i]), "is_error": err}
        f.write(json.dumps({"type": "user", "timestamp": now, "message": {"role": "user", "content": [res]}}) + "\n")
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
    "probe": {"report": "Done."},
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


def reporting_token(folder):
    """The token in a job folder's REPORTING.md (its report line)."""
    return re.search(r"<!-- report (\w+) -->", read_text(os.path.join(folder, "REPORTING.md"))).group(1)


# The answer a question gets when the owner does not answer (HR.NO_OWNER_ANSWER), written out so a wording change shows.
NO_OWNER = "No owner answer; use your best judgement, say in the report what you chose."


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
        # A graded scenario needs its expected.json before a run starts; these runs grade no particular test names.
        write_json(os.path.join(folder, "expected.json"), {"tests": [], "discriminating": []})

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

    def test_arm_bh_runs_the_haiku_builder_without_the_planner(self):
        bh = self.load(["BH"])["BH"]
        self.assertEqual(bh["disable"], ["planner"])
        self.assertNotIn("planner", bh["profiles"])
        self.assertEqual(
            bh["profiles"]["builder"]["args"],
            ["--agent", "builder", "--model", "haiku", "--effort", "xhigh", "--permission-mode", "auto"],
        )

    def test_the_eval_config_resolves_every_arm(self):
        # scripts/hrd-eval/config.json holds the profiles the scored runs used; every arm must load over it
        arms = HR.load_arms(ARMS, None, os.path.join(os.path.dirname(ARMS), "config.json"))
        self.assertEqual(sorted(arms), ["A", "B", "B2", "BH", "C", "R"])
        self.assertIn("sonnet", arms["A"]["profiles"]["builder"]["args"])

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

    def test_role_argv_has_the_settings_the_permissions_and_the_webfetch_denial(self):
        argv = HR.role_argv(self.PROFILE, "sid-1", False, 2.5, '{"env":{}}')
        self.assertEqual(argv[0], "claude")
        self.assertEqual(argv[1], "-p")
        self.assertIn('--settings={"env":{}}', argv)
        self.assertEqual(argv[argv.index("--permission-prompts") + 1], "none")
        self.assertIn("--disallowedTools=WebFetch(domain:github.com)", argv)
        self.assertEqual(argv[argv.index("--output-format") + 1], "json")
        self.assertEqual(argv[argv.index("--max-budget-usd") + 1], "2.5")
        self.assertEqual(argv[argv.index("--session-id") + 1], "sid-1")
        self.assertNotIn("--resume", argv)

    def test_role_argv_resumes_a_session_without_a_new_id(self):
        argv = HR.role_argv(self.PROFILE, "sid-1", True, 1, "{}")
        self.assertEqual(argv[argv.index("--resume") + 1], "sid-1")
        self.assertNotIn("--session-id", argv)

    def test_run_env_puts_the_shim_first_and_sets_the_gh_state(self):
        env_patch = {"GH_TOKEN": "t", "GITHUB_TOKEN": "t", "CLAUDECODE": "1", "HERDR_SOCKET": "s", "KEEP_ME": "k"}
        with mock.patch.dict(os.environ, env_patch):
            env = HR.run_env(self.run, self.PROFILE)
        self.assertTrue(env["PATH"].startswith(os.path.join(self.run, "bin") + os.pathsep))
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

    def test_the_reminder_is_word_for_word_in_workers_ts_minus_its_wait_json_words(self):
        # reportReminder() is a template literal in workers.ts, so its backticks are escaped there.
        line = next(line for line in self.ts.splitlines() if "report as before:" in line)
        literal = line.split("return `", 1)[1].rsplit("`", 1)[0].replace("\\`", "`")
        self.assertIn("DECISION lines and WAIT.json work as in", literal)
        self.assertIn(HR.REPORT_REMINDER, literal.replace("and WAIT.json work", "work"))
        self.assertNotIn("WAIT.json", HR.REPORT_REMINDER)

    def test_report_reminder_fills_in_the_job_folder_and_the_token(self):
        reminder = HR.report_reminder("/run/jobs/02-builder-S1", "abcd1234")
        self.assertIn("write /run/jobs/02-builder-S1/RESULT.md in one write, as your last step", reminder)
        self.assertIn("with the first line exactly <!-- report abcd1234 -->", reminder)
        self.assertIn("DECISION lines work as in /run/jobs/02-builder-S1/REPORTING.md.", reminder)
        self.assertNotIn("${", reminder)

    def test_report_rule_fills_in_the_job_folder_and_the_token(self):
        rule = HR.report_rule("/run/jobs/01-planner", "abcd1234")
        self.assertIn("write your final report to /run/jobs/01-planner/RESULT.md in one write, as your last step.", rule)
        self.assertIn("Its first line must be exactly: <!-- report abcd1234 -->", rule)
        self.assertIn("in another file in /run/jobs/01-planner (a plan goes in PLAN.md)", rule)
        self.assertNotIn("${", rule)
        self.assertNotIn("WAIT.json", rule)

    def test_report_rule_puts_the_header_fences_and_keys_on_their_own_lines(self):
        rule = HR.report_rule("/run/jobs/01-planner", "abcd1234")
        self.assertIn("\n```report\nstatus: done\npr: 123\nsummary: what changed;", rule)
        self.assertIn("\nask: one line, only if your coordinator must answer something;", rule)
        self.assertIn("\n```\nstatus is done, blocked (you need an answer", rule)

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


class ReportHeaderTest(unittest.TestCase):
    def test_the_pr_field_of_a_fenced_header_gives_its_prs(self):
        report = "```report\nstatus: done\npr: 12, 13\nsummary: Built.\n```\n\nSee https://github.com/o/r/pull/99."
        self.assertEqual(HR.header_prs(report), [12, 13])

    def test_an_unfenced_header_gives_its_pr(self):
        self.assertEqual(HR.header_prs("status: done\npr: #12\nsummary: Built.\n\nThe body."), [12])

    def test_blank_lines_before_the_header_are_skipped(self):
        self.assertEqual(HR.header_prs("\n\n```report\npr: 7\n```\nbody"), [7])

    def test_a_pr_link_in_the_pr_field_gives_its_number(self):
        self.assertEqual(HR.header_prs("```report\npr: https://github.com/o/r/pull/21\n```"), [21])

    def test_the_pr_list_ends_at_the_first_item_that_is_not_a_pr(self):
        self.assertEqual(HR.header_prs("```report\npr: 42 (merged 2026-10-24) 43\n```"), [42])

    def test_pr_none_and_a_header_without_a_pr_line_name_no_pr(self):
        self.assertEqual(HR.header_prs("```report\nstatus: blocked\npr: none\n```"), [])
        self.assertEqual(HR.header_prs("```report\nstatus: blocked\nsummary: Stuck.\n```"), [])

    def test_a_report_without_a_header_names_no_pr_even_if_a_later_line_looks_like_one(self):
        self.assertEqual(HR.header_prs("Built the PR: https://github.com/o/r/pull/5\n\npr: 6"), [])

    def test_a_fence_that_is_never_closed_is_no_header(self):
        self.assertEqual(HR.header_prs("```report\npr: 12\nThe body."), [])


class ReadReportTest(unittest.TestCase):
    def setUp(self):
        self.job = tempfile.mkdtemp(prefix="hrd-eval-job-")
        self.addCleanup(shutil.rmtree, self.job, True)

    def test_a_result_md_in_the_new_format_is_read_without_its_token_line(self):
        text = "```report\nstatus: done\npr: 12\nsummary: Built.\n```\n\nDECISION: Stack? | Yes (recommended) | No\n"
        write(self.job, "RESULT.md", "<!-- report abcd1234 -->\n" + text)
        self.assertEqual(HR.read_report(self.job, "abcd1234", "json result"), (text, "result_md"))
        self.assertEqual(HR.header_prs(text), [12])
        self.assertEqual(HR.decisions(text), ["Stack? | Yes (recommended) | No"])

    def test_a_result_md_with_another_token_is_not_this_prompts_report(self):
        write(self.job, "RESULT.md", "<!-- report zzzz9999 -->\n```report\npr: 12\n```\n")
        self.assertEqual(HR.read_report(self.job, "abcd1234", "json result"), ("json result", "result"))


class AskTest(unittest.TestCase):
    def test_the_ask_line_of_a_fenced_header_is_read(self):
        report = "```report\nstatus: done\nsummary: Built.\nask: Stack member and bulk discounts?\n```\n\nBody."
        self.assertEqual(HR.header_ask(report), "Stack member and bulk discounts?")

    def test_an_ask_in_bold_or_as_a_bullet_is_read(self):
        self.assertEqual(HR.header_ask("**Status:** done\n- **Ask:** Stack?"), "Stack?")

    def test_an_ask_of_none_n_a_or_nothing_is_no_question(self):
        for value in ("none", "None.", "n/a", "N/A", ""):
            with self.subTest(value=value):
                self.assertIsNone(HR.header_ask(f"```report\nstatus: done\nask: {value}\n```"))

    def test_a_report_without_an_ask_line_has_none(self):
        self.assertIsNone(HR.header_ask("```report\nstatus: done\nsummary: Built.\n```\n\nBody."))
        self.assertIsNone(HR.header_ask("Plain report, no header."))

    def test_an_ask_line_below_the_header_is_not_read(self):
        self.assertIsNone(HR.header_ask("```report\nstatus: done\n```\n\nask: Stack?"))
        self.assertIsNone(HR.header_ask("status: done\n\nask: Stack?"))

    def test_questions_list_the_ask_first_then_the_decisions_as_written(self):
        report = "```report\nstatus: done\nask: Which base?\n```\n\nDECISION: [Stack] Stack? | Yes (recommended) | No"
        self.assertEqual(
            HR.questions(report),
            [("Which base?", "Which base?", NO_OWNER), ("[Stack] Stack? | Yes (recommended) | No", "Stack?", "Yes")],
        )


class FindPrTest(RunnerCase):
    """Run.find_pr with the gh state written by hand: no call made the PR, so only the report can name it."""

    def run_for_find(self):
        sc = HR.load_scenario(os.path.join(self.scen, "replay-test"))
        ctx = HR.Ctx(self.results, "claude", 60, HR.Budget(5.0, 5.0), self.src)
        return HR.Run(ctx, sc, {"id": "A"}, 1)

    def open_pr(self, run, number, head):
        write_json(os.path.join(run.dir, "gh", "prs", f"{number}.json"), {"number": number, "headRefName": head})

    def call(self, report):
        return {"started": 1.0, "ended": 2.0, "report": report}

    def test_the_pr_the_header_names_is_found_when_no_call_made_it(self):
        run = self.run_for_find()
        self.open_pr(run, 13, "other-branch")
        self.assertEqual(run.find_pr("issue-12-eval", self.call("```report\nstatus: done\npr: 13\n```")), 13)

    def test_a_header_pr_that_is_not_a_known_pr_falls_back_to_the_link(self):
        run = self.run_for_find()
        self.open_pr(run, 13, "other-branch")
        report = "pr: 14\n\nSee https://github.com/hrd-eval/replay-test/pull/13"
        self.assertEqual(run.find_pr("issue-12-eval", self.call(report)), 13)

    def test_a_header_pr_that_is_not_a_known_pr_and_no_link_finds_nothing(self):
        run = self.run_for_find()
        self.assertIsNone(run.find_pr("issue-12-eval", self.call("```report\npr: 14\n```")))


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


class HeaderVerdictTest(unittest.TestCase):
    def test_the_header_verdict_is_read_first(self):
        self.assertEqual(HR.parse_verdict("```report\nstatus: done\nverdict: approve\n```\nOK."), ("approve", 0, "header"))
        text = "```report\nstatus: done\nverdict: changes\n```\n**Blockers**\n1. a\n2. b\n"
        self.assertEqual(HR.parse_verdict(text), ("changes", 2, "header"))

    def test_the_header_wins_over_a_disagreeing_verdict_line(self):
        text = "```report\nstatus: done\nverdict: changes\n```\nVERDICT: approve"
        self.assertEqual(HR.parse_verdict(text), ("changes", 1, "header"))
        text = "```report\nstatus: done\nverdict: approve\n```\nVERDICT: changes needed, 2 blockers"
        self.assertEqual(HR.parse_verdict(text), ("approve", 0, "header"))

    def test_a_header_with_no_verdict_key_falls_back_to_the_line_and_then_none(self):
        self.assertEqual(HR.parse_verdict("```report\nstatus: done\n```\nVERDICT: approve"), ("approve", 0, "line"))
        self.assertEqual(HR.parse_verdict("```report\nstatus: done\n```\nI looked at it."), (None, None, "none"))

    def test_an_unknown_header_word_is_not_a_verdict(self):
        self.assertEqual(HR.parse_verdict("```report\nverdict: maybe\n```\nVERDICT: approve"), ("approve", 0, "line"))


class BlockersSectionTest(unittest.TestCase):
    def test_it_runs_from_the_blockers_heading_to_the_next_heading(self):
        text = "Intro.\n\n**Blockers**\n1. a is wrong\n2. b\n\n**Nits**\n- c\n"
        self.assertEqual(HR.blockers_section(text), "1. a is wrong\n2. b")
        self.assertEqual(HR.blockers_section("## Blockers\n1. x\n## Nits\n- y"), "1. x")
        self.assertEqual(HR.blockers_section("Blockers:\n1. x\nNits:\n- y"), "1. x")

    def test_it_runs_to_the_end_when_nothing_follows(self):
        self.assertEqual(HR.blockers_section("Blockers\n1. x\n2. y\nVERDICT: changes needed, 2 blockers"),
                         "1. x\n2. y\nVERDICT: changes needed, 2 blockers")

    def test_no_blockers_heading_gives_the_whole_report(self):
        self.assertEqual(HR.blockers_section("  Looks fine.\n"), "Looks fine.")


class AgentsArmTest(RunnerCase):
    AGENT = "---\nname: reviewer\ndescription: Reviews a PR.\ntools: Read, Grep, Bash\nmodel: opus\n---\nYou are the reviewer.\n\nBe strict.\n"

    def arm_dir(self, **arm):
        folder = os.path.join(self.tmp, "arms")
        write_json(os.path.join(folder, "P.json"), {"profiles": CONFIG["profiles"], **arm})
        return folder

    def test_a_repo_path_is_parsed_into_the_agents_file_and_the_argv(self):
        write(self.tmp, "repo/agents/reviewer.md", self.AGENT)
        arms = HR.load_arms(self.arm_dir(agents={"reviewer": "agents/reviewer.md"}), ["P"], self.config, repo=os.path.join(self.tmp, "repo"))
        agent = arms["P"]["agents"]["reviewer"]
        self.assertEqual(agent["name"], "hrd-eval-reviewer")
        self.assertEqual(HR.agents_file_data(arms["P"]["agents"]), {"hrd-eval-reviewer": {
            "description": "Reviews a PR.", "prompt": "You are the reviewer.\n\nBe strict.", "tools": ["Read", "Grep", "Bash"]}})
        argv = HR.role_argv(arms["P"]["profiles"]["reviewer"], "sid", False, 1, "{}", agent, "/run/agents.json")
        self.assertEqual(argv[argv.index("--agent") + 1], "hrd-eval-reviewer")
        self.assertEqual(argv.count("--agent"), 1)
        self.assertIn("--agents=/run/agents.json", argv)
        plain = HR.role_argv(arms["P"]["profiles"]["builder"], "sid", False, 1, "{}")
        self.assertEqual(plain[plain.index("--agent") + 1], "builder")
        self.assertFalse([a for a in plain if a.startswith("--agents")])

    def test_a_git_ref_reads_the_file_at_that_revision(self):
        repo = os.path.join(self.tmp, "repo")
        write(repo, "agents/reviewer.md", self.AGENT)
        git(repo, "init", "-q", "-b", "main")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "old")
        old = git(repo, "rev-parse", "HEAD")
        write(repo, "agents/reviewer.md", self.AGENT.replace("Be strict.", "Be kind."))
        git(repo, "commit", "-qam", "new")
        agent = HR.read_agent(f"git:{old}:agents/reviewer.md", repo)
        self.assertIn("Be strict.", agent["prompt"])
        self.assertIn("Be kind.", HR.read_agent("agents/reviewer.md", repo)["prompt"])

    def test_a_missing_file_a_bad_rev_and_an_unknown_role_are_errors_at_load_time(self):
        repo = os.path.join(self.tmp, "repo")
        write(repo, "agents/reviewer.md", self.AGENT)
        git(repo, "init", "-q", "-b", "main")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "old")
        for spec in ({"reviewer": "agents/none.md"}, {"reviewer": "git:nope:agents/reviewer.md"},
                     {"reviewer": "git:HEAD:agents/none.md"}, {"coordinator": "agents/reviewer.md"}):
            with self.assertRaises(HR.RunnerError, msg=spec):
                HR.load_arms(self.arm_dir(agents=spec), ["P"], self.config, repo=repo)

    def test_the_run_writes_agents_json_and_the_reviewer_call_uses_the_pinned_agent(self):
        write(self.tmp, "repo/agents/reviewer.md", self.AGENT)
        arms = HR.load_arms(self.arm_dir(agents={"reviewer": "agents/reviewer.md"}), ["P"], self.config, repo=os.path.join(self.tmp, "repo"))
        sc = HR.load_scenario(os.path.join(self.scen, "replay-test"))
        run = HR.Run(HR.Ctx(self.results, self.fake, 60, HR.Budget(30, 5), self.src), sc, arms["P"], 1)
        os.makedirs(run.dir)
        run.setup()
        self.assertEqual(list(read_json(os.path.join(run.dir, "agents.json"))), ["hrd-eval-reviewer"])


# A review item over the fixture repo: the base scenario is replay-test (shop.py, tests/test_own.py, grade_stub.py).
PR_PATCH = "--- a/shop.py\n+++ b/shop.py\n@@ -1 +1 @@\n-TOTAL = 0\n+TOTAL = 5\n"
WITNESS = "import unittest\nfrom shop import TOTAL\n\n\nclass WitnessTest(unittest.TestCase):\n    def test_witness(self):\n        self.assertEqual(TOTAL, 5)\n"
# A quiet bug: TOTAL stays 0, which the PR's own test allows; the witness wants 5.
BUG_PATCH = "--- a/shop.py\n+++ b/shop.py\n@@ -1 +1,2 @@\n TOTAL = 0\n+EXTRA = 1\n"
# A loud one: the PR's own suite fails.
LOUD_PATCH = "--- a/shop.py\n+++ b/shop.py\n@@ -1 +1 @@\n-TOTAL = 0\n+TOTAL = 4\n"
UNITTEST_GRADE = {"cmd": ["python3", "-m", "unittest", "discover", "-s", "tests", "-v"], "parser": "unittest", "timeout": 60}


class ReviewItemCase(RunnerCase):
    def make_item(self, sid, patch=PR_PATCH, seed=None, witness=False, clean=None, extra_files=None, **more):
        folder = os.path.join(self.scen, sid)
        write(folder, "pr.patch", patch)
        for rel, text in (extra_files or {}).items():
            write(folder, rel, text)
        sc = {"title": sid, "kind": "review", "base": "../replay-test",
              "pr": {"patch": "pr.patch", "title": "Make the total 5", "body": "Sets TOTAL."}, "seed": seed}
        if witness:
            write(folder, "witness/test_witness.py", WITNESS)
            sc["witness"] = {"dir": "witness", "to": "tests"}
        if clean:
            sc["clean"] = clean
        sc.update(more)
        write_json(os.path.join(folder, "scenario.json"), sc)
        write_json(os.path.join(folder, "expected.json"), {"own_exit_head": 0, "witness_exit_head": None, "witness_exit_clean": None, "clean": None})
        return folder

    def seed(self, **kw):
        return {"type": "logic", "quiet": True, "check": "witness", "match": "(?i)total", "origin": "seeded", **kw}

    def check(self, sid, *extra):
        argv = ["--check-scenarios", "--scenarios-dir", self.scen, "--scenarios", sid, "--source-repo", self.src] + list(extra)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = HR.main(argv)
        return code, out.getvalue()

    def stub_base(self):
        self.make_scenario(grade=UNITTEST_GRADE)


class ReviewLoadTest(ReviewItemCase):
    def test_an_item_takes_its_source_issue_setup_and_grade_from_the_base(self):
        self.stub_base()
        self.make_item("rv-clean")
        sc = HR.load_scenario(os.path.join(self.scen, "rv-clean"))
        self.assertEqual((sc["kind"], sc["source"], sc["issue"]["number"]), ("review", {"commit": self.parent}, 12))
        self.assertEqual(sc["grade"], {**UNITTEST_GRADE})
        self.assertEqual([s["id"] for s in sc["slices"]], ["S1"])
        self.assertEqual(sc["pr"]["body_text"], "Sets TOTAL.")
        self.assertTrue(os.path.isabs(sc["issue"]["file"]))

    def test_a_body_file_is_read(self):
        self.stub_base()
        folder = self.make_item("rv-clean", extra_files={"body.md": "From a file.\n"})
        sc = read_json(os.path.join(folder, "scenario.json"))
        sc["pr"]["body"] = {"file": "body.md"}
        write_json(os.path.join(folder, "scenario.json"), sc)
        self.assertEqual(HR.load_scenario(folder)["pr"]["body_text"], "From a file.\n")

    def test_bad_items_are_rejected(self):
        self.stub_base()
        cases = {
            "no patch file": lambda sc: sc["pr"].update(patch="gone.patch"),
            "bad seed type": lambda sc: sc.update(seed=self.seed(type="weird")),
            "seed quiet not bool": lambda sc: sc.update(seed=self.seed(quiet="yes")),
            "bad match": lambda sc: sc.update(seed=self.seed(match="(")),
            "bad origin": lambda sc: sc.update(seed=self.seed(origin="made up")),
            "witness without witness key": lambda sc: sc.update(seed=self.seed()),
            "quiet without witness": lambda sc: sc.update(seed=self.seed(check="none")),
            "witness on a clean item": lambda sc: sc.update(witness={"dir": "witness", "to": "tests"}),
            "base missing": lambda sc: sc.update(base="../nowhere"),
        }
        for name, change in cases.items():
            folder = self.make_item("rv-bad")
            write(folder, "witness/test_witness.py", WITNESS)
            sc = read_json(os.path.join(folder, "scenario.json"))
            change(sc)
            write_json(os.path.join(folder, "scenario.json"), sc)
            with self.assertRaises(HR.RunnerError, msg=name):
                HR.load_scenario(folder)


class ReviewCheckTest(ReviewItemCase):
    def setUp(self):
        super().setUp()
        self.stub_base()
        self.make_item("rv-clean")

    def test_a_clean_item_passes_and_expected_json_is_written_and_then_matches(self):
        os.remove(os.path.join(self.scen, "rv-clean", "expected.json"))
        code, out = self.check("rv-clean")
        self.assertEqual(code, 1, out)
        self.assertIn("no expected.json", out)
        code, out = self.check("rv-clean", "--update-expected")
        self.assertEqual(code, 0, out)
        self.assertEqual(read_json(os.path.join(self.scen, "rv-clean", "expected.json")),
                         {"own_exit_head": 0, "witness_exit_head": None, "witness_exit_clean": None, "clean": None})
        self.assertEqual(self.check("rv-clean")[0], 0)

    def test_a_quiet_seed_with_a_witness_that_fails_at_the_head_and_passes_at_the_twin_is_accepted(self):
        self.make_item("rv-bug", patch=BUG_PATCH, seed=self.seed(), witness=True, clean="rv-clean")
        code, out = self.check("rv-bug", "--update-expected")
        self.assertEqual(code, 0, out)
        self.assertEqual(read_json(os.path.join(self.scen, "rv-bug", "expected.json")),
                         {"own_exit_head": 0, "witness_exit_head": 1, "witness_exit_clean": 0, "clean": "rv-clean"})

    def test_a_witness_that_passes_at_the_head_is_rejected(self):
        self.make_item("rv-bug", patch=PR_PATCH, seed=self.seed(), witness=True, clean="rv-clean")
        code, out = self.check("rv-bug")
        self.assertEqual(code, 1)
        self.assertIn("witness must fail at the PR head", out)

    def test_a_witness_that_fails_at_the_clean_twin_is_rejected(self):
        self.make_item("rv-bug", patch=BUG_PATCH, seed=self.seed(), witness=True, clean="rv-also-bug")
        self.make_item("rv-also-bug", patch=BUG_PATCH)
        code, out = self.check("rv-bug")
        self.assertEqual(code, 1)
        self.assertIn("witness must pass at the clean twin", out)

    def test_a_missing_twin_is_a_problem(self):
        self.make_item("rv-bug", patch=BUG_PATCH, seed=self.seed(), witness=True, clean="rv-nowhere")
        code, out = self.check("rv-bug")
        self.assertEqual(code, 1)
        self.assertIn("clean twin rv-nowhere not found", out)

    def test_a_loud_seed_marked_quiet_is_rejected(self):
        self.make_item("rv-loud", patch=LOUD_PATCH, seed=self.seed(), witness=True, clean="rv-clean")
        code, out = self.check("rv-loud")
        self.assertEqual(code, 1)
        self.assertIn("own suite must pass at the head", out)

    def test_a_loud_seed_is_accepted_and_a_quiet_one_marked_loud_is_rejected(self):
        self.make_item("rv-loud", patch=LOUD_PATCH, seed=self.seed(quiet=False, check="none"))
        self.assertEqual(self.check("rv-loud", "--update-expected")[0], 0)
        self.make_item("rv-bug", patch=BUG_PATCH, seed=self.seed(quiet=False, check="none"))
        code, out = self.check("rv-bug")
        self.assertEqual(code, 1)
        self.assertIn("own suite must fail at the head", out)

    def test_a_clean_item_whose_own_suite_fails_is_rejected(self):
        self.make_item("rv-sick", patch=LOUD_PATCH)
        code, out = self.check("rv-sick")
        self.assertEqual(code, 1)
        self.assertIn("own suite must pass", out)

    def test_a_patch_that_does_not_apply_is_a_problem(self):
        self.make_item("rv-broken", patch="--- a/nothing.py\n+++ b/nothing.py\n@@ -1 +1 @@\n-x\n+y\n")
        code, out = self.check("rv-broken")
        self.assertEqual(code, 1)
        self.assertIn("problem", out)


class ReviewRunTest(ReviewItemCase):
    def setUp(self):
        super().setUp()
        self.stub_base()
        write(self.scen, "rv-bug/overlay/NOTE.md", "rule\n")
        self.make_item("rv-bug", patch=BUG_PATCH, seed=self.seed(match="(?i)wrong total"), witness=True, clean="rv-clean",
                       baseOverlay={"dir": "overlay"})
        self.make_item("rv-clean")

    def run_dir(self, arm="A", k=1, sid="rv-bug"):
        return os.path.join(self.results, sid, arm, f"r{k}")

    def review_run(self, sid="rv-bug", report=None, arm="A"):
        if report is not None:
            self.behave(review={"report": report})
        return self.matrix(scenarios=sid, arms=arm)

    def test_only_the_reviewer_runs_on_the_prs_head_and_its_record_is_written(self):
        report = "```report\nstatus: done\nverdict: changes\nhead: abc1234\n```\n**Blockers**\n1. Wrong total: TOTAL stays 0.\n\n**Nits**\n- none\n"
        code, out, err = self.review_run(report=report)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.kinds(), ["review"])
        rec = self.run_json()
        self.assertEqual(rec["status"], "done")
        self.assertFalse(rec["grade"]["ran"])
        self.assertEqual([s["id"] for s in rec["slices"]], ["S1"])
        s = rec["slices"][0]
        self.assertEqual((s["branch"], s["pr"], s["fix_rounds"]), ("issue-12-review", 13, 0))
        run = self.run_dir(sid="rv-bug")
        self.assertEqual(s["head"], git(run, "--git-dir", os.path.join(run, "remote.git"), "rev-parse", "issue-12-review"))
        r = rec["review"]
        self.assertEqual((r["item"], r["seed_type"], r["quiet"]), ("rv-bug", "logic", True))
        self.assertEqual((r["verdict"], r["how"], r["blockers"]), ("changes", "header", 1))
        self.assertEqual(r["blockers_text"], "1. Wrong total: TOTAL stays 0.")
        self.assertTrue(r["matched_blockers"] and r["matched_report"])
        self.assertEqual((r["cost"], r["turns"]), (0.1, 1))
        self.assertGreater(r["wall"], 0)

    def test_the_pr_is_a_commit_on_the_base_and_the_shim_serves_it(self):
        self.review_run()
        run = self.run_dir()
        remote = os.path.join(run, "remote.git")
        self.assertEqual(git(run, "--git-dir", remote, "log", "-1", "--format=%s", "issue-12-review"), "Make the total 5")
        self.assertEqual(git(run, "--git-dir", remote, "rev-list", "--count", "main..issue-12-review"), "1")
        # the overlay is in the Base commit
        self.assertEqual(git(run, "--git-dir", remote, "show", "main:NOTE.md"), "rule")
        env = {**os.environ, "HRD_EVAL_GH_STATE": os.path.join(run, "gh")}
        view = json.loads(subprocess.run([sys.executable, os.path.join(SHIM_BIN, "gh"), "pr", "view", "13", "--json", "title,body,headRefName"],
                                         cwd=os.path.join(run, "work"), env=env, capture_output=True, text=True, check=True).stdout)
        self.assertEqual(view, {"title": "Make the total 5", "body": "Sets TOTAL.", "headRefName": "issue-12-review"})
        diff = subprocess.run([sys.executable, os.path.join(SHIM_BIN, "gh"), "pr", "diff", "13"], cwd=os.path.join(run, "work"),
                              env=env, capture_output=True, text=True, check=True).stdout
        self.assertIn("+EXTRA = 1", diff)
        # the reviewer's worktree is at the PR head
        call = self.fake_calls()[0]
        self.assertTrue(call["cwd"].endswith("wt-S1"))
        self.assertEqual(read_text(os.path.join(call["cwd"], "shop.py")), "TOTAL = 0\nEXTRA = 1\n")
        self.assertIn("Review PR #13 for issue #12", call["prompt"])

    def test_a_blocked_review_without_a_match_and_an_approve_that_mentions_it(self):
        self.review_run(report="```report\nstatus: done\nverdict: changes\n```\n**Blockers**\n1. Style.\n\n**Nits**\n- wrong total maybe\n")
        r = read_json(os.path.join(self.run_dir(), "run.json"))["review"]
        self.assertEqual(r["verdict"], "changes")
        self.assertFalse(r["matched_blockers"])
        self.assertTrue(r["matched_report"])
        shutil.rmtree(self.results)
        self.review_run(report="```report\nstatus: done\nverdict: approve\n```\nNit: wrong total in a comment.")
        r = read_json(os.path.join(self.run_dir(), "run.json"))["review"]
        self.assertEqual(r["verdict"], "approve")

    def test_an_unparsed_review_and_a_clean_item_record_their_fields(self):
        self.review_run(sid="rv-clean", report="I looked at it.")
        r = read_json(os.path.join(self.run_dir(sid="rv-clean"), "run.json"))["review"]
        self.assertEqual((r["verdict"], r["how"], r["blockers"]), (None, "none", None))
        self.assertEqual((r["seed_type"], r["quiet"], r["matched_blockers"], r["matched_report"]), (None, None, False, False))
        self.assertEqual(read_json(os.path.join(self.run_dir(sid="rv-clean"), "run.json"))["status"], "done")

    def test_the_reviewer_call_uses_the_arms_pinned_agent(self):
        write(self.tmp, "repo/agents/reviewer.md", AgentsArmTest.AGENT)
        arms_dir = os.path.join(self.tmp, "arms")
        write_json(os.path.join(arms_dir, "P.json"), {"profiles": CONFIG["profiles"], "agents": {"reviewer": "agents/reviewer.md"}})
        orig = HR.load_arms
        with mock.patch.object(HR, "load_arms", lambda *a, **k: orig(*a, **{**k, "repo": os.path.join(self.tmp, "repo")})):
            code, _, err = self.matrix(scenarios="rv-clean", arms="P", arms_dir=arms_dir)
        self.assertEqual(code, 0, err)
        argv = self.fake_calls()[0]["argv"]
        self.assertEqual(argv[argv.index("--agent") + 1], "hrd-eval-reviewer")
        run = self.run_dir(arm="P", sid="rv-clean")
        self.assertIn(f"--agents={run}/agents.json", argv)
        self.assertEqual(read_json(os.path.join(run, "agents.json"))["hrd-eval-reviewer"]["prompt"], "You are the reviewer.\n\nBe strict.")


class ReviewDryRunTest(ReviewItemCase):
    def test_the_estimate_is_the_reviewers_only(self):
        self.stub_base()
        self.make_item("rv-clean")
        arm = HR.load_arms(ARMS, ["A"], self.config)["A"]
        sc = HR.load_scenario(os.path.join(self.scen, "rv-clean"))
        self.assertEqual(HR.run_estimate(sc, arm["profiles"]), HR.estimate(arm["profiles"]["reviewer"]))
        argv = ["--dry-run", "--scenarios-dir", self.scen, "--scenarios", "rv-clean", "--arms", "A", "--config", self.config,
                "--source-repo", self.src, "--results", self.results, "--repeats", "2"]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = HR.main(argv)
        self.assertEqual(code, 0)
        self.assertIn("scenario rv-clean (review, 1 slice(s))", out.getvalue())
        self.assertIn(f"arm A: ${HR.estimate(arm['profiles']['reviewer']):.2f} per run", out.getvalue())
        self.assertFalse(os.path.exists(self.results))


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


class GradeParsersTest(unittest.TestCase):
    def test_the_runner_has_no_copy_of_the_plugin_row_parser(self):
        # Grade rows are read by score.py's parse_plugin_test (its rows are tested in test_hrd_eval_score.py); a second
        # copy here could drift from it. CheckScenariosTest reads the rows through the runner's check.
        self.assertFalse(hasattr(HR, "plugin_rows"))
        self.assertFalse(hasattr(HR, "PLUGIN_ROW"))
        self.assertFalse(hasattr(HR, "PLUGIN_MS"))


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
            self.assertIn(os.path.join(run.dir, "bin"), f.read())
        # the run's own copy of the shim: a worker's sandbox cannot read this repo
        self.assertEqual(read_text(os.path.join(run.dir, "bin", "gh")), read_text(os.path.join(SHIM_BIN, "gh")))
        self.assertTrue(os.access(os.path.join(run.dir, "bin", "gh"), os.X_OK))
        issue = read_json(os.path.join(run.dir, "gh", "issues", "12.json"))
        self.assertEqual((issue["state"], issue["url"]), ("OPEN", "https://github.com/hrd-eval/replay-test/issues/12"))

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
        # the builder's gh resolves to the run's copy of the shim
        builder = [e for e in self.fake_calls() if e["kind"] == "build"][0]
        self.assertEqual(builder["gh"], os.path.join(self.run_dir(), "bin", "gh"))
        # the hidden tests ran in the grade, then were taken out of it: a later run's workers could read them there
        self.assertFalse(os.path.exists(os.path.join(self.run_dir(), "grade", "tests", "test_hidden.py")))
        self.assertTrue(os.path.exists(os.path.join(self.run_dir(), "grade", "tests", "test_own.py")))

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
        self.assertEqual(run["decisions"][0]["how"], "recommended")
        self.assertEqual(run["questions"], {"recommended": 1, "auto": 0, "unanswered": 0, "stop": 0})
        self.assertEqual(run["status"], "done")

    def test_past_two_answers_a_question_gets_the_no_owner_answer_once_then_the_run_carries_on_and_is_graded(self):
        # contract/B2 (20261026-172215) ended at the third question, ungraded. Past the cap the asker gets one answer
        # with no owner answer in it, then its questions go unanswered; the review and the grade still happen.
        self.behave(
            build={"report": "DECISION: First? | A (recommended) | B"},
            answer=[
                {"report": "DECISION: Second? | C (recommended) | D"},
                {"report": "DECISION: Third? | E (recommended) | F"},
                {"report": "DECISION: Fourth? | G (recommended) | H"},
            ],
        )
        code, out, _ = self.matrix()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.kinds(), ["plan", "build", "answer", "answer", "answer", "review"])
        run = self.run_json()
        self.assertEqual(run["status"], "done")
        self.assertEqual([d["answered"] for d in run["decisions"]], ["A", "C", NO_OWNER, None])
        self.assertEqual([d["how"] for d in run["decisions"]], ["recommended", "recommended", "auto", "unanswered"])
        self.assertEqual(run["questions"], {"recommended": 2, "auto": 1, "unanswered": 1, "stop": 0})
        self.assertTrue(run["grade"]["ran"])
        prompts = [e["prompt"] for e in self.fake_calls() if e["kind"] == "answer"]
        self.assertIn(f"Answers to your DECISION questions: Third? -> {NO_OWNER}. No more answers will come in this run", prompts[2])

    def test_past_the_cap_a_reviewer_that_asks_still_gives_its_verdict_and_the_other_slice_goes_on(self):
        slices = [{"id": "S1", "brief": "the server"}, {"id": "S2", "brief": "the client"}]
        self.make_scenario(slices=slices)
        ask = "```report\nstatus: done\nsummary: x\nask: {}\n```"
        self.behave(
            plan={"report": ask.format("Which fields?")},
            answer=[{"report": ask.format("Really which fields?")}, {"report": "Done.\n\nVERDICT: approve"}],
            review={"report": ask.format("Fix one contract?") + "\n\nVERDICT: approve"},
        )
        code, out, _ = self.matrix()
        self.assertEqual(code, 0, out)
        run = self.run_json()
        self.assertEqual(run["status"], "done")
        self.assertEqual(sorted(s["pr"] for s in run["slices"]), [13, 14])
        self.assertTrue(all(s["reviews"] and s["reviews"][-1]["verdict"] == "approve" for s in run["slices"]))
        self.assertTrue(run["grade"]["merged"])
        self.assertEqual(run["questions"]["recommended"], 2)
        self.assertGreaterEqual(run["questions"]["auto"], 1)

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
        code, _, _ = self.matrix("--arms", "A,B", "--max-cost", "2.65", "--jobs", "1")  # B starts after A
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

    def test_every_prompt_carries_the_report_header_rule(self):
        self.matrix()
        calls = self.fake_calls()
        self.assertTrue(calls)
        for call in calls:
            self.assertIn("\n```report\nstatus: done\npr: 123\n", call["prompt"], call["kind"])
            self.assertRegex(call["prompt"], r"Its first line must be exactly: <!-- report \w+ -->")

    def test_a_decision_below_a_report_header_is_found_and_stops_the_run(self):
        self.make_scenario(on_decision="stop")
        report = "```report\nstatus: done\nsummary: Built.\n```\n\nDECISION: Stack? | Yes (recommended) | No"
        self.behave(build={"report": report})
        self.matrix()
        run = self.run_json()
        self.assertEqual(run["status"], "decision")
        self.assertEqual(run["decisions"][0]["text"], "Stack? | Yes (recommended) | No")

    def test_a_header_pr_that_no_call_made_ends_the_run_as_no_pr(self):
        self.behave(build={"pr": None, "report": "```report\nstatus: done\npr: 13\nsummary: Built.\n```"})
        self.matrix()
        run = self.run_json()
        self.assertEqual(run["status"], "no_pr")
        self.assertIsNone(run["slices"][0]["pr"])

    def test_a_header_pr_in_the_shim_state_that_no_call_made_is_the_slices_pr(self):
        # PR 13 is in the shim's state before the builder's report is read, its head is not the slice branch, and no gh
        # call opened it in this run. The builder's header names it, so the run takes it and goes on to review.
        pr = {
            "number": 13,
            "title": "Make the total 5",
            "body": "Body",
            "state": "OPEN",
            "isDraft": False,
            "headRefName": "owner-total-fix",
            "baseRefName": "main",
            "author": {"login": "hrd-eval"},
            "labels": [],
            "comments": [],
            "reviews": [],
            "createdAt": "2026-10-01T00:00:00Z",
            "updatedAt": "2026-10-01T00:00:00Z",
            "mergedAt": None,
            "mergeCommit": None,
            "autoMergeRequest": None,
        }
        report = "```report\nstatus: done\npr: 13\nsummary: Built.\n```"
        self.behave(build={"pr": None, "shim_pr": pr, "report": report})
        code, out, _ = self.matrix()
        self.assertEqual(code, 0, out)
        run = self.run_json()
        self.assertEqual(run["slices"][0]["pr"], 13)
        self.assertEqual(run["status"], "done")
        self.assertEqual(self.kinds(), ["plan", "build", "review"])

    def test_every_job_folder_keeps_the_full_rule_in_reporting_md(self):
        self.behave(build={"report": "Built.\nDECISION: Stack? | Yes (recommended) | No"})
        self.matrix()
        calls = self.calls()
        self.assertEqual([c["kind"] for c in calls], ["plan", "build", "answer", "review"])
        for call in calls:
            folder = os.path.join(self.run_dir(), call["job"])
            rules = read_text(os.path.join(folder, "REPORTING.md"))
            token = reporting_token(folder)
            self.assertEqual(rules, HR.report_rule(folder, token), call["job"])
            self.assertNotIn("WAIT.json", rules)
            prompt = read_text(os.path.join(folder, "prompt.txt"))
            if call["resumed"]:
                self.assertTrue(prompt.endswith(HR.report_reminder(folder, token)), call["job"])
            else:
                self.assertIn(rules, prompt, call["job"])

    def test_arm_c_fix_carries_the_short_reminder_and_its_folder_keeps_the_full_rule(self):
        self.behave(review=[{"report": "VERDICT: changes needed, 1 blocker"}, {"report": "VERDICT: approve"}])
        self.matrix(arms="C", arms_dir=ARMS)
        call = next(c for c in self.calls("C") if c["kind"] == "fix")
        folder = os.path.join(self.run_dir("C"), call["job"])
        token = reporting_token(folder)
        fix = next(e for e in self.fake_calls() if e["kind"] == "fix")
        self.assertTrue(fix["resumed"])
        self.assertTrue(fix["prompt"].endswith(HR.report_reminder(folder, token)))
        self.assertNotIn("When you are completely finished", fix["prompt"])
        self.assertEqual(read_text(os.path.join(folder, "REPORTING.md")), HR.report_rule(folder, token))

    def test_an_answer_call_carries_the_short_reminder_not_the_full_rule(self):
        self.behave(build={"report": "Built.\nDECISION: Stack? | Yes (recommended) | No"})
        self.matrix()
        call = next(c for c in self.calls() if c["kind"] == "answer")
        folder = os.path.join(self.run_dir(), call["job"])
        answer = next(e for e in self.fake_calls() if e["kind"] == "answer")
        self.assertTrue(answer["prompt"].endswith("Carry on. " + HR.report_reminder(folder, reporting_token(folder))))
        self.assertNotIn("When you are completely finished", answer["prompt"])

    def test_an_ask_header_with_onDecision_stop_ends_the_run_with_status_decision(self):
        self.make_scenario(on_decision="stop")
        report = "```report\nstatus: done\nsummary: Built.\nask: Do member and bulk discounts stack?\n```"
        self.behave(build={"report": report})
        self.matrix()
        self.assertEqual(self.kinds(), ["plan", "build"])
        run = self.run_json()
        self.assertEqual(run["status"], "decision")
        build = next(c for c in self.calls() if c["kind"] == "build")
        self.assertEqual(
            run["decisions"],
            [{"call": build["n"], "role": "builder", "text": "Do member and bulk discounts stack?", "answered": None,
              "how": "stop"}],
        )

    def test_an_ask_header_is_answered_with_no_owner_answer_under_recommended(self):
        report = "```report\nstatus: done\nsummary: Built.\nask: Do member and bulk discounts stack?\n```"
        self.behave(build={"report": report})
        self.matrix()
        self.assertEqual(self.kinds(), ["plan", "build", "answer", "review"])
        prompt = next(e["prompt"] for e in self.fake_calls() if e["kind"] == "answer")
        self.assertIn(
            f"Answers to your DECISION questions: Do member and bulk discounts stack? -> {NO_OWNER}. Carry on.", prompt
        )
        build = next(c for c in self.calls() if c["kind"] == "build")
        run = self.run_json()
        self.assertEqual(run["status"], "done")
        self.assertEqual(
            run["decisions"],
            [{"call": build["n"], "role": "builder", "text": "Do member and bulk discounts stack?", "answered": NO_OWNER,
              "how": "recommended"}],
        )

    def test_an_ask_and_a_decision_in_one_report_share_one_answer_call(self):
        report = "```report\nstatus: done\nsummary: Built.\nask: Which base branch?\n```\n\nDECISION: Stack? | Yes (recommended) | No"
        self.behave(build={"report": report})
        self.matrix()
        self.assertEqual(self.kinds(), ["plan", "build", "answer", "review"])
        prompt = next(e["prompt"] for e in self.fake_calls() if e["kind"] == "answer")
        self.assertIn(f"Answers to your DECISION questions: Which base branch? -> {NO_OWNER}; Stack? -> Yes. Carry on.", prompt)
        run = self.run_json()
        self.assertEqual([d["text"] for d in run["decisions"]], ["Which base branch?", "Stack? | Yes (recommended) | No"])
        self.assertEqual([d["answered"] for d in run["decisions"]], [NO_OWNER, "Yes"])

    def test_an_ask_counts_toward_the_two_answers_a_run_gets(self):
        ask = "```report\nstatus: done\nsummary: Carry on.\nask: {}\n```"
        self.behave(build={"report": ask.format("First?")}, answer=[{"report": ask.format("Second?")}, {"report": ask.format("Third?")}])
        self.matrix()
        self.assertEqual(self.kinds(), ["plan", "build", "answer", "answer", "answer", "review"])
        run = self.run_json()
        self.assertEqual(run["status"], "done")
        self.assertEqual([d["text"] for d in run["decisions"]], ["First?", "Second?", "Third?", "Third?"])
        self.assertEqual([d["how"] for d in run["decisions"]], ["recommended", "recommended", "auto", "unanswered"])

    def test_an_ask_of_none_n_a_or_nothing_is_no_question(self):
        for value in ("none", "N/A", ""):
            with self.subTest(value=value):
                shutil.rmtree(self.results, ignore_errors=True)
                self.behave(build={"report": f"```report\nstatus: done\nsummary: Built.\nask: {value}\n```"})
                self.matrix()
                self.assertEqual(self.kinds(), ["plan", "build", "review"])
                self.assertEqual(self.run_json()["decisions"], [])

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
        # plan (opus, estimate 0.30) then build (haiku, 0.06) fit under 1.63; the plan really cost 1.5, so review (0.30) does not
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

    def test_a_slice_that_conflicts_is_left_out_and_the_rest_is_graded(self):
        slices = [{"id": "S1", "brief": "the total"}, {"id": "S2", "brief": "the same total again"}]
        self.make_scenario(slices=slices)
        self.behave(by_dir={
            "wt-S1": {"build": {"commit": {"file": "shop.py", "text": "TOTAL = 5\n"}}},
            "wt-S2": {"build": {"commit": {"file": "shop.py", "text": "TOTAL = 7\n"}}},
        })
        self.matrix()
        run = self.run_json()
        self.assertFalse(run["grade"]["merged"])
        self.assertRegex(run["grade"]["merge_error"], r"^issue-12-s\d: ")
        self.assertTrue(run["grade"]["ran"])
        self.assertTrue(os.path.exists(os.path.join(self.run_dir(), "grade", "hidden.txt")))

    def test_two_slices_that_both_add_to_the_changelog_merge_as_a_union(self):
        # contract/R and contract/B2 (20261026-172215): both slices added a CHANGELOG.md line, so the grade never ran.
        slices = [{"id": "S1", "brief": "the server"}, {"id": "S2", "brief": "the client"}]
        self.make_scenario(slices=slices)
        self.behave(by_dir={
            "wt-S1": {"build": {"commit": {"file": "CHANGELOG.md", "text": "# Changelog\n\n- The server quotes.\n"}}},
            "wt-S2": {"build": {"commit": {"file": "CHANGELOG.md", "text": "# Changelog\n\n- The client quotes.\n"}}},
        })
        self.matrix()
        run = self.run_json()
        self.assertTrue(run["grade"]["merged"], run["grade"]["merge_error"])
        self.assertTrue(run["grade"]["ran"])
        changelog = read_text(os.path.join(self.run_dir(), "grade", "CHANGELOG.md"))
        self.assertIn("- The server quotes.", changelog)
        self.assertIn("- The client quotes.", changelog)

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

    def test_one_slice_plan_asks_for_one_pr(self):
        self.make_scenario()
        self.matrix()
        plan_prompt = next(e["prompt"] for e in self.fake_calls() if e["kind"] == "plan")
        self.assertIn("Plan it as one PR: one builder builds all of it.", plan_prompt)
        self.assertNotIn("Split it into", plan_prompt)

    def test_two_arms_at_once_each_get_their_run(self):
        code, _, _ = self.matrix("--jobs", "2", arms="A,B")
        self.assertEqual(code, 0)
        for arm in ("A", "B"):
            run = self.run_json(arm)
            self.assertEqual(run["status"], "done", f"arm {arm}: {run['error']}")

    def test_two_runs_call_the_model_at_once_but_their_grades_take_turns(self):
        spans = os.path.join(self.tmp, "grade-spans")
        grader = (f"import time, json\nt = time.time()\ntime.sleep(0.6)\n"
                  f"open({spans!r}, 'a').write(json.dumps([t, time.time()]) + '\\n')\nprint('(pass) own test [1ms]')")
        self.make_scenario(grade={"cmd": ["python3", "-c", grader], "parser": "plugin-test", "timeout": 60})
        self.behave(build={"sleep": 1.5})
        code, out, err = self.matrix("--jobs", "2", arms="A,B")
        self.assertEqual(code, 0, err)

        def read_spans(path):
            with open(path, encoding="utf-8") as f:
                return sorted(json.loads(line) for line in f if line.strip())

        calls = read_spans(self.log + ".spans")
        self.assertEqual(len(calls), 2)
        self.assertLess(calls[1][0], calls[0][1])  # the second build started before the first one ended
        grades = read_spans(spans)
        self.assertGreaterEqual(len(grades), 2)  # own tests and hidden tests, per run
        for before, after in zip(grades, grades[1:]):
            self.assertGreaterEqual(after[0], before[1])  # no two grades overlap

    def test_jobs_is_shown_in_the_dry_run_and_defaults_to_four(self):
        _, out, _ = self.matrix("--dry-run")
        self.assertIn("jobs 4", out)
        _, out, _ = self.matrix("--dry-run", "--jobs", "2")
        self.assertIn("jobs 2", out)
        code, _, err = self.matrix("--jobs", "0")
        self.assertEqual(code, 1)
        self.assertIn("--jobs", err)

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


class HiddenCleanupTest(RunnerCase):
    def test_the_hidden_tests_leave_the_grade_folder_when_a_grade_raises(self):
        real = HR.run_grade
        seen = []

        def boom(cmd, cwd, timeout_s, env):
            if os.path.exists(os.path.join(cwd, "tests", "test_hidden.py")):
                seen.append(True)
                raise RuntimeError("boom")
            return real(cmd, cwd, timeout_s, env)

        with mock.patch.object(HR, "run_grade", boom):
            self.matrix()
        self.assertTrue(seen, "the grade never ran with the hidden tests")
        self.assertFalse(os.path.exists(os.path.join(self.run_dir(), "grade", "tests", "test_hidden.py")))


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
        os.remove(os.path.join(self.scen, "replay-test", "expected.json"))  # make_scenario wrote an empty one
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("drift: no expected.json", out)
        code, out = self.check("--update-expected")
        self.assertEqual(code, 0, out)
        self.assertIn("expected.json written", out)
        expected = read_json(os.path.join(self.scen, "replay-test", "expected.json"))
        self.assertEqual(expected, {"tests": ["hidden test", "own test"], "discriminating": ["hidden test"], "flaky": []})
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
            {"tests": ["hidden test", "own test"], "discriminating": ["hidden test"], "flaky": []},
        )


# A grader whose "flaky row" fails on every other run (a counter file named by FLAKE_COUNTER) and whose "broken row"
# fails when BROKEN is set; the "hidden test" row is the discriminating one, as in STUB.
FLAKY_STUB = """import os, sys
sys.path.insert(0, os.getcwd())
import shop
path = os.environ["FLAKE_COUNTER"]
n = int(open(path).read()) if os.path.exists(path) else 0
open(path, "w").write(str(n + 1))
rows = [("pass", "own test"), ("fail" if n % 2 else "pass", "flaky row"), ("fail" if os.environ.get("BROKEN") else "pass", "broken row")]
if os.path.exists(os.path.join("tests", "test_hidden.py")):
    rows.append(("pass" if shop.TOTAL == 5 else "fail", "hidden test"))
for state, name in rows:
    print(f"({state}) {name} [1.0ms]")
sys.exit(1 if any(s == "fail" for s, _ in rows) else 0)
"""


class FlakeTest(RunnerCase):
    def fixture(self, known=None):
        folder = os.path.join(self.scen, "flake-test")
        write(folder, "source/shop.py", "TOTAL = 0\n")
        write(folder, "source/grade_stub.py", FLAKY_STUB)
        write(folder, "hidden/test_hidden.py", HIDDEN_TEST)
        write(folder, "solution.patch", "--- a/shop.py\n+++ b/shop.py\n@@ -1 +1 @@\n-TOTAL = 0\n+TOTAL = 5\n")
        write_json(os.path.join(folder, "issue.json"), {"number": 12, "title": "t", "body": "b"})
        sc = {
            "title": "flaky fixture",
            "kind": "fixture",
            "issue": {"number": 12, "file": "issue.json"},
            "source": {"dir": "source"},
            "hidden": {"dir": "hidden", "to": "tests"},
            "grade": {"cmd": ["python3", "grade_stub.py"], "parser": "plugin-test", "timeout": 60},
        }
        if known is not None:
            sc["knownFlaky"] = known
        write_json(os.path.join(folder, "scenario.json"), sc)
        return folder

    def check(self, *extra, env=None):
        argv = ["--check-scenarios", "--scenarios-dir", self.scen, "--scenarios", "flake-test", "--source-repo", self.src]
        out = io.StringIO()
        patch = {"FLAKE_COUNTER": os.path.join(self.tmp, "counter"), **(env or {})}
        with mock.patch.dict(os.environ, patch), contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = HR.main(argv + list(extra))
        return code, out.getvalue()

    def test_a_test_that_fails_in_some_runs_only_is_recorded_flaky_and_is_no_problem(self):
        folder = self.fixture(known=["own test"])
        code, out = self.check("--update-expected", "--flake-runs", "3")
        self.assertEqual(code, 0, out)
        self.assertIn("3 run(s) each", out)
        self.assertEqual(
            read_json(os.path.join(folder, "expected.json")),
            {"tests": ["broken row", "flaky row", "hidden test", "own test"], "discriminating": ["hidden test"],
             "flaky": ["flaky row", "own test"]},  # seen failing in some runs, and the scenario's knownFlaky
        )
        code, out = self.check()  # one run: the flake does not show, which is a note, not drift
        self.assertEqual(code, 0, out)
        self.assertIn("note: flaky: these runs have ['own test']", out)

    def test_a_test_that_fails_in_every_reference_run_is_a_problem(self):
        self.fixture()
        code, out = self.check("--update-expected", "--flake-runs", "2", env={"BROKEN": "1"})
        self.assertEqual(code, 1)
        self.assertIn("reference + overlay must pass", out)
        self.assertIn("broken row", out)

    def test_known_flaky_must_name_a_reference_test(self):
        self.fixture(known=["no such test"])
        code, out = self.check("--flake-runs", "2")
        self.assertEqual(code, 1)
        self.assertIn("knownFlaky names tests the reference does not have: ['no such test']", out)

    def test_flake_runs_goes_with_check_scenarios(self):
        code, _, err = self.matrix("--dry-run", "--flake-runs", "3")
        self.assertEqual(code, 1)
        self.assertIn("--flake-runs goes with --check-scenarios", err)


class GradeRetryTest(RunnerCase):
    def test_a_hidden_grade_that_fails_once_runs_again_and_the_better_try_is_kept(self):
        # replay-13/R (20261026-172215) failed one timed test that took 5 s on a busy machine and passes alone.
        stub = os.path.join(self.tmp, "once.py")
        write(self.tmp, "once.py", (
            "import os, sys\n"
            "path = os.environ['FLAKE_COUNTER']\n"
            "n = int(open(path).read()) if os.path.exists(path) else 0\n"
            "open(path, 'w').write(str(n + 1))\n"
            "hidden = os.path.exists(os.path.join('tests', 'test_hidden.py'))\n"
            "bad = hidden and n == 1\n"  # run 0 is the own-tests run; the first hidden run (1) fails
            "print('(fail) timed test' if bad else '(pass) timed test')\n"
            "sys.exit(1 if bad else 0)\n"
        ))
        self.make_scenario(grade={"cmd": ["python3", stub], "parser": "plugin-test", "timeout": 60})
        with mock.patch.dict(os.environ, {"FLAKE_COUNTER": os.path.join(self.tmp, "counter")}):
            code, out, _ = self.matrix()
        self.assertEqual(code, 0, out)
        run = self.run_json()
        self.assertEqual((run["grade"]["tries"], run["grade"]["exit"]), (2, 0))
        self.assertIn("(pass) timed test", read_text(os.path.join(self.run_dir(), "grade", "hidden.txt")))
        self.assertIn("(fail) timed test", read_text(os.path.join(self.run_dir(), "grade", "hidden-try1.txt")))


class BestTryTest(unittest.TestCase):
    @staticmethod
    def parse(text):
        return dict(line.split(":") for line in text.split() if ":" in line)

    def test_a_try_with_no_rows_does_not_beat_a_try_with_one_real_failure(self):
        timed_out = (124, "timed out after 60 s\n")
        one_fail = (1, "a:pass b:fail")
        self.assertIs(HR.best_try([timed_out, one_fail], self.parse, ["a", "b"]), one_fail)
        self.assertIs(HR.best_try([one_fail, timed_out], self.parse, ["a", "b"]), one_fail)

    def test_with_no_expected_tests_an_empty_try_has_no_failures(self):
        timed_out = (124, "")
        one_fail = (1, "a:fail")
        self.assertIs(HR.best_try([timed_out, one_fail], self.parse, []), timed_out)

    def test_the_first_try_wins_a_tie(self):
        a, b = (1, "a:fail"), (1, "b:fail")
        self.assertIs(HR.best_try([a, b], self.parse, []), a)


class IsolationTest(RunnerCase):
    def test_the_installed_mods_the_source_repo_its_worktree_folder_and_old_results_are_unreadable(self):
        wt_parent = os.path.join(self.tmp, "source-wt")
        git(self.src, "worktree", "add", "-q", "-b", "side", os.path.join(wt_parent, "side"))
        old = os.path.join(self.tmp, "results-old")
        write_json(os.path.join(old, "matrix.json"), {})
        write(self.tmp, "not-results/x.txt", "x")  # a folder beside the results with no matrix.json stays readable
        paths = HR.isolation_paths(self.src, os.path.join(self.tmp, "results-new"))
        mods = os.path.join(os.path.realpath(self.cfgdir), "mods")
        for want in (mods, self.src, wt_parent, old):
            self.assertIn(want, paths)
        plugins = os.path.join(os.path.realpath(self.cfgdir), "plugins")
        for name in ("cache", "marketplaces", "store"):
            self.assertIn(os.path.join(plugins, name), paths)
        self.assertNotIn(plugins, paths)  # `claude plugin test` may need installed_plugins.json
        repo = os.path.realpath(HR.REPO)  # this runner's repo: listed, or inside a listed folder
        self.assertTrue(any(repo == p or repo.startswith(p + os.sep) for p in paths), paths)
        self.assertNotIn(os.path.join(self.tmp, "not-results"), paths)
        self.assertNotIn(os.path.join(wt_parent, "side"), paths)  # inside wt_parent, which is listed
        home = os.path.realpath(os.path.expanduser("~"))
        for p in paths:
            self.assertFalse(home == p or home.startswith(p + os.sep), p)  # never home or a folder above it

    def test_a_folder_that_holds_the_results_is_never_unreadable(self):
        results = os.path.join(self.src, "..", "inside-source-wt", "results")
        git(self.src, "worktree", "add", "-q", "-b", "side", os.path.join(self.tmp, "inside-source-wt", "side"))
        paths = HR.isolation_paths(self.src, results)
        self.assertNotIn(os.path.join(self.tmp, "inside-source-wt"), paths)

    def test_every_call_runs_with_the_read_denials_and_the_bash_sandbox(self):
        self.matrix()
        run = self.run_json()
        self.assertTrue(run["isolation"]["sandbox"])
        mods = os.path.join(os.path.realpath(self.cfgdir), "mods")
        self.assertIn(mods, run["isolation"]["deny_read"])
        for call in self.calls():
            arg = next(a for a in call["argv"] if a.startswith("--settings="))
            settings = json.loads(arg[len("--settings="):])
            self.assertEqual(settings["env"], {"CLAUDE_CODE_PLUGIN_DIRS": ""})
            box = settings["sandbox"]
            self.assertTrue(box["enabled"] and box["failIfUnavailable"] and box["autoAllowBashIfSandboxed"])
            self.assertFalse(box["allowUnsandboxedCommands"])
            self.assertEqual(box["filesystem"]["allowWrite"], [self.run_dir()])
            for path in (mods, self.src):
                self.assertIn(path, box["filesystem"]["denyRead"])
                for tool in ("Read", "Edit"):
                    self.assertIn(f"{tool}(/{path}/**)", settings["permissions"]["deny"])

    def test_dry_run_prints_the_worker_settings_and_the_unreadable_folders(self):
        code, out, _ = self.matrix("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn('worker settings: {"env":{"CLAUDE_CODE_PLUGIN_DIRS":""}', out)
        self.assertIn('"allowWrite":["<run folder>"]', out)
        self.assertIn("unreadable for workers (Read/Edit deny rules and the Bash sandbox): ", out)


class CheckIsolationTest(RunnerCase):
    # Prompt paths in order: 0 ls mods, 1 cat mods, 2 ls other, 3 Read mods, 4 Grep mods, 5 cat through the link,
    # 6 Read through the link.
    REFUSED = [["Bash", "command", 0, "ls: PATH: Operation not permitted", True],
               ["Bash", "command", 1, "cat: PATH: Operation not permitted", True],
               ["Read", "file_path", 3, "Permission to read PATH has been denied.", True]]
    LINK_REFUSED = [["Bash", "command", 5, "cat: PATH: Operation not permitted", True],
                    ["Read", "file_path", 6, "Permission to read PATH has been denied.", True]]
    GOOD = dict(write=True, shell=True)

    def probe(self, **beh):
        self.behave(probe=beh)
        self.make_scenario(grade={"cmd": ["python3", "-c", "pass"], "parser": "unittest", "timeout": 60})
        return self.matrix("--check-isolation")

    def good(self, **more):
        return self.probe(tools=self.REFUSED + self.LINK_REFUSED, **{**self.GOOD, **more})

    def test_every_refused_read_and_a_working_write_pass(self):
        code, out, _ = self.good()
        self.assertEqual(code, 0, out)
        self.assertIn("isolation holds", out)
        self.assertIn(": refused", out)
        self.assertIn("Bash through the symlink: refused", out)
        self.assertIn("Read through the symlink: refused", out)
        self.assertIn("git commit and push to the local remote: worked", out)
        self.assertIn("the scenario's test command: passed", out)
        probe = self.fake_calls()[0]
        settings = json.loads(next(a for a in probe["argv"] if a.startswith("--settings="))[len("--settings="):])
        self.assertTrue(settings["sandbox"]["enabled"])

    def test_the_probes_own_ln_s_is_not_a_read_of_the_mods_folder(self):
        # 20261026-195710: `ln -s <mods> <link>` names the mods folder, prints nothing and is not refused.
        ln = ["Bash", "command", 0, "(Bash completed with no output)", False, "ln -s PATH /link"]
        code, out, _ = self.probe(tools=self.REFUSED + [ln] + self.LINK_REFUSED, **self.GOOD)
        self.assertEqual(code, 0, out)
        self.assertNotIn("READ", out)
        # the same text in a command that also reads is still a hit
        shutil.rmtree(self.results)
        chained = ["Bash", "command", 0, "herdr-agents", False, "ln -s PATH /link && ls PATH"]
        code, out, _ = self.probe(tools=self.REFUSED + [chained] + self.LINK_REFUSED, **self.GOOD)
        self.assertEqual(code, 1)

    def test_a_read_that_came_back_fails(self):
        tools = self.REFUSED + self.LINK_REFUSED + [["Bash", "command", 0, "herdr-agents\nherdr-agents-view", False]]
        code, out, _ = self.probe(tools=tools, **self.GOOD)
        self.assertEqual(code, 1)
        self.assertIn(": READ", out)
        self.assertIn("ISOLATION FAILED", out)

    def test_no_try_or_no_write_fails(self):
        self.assertEqual(self.probe(tools=[], **self.GOOD)[0], 1)
        shutil.rmtree(self.results)
        code, out, _ = self.good(write=False)
        self.assertEqual(code, 1)
        self.assertIn("Bash write into the run folder: FAILED", out)

    def test_a_bash_cat_through_the_symlink_that_came_back_fails(self):
        leak = [["Bash", "command", 5, '{"name": "herdr-agents"}', False], self.LINK_REFUSED[1]]
        code, out, _ = self.probe(tools=self.REFUSED + leak, **self.GOOD)
        self.assertEqual(code, 1)
        self.assertIn("Bash through the symlink: READ", out)
        self.assertIn("Read through the symlink: refused", out)

    def test_a_read_through_the_symlink_that_came_back_fails(self):
        leak = [self.LINK_REFUSED[0], ["Read", "file_path", 6, '{"name": "herdr-agents"}', False]]
        code, out, _ = self.probe(tools=self.REFUSED + leak, **self.GOOD)
        self.assertEqual(code, 1)
        self.assertIn("Read through the symlink: READ", out)
        self.assertIn("Bash through the symlink: refused", out)

    def test_a_symlink_that_was_not_tried_fails(self):
        code, out, _ = self.probe(tools=self.REFUSED, **self.GOOD)
        self.assertEqual(code, 1)
        self.assertIn("Bash through the symlink: not tried", out)
        self.assertIn("Read through the symlink: not tried", out)

    def test_no_symlink_made_fails(self):
        code, out, _ = self.good(shell=False)
        self.assertEqual(code, 1)
        self.assertIn("symlink to the mods folder: NOT MADE", out)
        self.assertIn("git commit and push to the local remote: FAILED", out)

    def test_a_failing_test_command_fails(self):
        self.behave(probe=dict(tools=self.REFUSED + self.LINK_REFUSED, **self.GOOD))
        self.make_scenario(grade={"cmd": ["python3", "-c", "raise SystemExit(3)"], "parser": "unittest", "timeout": 60})
        code, out, _ = self.matrix("--check-isolation")
        self.assertEqual(code, 1)
        self.assertIn("the scenario's test command: FAILED (exit 3)", out)

    def test_the_prompt_names_the_symlink_and_the_flow_steps(self):
        text = HR.isolation_prompt(["/x/mods", "/y"], "/r", "python3 -m unittest")
        for want in ("ln -s /x/mods /r/link-mods", "cat /r/link-mods/herdr-agents/package.json",
                     "Read: /r/link-mods/herdr-agents/package.json", "git push -q origin probe-branch",
                     "(python3 -m unittest) > /r/test-out.txt"):
            self.assertIn(want, text)
        self.assertNotIn("test-exit", HR.isolation_prompt(["/x/mods", "/y"], "/r"))


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("sandbox-exec"), "macOS seatbelt")
class SeatbeltTest(unittest.TestCase):
    """What Claude Code's sandbox does on macOS, with the same seatbelt and the folders isolation_paths() names: a
    command cannot read the installed mods, while the grade a worker runs (writes only under the run folder and the
    temp folders) still works. Claude Code's own sandbox is not run here: that needs a model call."""

    def test_a_seatbelt_that_denies_the_mods_folder_stops_ls_cat_and_grep(self):
        tmp = os.path.realpath(tempfile.mkdtemp(prefix="hrd-eval-seatbelt-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        mods = os.path.join(tmp, "mods")
        write(mods, "herdr-agents/hooks/state.ts", "export const store = 1\n")
        run = os.path.join(tmp, "run")
        os.makedirs(run)
        profile = f'(version 1)(allow default)(deny file-read* (subpath "{mods}"))'
        script = f"ls {mods}/herdr-agents; cat {mods}/herdr-agents/hooks/state.ts; grep -rn store {mods}; echo ok > {run}/x"
        p = subprocess.run(["sandbox-exec", "-p", profile, "sh", "-c", script], capture_output=True, text=True)
        self.assertNotIn("export const store", p.stdout)
        self.assertIn("Operation not permitted", p.stderr)
        self.assertEqual(read_text(os.path.join(run, "x")), "ok\n")


class InterruptTest(RunnerCase):
    """Ctrl-C or SIGTERM on the runner kills the workers it started: each runs in its own process group."""

    def alive(self, pid):
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True

    def interrupt(self, sig):
        self.behave(plan={"sleep": 120})
        argv = [sys.executable, RUNNER, "--claude", self.fake, "--scenarios-dir", self.scen, "--arms-dir", ARMS,
                "--arms", "A", "--config", self.config, "--source-repo", self.src, "--results", self.results,
                "--scenarios", "replay-test", "--repeats", "1"]
        env = {**os.environ, "FAKE_CLAUDE_SCRIPT": self.script_path, "FAKE_CLAUDE_LOG": self.log}
        proc = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(proc.kill)
        deadline = time.time() + 30
        while not self.fake_calls() and time.time() < deadline and proc.poll() is None:
            time.sleep(0.1)
        calls = self.fake_calls()
        self.assertTrue(calls, "the fake claude never started")
        pid = calls[0]["pid"]
        self.assertTrue(self.alive(pid))
        proc.send_signal(sig)
        _, err = proc.communicate(timeout=30)
        self.addCleanup(lambda: self.alive(pid) and os.kill(pid, signal.SIGKILL))
        deadline = time.time() + 10
        while self.alive(pid) and time.time() < deadline:
            time.sleep(0.1)
        self.assertFalse(self.alive(pid), "the worker is still running")
        self.assertEqual(proc.returncode, 130, err)
        self.assertEqual(len(self.fake_calls()), 1)  # no new call after the kill

    def test_ctrl_c_kills_the_running_worker(self):
        self.interrupt(signal.SIGINT)

    def test_sigterm_kills_the_running_worker(self):
        self.interrupt(signal.SIGTERM)

    def test_a_child_runs_in_its_own_process_group(self):
        proc = HR.spawn([sys.executable, "-c", "import time; time.sleep(30)"], None, None)
        self.addCleanup(HR.kill_live)
        self.assertNotEqual(os.getpgid(proc.pid), os.getpgid(0))
        HR.kill_live()
        proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, -signal.SIGKILL)
        HR.STOPPING.clear()


class ScoreTableTest(RunnerCase):
    def test_a_real_run_ends_with_the_score_table_of_its_results(self):
        code, out, _ = self.matrix()
        self.assertEqual(code, 0, out)
        self.assertIn("== hrd-eval: 1 runs, 1 scenarios, 1 arms, repeats 1, started ", out)
        self.assertIn("== per arm", out)
        self.assertLess(out.index("fix rounds"), out.index("== hrd-eval:"))  # the run's line comes before the table

    def test_json_prints_the_aggregate_with_its_six_keys(self):
        code, out, _ = self.matrix("--json")
        self.assertEqual(code, 0, out)
        data = json.loads(out)
        self.assertEqual(set(data), {"matrix", "runs", "cells", "arms", "roles", "disagreements"})
        self.assertEqual(data["matrix"]["repeats"], 1)
        self.assertEqual([(r["scenario"], r["arm"]) for r in data["runs"]], [("replay-test", "A")])

    def test_a_graded_scenario_without_expected_json_is_refused_before_any_call(self):
        os.remove(os.path.join(self.scen, "replay-test", "expected.json"))
        code, _, err = self.matrix()
        self.assertEqual(code, 1)
        self.assertEqual(len(err.strip().splitlines()), 1, err)
        self.assertIn("replay-test: no expected.json", err)
        self.assertEqual(self.fake_calls(), [])
        self.assertFalse(os.path.exists(self.results))


class FixtureRunTest(RunnerCase):
    def test_a_fixture_run_works_in_a_copy_of_its_folder_and_needs_no_expected_json(self):
        fixture = os.path.join(self.tmp, "fixture")
        write(fixture, "shop.py", "TOTAL = 0\n")
        write(fixture, "AGENTS.md", "# Rules\n")
        self.make_scenario(sid="fixture-test", hidden=False)
        path = os.path.join(self.scen, "fixture-test", "scenario.json")
        sc = read_json(path)
        sc.pop("grade")
        sc.update(kind="fixture", source={"dir": fixture})
        write_json(path, sc)
        os.remove(os.path.join(self.scen, "fixture-test", "expected.json"))
        code, out, err = self.matrix(scenarios="fixture-test")
        self.assertEqual(code, 0, out + err)
        plan = self.fake_calls()[0]
        self.assertEqual(plan["files"], ["AGENTS.md", "shop.py"])  # the worker's repo: the folder's files, and nothing else
        run = read_json(os.path.join(self.results, "fixture-test", "A", "r1", "run.json"))
        self.assertEqual(run["status"], "done")
        self.assertEqual(run["changed_files"], ["shop.py"])  # the build's commit, merged into main for the record


class SshAgentTest(unittest.TestCase):
    PROFILE = {"kind": "claude", "args": ["--agent", "builder", "--model", "haiku", "--effort", "xhigh"]}

    def setUp(self):
        self.run = tempfile.mkdtemp(prefix="hrd-eval-ssh-")
        self.addCleanup(shutil.rmtree, self.run, True)
        owner = os.path.join(self.run, "owner.gitconfig")
        write(self.run, "owner.gitconfig", "")
        patcher = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": owner, "SSH_AUTH_SOCK": "/private/tmp/agent.sock"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_worker_call_gets_no_ssh_agent_socket(self):
        self.assertIn("SSH_AUTH_SOCK", os.environ)  # the owner's shell has one; the worker's env must not
        self.assertNotIn("SSH_AUTH_SOCK", HR.run_env(self.run, self.PROFILE))

    def test_setup_and_grade_get_no_ssh_agent_socket_either(self):
        self.assertNotIn("SSH_AUTH_SOCK", HR.clean_env(self.run))


class EstimateTest(unittest.TestCase):
    # The smoke run's calls (replay-13 x A x 1, calls.jsonl): opus plan 0.5213, opus answer 0.1542, opus review 0.1874 and
    # haiku build 0.0591. A model's per-call estimate must cover the mean of its calls and stay within 1.25 times it.
    SMOKE = {"opus": [0.5213, 0.1542, 0.1874], "haiku": [0.0591]}

    def test_each_model_estimate_covers_its_smoke_mean_and_stays_close_to_it(self):
        for model, costs in self.SMOKE.items():
            mean = sum(costs) / len(costs)
            est = HR.estimate({"args": ["--model", model]})
            self.assertGreaterEqual(est, mean, model)
            self.assertLessEqual(est, 1.25 * mean, model)


class CheckUngradedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hrd-eval-ungraded-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        write(os.path.join(self.tmp, "fixture"), "shop.py", "TOTAL = 0\n")

    def scenario(self, **changes):
        folder = os.path.join(self.tmp, "scenarios", "ungraded")
        write_json(os.path.join(folder, "issue.json"), {"number": 3, "title": "t", "body": "b"})
        sc = {
            "title": "ungraded",
            "kind": "fixture",
            "issue": {"number": 3, "file": "issue.json"},
            "source": {"dir": os.path.join(self.tmp, "fixture")},
            "expect": {"decision": {"match": "(?i)stack"}, "testsChanged": False},
        }
        sc.update(changes)
        write_json(os.path.join(folder, "scenario.json"), sc)
        return HR.load_scenario(folder)

    def test_a_scenario_with_no_grade_checks_out_and_writes_no_expected_json(self):
        sc = self.scenario()
        r = HR.check_scenario(sc, None, True)
        self.assertTrue(r["ungraded"])
        self.assertEqual(r["problems"], [])
        self.assertFalse(os.path.exists(os.path.join(sc["dir"], "expected.json")))

    def test_a_decision_regex_that_does_not_compile_is_a_problem(self):
        r = HR.check_scenario(self.scenario(expect={"decision": {"match": "(stack"}, "testsChanged": False}), None, False)
        self.assertEqual(len(r["problems"]), 1)
        self.assertIn("does not compile", r["problems"][0])

    def test_a_setup_that_fails_is_a_problem(self):
        r = HR.check_scenario(self.scenario(setup=[["false"]]), None, False)
        self.assertEqual(len(r["problems"]), 1)
        self.assertIn("setup", r["problems"][0])


class CiScenarioCheck(unittest.TestCase):
    """The Python-only check CI runs (the plan's Q13): the fixture scenarios decision-rule and contract, whose grades run
    python3 only and make no model call. The replays are checked by hand, since their setup needs npm."""

    def test_decision_rule_and_contract_check_out_against_their_expected_json(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = HR.main(["--check-scenarios", "--scenarios", "decision-rule,contract"])
        self.assertEqual(code, 0, out.getvalue() + err.getvalue())


if __name__ == "__main__":
    unittest.main()
