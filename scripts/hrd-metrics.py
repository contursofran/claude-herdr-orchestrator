#!/usr/bin/env python3
"""Baseline metrics for herdr-agents: how a coordinator and its workers spend time and tokens.

Usage: hrd-metrics.py [--days N] [--since "YYYY-MM-DD HH:MM"] [--reports DIR] [--repo [+]OWNER/NAME] [--json]   (default 7 days)

Reads only what Claude Code and the mod already write:
  - transcripts: $CLAUDE_CONFIG_DIR/projects/*/*.jsonl (default ~/.claude/projects)
  - worker folders: <cwd>/.herdr-agents/<worker>/ with RESULT-<token>.md and SCREEN-<token>.txt
  - the report archive: ~/.herdr-agents/reports/<worker folder>/ (--reports DIR), the mod's copy of each
    report file; used when the worker folder is gone because its worktree was pruned
A coordinator session got at least one <herdr-agent> prompt. A worker session's first prompt
names .herdr-agents/<worker>/TASK.md. Everything counts inside the window, by record time.
The window starts at --since (local time), at --days ago, or at the later of the two when both are given.
A report counts when its prompt is inside the window, even when its session started before it;
a session's turns and cost count from the window start.

Per report (one <herdr-agent> prompt from the mod):
  turns     assistant turns from the prompt to its first spawn/message/stop call (that turn
            included), or to the next user or plugin prompt when there is no such call
  reaction  everything until the next user or plugin prompt: tokens and cost per report
  det       detection lag: the worker's earliest RESULT.md write (a Write or Edit call, or a Bash redirect
            or heredoc, in the worker's transcript, with `<!-- report <token> -->` on its first line)
            to the mtime of RESULT-<token>.md, which the mod writes when it delivers the report
  det_est   with no queue lag (the worker folder is gone, or the token file is missing): the prompt minus
            that same earliest write. It includes the queue lag, which is unknown then: an upper bound on det
  queue     queue lag: RESULT-<token>.md mtime to the prompt. The prompt names the token when the
            report is long (a pointer); a short report is matched to the worker's RESULT files by its text
  action    prompt to the first spawn/message/stop call
Reads of RESULT files (Read calls, and Bash cat/head/tail/sed/less on them) are counted per session;
read% is the share of reports followed by one. COORDINATOR-STATE.md edits (Edit/Write calls, and Bash commands that write it: sed -i, > or >>, tee,
python open(..., 'w')) are counted per session and divided by its reports. A prompt with several
<herdr-agent> blocks gives one report per block; the reaction goes to the last.
Prompt kinds: each coordinator prompt is a report (<herdr-agent), pipeline (<herdr-pipeline), bgtask (<task-notification),
panel (<herdr-decision, <herdr-owner-done), compact (<herdr-context, or Claude Code's own continuation summary) or owner
(other text; shell echoes and slash-command records are not prompts). prompt_kinds counts the prompts of each kind and
the unique assistant message ids (model turns) after them, up to the next prompt.
merged_prs counts worker-built PRs merged in the window: Bash `gh pr merge N` calls whose result is not an error, leaving
out those with a --subject that starts with Version, plus <herdr-pipeline event="merged" pr="N"> prompts; unique per
repo (-R/--repo, else none) and number.
mech_turns_per_pr is the turns after report, pipeline and bgtask prompts per merged PR; wakeups_per_pr counts those
prompts (None when nothing merged). Text columns: mrg, t/PR, w/PR.
Spawn lead is the coordinator's assistant turns before each successful spawn: from the last user or plugin
prompt, or the previous spawn/message/stop result, up to the spawn call (that turn included).
wt_calls counts Bash calls that run `git worktree add`, plus the `git fetch` call right before one (a fetch
that no worktree add follows is not counted); wt/sp is wt_calls per successful spawn.
branch% is the share of successful spawns that passed `branch`. start_failed counts <herdr-agent status="failed">
prompts that start with "The worker did not start".
Spawn time is the duration of each spawn call that succeeded; a denied one ("Wrapping up") is left out.
Subagent transcripts (<session>/subagents/*.jsonl) are not top-level files and are not counted.

GitHub section, through `gh`, per repo:
  repos     the GitHub `origin` remotes of the working folders of every session in the window. --repo OWNER/NAME
            (repeatable) reports only the repos named and reads no folders, even when mixed with +; --repo +OWNER/NAME
            alone adds one to the repos found. A folder that is gone, such as a pruned worktree, gives no repo and is
            counted on one line.
  window    GitHub filters by date: runs and PRs count from the UTC date the window starts on.
  CI        per workflow: runs, failures (failure or timed_out), median and worst queue wait (created to started)
            and run time (started to last update). Runs that never started a job (startup failure, cancelled
            while queued) are left out and counted on one "ignored" line. Skipped and unfinished runs are left out.
  PR flow   merged PRs (newest 40): open to merged, fix commits (committed after opening) and failed CI runs on
            the head branch. A branch that is the base of a merged PR counts as a base, and its runs do not count.
            Limit: a stacked PR's parent branch is a base too, so its failures are not counted.
A repo `gh` cannot read or answering in an unexpected shape, or with no runs and no merged PRs, shows one line. pi sessions are not analysed here:
their count is printed, and agent-metrics.py reads them.
"""

import argparse
import collections
import glob
import json
import os
import re
import statistics
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

# List prices in USD per million tokens, from pi's model catalogue (~/.pi/agent/models-store.json);
# not checked against Anthropic's price page. A 1-hour cache write costs 2x input (not in that file).
# A model's `tier` applies to a request whose input + cache read + cache write is above its threshold.
PRICES = {
    "claude-opus-5-5": {"inp": 4, "out": 20, "cr": 0.2, "cw5": 5, "cw1h": 8},
    "claude-sonnet-5-5": {"inp": 2, "out": 10, "cr": 0.1, "cw5": 2.5, "cw1h": 4},
    "claude-haiku-5-5": {
        "inp": 0.1,
        "out": 0.5,
        "cr": 0.01,
        "cw5": 0.125,
        "cw1h": 0.2,
        "tier": (100_000, {"inp": 0.5, "out": 2.5, "cr": 0.05, "cw5": 0.625, "cw1h": 1}),
    },
    "claude-fable-5-1": {"inp": 10, "out": 50, "cr": 0.25, "cw5": 12.5, "cw1h": 20},
}
RATE_KEYS = ("inp", "out", "cr", "cw5", "cw1h")

SPAWN = "mcp__herdr-agents__spawn"
BOUNDARY = {SPAWN, "mcp__herdr-agents__message", "mcp__herdr-agents__stop"}
# Claude Code puts "The herdr-agents plugin sent a message:" before a plugin prompt; the tag may come bare too.
PROMPT_TAG = re.compile(r'\s*(?:The herdr-agents plugin sent a message:\s*)?<herdr-agent((?:\s+[\w-]+="[^"]*")*)\s*>')
ATTR = re.compile(r'([\w-]+)="([^"]*)"')
# A long report reaches the prompt as a pointer to its file: "[Full report, 24 lines: <path>RESULT-<token>.md. ...]"
# or, in the cut wording, "[Report cut to its summary. Full report (3971 chars): <path>RESULT-<token>.md]".
POINTER = re.compile(r"\[[^\n]*?Full report[^\n]*?RESULT-(\w+)\.md")
TASK_IN_PROMPT = re.compile(r"(/\S*?)/\.herdr-agents/([^/\s]+)/TASK\.md")
RESULT_FILE = re.compile(r"RESULT(?:-\w+)?\.md")
REPORT_MARK = re.compile(r"^\s*<!-- report \S+ -->\s*")
MARK = re.compile(r"<!-- report (\S+) -->")  # the token a worker puts on RESULT.md's first line
WORKTREE_ADD = re.compile(r"\bgit\s+(?:-C\s+\S+\s+)?worktree\s+add\b")
GIT_FETCH = re.compile(r"\bgit\s+(?:-C\s+\S+\s+)?fetch\b")
# A Bash command counts as one write when it names COORDINATOR-STATE.md and has a write anywhere in it:
# a redirect to it, tee, sed -i, perl -i, a python open(<anything>, 'w'/'a'/'x') or write_text.
# The command is not split: the file name may sit in a variable, and ; may sit inside a quoted script.
STATE_NAME = "COORDINATOR-STATE.md"
STATE_REDIRECT = re.compile(r">>?\s*[\"']?\S*COORDINATOR-STATE\.md")
STATE_TEE = re.compile(r"\btee\b(?:\s+-\w+)*\s+[\"']?\S*COORDINATOR-STATE\.md")
SED_INPLACE = re.compile(r"\bsed\b(?:\s+-\w+)*?\s+(?:-\w*i\w*|--in-place)\b")
STATE_PY = re.compile(r"open\([^)]*,\s*(?:mode\s*=\s*)?[\"'][wax]\+?b?[\"']|\.write_text\(")
PERL_INPLACE = re.compile(r"\bperl\b(?:\s+-\w+)*?\s+-\w*i\w*")
START_FAILED = "The worker did not start"
READ_CMDS = ("cat", "head", "tail", "sed", "less")
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n(.*?)^[ \t]*\2[ \t]*$", re.M | re.S)
CD = re.compile(r"\s*cd\s+[\"']?([^\s\"';&|]+)[\"']?\s*(?:&&|;)")
ASSIGN = re.compile(r"[A-Za-z_]\w*=")
ASSIGN_VALUE = re.compile(r"(?:^|[;&\n]\s*)([A-Za-z_]\w*)=([^\s;&|'\"]+)")  # D=/path; ... $D/RESULT.md
RESULT_WRITE = re.compile(r"(?:>>?|\btee(?:\s+-a)?)\s*[\"']?([^\s\"'<>|;&]*?)RESULT\.md(?![\w.-])")
RESULT_OUT = re.compile(r">>?\s*\S*RESULT(?:-\w+)?\.md")  # a segment that writes a RESULT file is not a read
SKIP_LINES = (b'{"type":"api-request',)  # the big system-prompt dumps; no metric reads them
DEFAULT_DAYS = 7
REPO_ARG = re.compile(r"\+?[\w.-]+/[\w.-]+")
GITHUB_REMOTE = re.compile(r"(?:^|@|//)github\.com[:/]+([\w.-]+)/([\w.-]+?)(?:\.git)?/?$")
PR_LIMIT = 40  # newest merged PRs per repo: GitHub caps the commits query size
RUNS_CAP = 1000  # GitHub returns no more runs than this for a filtered query
MALFORMED = (ValueError, KeyError, TypeError, AttributeError)  # what a gh reply of the wrong shape raises
# What woke the coordinator. `report`, `pipeline` and `bgtask` prompts are mechanical: no human asked for them.
KINDS = ("report", "pipeline", "bgtask", "panel", "compact", "owner")
MECH = ("report", "pipeline", "bgtask")
PLUGIN_PREAMBLE = re.compile(r"\s*(?:The herdr-agents plugin sent a message:\s*)?")
KIND_TAGS = (
    ("<herdr-agent", "report"),
    ("<herdr-pipeline", "pipeline"),
    ("<task-notification", "bgtask"),
    ("<herdr-decision", "panel"),
    ("<herdr-owner-done", "panel"),
    ("<herdr-context", "compact"),
    ("This session is being continued", "compact"),  # Claude Code's own compaction summary
)
# Shell echoes and slash-command records Claude Code stores as user records: not prompts, they wake nobody.
NOT_PROMPTS = ("<bash-input>", "<bash-stdout>", "<bash-stderr>", "<local-command", "<command-")
MERGE_CMD = re.compile(r"\bgh\s+pr\s+merge\s+(?:\S*/pull/)?(\d+)")
MERGE_REPO = re.compile(r"(?:--repo|-R)[ =]\s*[\"']?([\w.-]+/[\w.-]+)")
MERGE_VERSION = re.compile(r"(?:--subject|-t)[ =]\s*[\"']?Version\b")
MERGED_EVENT = re.compile(r'<herdr-pipeline\b([^>]*\bevent="merged"[^>]*)>')


def prompt_kind(text):
    """The kind of a prompt (see KINDS), or None for a record that is not a prompt (a shell echo, a slash command)."""
    body = text[PLUGIN_PREAMBLE.match(text).end() :]
    if body.startswith(NOT_PROMPTS):
        return None
    for prefix, kind in KIND_TAGS:
        if body.startswith(prefix):
            return kind
    return "owner"


def merges(cmd):
    """[(repo, number, is_version)] for each `gh pr merge` in a Bash command; repo is "" unless -R/--repo names it."""
    found = list(MERGE_CMD.finditer(cmd))
    out = []
    for i, m in enumerate(found):
        rest = cmd[m.end() : found[i + 1].start() if i + 1 < len(found) else len(cmd)]
        repo = MERGE_REPO.search(rest)
        out.append((repo.group(1) if repo else "", int(m.group(1)), bool(MERGE_VERSION.search(rest))))
    return out


def merged_events(text):
    """[(repo, number)] for each <herdr-pipeline event="merged" pr="N"> tag in a prompt."""
    out = []
    for m in MERGED_EVENT.finditer(text):
        attrs = dict(ATTR.findall(m.group(1)))
        if attrs.get("pr", "").isdigit():
            out.append((attrs.get("repo", ""), int(attrs["pr"])))
    return out


def epoch(stamp):
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


def since_arg(text):
    """A local-time 'YYYY-MM-DD HH:MM' as an epoch time; argparse reports a text it cannot read."""
    try:
        return datetime.strptime(text, "%Y-%m-%d %H:%M").timestamp()
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD HH:MM (local time), got {text!r}")


def window_start(days, since, now):
    """Where the window starts: `days` before now, at `since`, or the later of the two when both are given."""
    starts = []
    if days is not None:
        starts.append(now - days * 86400)
    if since is not None:
        starts.append(since)
    return max(starts) if starts else now - DEFAULT_DAYS * 86400


def records(path):
    """The user and assistant records of one transcript, in file order."""
    with open(path, "rb") as fh:
        for line in fh:
            if line.startswith(SKIP_LINES) or (b'"user"' not in line and b'"assistant"' not in line):
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") in ("user", "assistant") and d.get("timestamp"):
                yield d


def prompt_text(content):
    """The text of a human or plugin prompt, or None for a record that only carries tool results."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        if parts:
            return "\n".join(parts)
    return None


def first_line_token(text):
    """The token of a `<!-- report <token> -->` that is the first line of text (blank lines before it are skipped)."""
    m = MARK.match(text.lstrip())
    return m.group(1) if m else None


def result_folder(path):
    """The folder <cwd>/.herdr-agents/<worker> that a RESULT.md path lies in; None for any other path."""
    path = os.path.normpath(path)
    if os.path.basename(path) != "RESULT.md":
        return None
    folder = os.path.dirname(path)
    return folder if os.path.basename(os.path.dirname(folder)) == ".herdr-agents" else None


def expand_assignments(cmd):
    """The command with $NAME and ${NAME} replaced by the value of a plain `NAME=value` set earlier in it."""
    values = dict(ASSIGN_VALUE.findall(cmd))
    return re.sub(r"\$\{?(\w+)\}?", lambda m: values.get(m.group(1), m.group(0)), cmd)


def bash_result_writes(cmd, cwd):
    """(folder, token) for each RESULT.md that a Bash command writes by a redirect, tee or heredoc.

    A command may hold several heredocs (a plan, then the report). Each piece of the command between
    heredocs is one unit: its redirect takes the token on the first line of the heredoc after it, or, when
    that has none, the first `<!-- report <token> -->` in the unit (printf arguments). The text after the
    last heredoc takes that heredoc's token (`{ cat <<EOF ... EOF` then `} > RESULT.md`).
    """
    cmd = expand_assignments(cmd)
    cd = CD.match(cmd)  # `cd <dir> && cat > RESULT.md` writes into <dir>
    base = os.path.join(cwd or "", os.path.expanduser(cd.group(1))) if cd else (cwd or "")
    units, pos, last = [], 0, None  # (unit text, the token of the heredoc after it)
    for m in HEREDOC.finditer(cmd):
        units.append((cmd[pos : m.start()], first_line_token(m.group(3))))
        pos = m.end()
        last = units[-1][1]
    units.append((cmd[pos:], last))
    found = []
    for text, token in units:
        mark = MARK.search(text)
        token = token or (mark.group(1) if mark else None)
        if token is None:
            continue
        for m in RESULT_WRITE.finditer(text):
            folder = result_folder(os.path.join(base, os.path.expanduser(m.group(1)), "RESULT.md"))
            if folder:
                found.append((folder, token))
    return found


def sed_in_place(opts):
    """Whether sed's options (the words after `sed`) include -i or --in-place: that edits the file."""
    return any(o == "--in-place" or o.startswith("--in-place=") or (o[:1] == "-" and o[1:2] != "-" and "i" in o) for o in opts)


def bash_state_write(cmd):
    """True when the Bash command names COORDINATOR-STATE.md and writes: sed -i, perl -i, > or >>, tee, python open(..., 'w')."""
    if STATE_NAME not in cmd:
        return False
    return any(r.search(cmd) for r in (STATE_PY, STATE_REDIRECT, STATE_TEE, SED_INPLACE, PERL_INPLACE))


def bash_reads(cmd):
    """Whether a segment of a Bash command reads a RESULT file: cat, head, tail, sed or less on it, not a write."""
    for seg in re.split(r"\|\||&&|[|;&\n]", expand_assignments(HEREDOC.sub("", cmd))):
        words = seg.split()
        while words and ASSIGN.match(words[0]):
            words = words[1:]
        if not words:
            continue
        name = os.path.basename(words[0].lstrip("({"))
        if name not in READ_CMDS or (name == "sed" and sed_in_place(words[1:])) or RESULT_OUT.search(seg):
            continue
        if any(RESULT_FILE.fullmatch(os.path.basename(w.strip("'\""))) for w in words[1:]):
            return True
    return False


def usage(msg):
    u = msg.get("usage") or {}
    cc = u.get("cache_creation") or {}
    cw1h = cc.get("ephemeral_1h_input_tokens") or 0
    cw_all = u.get("cache_creation_input_tokens") or 0
    return {
        "inp": u.get("input_tokens") or 0,
        "out": u.get("output_tokens") or 0,
        "cr": u.get("cache_read_input_tokens") or 0,
        "cw5": cc.get("ephemeral_5m_input_tokens", cw_all - cw1h) or 0,
        "cw1h": cw1h,
    }


def price(model, u):
    """USD for one request, or None when PRICES has no entry for the model."""
    p = PRICES.get(model)
    if p is None:
        return None
    rates = p
    if "tier" in p and u["inp"] + u["cr"] + u["cw5"] + u["cw1h"] > p["tier"][0]:
        rates = p["tier"][1]
    return sum(u[k] * rates[k] for k in RATE_KEYS) / 1e6


def new_tot():
    return {"turns": 0, "inp": 0, "out": 0, "cr": 0, "cw": 0, "cost": 0.0}


def add(tot, u, cost):
    tot["turns"] += 1
    tot["inp"] += u["inp"]
    tot["out"] += u["out"]
    tot["cr"] += u["cr"]
    tot["cw"] += u["cw5"] + u["cw1h"]
    tot["cost"] += cost or 0.0


class Report:
    def __init__(self, ts, folder, inner):
        self.ts = ts
        self.folder, self.inner = folder, inner
        pointer = POINTER.search(inner)
        self.pointer = bool(pointer)
        self.token = pointer.group(1) if pointer else None
        self.resp_open = True
        self.turns = set()
        self.action = None
        self.read = False
        self.tot = new_tot()
        self.queue = None
        self.queue_how = None  # "token" or "text": how the RESULT file was found
        self.queue_miss = None  # why there is no queue lag, when there is none
        self.det = None  # the worker's earliest RESULT.md write to the RESULT file's mtime
        self.det_est = None  # with no queue lag: the prompt minus that write (includes the queue lag)


class Session:
    def __init__(self, path):
        self.sid = os.path.basename(path)[: -len(".jsonl")]
        self.cwd = None
        self.start = None
        self.reports = []
        self.spawn_cwd = {}
        self.spawn_folders = set()
        self.spawn_secs = []
        self.spawn_lead = []  # assistant turns before each successful spawn, from the previous boundary
        self.spawn_branch = 0  # successful spawns that passed `branch`
        self.wt_calls = 0  # Bash calls running `git worktree add`, and the git fetch call right before one
        self.start_failed = 0
        self.read_calls = 0  # Read calls on a RESULT file
        self.bash_reads = 0  # Bash cat/head/tail/sed/less on a RESULT file
        self.result_writes = []  # (worker folder, token, time) of each RESULT.md this session wrote
        self.edits = 0
        self.tot = new_tot()
        self.by_model = {}
        self.unpriced = set()
        self.worker = None
        self.quiet = 0
        self.kinds = {k: {"prompts": 0, "turns": 0} for k in KINDS}  # prompts that woke the coordinator, and model turns after them
        self.merged = set()  # (repo, number) of each worker-built PR merged in the window

    def reports_in(self, ts, tag, text):
        """Adds a report for every <herdr-agent> block in the prompt; returns the last, which takes the reaction."""
        while True:
            r = self.report(ts, tag, text)
            end = text.find("</herdr-agent>", tag.end())
            tag = PROMPT_TAG.match(text, end + len("</herdr-agent>")) if end >= 0 else None
            if tag is None:
                return r

    def report(self, ts, tag, text):
        name = dict(ATTR.findall(tag.group(1))).get("name", "")
        end = text.find("</herdr-agent>", tag.end())
        inner = text[tag.end() : end if end >= 0 else len(text)].strip()
        cwd = self.spawn_cwd.get(name) or self.cwd
        folder = os.path.normpath(os.path.join(cwd, ".herdr-agents", name)) if cwd else None
        r = Report(ts, folder, inner)
        if dict(ATTR.findall(tag.group(1))).get("status") == "failed" and inner.startswith(START_FAILED):
            self.start_failed += 1
        self.reports.append(r)
        return r


def scan(path, since):
    s = Session(path)
    seen, pending = set(), {}
    cur = None  # the report whose reaction is still running
    lead = set()  # assistant turns since the last boundary (prompt, or spawn/message/stop result)
    prompts = 0
    kind = None  # the kind of the prompt whose turns are being counted
    merging = {}  # Bash tool_use id -> [(repo, number)] of a `gh pr merge` call whose result is not in yet
    fetch_before = False  # the previous Bash call was a git fetch
    for d in records(path):
        ts = epoch(d["timestamp"])
        if ts < since:
            continue
        if s.start is None:
            s.start, s.cwd = ts, d.get("cwd")
        msg = d.get("message") or {}
        content = msg.get("content")
        if d["type"] == "user":
            text = prompt_text(content)
            if text is None:  # tool results: a spawn's duration ends here
                for b in content if isinstance(content, list) else []:
                    if isinstance(b, dict) and b.get("tool_use_id") in pending:
                        started, turns, branch = pending.pop(b["tool_use_id"])
                        if turns is not None and not b.get("is_error"):  # a denied spawn returns at once: it blocked nothing
                            s.spawn_secs.append(ts - started)
                            s.spawn_lead.append(turns)
                            s.spawn_branch += branch
                        lead = set()
                    for key in merging.pop(b.get("tool_use_id") if isinstance(b, dict) else None, ()):
                        if not b.get("is_error"):
                            s.merged.add(key)
                continue
            if d.get("isMeta"):  # Claude Code's own context records, not a prompt
                continue
            new = prompt_kind(text)
            if new is None:
                continue
            kind = new
            s.kinds[kind]["prompts"] += 1
            s.merged.update(merged_events(text))
            lead = set()
            tag = PROMPT_TAG.match(text)
            if tag:
                cur = s.reports_in(ts, tag, text)
            else:
                cur = None
                if prompts == 0:
                    found = TASK_IN_PROMPT.search(text)
                    if found:
                        s.worker = found.group(2)
                prompts += 1
            continue

        model = msg.get("model") or "?"
        if model.startswith("<"):  # synthetic API errors carry no usage
            continue
        mid = msg.get("id") or d.get("uuid")
        if mid not in seen:
            seen.add(mid)  # one API call writes one record per content block, all with the same usage
            u = usage(msg)
            c = price(model, u)
            if c is None:
                s.unpriced.add(model)
            add(s.tot, u, c)
            add(s.by_model.setdefault(model, new_tot()), u, c)
            if kind is not None:
                s.kinds[kind]["turns"] += 1
            if cur is not None:
                add(cur.tot, u, c)
        lead.add(mid)
        if cur is not None and cur.resp_open:
            cur.turns.add(mid)
        rcwd = d.get("cwd") or s.cwd  # the directory this record's Bash and file paths start from
        for b in content if isinstance(content, list) else []:
            if not (isinstance(b, dict) and b.get("type") == "tool_use"):
                continue
            name, args = b.get("name") or "", b.get("input") or {}
            if name in BOUNDARY and cur is not None and cur.resp_open:
                cur.resp_open = False
                cur.action = (name, ts)
            if name in BOUNDARY and name != SPAWN:
                pending[b.get("id")] = (ts, None, False)
            if name == SPAWN:
                pending[b.get("id")] = (ts, len(lead), bool(args.get("branch")))
                worker, cwd = args.get("worker"), args.get("cwd")
                if worker and cwd:
                    s.spawn_cwd[worker] = cwd
                    s.spawn_folders.add((cwd, worker))
            elif name == "Read" and RESULT_FILE.fullmatch(os.path.basename(str(args.get("file_path") or ""))):
                s.read_calls += 1
                if cur is not None:
                    cur.read = True
            elif name == "Bash":
                cmd = str(args.get("command") or "")
                keys = [(repo, n) for repo, n, version in merges(cmd) if not version]
                if keys:
                    merging[b.get("id")] = keys
                if WORKTREE_ADD.search(cmd):
                    s.wt_calls += 1 + (fetch_before and not GIT_FETCH.search(cmd))  # the fetch call right before counts too
                fetch_before = bool(GIT_FETCH.search(cmd)) and not WORKTREE_ADD.search(cmd)
                if bash_state_write(cmd):
                    s.edits += 1
                if bash_reads(cmd):
                    s.bash_reads += 1
                    if cur is not None:
                        cur.read = True
                s.result_writes.extend((folder, token, ts) for folder, token in bash_result_writes(cmd, rcwd))
            elif name in ("Edit", "Write"):
                file_path = str(args.get("file_path") or "")
                if os.path.basename(file_path) == "COORDINATOR-STATE.md":
                    s.edits += 1
                folder = result_folder(os.path.join(rcwd or "", file_path))
                token = first_line_token(str(args.get("content" if name == "Write" else "new_string") or ""))
                if folder and token:
                    s.result_writes.append((folder, token, ts))
    return s


def collect(root, since, reports=None, cwds=None):
    """Scans every transcript written in the window; returns (coordinator sessions, worker sessions), resolved.
    The working folder of every session, plain ones too, is added to the set `cwds` when one is given."""
    scanned = [
        scan(path, since)
        for path in sorted(glob.glob(os.path.join(root, "*", "*.jsonl")))
        if os.path.getmtime(path) >= since
    ]
    if cwds is not None:
        cwds.update(s.cwd for s in scanned if s.cwd)
    coords = [s for s in scanned if s.reports]
    workers = [s for s in scanned if not s.reports and s.worker]
    writes = write_index(scanned)  # a worker's RESULT.md write can only be found once every transcript is read
    for s in coords:
        resolve(s, since, writes, reports)
    return coords, workers


def write_index(sessions):
    """(folder, token) -> the earliest time a session wrote that RESULT.md with the token on its first line."""
    first = {}
    for s in sessions:
        for folder, token, ts in s.result_writes:
            first[(folder, token)] = min(ts, first.get((folder, token), ts))
    return first


def found(r, mtime, how, writes):
    """Sets a report's queue from its RESULT file's mtime, and its det from the worker's write of that file."""
    r.queue, r.queue_how = r.ts - mtime, how
    wrote = writes.get((r.folder, r.token))
    if wrote is not None:
        r.det = mtime - wrote


def write_lag(r, writes):
    """Without a queue lag, det_est: the prompt minus the worker's earliest write of the report's RESULT.md."""
    wrote = writes.get((r.folder, r.token)) if r.folder and r.token else None
    if wrote is not None:
        r.det_est = r.ts - wrote


def archived(folder, reports):
    """The archive copy of a worker folder (the mod copies each report there), or the folder itself when it exists."""
    if os.path.isdir(folder) or not reports:
        return folder
    copy = os.path.join(reports, folder.lstrip("/"))
    return copy if os.path.isdir(copy) else folder


def resolve(s, since, writes, reports=None):
    """Fills each report's queue and det from the RESULT file the mod wrote for it, and counts quiet stops.

    With no queue lag, det_est is the prompt minus the worker's write (write_lag).
    writes is write_index() over every session: the worker's RESULT.md writes.
    reports is the archive folder: a worker folder that is gone is read from its copy there.
    """
    texts = {}  # folder -> [(mtime, body, token)], read once per folder
    for r in s.reports:
        if not r.folder:
            r.queue_miss = "no cwd"
            continue
        where = archived(r.folder, reports)
        if not os.path.isdir(where):
            r.queue_miss = "folder gone"  # the worktree was pruned after its PR merged, and no archive copy is left
            continue
        if r.token:
            path = os.path.join(where, f"RESULT-{r.token}.md")
            if os.path.exists(path):
                found(r, os.path.getmtime(path), "token", writes)
            else:
                r.queue_miss = "token file missing"
            continue
        if r.folder not in texts:
            texts[r.folder] = []
            for path in glob.glob(os.path.join(where, "RESULT-*.md")):
                with open(path, encoding="utf-8", errors="replace") as fh:
                    body = REPORT_MARK.sub("", fh.read()).strip()
                token = os.path.basename(path)[len("RESULT-") : -len(".md")]
                texts[r.folder].append((os.path.getmtime(path), body, token))
        # The prompt carries a short report whole, so its text starts with the file's text.
        hits = [(mt, tok) for mt, body, tok in texts[r.folder] if body and mt <= r.ts + 5 and r.inner.startswith(body)]
        if hits:
            mt, r.token = max(hits)
            found(r, mt, "text", writes)
        else:
            r.queue_miss = "no report file"  # blocked and stopped prompts write none; older mods wrote RESULT.md only
    for r in s.reports:
        if r.queue is None:
            write_lag(r, writes)
    s.quiet = sum(
        1
        for cwd, worker in s.spawn_folders
        for path in glob.glob(os.path.join(archived(os.path.join(cwd, ".herdr-agents", worker), reports), "SCREEN-*.txt"))
        if os.path.getmtime(path) >= since
    )


def dist(xs):
    """n, median, p90 (nearest rank) and max of a list; None values when empty."""
    xs = sorted(xs)
    if not xs:
        return {"n": 0, "median": None, "p90": None, "max": None}
    return {
        "n": len(xs),
        "median": round(statistics.median(xs), 2),
        "p90": round(xs[min(len(xs) - 1, -(-9 * len(xs) // 10) - 1)], 2),
        "max": round(xs[-1], 2),
    }


def fmt_1(x):
    return "-" if x is None else f"{x:.1f}"


def fmt_ratio(x):
    return "-" if x is None else f"{x:.2f}"


def fmt_money(x):
    return "-" if x is None else f"${x:.2f}"


def share(part, whole):
    return part / whole if whole else None


def queue_by(reports):
    """How many queue lags were found by token, by text, and why the rest have none."""
    how = collections.Counter(r.queue_how for r in reports if r.queue is not None)
    missing = collections.Counter(r.queue_miss for r in reports if r.queue is None)
    return {"token": how["token"], "text": how["text"], "missing": dict(missing)}


def det_missing(reports):
    """Why each report has neither det nor det_est: no worker wrote its token's RESULT.md, or (no token) its queue miss."""
    why = ["no worker write" if r.token else r.queue_miss for r in reports if r.det is None and r.det_est is None]
    return dict(collections.Counter(why))


def per_pr(kinds, merged):
    """prompt_kinds, merged_prs, and the mechanical turns and wake-ups per merged PR (None when nothing merged)."""
    return {
        "prompt_kinds": {k: dict(v) for k, v in kinds.items()},
        "merged_prs": merged,
        "mech_turns_per_pr": share(sum(kinds[k]["turns"] for k in MECH), merged),
        "wakeups_per_pr": share(sum(kinds[k]["prompts"] for k in MECH), merged),
    }


def coordinator_row(s):
    reports = s.reports
    n = len(reports)
    return {
        "start": s.start,
        "session": s.sid[:8],
        "cwd": (s.cwd or "").replace(os.path.expanduser("~"), "~"),
        "project": (s.cwd or "").split("/Documents/code/")[-1],
        "reports": n,
        "turns": dist([len(r.turns) for r in reports]),
        "read_share": share(sum(r.read for r in reports), n),
        "pointer_share": share(sum(r.pointer for r in reports), n),
        "reads": {"read": s.read_calls, "bash": s.bash_reads},
        "edits_per_report": share(s.edits, n),
        "det": dist([r.det for r in reports if r.det is not None]),
        "det_est": dist([r.det_est for r in reports if r.det_est is not None]),
        "det_missing": det_missing(reports),
        "queue": dist([r.queue for r in reports if r.queue is not None]),
        "queue_by": queue_by(reports),
        "action": dist([r.action[1] - r.ts for r in reports if r.action]),
        "spawn": dist(s.spawn_secs),
        "spawn_lead": dist(s.spawn_lead),
        "wt_calls": s.wt_calls,
        "wt_per_spawn": share(s.wt_calls, len(s.spawn_secs)),
        "branch_share": share(s.spawn_branch, len(s.spawn_secs)),
        "start_failed": s.start_failed,
        "quiet": s.quiet,
        "tokens": dict(s.tot),
        "reaction_cost_per_report": share(sum(r.tot["cost"] for r in reports), n),
        **per_pr(s.kinds, len(s.merged)),
    }


def totals(rows, coords):
    """One row over all coordinator sessions: lists pooled, counts summed."""
    reports = [r for s in coords for r in s.reports]
    n = len(reports)
    tok = new_tot()
    kinds = {k: {"prompts": 0, "turns": 0} for k in KINDS}
    for s in coords:
        for k in tok:
            tok[k] += s.tot[k]
        for k in KINDS:
            for f in ("prompts", "turns"):
                kinds[k][f] += s.kinds[k][f]
    return {
        "sessions": len(rows),
        "reports": n,
        "turns": dist([len(r.turns) for r in reports]),
        "read_share": share(sum(r.read for r in reports), n),
        "pointer_share": share(sum(r.pointer for r in reports), n),
        "reads": {"read": sum(s.read_calls for s in coords), "bash": sum(s.bash_reads for s in coords)},
        "edits_per_report": share(sum(s.edits for s in coords), n),
        "det": dist([r.det for r in reports if r.det is not None]),
        "det_est": dist([r.det_est for r in reports if r.det_est is not None]),
        "det_missing": det_missing(reports),
        "queue": dist([r.queue for r in reports if r.queue is not None]),
        "queue_by": queue_by(reports),
        "action": dist([r.action[1] - r.ts for r in reports if r.action]),
        "spawn": dist([x for s in coords for x in s.spawn_secs]),
        "spawn_lead": dist([x for s in coords for x in s.spawn_lead]),
        "wt_calls": sum(s.wt_calls for s in coords),
        "wt_per_spawn": share(sum(s.wt_calls for s in coords), sum(len(s.spawn_secs) for s in coords)),
        "branch_share": share(sum(s.spawn_branch for s in coords), sum(len(s.spawn_secs) for s in coords)),
        "start_failed": sum(s.start_failed for s in coords),
        "quiet": sum(s.quiet for s in coords),
        "tokens": tok,
        "reaction_cost_per_report": share(sum(r.tot["cost"] for r in reports), n),
        **per_pr(kinds, sum(len(s.merged) for s in coords)),
    }


def worker_models(workers):
    by_model = {}
    for s in workers:
        for model, tot in s.by_model.items():
            agg = by_model.setdefault(model, {"sessions": 0, **new_tot()})
            agg["sessions"] += 1
            for k in new_tot():
                agg[k] += tot[k]
    return by_model


def fmt_s(x):
    return "-" if x is None else f"{x:.0f}"


def fmt_pct(x):
    return "-" if x is None else f"{x:.0%}"


def fmt_tok(x):
    return f"{x:,d}"


def short(s, width):
    return s if len(s) <= width else "…" + s[-(width - 1) :]


def when(ts):
    return datetime.fromtimestamp(ts).strftime("%m-%d %H:%M")


def missing_text(missing):
    return ", ".join(f"{n} {why}" for why, n in sorted(missing.items(), key=lambda kv: -kv[1])) or "none"


def tilde(path):
    """The path with the home folder shown as ~ when it is under it, so pasted output does not carry the user name."""
    home = os.path.expanduser("~").rstrip("/")
    if home and (path == home or path.startswith(home + "/")):
        return "~" + path[len(home):]
    return path


def print_text(label, rows, tot, workers, by_model, unpriced, root):
    print(f"== coordinator sessions, {label}: {len(rows)} with {tot['reports']} reports")
    if not rows:
        print("   none: no transcript in the window got a <herdr-agent> prompt")
    else:
        print("start        session  cwd                              rpts turns read% ptr%  reads edit/r"
              "  det med  p90  max  queue med  p90  max  act med  p90  spawn med  max lead med wt/sp br% sfail quiet"
              "  mrg  t/PR  w/PR")
        for r in rows + [None]:
            row = tot if r is None else r
            label = "total" if r is None else short(r["project"], 32)
            start = "" if r is None else when(r["start"])
            session = "" if r is None else r["session"]
            det, queue, act, spawn = row["det"], row["queue"], row["action"], row["spawn"]
            reads = row["reads"]["read"] + row["reads"]["bash"]
            print(f"{start:12s} {session:8s} {label:32s} {row['reports']:4d} {fmt_1(row['turns']['median']):>5s} "
                  f"{fmt_pct(row['read_share']):>5s} {fmt_pct(row['pointer_share']):>4s} {reads:6d} "
                  f"{fmt_ratio(row['edits_per_report']):>6s}  {fmt_s(det['median']):>7s} {fmt_s(det['p90']):>4s} "
                  f"{fmt_s(det['max']):>4s}  {fmt_s(queue['median']):>9s} {fmt_s(queue['p90']):>4s} {fmt_s(queue['max']):>4s}  "
                  f"{fmt_s(act['median']):>7s} {fmt_s(act['p90']):>4s}  "
                  f"{fmt_s(spawn['median']):>9s} {fmt_s(spawn['max']):>4s} {fmt_1(row['spawn_lead']['median']):>8s} "
                  f"{fmt_ratio(row['wt_per_spawn']):>5s} {fmt_pct(row['branch_share']):>4s} {row['start_failed']:5d} {row['quiet']:5d}"
                  f" {row['merged_prs']:4d} {fmt_1(row['mech_turns_per_pr']):>5s} {fmt_1(row['wakeups_per_pr']):>5s}")
        print("   turns: model turns per report up to its spawn/message/stop call; read%: reports followed by a RESULT read"
              " (Read or Bash); ptr%: reports whose prompt pointed at the file")
        print("   det s: the worker's earliest RESULT.md write to RESULT-<token>.md; queue s: RESULT-<token>.md to the prompt;"
              " act s: prompt to its spawn/message/stop call; spawn: the tool call; lead: coordinator turns before a spawn; wt/sp: git worktree add/fetch calls per spawn; br%: spawns that passed branch; sfail: workers that did not start; quiet: SCREEN files (stopped without a report)")
        print("   mrg: worker-built PRs merged (gh pr merge that worked, not Version; plus pipeline merged events); "
              "t/PR, w/PR: model turns and wake-ups from report, pipeline and background-task prompts, per merged PR")
        print("   prompt kinds (turns/prompts): " + ", ".join(
            f"{k} {tot['prompt_kinds'][k]['turns']}/{tot['prompt_kinds'][k]['prompts']}" for k in KINDS))
        print("\n== tokens and cost (session = every turn in the window; $/rpt = cost inside each report's reaction)")
        print("start        session  rpts        input      cache-r      cache-w      output       cost  $/rpt")
        for r in rows + [None]:
            row = tot if r is None else r
            t = row["tokens"]
            label = "total" if r is None else r["session"]
            start = "" if r is None else when(r["start"])
            per = row["reaction_cost_per_report"]
            print(f"{start:12s} {label:8s} {row['reports']:4d}  {fmt_tok(t['inp']):>11s}  {fmt_tok(t['cr']):>11s}  "
                  f"{fmt_tok(t['cw']):>11s}  {fmt_tok(t['out']):>11s}  ${t['cost']:9,.2f}  {fmt_money(per):>5s}")
        est = tot["det_est"]
        est_text = (f"; prompt minus write, no queue lag known, for {est['n']} more (median {fmt_s(est['median'])} s, "
                    f"p90 {fmt_s(est['p90'])} s, max {fmt_s(est['max'])} s; queue lag included)") if est["n"] else ""
        print(f"\n== det found for {tot['det']['n']} of {tot['reports']} reports{est_text}; "
              f"the rest: {missing_text(tot['det_missing'])}")
        print(f"== queue found for {tot['queue']['n']} of {tot['reports']} reports (by token {tot['queue_by']['token']}, "
              f"by text {tot['queue_by']['text']}); the rest: {missing_text(tot['queue_by']['missing'])}")
    print(f"\n== worker sessions by model: {len(workers)} (first prompt names .herdr-agents/<worker>/TASK.md)")
    if by_model:
        print("model                  sess    turns        input      cache-r      cache-w      output       cost")
        for model, m in sorted(by_model.items(), key=lambda kv: -kv[1]["cost"]):
            print(f"{model[:22]:22s} {m['sessions']:5d}  {m['turns']:7d}  {fmt_tok(m['inp']):>11s}  {fmt_tok(m['cr']):>11s}  "
                  f"{fmt_tok(m['cw']):>11s}  {fmt_tok(m['out']):>11s}  ${m['cost']:9,.2f}")
    result_reads = tot["reads"]
    print(f"\n   reads of RESULT files: {result_reads['read']} Read calls and {result_reads['bash']} Bash reads (cat, head, tail, sed, less)")
    print("   not counted: subagent transcripts (<session>/subagents/)")
    if unpriced:
        print(f"   no price for {', '.join(sorted(unpriced))}: cost counted as 0")
    print(f"   transcripts from {tilde(root)}")


def repo_arg(text):
    """--repo's value: OWNER/NAME, or +OWNER/NAME to add it to the repos found."""
    if not REPO_ARG.fullmatch(text):
        raise argparse.ArgumentTypeError(f"expected OWNER/NAME or +OWNER/NAME, got {text!r}")
    return text


def github_repo(url):
    """OWNER/NAME of a GitHub remote URL, or None for any other host."""
    m = GITHUB_REMOTE.search(url.strip())
    return f"{m.group(1)}/{m.group(2)}" if m else None


def folder_repo(cwd):
    """(repo, None), or (None, why) when the working folder gives no GitHub repo."""
    if not os.path.isdir(cwd):
        return None, "gone"
    try:
        p = subprocess.run(["git", "-C", cwd, "remote", "get-url", "origin"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None, "no GitHub remote"
    repo = github_repo(p.stdout) if p.returncode == 0 else None
    return (repo, None) if repo else (None, "no GitHub remote")


def find_repos(cwds):
    """The sorted GitHub repos of the working folders, and how many folders gave none, by reason."""
    repos, skipped = {}, collections.Counter()
    with ThreadPoolExecutor(max_workers=8) as ex:
        for repo, why in ex.map(folder_repo, sorted(cwds)):
            if repo:
                repos.setdefault(repo.lower(), repo)
            else:
                skipped[why] += 1
    return [repos[k] for k in sorted(repos)], dict(skipped)


def choose_repos(asked, cwds):
    """The repos to report from --repo's values and the working folders, and the folders that gave none."""
    only = [r for r in asked if not r.startswith("+")]
    added = [r[1:] for r in asked if r.startswith("+")]
    found, skipped = ([], {}) if only else find_repos(cwds)
    repos = {}
    for repo in only + found + added:
        repos.setdefault(repo.lower(), repo)
    return [repos[k] for k in sorted(repos)], skipped


def gh(*args, timeout=120):
    """Runs gh; returns (stdout, None), or (None, why) when it failed."""
    try:
        p = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "timed out"
    except OSError as e:
        return None, str(e)
    if p.returncode != 0:
        lines = p.stderr.strip().splitlines()
        return None, lines[0][:200] if lines else f"gh exited with {p.returncode}"
    return p.stdout, None


def job_count(repo, run_id):
    """How many jobs a run has, or None if GitHub cannot tell (then it is treated as a real run)."""
    out, _ = gh("api", f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=1", "--jq", ".total_count", timeout=60)
    try:
        return int(out.strip())
    except (AttributeError, ValueError):
        return None


def read_runs(repo, day):
    """The finished runs from `day` on (skipped ones left out); returns (runs, whether GitHub's cap was hit, None), or
    (None, False, why). The cap counts every row GitHub returned, the ones left out too."""
    out, why = gh("api", "--paginate", f"repos/{repo}/actions/runs?per_page=100&created=>={day}", "--jq",
                  ".workflow_runs[]|[.name,.conclusion,.created_at,.run_started_at,.updated_at,(.id|tostring),.head_branch]|@tsv")
    if why:
        return None, False, why
    runs = []
    lines = out.splitlines()
    for line in lines:
        name, concl, created, started, updated, rid, branch = (line.split("\t") + [""] * 7)[:7]
        if started and concl not in ("skipped", ""):
            runs.append({"id": rid, "name": name, "concl": concl, "created": created, "started": started,
                         "updated": updated, "branch": branch})
    return runs, len(lines) >= RUNS_CAP, None


def jobless_runs(repo, runs):
    """Ids of the runs that never started a job. Only failed-looking ones are probed: a few calls, not one per run."""
    jobless = {r["id"] for r in runs if r["concl"] == "startup_failure"}
    suspect = [r["id"] for r in runs if r["concl"] in ("failure", "cancelled", "timed_out") and r["id"] not in jobless]
    with ThreadPoolExecutor(max_workers=8) as ex:
        jobless.update(rid for rid, n in zip(suspect, ex.map(lambda rid: job_count(repo, rid), suspect)) if n == 0)
    return jobless


def workflow_rows(runs, jobless):
    """One row per workflow with at least one real run, most run time first."""
    wf = collections.defaultdict(lambda: {"failures": 0, "queue": [], "run": []})
    for r in runs:
        if r["id"] in jobless:
            continue
        w = wf[r["name"]]
        w["failures"] += r["concl"] in ("failure", "timed_out")
        w["queue"].append(epoch(r["started"]) - epoch(r["created"]))
        w["run"].append(epoch(r["updated"]) - epoch(r["started"]))
    rows = [{"name": name, "runs": len(w["queue"]), "failures": w["failures"],
             "queue_median": statistics.median(w["queue"]), "queue_max": max(w["queue"]),
             "run_median": statistics.median(w["run"]), "run_total": sum(w["run"])} for name, w in wf.items()]
    return sorted(rows, key=lambda w: -w["run_total"])


def pr_flow(prs, runs, jobless):
    """Open to merged, fix commits and failed CI runs over the merged PRs."""
    bases = {p.get("baseRefName") for p in prs}
    failed = collections.Counter(r["branch"] for r in runs
                                 if r["concl"] == "failure" and r["id"] not in jobless and r["branch"] not in bases)
    rows = []
    for p in prs:
        opened = epoch(p["createdAt"])
        rows.append({"number": int(p["number"]), "title": str(p["title"]),
                     "author": str((p.get("author") or {}).get("login") or "?"),
                     "hours": (epoch(p["mergedAt"]) - opened) / 3600,
                     "fix_commits": sum(1 for c in p.get("commits", []) if c.get("committedDate") and epoch(c["committedDate"]) > opened),
                     "failed_ci": failed[p["headRefName"]]})
    rows.sort(key=lambda r: -(r["hours"] + r["fix_commits"] * 2 + r["failed_ci"] * 2))
    hours = [r["hours"] for r in rows]
    return {"merged": len(rows), "capped": len(rows) >= PR_LIMIT,
            "hours_median": statistics.median(hours) if rows else None, "hours_max": max(hours) if rows else None,
            "fix_commits_median": statistics.median(r["fix_commits"] for r in rows) if rows else None,
            "failed_ci_median": statistics.median(r["failed_ci"] for r in rows) if rows else None,
            "slowest": rows[:6]}


def repo_flow(repo, day):
    """CI and PR flow of one repo. A failure ends up in `error` or `prs_error`: it never stops the report."""
    flow = {"repo": repo}
    runs, capped, why = read_runs(repo, day)
    if why:
        flow["error"] = why
        return flow
    jobless = jobless_runs(repo, runs)
    ignored = collections.Counter(r["name"] for r in runs if r["id"] in jobless)
    try:
        flow.update(workflows=workflow_rows(runs, jobless), ignored=dict(ignored), runs_capped=capped)
    except MALFORMED as e:
        flow["error"] = f"unexpected reply: {e}"
        return flow
    out, why = gh("pr", "list", "-R", repo, "--state", "merged", "--limit", str(PR_LIMIT), "--search", f"merged:>={day}",
                  "--json", "number,title,author,createdAt,mergedAt,headRefName,baseRefName,commits", timeout=180)
    if not why:
        try:
            prs = json.loads(out)
            if not isinstance(prs, list):
                raise TypeError("not a list")
            flow["prs"] = pr_flow(prs, runs, jobless)
        except MALFORMED as e:
            why = f"unexpected reply: {e}"
    if why:
        flow["prs_error"] = why
    return flow


def github_flows(repos, since):
    day = datetime.fromtimestamp(since, timezone.utc).strftime("%Y-%m-%d")
    with ThreadPoolExecutor(max_workers=4) as ex:
        return day, list(ex.map(lambda repo: repo_flow(repo, day), repos))


def pi_session_count(since):
    """pi sessions written in the window, by file time; the old script analyses them."""
    paths = glob.glob(os.path.expanduser("~/.pi/agent/sessions/*/*.jsonl"))
    return sum(1 for path in paths if os.path.getmtime(path) >= since)


def fmt_m(secs):
    return f"{secs / 60:5.1f}m"


def print_flow(flow):
    repo = flow["repo"]
    if "error" in flow:
        print(f"  {repo}: gh cannot read it: {flow['error']}")
        return
    wf, prs = flow["workflows"], flow.get("prs")
    if not wf and not flow["ignored"] and prs and not prs["merged"]:
        print(f"  {repo}: no CI runs and no merged PRs")
        return
    print(f"  {repo}")
    if flow["ignored"]:
        detail = ", ".join(f"{name} {n}" for name, n in sorted(flow["ignored"].items(), key=lambda kv: -kv[1]))
        print(f"    ignored {sum(flow['ignored'].values())} jobless runs (no job ever started): {detail}")
    if not wf and not flow["ignored"]:
        print("    no CI runs")
    if flow["runs_capped"]:
        print(f"    GitHub returns at most {RUNS_CAP} runs for a filter: the counts may be short")
    for w in wf:
        print(f"    {w['name'][:28]:28s} {w['runs']:4d} runs {w['failures']:3d} fail  queue med {fmt_m(w['queue_median'])} "
              f"max {fmt_m(w['queue_max'])}  run med {fmt_m(w['run_median'])} total {w['run_total'] / 3600:5.1f}h")
    if "prs_error" in flow:
        print(f"    PRs: gh cannot read them: {flow['prs_error']}")
    elif prs["merged"]:
        newest = f" (newest {PR_LIMIT} only)" if prs["capped"] else ""
        print(f"    PRs merged: {prs['merged']}{newest}  open→merged median {prs['hours_median']:.1f}h, max {prs['hours_max']:.1f}h  "
              f"fix commits median {prs['fix_commits_median']:.0f}  failed CI runs median {prs['failed_ci_median']:.0f}")
        print("    slowest / most reworked:")
        for r in prs["slowest"]:
            print(f"      #{r['number']:<5} {r['hours']:5.1f}h  {r['fix_commits']:2d} fix commits  {r['failed_ci']:2d} failed CI  "
                  f"{r['author'][:14]:14s} {r['title'][:60]}")
    else:
        print("    PRs merged: 0")


def print_github(day, flows, skipped, pi_sessions):
    print(f"== GitHub, {len(flows)} repos, from {day} UTC (queue = created → started; run = started → finished)")
    if not flows:
        print("  no repos: no session folder in the window has a GitHub remote; --repo OWNER/NAME names one")
    for flow in flows:
        print_flow(flow)
    if skipped:
        print(f"  session folders with no repo: {missing_text(skipped)}")
    if pi_sessions:
        print(f"== pi: {pi_sessions} sessions in the window, not counted here; agent-metrics.py reads them")
    print()


def main():
    ap = argparse.ArgumentParser(description="Coordinator and worker time and tokens from Claude Code transcripts.")
    ap.add_argument("--days", type=int, help=f"count the last N days (default {DEFAULT_DAYS} when --since is not given)")
    ap.add_argument("--since", type=since_arg, metavar='"YYYY-MM-DD HH:MM"',
                    help="count from this local time on; with --days too, the later of the two starts the window")
    ap.add_argument("--reports", default="~/.herdr-agents/reports", metavar="DIR",
                    help="the mod's report archive, read for worker folders that were removed (default %(default)s)")
    ap.add_argument("--repo", action="append", default=[], type=repo_arg, metavar="[+]OWNER/NAME",
                    help="report only this repo; a plain OWNER/NAME turns off finding repos from the sessions' folders, even when "
                         "mixed with +. +OWNER/NAME alone adds it to the repos found (repeatable)")
    ap.add_argument("--json", action="store_true", help="print JSON instead of the tables")
    args = ap.parse_args()
    days = args.days
    if days is None and args.since is None:
        days = DEFAULT_DAYS
    since = window_start(days, args.since, time.time())
    label = f"last {days} days" if args.since is None else f"since {datetime.fromtimestamp(since):%Y-%m-%d %H:%M}"
    root = os.path.join(os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude"), "projects")

    cwds = set()
    coords, workers = collect(root, since, os.path.expanduser(args.reports), cwds)
    coords.sort(key=lambda s: s.start)
    rows = [coordinator_row(s) for s in coords]
    tot = totals(rows, coords)
    by_model = worker_models(workers)
    unpriced = {m for s in coords + workers for m in s.unpriced}
    repos, skipped = choose_repos(args.repo, cwds)
    day, flows = github_flows(repos, since)
    pi_sessions = pi_session_count(since)

    if args.json:
        out = {
            "days": days,
            "window_start": datetime.fromtimestamp(since).strftime("%Y-%m-%d %H:%M"),
            "coordinators": rows,
            "totals": tot,
            "workers": {"sessions": len(workers), "by_model": by_model},
            "unpriced": sorted(unpriced),
            "github": {"from": day, "repos": flows, "folders_without_repo": skipped},
            "pi_sessions": pi_sessions,
        }
        print(json.dumps(out, indent=2))
        return
    print_github(day, flows, skipped, pi_sessions)
    print_text(label, rows, tot, workers, by_model, unpriced, root)


if __name__ == "__main__":
    main()
