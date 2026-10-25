#!/usr/bin/env python3
"""hrd-eval runner: the eval suite's level 1 (workers only), issue #28.

For each scenario and arm it plays the coordinator: a planner (unless the arm disables it), one builder per slice in
its own worktree, a reviewer, and fix rounds until the review has no blockers. Every role is a `claude -p` call built
from the arm's profile (herdr-agents.json format); each prompt carries the mod's report rule (hooks/workers.ts), and
each job folder keeps the full rule in REPORTING.md. Results go to --results, outside this repo. Hidden tests are copied
into the grade folder only after the last worker call has ended.

  scripts/hrd-eval.py --dry-run [--scenarios a] [--arms A,C]   print the matrix and each role's command; calls nothing
  scripts/hrd-eval.py --check-scenarios --scenarios replay-13 [--update-expected]
                                                               grade the base and the reference; no model call
  scripts/hrd-eval.py [--arms A,C] [--repeats 3] [--parallel 1] [--max-cost 30] [--max-call-cost 5] [--call-timeout 20]
                      [--results DIR] [--config PATH] [--claude PATH] [--json]

A real run ends with the score table of its results folder (scripts/hrd-eval/score.py); --json prints the aggregate.
Exit codes: 0 done; 1 error (bad input, or a check that failed); 2 budget refused the start or stopped a run.
Python 3 standard library only (3.9 compatible).
"""

import argparse
import concurrent.futures
import glob
import importlib.util
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
EVAL_DIR = os.path.join(HERE, "hrd-eval")
SHIM_BIN = os.path.join(EVAL_DIR, "bin")
DEFAULT_SCENARIOS = os.path.join(EVAL_DIR, "scenarios")
DEFAULT_ARMS = os.path.join(EVAL_DIR, "arms")
FALLBACK_NAME, FALLBACK_EMAIL = "hrd-eval", "hrd-eval@localhost"  # the identity when the owner has none
IDENT = ["-c", f"user.name={FALLBACK_NAME}", "-c", f"user.email={FALLBACK_EMAIL}"]
# Every github.com remote is rewritten to a path under /dev/null, which is not a repository, so git fails at once.
BLOCKED_BASE = "file:///dev/null/blocked/"
BLOCKED_PREFIXES = ["https://github.com/", "http://github.com/", "ssh://git@github.com/", "git@github.com:"]

# Dollars per call by the profile's --model, and the factor a run's fix rounds add. Calibrated on the smoke run
# (replay-13 x A x 1, calls.jsonl): the three opus calls cost $0.52, $0.15 and $0.19 (mean $0.29), the one haiku
# call $0.059. sonnet has no call in that run and keeps its old figure; "other" is unchanged.
ESTIMATE = {"opus": 0.30, "sonnet": 0.30, "haiku": 0.06}
ESTIMATE_OTHER = 0.50
FIX_FACTOR = 1.5
MAX_ANSWERS = 2  # answer calls a run gets under onDecision "recommended"
KILL_GRACE_S = 30  # after SIGINT, before SIGKILL
MAX_FIX_ROUNDS = 2
SETTINGS = json.dumps({"env": {"CLAUDE_CODE_PLUGIN_DIRS": ""}}, separators=(",", ":"))
DISALLOW = "WebFetch(domain:github.com)"
ENV_DROP = ("GH_TOKEN", "GITHUB_TOKEN", "CLAUDECODE", "SSH_AUTH_SOCK")  # and every HERDR_* variable
ARM_KEYS = ("profiles", "disable", "fixRound", "maxFixRounds", "note")

# The report rule of hooks/workers.ts reportRule(), one part per line of its array in the TS form (${job.dir}, and
# ${token} for the token), minus the WAIT.json sentences (a level 1 worker never waits). report_rule() joins the parts
# with newlines, as workers.ts does, so the header's fences and keys stay on their own lines. A test checks each part
# still appears word for word in workers.ts.
REPORT_RULE_PARTS = [
    "When you are completely finished, write your final report to ${job.dir}/RESULT.md in one write, as your last step. Its first line must be exactly: <!-- report ${token} -->",
    "Right below that line, put this header, fences included, with your own values:",
    "```report",
    "status: done",
    "pr: 123",
    "summary: what changed; the checks you ran and their result; what is next (at most 3 short lines)",
    "ask: one line, only if your coordinator must answer something; otherwise leave this line out",
    "```",
    "status is done, blocked (you need an answer or something outside your control) or failed. Leave out pr if you opened or updated no PR; list several as 12, 13. Your coordinator usually reads only this header, so make the summary enough to act on.",
    "Below the header, in at most 25 lines: what you did, the branch or PR link, test results, open questions, and anything you could not do. Put long material, such as a plan or a full review, in another file in ${job.dir} (a plan goes in PLAN.md) and give its absolute path instead of copying it in.",
    'If you need a decision only the owner can make, write each question on its own line as "DECISION: [Short title] <question> | <option> (recommended) | <option>", the title 2-4 words and the options short; if you cannot go on without the answer, stop there.',
    "If you cannot go on, write why to RESULT.md (status: blocked or failed) and stop. These rules are kept in ${job.dir}/REPORTING.md; later messages only remind you of them.",
]
# The one-line reminder a resumed session gets instead of the full rule: reportReminder() in workers.ts, minus its
# WAIT.json words. A test checks it against workers.ts.
REPORT_REMINDER = (
    "When you are finished, report as before: write ${job.dir}/RESULT.md in one write, as your last step, with the first "
    "line exactly <!-- report ${job.token} -->, then the ```report header (status, pr, summary, ask) and your report. "
    "DECISION lines work as in ${job.dir}/REPORTING.md."
)
# The answer to an ask: the header's ask line has no options, so it is answered with this (see questions()).
NO_OWNER_ANSWER = "No owner answer; use your best judgement, say in the report what you chose."
VERDICT_LINE = "End the report with one line: `VERDICT: approve` or `VERDICT: changes needed, <n> blockers`."
# The same regexes as hooks/workers.ts deliver() (DECISION) and the verdict rule of this runner.
DECISION_SRC = r"^\s*(?:[-*]\s*)?\**DECISION:?\**:?\s*(.+)$"
NONE_SRC = r"^(?:none|n/a)\b"
DECISION_RE = re.compile(DECISION_SRC, re.M)
NONE_RE = re.compile(NONE_SRC, re.I)
VERDICT_RE = re.compile(r"(?im)^\s*VERDICT:\s*(approve|changes needed)(?:,\s*(\d+)\s+blockers?)?")
MARKED = re.compile(r"\s*\((?:recommended|rec\.?)\)\s*", re.I)
REPORT_MARK = re.compile(r"^\s*<!-- report (\S+) -->\s*")
# The report's header (reportRule in workers.ts, parseHeader in report.ts): read here for its pr and ask fields only.
FENCE_LINE = re.compile(r"^\s*```")
HEADER_KEY = re.compile(r"^\s*(?:[-*]\s+)?\**[A-Za-z][\w-]*\**\s*:")
HEADER_PR = re.compile(r"^\s*(?:[-*]\s+)?\**(?:pr|prs)\**\s*:\s*\**\s*(.*?)\s*$", re.I)
HEADER_ASK = re.compile(r"^\s*(?:[-*]\s+)?\**ask\**\s*:\s*\**\s*(.*?)\s*$", re.I)
PR_ITEM = re.compile(r"^(?:#?(\d+)|https?://\S*?/pull/(\d+)\b\S*)$")


class RunnerError(Exception):
    """A bad input or a failed setup: the message goes to stderr and the runner exits 1."""


class Halt(Exception):
    """Ends a run early with a status (run.json's "status")."""

    def __init__(self, status, error=None):
        super().__init__(status)
        self.status, self.error = status, error


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


hm = load_module("hrd_metrics", os.path.join(HERE, "hrd-metrics.py"))
scorer = load_module("hrd_eval_score", os.path.join(EVAL_DIR, "score.py"))  # the grade parsers and the table


# Files, git and processes


def write_text(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def write_json(path, obj):
    write_text(path, json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def append_jsonl(path, obj):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def git(*args, cwd=None, check=True):
    p = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RunnerError(f"git {' '.join(args)} failed: {(p.stderr or p.stdout).strip()[-300:]}")
    return p


def git_bytes(cwd, *args):
    p = subprocess.run(["git", "-C", cwd, *args], capture_output=True)
    if p.returncode != 0:
        raise RunnerError(f"git {' '.join(args)} failed: {p.stderr.decode('utf-8', 'replace').strip()[-300:]}")
    return p.stdout


def commit_present(source, sha):
    return git("cat-file", "-e", f"{sha}^{{commit}}", cwd=source, check=False).returncode == 0


def export_tree(source, commit, dest):
    """A commit's tree as a plain folder (git archive)."""
    data = git_bytes(source, "archive", commit)
    os.makedirs(dest)
    subprocess.run(["tar", "-x", "-C", dest], input=data, check=True)


def scenario_snapshot(sc, source, dest):
    """The scenario's source as a folder: a commit's tree, or a fixture folder copied."""
    src = sc["source"]
    if "commit" in src:
        export_tree(source, src["commit"], dest)
    else:
        shutil.copytree(os.path.join(sc["dir"], src["dir"]), dest)


def apply_hidden(sc, source, grade_dir):
    """The hidden tests over a grade folder: a commit's paths replaced, or a folder copied over."""
    h = sc.get("hidden")
    if not h:
        return
    if "commit" in h:
        for p in h["paths"]:
            target = os.path.join(grade_dir, p)
            if os.path.isdir(target) and not os.path.islink(target):
                shutil.rmtree(target)
            elif os.path.lexists(target):
                os.remove(target)
        data = git_bytes(source, "archive", h["commit"], *h["paths"])
        subprocess.run(["tar", "-x", "-C", grade_dir], input=data, check=True)
    else:
        target = os.path.join(grade_dir, h["to"])
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copytree(os.path.join(sc["dir"], h["dir"]), target, dirs_exist_ok=True)


def owner_identity():
    """The owner's global user.name and user.email; None where unset."""
    out = {}
    for key in ("name", "email"):
        p = subprocess.run(["git", "config", "--global", "--get", f"user.{key}"], capture_output=True, text=True)
        out[key] = (p.stdout.strip() if p.returncode == 0 else "") or None
    return out


def write_git_config(folder):
    """Writes folder/gitconfig, the only git config a run's processes read: the owner's user.name and user.email (or
    the fallback identity) and the github.com rewrites. No credential helper. Written under a temp name and renamed, so
    a git process never reads half of it."""
    ident = owner_identity()
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".gitconfig-")
    os.close(fd)
    try:
        git("config", "--file", tmp, "user.name", ident["name"] or FALLBACK_NAME)
        git("config", "--file", tmp, "user.email", ident["email"] or FALLBACK_EMAIL)
        for prefix in BLOCKED_PREFIXES:
            git("config", "--file", tmp, "--add", f"url.{BLOCKED_BASE}.insteadOf", prefix)
        os.replace(tmp, os.path.join(folder, "gitconfig"))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def clean_env(folder):
    """The environment a setup, grade or claude call in run folder `folder` starts from: the runner's, minus what marks
    a coordinator and any GIT_CONFIG_* variable. git reads only folder/gitconfig, never the system config, and never
    prompts. The file is written on every call, so no call can start without it."""
    folder = os.path.abspath(folder)
    env = {k: v for k, v in os.environ.items() if k not in ENV_DROP and not k.startswith(("HERDR_", "GIT_CONFIG_"))}
    write_git_config(folder)
    env.update(GIT_CONFIG_GLOBAL=os.path.join(folder, "gitconfig"), GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")
    return env


def run_setup(cmds, cwd, env):
    for argv in cmds:
        p = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True)
        if p.returncode != 0:
            tail = (p.stderr or p.stdout).strip()[-300:]
            raise RunnerError(f"setup {shlex.join(argv)} failed in {cwd} (exit {p.returncode}): {tail}")


def run_grade(cmd, cwd, timeout_s, env):
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout_s} s\n"
    return p.returncode, p.stdout + p.stderr


def changed_files(grade_dir, base):
    p = git("diff", "--name-only", f"{base}...HEAD", cwd=grade_dir, check=False)
    return [f for f in p.stdout.splitlines() if f] if p.returncode == 0 else []


def signal_group(proc, sig):
    try:
        os.killpg(proc.pid, sig)
    except OSError:
        pass


def run_claude(argv, prompt, cwd, env, timeout_s):
    """One claude call, the prompt on stdin. Past the timeout: SIGINT to its group, KILL_GRACE_S, then SIGKILL."""
    proc = subprocess.Popen(
        argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True
    )
    timed_out = False
    try:
        out, err = proc.communicate(prompt.encode("utf-8"), timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        signal_group(proc, signal.SIGINT)
        try:
            out, err = proc.communicate(timeout=KILL_GRACE_S)
        except subprocess.TimeoutExpired:
            signal_group(proc, signal.SIGKILL)
            out, err = proc.communicate()
    return proc.returncode, out, err, timed_out


def find_transcript(sid, env):
    base = env.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    hits = sorted(glob.glob(os.path.join(base, "projects", "*", f"{sid}.jsonl")))
    return hits[0] if hits else None


def default_config():
    return os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "herdr-agents.json")


def default_results():
    return os.path.join(os.path.expanduser("~"), ".cache", "hrd-eval", time.strftime("%Y%m%d-%H%M%S"))


def inside(path, root):
    return path == root or path.startswith(root + os.sep)


def split_names(text):
    if text is None:
        return None
    return [s.strip() for s in text.split(",") if s.strip()]


# Arms


def flag_value(args, flag):
    for i, a in enumerate(args):
        if a == flag:
            return args[i + 1] if i + 1 < len(args) else None
        if a.startswith(flag + "="):
            return a[len(flag) + 1 :]
    return None


def check_profile(where, prof):
    """A role's profile at level 1: Claude only, with --model and --effort, and no herdr-agents plugin agent."""
    if not isinstance(prof, dict) or not isinstance(prof.get("args"), list):
        raise RunnerError(f"{where}: a profile needs an args list")
    kind = prof.get("kind")
    if kind != "claude":
        raise RunnerError(f'{where}: profile kind is "{kind}"; level 1 runs Claude workers only')
    args = [str(a) for a in prof["args"]]
    for flag in ("--model", "--effort"):
        if not flag_value(args, flag):
            raise RunnerError(f"{where}: the profile needs {flag} (the matrix records the model and the effort)")
    agent = flag_value(args, "--agent") or ""
    if agent.startswith("herdr-agents:"):
        raise RunnerError(f"{where}: runs {agent}; the herdr-agents plugin is off in workers, so level 1 rejects it")
    return {**prof, "args": args}


def read_config(path):
    if not os.path.exists(path):
        return {}
    try:
        data = read_json(path)
    except ValueError as e:
        raise RunnerError(f"{path}: not JSON ({e})")
    if not isinstance(data, dict):
        raise RunnerError(f"{path}: expected a JSON object")
    return data


def load_arms(arms_dir, names=None, config_path=None):
    """The arms, resolved. Each arm merges over the user's herdr-agents.json the way hooks/config.ts config() does."""
    user = read_config(config_path or default_config())
    if names is None:
        names = sorted(os.path.splitext(f)[0] for f in os.listdir(arms_dir) if f.endswith(".json"))
    arms = {}
    for name in names:
        path = os.path.join(arms_dir, f"{name}.json")
        if not os.path.exists(path):
            raise RunnerError(f"no arm {name}: {path} does not exist")
        try:
            arm = read_json(path)
        except ValueError as e:
            raise RunnerError(f"{path}: not JSON ({e})")
        warnings = [f"arm {name}: '{k}' is not used by the runner and is ignored" for k in sorted(arm) if k not in ARM_KEYS]
        fix = arm.get("fixRound", "fresh")
        if fix not in ("fresh", "resume"):
            raise RunnerError(f'arm {name}: fixRound must be "fresh" or "resume", not {fix!r}')
        max_rounds = arm.get("maxFixRounds", MAX_FIX_ROUNDS)
        if not isinstance(max_rounds, int) or isinstance(max_rounds, bool) or max_rounds < 0:
            raise RunnerError(f"arm {name}: maxFixRounds must be a whole number, 0 or more")
        disable = arm.get("disable", user.get("disable", []))
        if not isinstance(disable, list):
            raise RunnerError(f"arm {name}: disable must be a list")
        for off in disable:
            if off == "reviewer":
                raise RunnerError(f"arm {name}: the reviewer cannot be disabled at level 1 (the fix loop needs it)")
            if off != "planner":
                raise RunnerError(f'arm {name}: only "planner" can be disabled at level 1, not {off!r}')
        profiles = {**(user.get("profiles") or {}), **(arm.get("profiles") or {})}
        roles = ["builder", "reviewer"] + ([] if "planner" in disable else ["planner"])
        resolved = {}
        for role in roles:
            if role not in profiles:
                raise RunnerError(f"arm {name}: no profile named {role} in the config or the arm")
            resolved[role] = check_profile(f"arm {name}, profile {role}", profiles[role])
        arms[name] = {
            "id": name,
            "note": arm.get("note"),
            "fixRound": fix,
            "maxFixRounds": max_rounds,
            "disable": list(disable),
            "profiles": resolved,
            "warnings": warnings,
        }
    return arms


# Scenarios


def load_scenario(folder):
    path = os.path.join(folder, "scenario.json")
    try:
        sc = read_json(path)
    except ValueError as e:
        raise RunnerError(f"{path}: not JSON ({e})")

    def bad(msg):
        return RunnerError(f"{path}: {msg}")

    sc["id"] = os.path.basename(os.path.normpath(folder))
    sc["dir"] = os.path.abspath(folder)
    if sc.get("kind") not in ("replay", "fixture"):
        raise bad('kind must be "replay" or "fixture"')
    src = sc.get("source") or {}
    if ("commit" in src) == ("dir" in src):
        raise bad("source needs exactly one of commit or dir")
    if sc["kind"] == "replay" and "commit" not in src:
        raise bad("a replay's source is a commit")
    issue = sc.get("issue") or {}
    if not isinstance(issue.get("number"), int) or not isinstance(issue.get("file"), str):
        raise bad("issue needs a number and a file")
    if not os.path.exists(os.path.join(folder, issue["file"])):
        raise bad(f"issue file {issue['file']} is missing")
    hidden = sc.get("hidden")
    if hidden is not None:
        if "commit" in hidden:
            if not isinstance(hidden.get("paths"), list) or not hidden["paths"]:
                raise bad("hidden.commit needs paths")
        elif "dir" in hidden:
            if not isinstance(hidden.get("to"), str):
                raise bad("hidden.dir needs to")
        else:
            raise bad("hidden needs commit or dir")
    sc.setdefault("slices", [{"id": "S1", "brief": ""}])
    ids = [s.get("id") for s in sc["slices"]]
    if not sc["slices"] or len(set(ids)) != len(ids) or not all(isinstance(i, str) and i for i in ids):
        raise bad("slices need unique ids")
    if len(sc["slices"]) > 1 and not all(s.get("brief") for s in sc["slices"]):
        raise bad("every slice of a multi-slice scenario needs a brief")
    sc["slices"] = [{"id": s["id"], "brief": s.get("brief", "")} for s in sc["slices"]]
    sc.setdefault("setup", [])
    grade = sc.get("grade")
    if grade is not None:
        if not isinstance(grade.get("cmd"), list) or grade.get("parser") not in ("plugin-test", "unittest"):
            raise bad("grade needs cmd (a list) and parser (plugin-test or unittest)")
        grade.setdefault("timeout", 300)
    sc.setdefault("allowed", [])
    sc.setdefault("expect", {"decision": None, "testsChanged": False})
    sc.setdefault("onDecision", "recommended")
    if sc["onDecision"] not in ("recommended", "stop"):
        raise bad('onDecision must be "recommended" or "stop"')
    sc.setdefault("estimateScale", 1)
    return sc


def load_scenarios(folder, names=None):
    if names is None:
        names = []
        if os.path.isdir(folder):
            names = sorted(d for d in os.listdir(folder) if os.path.exists(os.path.join(folder, d, "scenario.json")))
    out = []
    for name in names:
        if not os.path.exists(os.path.join(folder, name, "scenario.json")):
            raise RunnerError(f"no scenario {name} in {folder}")
        out.append(load_scenario(os.path.join(folder, name)))
    if not out:
        raise RunnerError(f"no scenarios in {folder}")
    return out


# Commands, prompts and reports


def role_argv(profile, sid, resume, cap):
    """The claude command for one role call (the prompt goes on stdin). argv[0] is the claude name; run() swaps it."""
    argv = [
        "claude",
        "-p",
        *profile["args"],
        "--output-format",
        "json",
        "--permission-prompts",
        "none",
        f"--settings={SETTINGS}",
        f"--disallowedTools={DISALLOW}",
        "--max-budget-usd",
        f"{cap:g}",
    ]
    return argv + (["--resume", sid] if resume else ["--session-id", sid])


def run_env(run, profile):
    """The environment of one role call in run folder `run`: the profile's env, the shim first on PATH, the gh state,
    and the run's git config (clean_env)."""
    env = clean_env(run)
    env.update({str(k): str(v) for k, v in (profile.get("env") or {}).items()})
    env["PATH"] = SHIM_BIN + os.pathsep + env.get("PATH", "")
    env["CLAUDE_ENV_FILE"] = os.path.join(run, "env.sh")
    env["HRD_EVAL_GH_STATE"] = os.path.join(run, "gh")
    env["GH_CONFIG_DIR"] = os.path.join(run, "gh-config")
    return env


def report_rule(job_dir, token):
    text = "\n".join(REPORT_RULE_PARTS)
    return text.replace("${job.dir}", job_dir).replace("${token}", token)


def report_reminder(job_dir, token):
    return REPORT_REMINDER.replace("${job.dir}", job_dir).replace("${job.token}", token)


def header_lines(report):
    """The lines of a report's header, its token line already gone: what a fenced ```report block holds (none if the
    fence is never closed), else the key lines from the first non-blank line on. [] when the report has no header."""
    lines = report.splitlines()
    start = next((i for i, line in enumerate(lines) if line.strip()), len(lines))
    if start < len(lines) and FENCE_LINE.match(lines[start]):
        for end in range(start + 1, len(lines)):
            if FENCE_LINE.match(lines[end]):
                return lines[start + 1 : end]
        return []
    out = []
    for line in lines[start:]:
        if not HEADER_KEY.match(line):
            break
        out.append(line)
    return out


def header_prs(report):
    """The PR numbers in a report's header (`pr: 12`, `pr: 12, 13` or PR links): the leading items of its pr value
    that are PRs, as report.ts reads them. [] when the header has no pr line."""
    for line in header_lines(report):
        m = HEADER_PR.match(line)
        if m:
            found = []
            for item in re.split(r"[\s,]+", m.group(1)):
                if not item:
                    continue
                pm = PR_ITEM.match(item)
                if not pm:
                    break
                found.append(int(pm.group(1) or pm.group(2)))
            # The same limit as prNumbers() in hooks/report.ts: the first five distinct PRs.
            return list(dict.fromkeys(found))[:5]
    return []


def header_ask(report):
    """The value of a report header's ask line, read like a DECISION line; None when there is no ask line, or its value
    is empty or says none or n/a. (The mod shows an ask as an `Ask:` line of the summary; here it is answered.)"""
    for line in header_lines(report):
        m = HEADER_ASK.match(line)
        if m:
            value = m.group(1)
            return None if not value or NONE_RE.match(value) else value
    return None


def questions(report):
    """What a report asks the coordinator, as (text, question, recommended): the header's ask first, with no options so
    it gets NO_OWNER_ANSWER, then the DECISION lines (see split_decision). text is the line as the report wrote it."""
    out = []
    ask = header_ask(report)
    if ask:
        out.append((ask, ask, NO_OWNER_ANSWER))
    for raw in decisions(report):
        question, _, rec = split_decision(raw)
        out.append((raw, question, rec))
    return out


def numbered_blockers(text):
    """Items of a numbered list under a Blockers heading (**Blockers**, ## Blockers, Blockers:)."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if re.match(r"(?i)^\W*blockers?\W*$", line.strip()):
            count = 0
            for nxt in lines[i + 1 :]:
                if not nxt.strip():
                    continue
                if re.match(r"^\s*\d+[.)]\s", nxt):
                    count += 1
                elif nxt[:1].isspace():
                    continue
                else:
                    break
            return count
    return 0


def parse_verdict(text):
    """(verdict, blockers, how): verdict "approve" | "changes" | None; how "line" | "heuristic" | "none"."""
    lines = list(VERDICT_RE.finditer(text))
    if lines:
        word, count = lines[-1].group(1).lower(), lines[-1].group(2)
        if word == "approve":
            return "approve", 0, "line"
        return "changes", int(count) if count else 1, "line"
    if re.search(r"(?i)\bno blockers?\b", text):
        return "approve", 0, "heuristic"
    counts = re.findall(r"(?i)\b(\d+)\s+blockers?\b", text)
    if counts:
        n = int(counts[-1])
        return ("changes" if n else "approve"), n, "heuristic"
    listed = numbered_blockers(text)
    if listed:
        return "changes", listed, "heuristic"
    if re.search(r"(?i)changes needed|changes requested", text):
        return "changes", 1, "heuristic"
    if re.search(r"(?i)\b(approve|approved|ready)\b", text):
        return "approve", 0, "heuristic"
    return None, None, "none"


def decisions(text):
    """The DECISION lines of a report (the text after DECISION:), minus DECISION: none and n/a."""
    out = []
    for m in DECISION_RE.finditer(text):
        q = m.group(1).strip()
        if q and not NONE_RE.match(q):
            out.append(q)
    return out


def split_decision(text):
    """(question, options, recommended) of a DECISION line: "[Title] question | option (recommended) | option".
    With no option marked recommended, the first option; with no options, "your best judgement"."""
    head, *parts = re.split(r"\s+\|\s+", text)
    titled = re.match(r"^\[[^\]]{1,40}\]\s*(.+)$", head)
    question = (titled.group(1) if titled else head).strip()
    options = [o for o in (MARKED.sub(" ", p).strip() for p in parts) if o]
    marked = [MARKED.sub(" ", p).strip() for p in parts if MARKED.search(p)]
    rec = marked[0] if marked else (options[0] if options else "your best judgement")
    return question, options, rec


def read_report(job, token, result):
    """RESULT.md minus its token line when the token is this prompt's (the header and the body stay in it: DECISION
    lines and PR links are read from all of it, as deliver() does); otherwise the JSON result."""
    path = os.path.join(job, "RESULT.md")
    if os.path.exists(path):
        text = read_text(path)
        m = REPORT_MARK.match(text)
        if m and m.group(1) == token:
            return text[m.end() :], "result_md"
    return result, "result"


def parse_json(text):
    try:
        data = json.loads(text)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def number(x):
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def created_epoch(rec):
    try:
        stamp = datetime.strptime(rec.get("createdAt", ""), "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return 0.0
    return stamp.replace(tzinfo=timezone.utc).timestamp()


# Cost


def scan_transcript(path):
    if not path or not os.path.exists(path):
        return hm.new_tot(), {}, set()
    s = hm.scan(path, 0)
    return s.tot, {m: t["cost"] for m, t in s.by_model.items()}, set(s.unpriced)


def call_cost(transcript, before=None):
    """What one call cost, from its session transcript: the transcript's totals minus `before`, the state the session's
    previous call ended with (None for a new session)."""
    tot, by_model, unpriced = scan_transcript(transcript)
    prev_tot = (before or {}).get("tot") or hm.new_tot()
    prev_models = (before or {}).get("by_model") or {}
    tokens = {
        "inp": tot["inp"] - prev_tot["inp"],
        "out": tot["out"] - prev_tot["out"],
        "cr": tot["cr"] - prev_tot["cr"],
        "cw": tot["cw"] - prev_tot["cw"],
    }
    models = {
        m: round(c - prev_models.get(m, 0.0), 10)
        for m, c in by_model.items()
        if m not in prev_models or c != prev_models[m]
    }
    return {
        "cost_transcript": round(tot["cost"] - prev_tot["cost"], 10),
        "tokens": tokens,
        "models": models,
        "unpriced": sorted(unpriced & set(models)),
        "state": {"tot": tot, "by_model": by_model},
    }


def estimate(profile):
    model = (flag_value(profile["args"], "--model") or "").lower()
    for key, usd in ESTIMATE.items():
        if key in model:
            return usd
    return ESTIMATE_OTHER


def run_estimate(sc, profiles):
    planner = estimate(profiles["planner"]) if "planner" in profiles else 0.0
    per_slice = estimate(profiles["builder"]) + estimate(profiles["reviewer"])
    return (planner + len(sc["slices"]) * per_slice * FIX_FACTOR) * sc["estimateScale"]


class Budget:
    """The matrix's dollars. A call reserves its estimate; one that would pass --max-cost is refused for every run."""

    def __init__(self, max_cost, max_call_cost):
        self.max_cost, self.max_call_cost = max_cost, max_call_cost
        self.spent = self.reserved = 0.0
        self.stopped = False
        self.lock = threading.Lock()

    def admit(self, est):
        """The --max-budget-usd cap for a call that reserves `est`, or None when that call would pass --max-cost."""
        with self.lock:
            if self.stopped or self.spent + self.reserved + est > self.max_cost:
                self.stopped = True
                return None
            self.reserved += est
            return max(0.0, min(self.max_call_cost, self.max_cost - self.spent - (self.reserved - est)))

    def settle(self, est, cost):
        with self.lock:
            self.reserved -= est
            self.spent += cost


class Ctx:
    """What the runs of one matrix share."""

    def __init__(self, results, claude, call_timeout_s, budget, source):
        self.results, self.claude, self.call_timeout_s = results, claude, call_timeout_s
        self.budget, self.source = budget, source


def leak_patterns(sc, source):
    home = os.path.expanduser("~")
    out = [
        source,
        "~/.claude/mods/herdr-agents",
        os.path.join(home, ".claude", "mods", "herdr-agents"),
        "scripts/hrd-eval",
        "plan-18",
        "github.com/contursofran",
    ]
    if (sc.get("hidden") or {}).get("commit"):
        out.append(sc["hidden"]["commit"])
    return out


# One run


class Run:
    """One run: a scenario, an arm and a repeat. Its pipeline, its folder and its run.json."""

    def __init__(self, ctx, sc, arm, k):
        self.ctx, self.sc, self.arm, self.k = ctx, sc, arm, k
        self.dir = os.path.join(ctx.results, sc["id"], arm["id"], f"r{k}")
        self.work = os.path.join(self.dir, "work")
        self.remote = os.path.join(self.dir, "remote.git")
        self.lock = threading.Lock()
        self.started = time.time()
        self.n = 0
        self.cost = 0.0
        self.sessions = {}
        self.decisions = []
        self.answers = 0
        self.plan = None
        self.plan_decisions = []
        self.base = None
        self.ready = False
        self.halt_status = None
        self.halt_error = None
        self.grade_rec = {"ran": False, "kind": None, "merged": False, "merge_error": None, "exit": None, "own_exit": None}
        self.changed = []
        self.issue = read_json(os.path.join(sc["dir"], sc["issue"]["file"]))
        n = sc["issue"]["number"]
        self.slices = []
        for sl in sc["slices"]:
            branch = f"issue-{n}-eval" if len(sc["slices"]) == 1 else f"issue-{n}-{sl['id'].lower()}"
            self.slices.append(
                {
                    "id": sl["id"],
                    "brief": sl["brief"],
                    "branch": branch,
                    "wt": os.path.join(self.dir, f"wt-{sl['id']}"),
                    "builder_sid": None,
                    "exhausted": False,
                    "rec": {
                        "id": sl["id"],
                        "branch": branch,
                        "pr": None,
                        "head": None,
                        "fix_rounds": 0,
                        "reviews": [],
                        "review_unparsed": False,
                    },
                }
            )

    # Halts: the first status recorded is the run's

    def record_halt(self, status, error=None):
        with self.lock:
            if self.halt_status is None:
                self.halt_status, self.halt_error = status, error

    def stop(self, status, error=None):
        self.record_halt(status, error)
        raise Halt(self.halt_status, self.halt_error)

    def check(self):
        if self.halt_status is not None:
            raise Halt(self.halt_status, self.halt_error)

    def finish(self):
        """(status, error) once the pipeline has ended."""
        if self.halt_status is not None:
            return self.halt_status, self.halt_error
        if any(s["exhausted"] for s in self.slices):
            return "rounds_exhausted", None
        if any(s["rec"]["pr"] is None for s in self.slices):
            return "no_pr", None
        return "done", None

    # Setup: the worker repo, the gh state, the worktrees

    def setup(self):
        sc = self.sc
        os.makedirs(os.path.join(self.dir, "jobs"), exist_ok=True)
        os.makedirs(os.path.join(self.dir, "gh-config"), exist_ok=True)
        write_text(os.path.join(self.dir, "env.sh"), f'export PATH={shlex.quote(SHIM_BIN)}:"$PATH"\n')
        snap = os.path.join(self.dir, ".snap")
        scenario_snapshot(sc, self.ctx.source, snap)
        git("init", "-q", "-b", "main", cwd=snap)
        git("add", "-A", cwd=snap)
        git(*IDENT, "commit", "-q", "-m", "Base", cwd=snap)
        git("init", "-q", "--bare", "-b", "main", self.remote)
        git("push", "-q", self.remote, "HEAD:refs/heads/main", cwd=snap)
        shutil.rmtree(snap)
        git("clone", "-q", self.remote, self.work)
        self.base = git("rev-parse", "HEAD", cwd=self.work).stdout.strip()
        gh = os.path.join(self.dir, "gh")
        os.makedirs(os.path.join(gh, "issues"), exist_ok=True)
        write_json(os.path.join(gh, "repo.json"), {"remote": self.remote, "name": sc["id"], "owner": "hrd-eval"})
        write_json(os.path.join(gh, "issues", f"{sc['issue']['number']}.json"), self.issue)
        env = clean_env(self.dir)
        run_setup(sc["setup"], self.work, env)
        for s in self.slices:
            git("worktree", "add", "-q", "-b", s["branch"], s["wt"], "origin/main", cwd=self.work)
            run_setup(sc["setup"], s["wt"], env)
        self.ready = True

    # The pipeline

    def pipeline(self):
        if "planner" in self.arm["profiles"]:
            self.settle(self.call("planner", "plan", None, self.work, self.plan_text()))
            self.plan_decisions = decisions(read_text(self.plan)) if self.plan else []
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=len(self.slices))
        try:
            list(pool.map(self.run_slice, self.slices))
        finally:
            pool.shutdown()

    def run_slice(self, s):
        try:
            self.slice_flow(s)
        except Halt:
            pass  # recorded by stop()
        except Exception as e:  # any other failure ends the run as an error
            self.record_halt("error", f"slice {s['id']}: {e}")

    def slice_flow(self, s):
        rec = s["rec"]
        builder = self.settle(self.call("builder", "build", s["id"], s["wt"], self.build_text(s)))
        s["builder_sid"] = builder["sid"]
        rec["pr"] = self.find_pr(s["branch"], builder)
        if rec["pr"] is None:
            return
        review = self.review(s, "review", self.review_text(s))
        while (review["blockers"] or 0) > 0:
            if rec["fix_rounds"] >= self.arm["maxFixRounds"]:
                s["exhausted"] = True
                return
            rec["fix_rounds"] += 1
            resume = self.arm["fixRound"] == "resume"
            self.settle(
                self.call(
                    "builder",
                    "fix",
                    s["id"],
                    s["wt"],
                    self.fix_text(s, rec["fix_rounds"], review["report"]),
                    sid=s["builder_sid"] if resume else None,
                    resume=resume,
                )
            )
            review = self.review(s, "rereview", self.rereview_text(s, review))

    def review(self, s, kind, text):
        sha = self.head(s["branch"])
        c = self.settle(self.call("reviewer", kind, s["id"], s["wt"], text))
        verdict, blockers, how = parse_verdict(c["report"])
        with self.lock:
            s["rec"]["reviews"].append({"call": c["n"], "sha": sha, "verdict": verdict, "blockers": blockers, "how": how})
            if how == "none":  # no blockers counted, so the fix loop ends; the run says so
                s["rec"]["review_unparsed"] = True
        return {"blockers": blockers, "report": c["report"], "sha": sha, "path": os.path.join(c["job"], "report.md")}

    def settle(self, c):
        """Answers what a call's report asks: the header's ask and the DECISION lines (see questions()). onDecision
        "stop" ends the run with status decision; "recommended" resumes the asker with the answers, at most MAX_ANSWERS
        times a run."""
        while True:
            asked = questions(c["report"])
            if not asked:
                return c
            raw = [text for text, _, _ in asked]
            if self.sc["onDecision"] == "stop":
                self.note(c, raw, [None] * len(raw))
                self.stop("decision", f"{c['role']} asked: {raw[0]}")
            with self.lock:
                full = self.answers >= MAX_ANSWERS
                if not full:
                    self.answers += 1
            if full:
                self.note(c, raw, [None] * len(raw))
                self.stop("decision", f"{MAX_ANSWERS} answers given already; {c['role']} asked again: {raw[0]}")
            self.note(c, raw, [rec for _, _, rec in asked])
            text = "; ".join(f"{q} -> {rec}" for _, q, rec in asked)
            c = self.call(
                c["role"],
                "answer",
                c["slice"],
                c["cwd"],
                lambda R, text=text: f"Answers to your DECISION questions: {text}. Carry on. {R}",
                sid=c["sid"],
                resume=True,
            )

    def note(self, c, asked, answered):
        with self.lock:
            for q, a in zip(asked, answered):
                self.decisions.append({"call": c["n"], "role": c["role"], "text": q, "answered": a})

    def call(self, role, kind, slice_id, cwd, text, sid=None, resume=False):
        """One role call: its job folder, prompt, claude run, cost, and its line in calls.jsonl."""
        self.check()
        profile = self.arm["profiles"][role]
        est = estimate(profile)
        cap = self.ctx.budget.admit(est)
        if cap is None:
            self.stop("budget", f"the {kind} call would pass --max-cost ${self.ctx.budget.max_cost:g}")
        with self.lock:
            self.n += 1
            n = self.n
        name = f"{n:02d}-{role}" + (f"-{slice_id}" if slice_id else "")
        job = os.path.join(self.dir, "jobs", name)
        os.makedirs(job)
        token = uuid.uuid4().hex[:8]
        # REPORTING.md gets the full rule on every call, resumed calls too, with this call's token. A job folder
        # outlives its job, so a resumed prompt cannot rely on a file an earlier prompt left; workers.ts writes
        # the full rule when a folder has no REPORTING.md. A resumed session has the rule already, so its prompt
        # only reminds it of the file.
        write_text(os.path.join(job, "REPORTING.md"), report_rule(job, token))
        prompt = text(report_reminder(job, token) if resume else report_rule(job, token))
        write_text(os.path.join(job, "prompt.txt"), prompt)
        if not resume:
            sid = str(uuid.uuid4())
        env = run_env(self.dir, profile)
        argv = role_argv(profile, sid, resume, cap)
        argv[0] = self.ctx.claude
        started = time.time()
        try:
            code, out, err, timed_out = run_claude(argv, prompt, cwd, env, self.ctx.call_timeout_s)
        except OSError as e:
            self.ctx.budget.settle(est, 0.0)
            raise RunnerError(f"cannot run {self.ctx.claude}: {e}")
        ended = time.time()
        out_text, err_text = out.decode("utf-8", "replace"), err.decode("utf-8", "replace")
        write_text(os.path.join(job, "out.json"), out_text)
        write_text(os.path.join(job, "stderr.txt"), err_text)
        j = parse_json(out_text)
        transcript = find_transcript(sid, env)
        if transcript:
            shutil.copyfile(transcript, os.path.join(job, "transcript.jsonl"))
        with self.lock:
            before = self.sessions.get(sid)
        cc = call_cost(transcript, before)
        reported = number(j.get("total_cost_usd")) if j else None
        prev_reported = (before or {}).get("reported")
        cost_reported = None
        if reported is not None:
            cost_reported = reported - (prev_reported or 0.0) if before is not None else reported
        cost = max(cc["cost_transcript"], cost_reported or 0.0)
        self.ctx.budget.settle(est, cost)
        with self.lock:
            self.cost += cost
            self.sessions[sid] = {**cc["state"], "reported": reported if reported is not None else prev_reported}
        is_error = j is None or bool(j.get("is_error"))
        result = str(j.get("result") or "") if j else ""
        report, source = read_report(job, token, result)
        write_text(os.path.join(job, "report.md"), report)
        plan_file = os.path.join(job, "PLAN.md")
        has_plan = os.path.exists(plan_file)
        if has_plan and role == "planner":
            with self.lock:
                self.plan = plan_file
        record = {
            "n": n,
            "role": role,
            "slice": slice_id,
            "kind": kind,
            "profile": role,
            "argv": argv,
            "session_id": sid,
            "resumed": resume,
            "cwd": cwd,
            "started": started,
            "ended": ended,
            "exit": code,
            "timed_out": timed_out,
            "is_error": is_error,
            "report_source": source,
            "job": f"jobs/{name}",
            "cost_transcript": cc["cost_transcript"],
            "cost_reported": None if cost_reported is None else round(cost_reported, 10),
            "tokens": cc["tokens"],
            "models": cc["models"],
            "unpriced": cc["unpriced"],
        }
        with self.lock:
            append_jsonl(os.path.join(self.dir, "calls.jsonl"), record)
        if timed_out:
            self.stop("timeout", f"{role} {kind} call ran past --call-timeout")
        if code != 0 or is_error:
            if j and str(j.get("subtype", "")).startswith("error_max_budget"):
                self.stop("budget", f"{role} {kind} call reached its --max-budget-usd cap")
            detail = (result or err_text).strip()[-300:]
            self.stop("error", f"{role} {kind} call failed (exit {code}): {detail}")
        return {
            "n": n,
            "role": role,
            "slice": slice_id,
            "kind": kind,
            "job": job,
            "sid": sid,
            "cwd": cwd,
            "report": report,
            "source": source,
            "started": started,
            "ended": ended,
        }

    def find_pr(self, branch, c):
        """The slice's PR: the one whose head is the slice branch; else one created during the call (calls.log);
        else the first PR the report's header names that exists; else the PR number the report links."""
        prs = self.gh_prs()
        for num in sorted(prs):
            if prs[num].get("headRefName") == branch:
                return num
        t0, t1 = c["started"] - 1, c["ended"] + 1
        if self.pr_created_in(t0, t1):
            made = [num for num, rec in prs.items() if t0 <= created_epoch(rec) <= t1]
            if made:
                return max(made)
        for num in header_prs(c["report"]):
            if num in prs:
                return num
        m = re.search(r"/pull/(\d+)", c["report"])
        if m and int(m.group(1)) in prs:
            return int(m.group(1))
        return None

    def gh_prs(self):
        folder = os.path.join(self.dir, "gh", "prs")
        out = {}
        if os.path.isdir(folder):
            for name in os.listdir(folder):
                if name.endswith(".json"):
                    rec = read_json(os.path.join(folder, name))
                    out[int(rec["number"])] = rec
        return out

    def pr_created_in(self, t0, t1):
        path = os.path.join(self.dir, "gh", "calls.log")
        if not os.path.exists(path):
            return False
        for line in read_text(path).splitlines():
            if not line.strip():
                continue
            d = json.loads(line)
            if d["argv"][:2] == ["pr", "create"] and d["exit"] == 0 and t0 <= d["t"] <= t1:
                return True
        return False

    def head(self, branch):
        p = git("--git-dir", self.remote, "rev-parse", "-q", "--verify", f"refs/heads/{branch}", check=False)
        return p.stdout.strip() if p.returncode == 0 else None

    # Prompts (the texts of the plan's "Prompts the runner sends")

    def slice_part(self, s):
        if len(self.sc["slices"]) == 1:
            return ""
        others = ", ".join(o["id"] for o in self.slices if o["id"] != s["id"])
        return f", slice {s['id']} only ({s['brief']}); another builder builds {others}"

    def plan_text(self):
        n, title, work = self.sc["issue"]["number"], self.issue.get("title", ""), self.work
        split = ""
        if len(self.sc["slices"]) > 1:
            parts = "; ".join(f"{s['id']}: {s['brief']}" for s in self.sc["slices"])
            split = f" Split it into these slices, one PR each: {parts}. Write a Contract section for what they share."
        return (
            lambda R: f"Plan issue #{n} ({title}): read it with `gh issue view {n} --comments`. "
            f"The repo is checked out at {work} (base branch main).{split} Change no code. {R}"
        )

    def build_text(self, s):
        n, wt, branch, part = self.sc["issue"]["number"], s["wt"], s["branch"], self.slice_part(s)
        if self.plan:
            head = f"Build issue #{n} from the plan at {self.plan}{part}, in the worktree {wt} (branch {branch}, made off origin/main)."
        else:
            head = (
                f"Build issue #{n}: read it with `gh issue view {n} --comments`; plan it before you build it. "
                f"Work in the worktree {wt} (branch {branch}, made off origin/main){part}."
            )
        return lambda R: f"{head} Open a PR into main. {R}"

    def review_text(self, s):
        n, wt, pr = self.sc["issue"]["number"], s["wt"], s["rec"]["pr"]
        plan = f"; the plan is at {self.plan}" if self.plan else ""
        return (
            lambda R: f"Review PR #{pr} for issue #{n} (`gh pr view {pr}`, `gh pr diff {pr}`){plan}. "
            f"Its worktree is {wt}. {VERDICT_LINE} {R}"
        )

    def fix_text(self, s, k, blockers_report):
        n, wt, pr = self.sc["issue"]["number"], s["wt"], s["rec"]["pr"]
        plan = f"; plan at {self.plan}" if self.plan else ""
        return (
            lambda R: f"Fix round {k} for PR #{pr} (issue #{n}){plan}, in the worktree {wt}. "
            f"The review's blockers:\n{blockers_report}\n{R}"
        )

    def rereview_text(self, s, prev):
        pr = s["rec"]["pr"]
        return (
            lambda R: f"Re-review PR #{pr}: you reviewed {prev['sha']} last time; that review is at {prev['path']}. "
            f"{VERDICT_LINE} {R}"
        )

    # Grade, record

    def grade(self):
        """Merges each slice's branch into main in a clone of the remote, runs the grade command, then runs it again
        with the hidden tests in place. A slice without a PR, or a merge that conflicts, skips the grade."""
        sc, rec = self.sc, self.grade_rec
        for s in self.slices:
            s["rec"]["head"] = self.head(s["branch"])
        grade_dir = os.path.join(self.dir, "grade")
        env = clean_env(self.dir)
        git("clone", "-q", self.remote, grade_dir)
        merged, error = True, None
        for s in self.slices:
            if s["rec"]["head"] is None:
                merged, error = False, f"{s['branch']}: no branch on the remote (no PR)"
                break
            p = git(*IDENT, "merge", "--no-edit", f"origin/{s['branch']}", cwd=grade_dir, check=False)
            if p.returncode != 0:
                git("merge", "--abort", cwd=grade_dir, check=False)
                merged, error = False, f"{s['branch']}: {(p.stdout + p.stderr).strip()[-200:]}"
                break
        rec["merged"], rec["merge_error"] = merged, error
        grade = sc.get("grade")
        if merged and grade:
            cmd, timeout = grade["cmd"], grade["timeout"]
            own_code, own_out = run_grade(cmd, grade_dir, timeout, env)
            write_text(os.path.join(self.dir, "grade", "own.txt"), own_out)
            write_text(os.path.join(self.dir, "grade", "own.exit"), str(own_code))
            hid_code, hid_out = own_code, own_out
            if sc.get("hidden"):
                apply_hidden(sc, self.ctx.source, grade_dir)
                hid_code, hid_out = run_grade(cmd, grade_dir, timeout, env)
            write_text(os.path.join(self.dir, "grade", "hidden.txt"), hid_out)
            write_text(os.path.join(self.dir, "grade", "hidden.exit"), str(hid_code))
            rec.update(ran=True, kind=grade["parser"], exit=hid_code, own_exit=own_code)
        self.changed = changed_files(grade_dir, self.base)

    def write_record(self, status, error):
        rec = {
            "scenario": self.sc["id"],
            "scenario_dir": self.sc["dir"],
            "arm": self.arm["id"],
            "repeat": self.k,
            "status": status,
            "error": error,
            "started": self.started,
            "ended": time.time(),
            "base": self.base,
            "pr_opened": any(s["rec"]["pr"] is not None for s in self.slices),
            "slices": [s["rec"] for s in self.slices],
            "decisions": self.decisions,
            "plan_decisions": self.plan_decisions,
            "grade": self.grade_rec,
            "changed_files": self.changed,
            "leak_patterns": leak_patterns(self.sc, self.ctx.source),
        }
        write_json(os.path.join(self.dir, "run.json"), rec)
        return rec


def run_one(ctx, sc, arm, k):
    """Runs one scenario, arm and repeat; returns its summary line. Never raises."""
    run = Run(ctx, sc, arm, k)
    os.makedirs(run.dir, exist_ok=True)
    try:
        if ctx.budget.stopped:
            raise Halt("budget", "--max-cost was reached before this run started")
        run.setup()
        run.pipeline()
    except Halt as h:
        run.record_halt(h.status, h.error)
    except Exception as e:
        run.record_halt("error", str(e))
    status, error = run.finish()
    if run.ready:
        try:
            run.grade()
        except Exception as e:
            status, error = "error", f"grade: {e}"
    rec = run.write_record(status, error)
    return {
        "scenario": sc["id"],
        "arm": arm["id"],
        "repeat": k,
        "status": rec["status"],
        "error": rec["error"],
        "fix_rounds": sum(s["rec"]["fix_rounds"] for s in run.slices),
        "review_unparsed": any(s["rec"]["review_unparsed"] for s in run.slices),
        "cost": round(run.cost, 4),
        "wall": round(rec["ended"] - rec["started"], 1),
    }


def run_matrix(ctx, scenarios, arms, repeats, parallel, quiet):
    jobs = [(sc, arm, k) for sc in scenarios for arm in arms.values() for k in range(1, repeats + 1)]
    rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=parallel) as pool:
        futures = [pool.submit(run_one, ctx, sc, arm, k) for sc, arm, k in jobs]
        for fut in concurrent.futures.as_completed(futures):
            row = fut.result()
            rows.append(row)
            if not quiet:
                print(
                    f"{row['scenario']:<14} {row['arm']:<4} r{row['repeat']:<2} {row['status']:<16} "
                    f"fix rounds {row['fix_rounds']}  ${row['cost']:.2f}  {row['wall']:.0f} s"
                    + ("  unparsed review" if row["review_unparsed"] else "")
                    + (f"  ({row['error']})" if row["error"] else "")
                )
    return sorted(rows, key=lambda r: (r["scenario"], r["arm"], r["repeat"]))


def score_rows(results, rows, matrix):
    """The aggregate of the runs this matrix made, scored by scripts/hrd-eval/score.py (the table at the end of a run)."""
    try:
        scores = [scorer.score_run(os.path.join(results, r["scenario"], r["arm"], f"r{r['repeat']}")) for r in rows]
    except ValueError as e:  # a graded scenario's expected.json was removed while the matrix ran
        raise RunnerError(str(e))
    return scorer.aggregate(scores, matrix)


# --check-scenarios


def overlay_and_grade(sc, source, folder, env):
    apply_hidden(sc, source, folder)
    return run_grade(sc["grade"]["cmd"], folder, sc["grade"]["timeout"], env)


def check_ungraded(sc, source):
    """A scenario with no grade command has nothing to grade. Its source must make a folder, its setup must run, and
    its expect.decision regex must compile. No expected.json is written for it."""
    problems = []
    decision = (sc.get("expect") or {}).get("decision")
    if decision:
        try:
            re.compile(decision["match"])
        except re.error as e:
            problems.append(f"expect.decision.match does not compile: {e}")
    tmp = tempfile.mkdtemp(prefix="hrd-eval-check-")
    try:
        folder = os.path.join(tmp, "base")
        scenario_snapshot(sc, source, folder)
        run_setup(sc["setup"], folder, clean_env(tmp))
    except (RunnerError, OSError, subprocess.CalledProcessError) as e:
        problems.append(str(e))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {"scenario": sc["id"], "ungraded": True, "base": None, "reference": None, "problems": problems, "drift": [],
            "written": False}


def check_scenario(sc, source, update):
    """Base + overlay must fail, reference + overlay must pass; expected.json holds the reference's tests and the
    base's failing tests (written with update, otherwise compared). A scenario with no grade: check_ungraded()."""
    grade = sc.get("grade")
    if not grade:
        return check_ungraded(sc, source)
    tmp = tempfile.mkdtemp(prefix="hrd-eval-check-")
    try:
        base, ref = os.path.join(tmp, "base"), os.path.join(tmp, "reference")
        scenario_snapshot(sc, source, base)
        if "commit" in (sc.get("hidden") or {}):
            export_tree(source, sc["hidden"]["commit"], ref)
        elif sc["kind"] == "fixture":
            shutil.copytree(base, ref)
            git("apply", os.path.join(sc["dir"], "solution.patch"), cwd=ref)
        else:
            raise RunnerError(f"{sc['id']}: a replay has no reference without hidden.commit")
        env = clean_env(tmp)
        for folder in (base, ref):
            run_setup(sc["setup"], folder, env)
        base_code, base_out = overlay_and_grade(sc, source, base, env)
        ref_code, ref_out = overlay_and_grade(sc, source, ref, env)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    parse = scorer.GRADE_PARSERS[grade["parser"]]
    base_rows, ref_rows = parse(base_out), parse(ref_out)
    discriminating = sorted(n for n, st in base_rows.items() if st == "fail")
    failing_ref = sorted(n for n, st in ref_rows.items() if st == "fail")
    want = {"tests": sorted(ref_rows), "discriminating": discriminating}
    problems = []
    if base_code == 0 or not discriminating:
        problems.append("base + overlay must fail: it passed, or no test failed")
    if ref_code != 0 or failing_ref:
        problems.append(f"reference + overlay must pass: exit {ref_code}, failing {failing_ref}")
    drift, written = [], False
    path = os.path.join(sc["dir"], "expected.json")
    if not problems:
        if update:
            write_json(path, want)
            written = True
        elif not os.path.exists(path):
            drift.append("no expected.json: run with --update-expected")
        else:
            have = read_json(path)
            for key in ("tests", "discriminating"):
                if sorted(have.get(key) or []) != want[key]:
                    drift.append(f"{key}: the run has {want[key]}, expected.json has {sorted(have.get(key) or [])}")
    return {
        "scenario": sc["id"],
        "base": {"exit": base_code, "failing": discriminating, "tests": len(base_rows)},
        "reference": {"exit": ref_code, "tests": want["tests"], "failing": failing_ref},
        "problems": problems,
        "drift": drift,
        "written": written,
    }


def print_check(r):
    if r.get("ungraded"):
        print(f"{r['scenario']}: no grade command, so nothing is graded: the snapshot, setup and decision regex are checked")
    else:
        print(
            f"{r['scenario']}: base + overlay exit {r['base']['exit']}, failing {r['base']['failing']}; "
            f"reference + overlay exit {r['reference']['exit']}, {len(r['reference']['tests'])} tests"
        )
    for p in r["problems"]:
        print(f"  problem: {p}")
    for d in r["drift"]:
        print(f"  drift: {d}")
    if r["written"]:
        print("  expected.json written")
    elif not r["problems"] and not r["drift"] and not r.get("ungraded"):
        print("  expected.json matches")


# --dry-run


def dry_run_data(args, source, scenarios, arms, results):
    max_call = min(args.max_call_cost, args.max_cost)
    data = {"results": results, "repo": source, "max_cost": args.max_cost, "max_call_cost": args.max_call_cost,
            "repeats": args.repeats, "parallel": args.parallel, "call_timeout_min": args.call_timeout,
            "arms": {}, "scenarios": {}, "estimate": 0.0, "runs": 0}
    for arm in arms.values():
        commands = {role: shlex.join(role_argv(prof, "<session-id>", False, max_call)) for role, prof in arm["profiles"].items()}
        data["arms"][arm["id"]] = {"note": arm["note"], "fixRound": arm["fixRound"], "maxFixRounds": arm["maxFixRounds"],
                                   "disable": arm["disable"], "commands": commands, "warnings": arm["warnings"]}
    for sc in scenarios:
        commits = {}
        if "commit" in sc["source"]:
            commits["source"] = {"commit": sc["source"]["commit"], "present": commit_present(source, sc["source"]["commit"])}
        if "commit" in (sc.get("hidden") or {}):
            commits["hidden"] = {"commit": sc["hidden"]["commit"], "present": commit_present(source, sc["hidden"]["commit"])}
        per_arm = {arm["id"]: run_estimate(sc, arm["profiles"]) for arm in arms.values()}
        for est in per_arm.values():
            data["estimate"] += est * args.repeats
            data["runs"] += args.repeats
        data["scenarios"][sc["id"]] = {"kind": sc["kind"], "slices": len(sc["slices"]), "commits": commits,
                                       "estimate_per_run": per_arm}
    data["refused"] = data["estimate"] > args.max_cost
    return data


def print_dry(data, args):
    lines = [
        "hrd-eval --dry-run: nothing is called",
        f"results: {data['results']} (not created)",
        f"repeats {args.repeats}, parallel {args.parallel}, max cost ${args.max_cost:g} "
        f"(per call ${args.max_call_cost:g}), call timeout {args.call_timeout:g} min",
        "",
    ]
    for arm_id, arm in data["arms"].items():
        note = f"  ({arm['note']})" if arm["note"] else ""
        disable = f", disable {', '.join(arm['disable'])}" if arm["disable"] else ""
        lines.append(f"arm {arm_id}{note}: fixRound {arm['fixRound']}, maxFixRounds {arm['maxFixRounds']}{disable}")
        for role in ("planner", "builder", "reviewer"):
            if role in arm["commands"]:
                lines.append(f"  {role:<9} {arm['commands'][role]}")
        for w in arm["warnings"]:
            lines.append(f"  warning: {w}")
    lines.append("")
    for sc_id, sc in data["scenarios"].items():
        lines.append(f"scenario {sc_id} ({sc['kind']}, {sc['slices']} slice(s))")
        for name, c in sc["commits"].items():
            lines.append(f"  {name} commit {c['commit']} in the source repo: {'yes' if c['present'] else 'NO'}")
        for arm_id, est in sc["estimate_per_run"].items():
            lines.append(f"  arm {arm_id}: ${est:.2f} per run, ${est * args.repeats:.2f} for {args.repeats} repeat(s)")
    verdict = "REFUSED: over --max-cost, a real run would exit 2" if data["refused"] else "fits"
    lines.append(
        f"total: {data['runs']} runs, estimate ${data['estimate']:.2f} against --max-cost ${args.max_cost:g}: {verdict}"
    )
    return "\n".join(lines)


# Command line


def parse_args(argv):
    p = argparse.ArgumentParser(description="hrd-eval runner (issue #28, level 1: workers only).")
    p.add_argument("--scenarios", help="comma-separated scenario ids (default: all)")
    p.add_argument("--arms", help="comma-separated arm ids (default: all)")
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--parallel", type=int, default=1)
    p.add_argument("--dry-run", action="store_true", help="print the matrix and each role's command; call nothing")
    p.add_argument("--check-scenarios", action="store_true", help="grade base and reference; no model call")
    p.add_argument("--update-expected", action="store_true", help="with --check-scenarios: write expected.json")
    p.add_argument("--max-cost", type=float, default=30.0, help="dollars for the whole matrix")
    p.add_argument("--max-call-cost", type=float, default=5.0, help="dollars for one call")
    p.add_argument("--call-timeout", type=float, default=20.0, help="minutes per call")
    p.add_argument("--results", help="results folder, outside this repo")
    p.add_argument("--config", help="herdr-agents.json (default: the user's)")
    p.add_argument("--claude", default="claude", help="the claude command")
    p.add_argument("--scenarios-dir", default=DEFAULT_SCENARIOS)
    p.add_argument("--arms-dir", default=DEFAULT_ARMS)
    p.add_argument("--source-repo", default=REPO, help="the repo the scenarios' commits are in")
    p.add_argument("--json", action="store_true")
    return p.parse_args(argv)


def cli(args):
    source = os.path.realpath(args.source_repo)
    if args.update_expected and not args.check_scenarios:
        raise RunnerError("--update-expected goes with --check-scenarios")
    if args.repeats < 1 or args.parallel < 1:
        raise RunnerError("--repeats and --parallel must be at least 1")
    if args.max_cost <= 0 or args.max_call_cost <= 0 or args.call_timeout <= 0:
        raise RunnerError("--max-cost, --max-call-cost and --call-timeout must be above 0")
    scenarios = load_scenarios(args.scenarios_dir, split_names(args.scenarios))
    if args.check_scenarios:
        results = [check_scenario(sc, source, args.update_expected) for sc in scenarios]
        if args.json:
            print(json.dumps(results, indent=2))
        else:
            for r in results:
                print_check(r)
        return 1 if any(r["problems"] or r["drift"] for r in results) else 0
    results = os.path.realpath(args.results or default_results())
    if inside(results, source):
        raise RunnerError(f"--results {results} is inside the repo {source}; pick a folder outside it")
    arms = load_arms(args.arms_dir, split_names(args.arms), args.config or default_config())
    if args.dry_run:
        data = dry_run_data(args, source, scenarios, arms, results)
        if args.json:
            print(json.dumps(data, indent=2))
        else:
            print(print_dry(data, args))
        return 2 if data["refused"] else 0
    total = sum(run_estimate(sc, arm["profiles"]) for sc in scenarios for arm in arms.values()) * args.repeats
    if total > args.max_cost:
        print(f"hrd-eval: estimate ${total:.2f} is over --max-cost ${args.max_cost:g}: nothing was run", file=sys.stderr)
        return 2
    for sc in scenarios:
        try:
            scorer.load_expected(sc["dir"], sc)  # a graded scenario's runs can only be scored with its expected.json
        except ValueError as e:
            raise RunnerError(str(e))
    for arm in arms.values():
        for w in arm["warnings"]:
            print(f"warning: {w}", file=sys.stderr)
    if os.path.exists(results):
        raise RunnerError(f"{results} already exists; pick another --results folder")
    os.makedirs(results)
    matrix = {
        "started": time.time(),
        "repo_root": source,
        "scenarios": [sc["id"] for sc in scenarios],
        "arms": arms,
        "repeats": args.repeats,
        "max_cost": args.max_cost,
        "estimate": total,
    }
    write_json(os.path.join(results, "matrix.json"), matrix)
    ctx = Ctx(results, args.claude, args.call_timeout * 60, Budget(args.max_cost, args.max_call_cost), source)
    rows = run_matrix(ctx, scenarios, arms, args.repeats, args.parallel, args.json)
    agg = score_rows(results, rows, matrix)
    if args.json:
        print(json.dumps(agg, indent=2))
    else:
        scorer.print_text(agg)
    return 2 if any(r["status"] == "budget" for r in rows) else 0


def main(argv=None):
    try:
        return cli(parse_args(argv))
    except RunnerError as e:
        print(f"hrd-eval: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
