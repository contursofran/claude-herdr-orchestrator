#!/usr/bin/env python3
"""Baseline metrics for herdr-agents: how a coordinator and its workers spend time and tokens.

Usage: hrd-metrics.py [--days N] [--json]        (default 7 days)

Reads only what Claude Code and the mod already write:
  - transcripts: $CLAUDE_CONFIG_DIR/projects/*/*.jsonl (default ~/.claude/projects)
  - worker folders: <cwd>/.herdr-agents/<worker>/ with RESULT-<token>.md and SCREEN-<token>.txt
A coordinator session got at least one <herdr-agent> prompt. A worker session's first prompt
names .herdr-agents/<worker>/TASK.md. Everything counts inside the window, by record time.

Per report (one <herdr-agent> prompt from the mod):
  turns     assistant turns from the prompt to its first spawn/message/stop call (that turn
            included), or to the next user or plugin prompt when there is no such call
  reaction  everything until the next user or plugin prompt: tokens and cost per report
  lag       RESULT-<token>.md mtime to the prompt. The prompt names the token when the report
            is long (a pointer); a short report is matched to the worker's RESULT files by its text
  action    prompt to the first spawn/message/stop call
Reads and COORDINATOR-STATE.md edits are counted per session and divided by its reports.
Spawn time is the duration of each spawn call that succeeded; a denied one ("Wrapping up") is left out.
Subagent transcripts (<session>/subagents/*.jsonl) are not top-level files and are not counted.
"""

import argparse
import collections
import glob
import json
import os
import re
import statistics
import time
from datetime import datetime

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
SKIP_LINES = (b'{"type":"api-request',)  # the big system-prompt dumps; no metric reads them


def epoch(stamp):
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


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
        self.lag = None
        self.lag_how = None  # "token" or "text": how the RESULT file was found
        self.lag_miss = None  # why there is no lag, when there is none


class Session:
    def __init__(self, path):
        self.sid = os.path.basename(path)[: -len(".jsonl")]
        self.cwd = None
        self.start = None
        self.reports = []
        self.spawn_cwd = {}
        self.spawn_folders = set()
        self.spawn_secs = []
        self.reads = 0
        self.edits = 0
        self.tot = new_tot()
        self.by_model = {}
        self.unpriced = set()
        self.worker = None
        self.quiet = 0

    def report(self, ts, tag, text):
        name = dict(ATTR.findall(tag.group(1))).get("name", "")
        end = text.find("</herdr-agent>", tag.end())
        inner = text[tag.end() : end if end >= 0 else len(text)].strip()
        cwd = self.spawn_cwd.get(name) or self.cwd
        folder = os.path.join(cwd, ".herdr-agents", name) if cwd else None
        r = Report(ts, folder, inner)
        self.reports.append(r)
        return r


def scan(path, since):
    s = Session(path)
    seen, pending = set(), {}
    cur = None  # the report whose reaction is still running
    prompts = 0
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
                        started = pending.pop(b["tool_use_id"])
                        if not b.get("is_error"):  # a denied spawn returns at once: it blocked nothing
                            s.spawn_secs.append(ts - started)
                continue
            if d.get("isMeta"):  # Claude Code's own context records, not a prompt
                continue
            tag = PROMPT_TAG.match(text)
            if tag:
                cur = s.report(ts, tag, text)
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
            if cur is not None:
                add(cur.tot, u, c)
        if cur is not None and cur.resp_open:
            cur.turns.add(mid)
        for b in content if isinstance(content, list) else []:
            if not (isinstance(b, dict) and b.get("type") == "tool_use"):
                continue
            name, args = b.get("name") or "", b.get("input") or {}
            if name in BOUNDARY and cur is not None and cur.resp_open:
                cur.resp_open = False
                cur.action = (name, ts)
            if name == SPAWN:
                pending[b.get("id")] = ts
                worker, cwd = args.get("worker"), args.get("cwd")
                if worker and cwd:
                    s.spawn_cwd[worker] = cwd
                    s.spawn_folders.add((cwd, worker))
            elif name == "Read" and RESULT_FILE.fullmatch(os.path.basename(str(args.get("file_path") or ""))):
                s.reads += 1
                if cur is not None:
                    cur.read = True
            elif name in ("Edit", "Write") and os.path.basename(str(args.get("file_path") or "")) == "COORDINATOR-STATE.md":
                s.edits += 1
    return s


def resolve(s, since):
    """Fills each report's lag from the RESULT file the mod wrote for it, and counts quiet stops."""
    texts = {}  # folder -> [(mtime, body)], read once per folder
    for r in s.reports:
        if not r.folder:
            r.lag_miss = "no cwd"
            continue
        if not os.path.isdir(r.folder):
            r.lag_miss = "folder gone"  # the worktree was pruned after its PR merged
            continue
        if r.token:
            path = os.path.join(r.folder, f"RESULT-{r.token}.md")
            if os.path.exists(path):
                r.lag, r.lag_how = r.ts - os.path.getmtime(path), "token"
            else:
                r.lag_miss = "token file missing"
            continue
        if r.folder not in texts:
            texts[r.folder] = []
            for path in glob.glob(os.path.join(r.folder, "RESULT-*.md")):
                with open(path, encoding="utf-8", errors="replace") as fh:
                    texts[r.folder].append((os.path.getmtime(path), REPORT_MARK.sub("", fh.read()).strip()))
        # The prompt carries a short report whole, so its text starts with the file's text.
        hits = [mt for mt, body in texts[r.folder] if body and mt <= r.ts + 5 and r.inner.startswith(body)]
        if hits:
            r.lag, r.lag_how = r.ts - max(hits), "text"
        else:
            r.lag_miss = "no report file"  # blocked and stopped prompts write none; older mods wrote RESULT.md only
    s.quiet = sum(
        1
        for cwd, worker in s.spawn_folders
        for path in glob.glob(os.path.join(cwd, ".herdr-agents", worker, "SCREEN-*.txt"))
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


def lag_by(reports):
    """How many lags were found by token, by text, and why the rest have none."""
    found = collections.Counter(r.lag_how for r in reports if r.lag is not None)
    missing = collections.Counter(r.lag_miss for r in reports if r.lag is None)
    return {"token": found["token"], "text": found["text"], "missing": dict(missing)}


def coordinator_row(s):
    reports = s.reports
    n = len(reports)
    lags = [r.lag for r in reports if r.lag is not None]
    return {
        "start": s.start,
        "session": s.sid[:8],
        "cwd": (s.cwd or "").replace(os.path.expanduser("~"), "~"),
        "project": (s.cwd or "").split("/Documents/code/")[-1],
        "reports": n,
        "turns": dist([len(r.turns) for r in reports]),
        "read_share": share(sum(r.read for r in reports), n),
        "pointer_share": share(sum(r.pointer for r in reports), n),
        "reads": s.reads,
        "edits_per_report": share(s.edits, n),
        "lag": dist(lags),
        "lag_by": lag_by(reports),
        "action": dist([r.action[1] - r.ts for r in reports if r.action]),
        "spawn": dist(s.spawn_secs),
        "quiet": s.quiet,
        "tokens": dict(s.tot),
        "reaction_cost_per_report": share(sum(r.tot["cost"] for r in reports), n),
    }


def totals(rows, coords):
    """One row over all coordinator sessions: lists pooled, counts summed."""
    reports = [r for s in coords for r in s.reports]
    n = len(reports)
    tok = new_tot()
    for s in coords:
        for k in tok:
            tok[k] += s.tot[k]
    return {
        "sessions": len(rows),
        "reports": n,
        "turns": dist([len(r.turns) for r in reports]),
        "read_share": share(sum(r.read for r in reports), n),
        "pointer_share": share(sum(r.pointer for r in reports), n),
        "reads": sum(s.reads for s in coords),
        "edits_per_report": share(sum(s.edits for s in coords), n),
        "lag": dist([r.lag for r in reports if r.lag is not None]),
        "lag_by": lag_by(reports),
        "action": dist([r.action[1] - r.ts for r in reports if r.action]),
        "spawn": dist([x for s in coords for x in s.spawn_secs]),
        "quiet": sum(s.quiet for s in coords),
        "tokens": tok,
        "reaction_cost_per_report": share(sum(r.tot["cost"] for r in reports), n),
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


def print_text(days, rows, tot, workers, by_model, unpriced, root):
    print(f"== coordinator sessions, last {days} days: {len(rows)} with {tot['reports']} reports")
    if not rows:
        print("   none: no transcript in the window got a <herdr-agent> prompt")
    else:
        print("start        session  cwd                              rpts turns read% ptr%  reads edit/r"
              "  lag med  p90  max  act med  p90  spawn med  max quiet")
        for r in rows + [None]:
            row = tot if r is None else r
            label = "total" if r is None else short(r["project"], 32)
            start = "" if r is None else when(r["start"])
            session = "" if r is None else r["session"]
            lag, act, spawn = row["lag"], row["action"], row["spawn"]
            print(f"{start:12s} {session:8s} {label:32s} {row['reports']:4d} {fmt_1(row['turns']['median']):>5s} "
                  f"{fmt_pct(row['read_share']):>5s} {fmt_pct(row['pointer_share']):>4s} {row['reads']:6d} "
                  f"{fmt_ratio(row['edits_per_report']):>6s}  {fmt_s(lag['median']):>7s} {fmt_s(lag['p90']):>4s} "
                  f"{fmt_s(lag['max']):>4s}  {fmt_s(act['median']):>7s} {fmt_s(act['p90']):>4s}  "
                  f"{fmt_s(spawn['median']):>9s} {fmt_s(spawn['max']):>4s} {row['quiet']:5d}")
        print("   turns: model turns per report up to its spawn/message/stop call; read%: reports followed by a RESULT Read;"
              " ptr%: reports whose prompt pointed at the file")
        print("   lag s: RESULT-<token>.md mtime to the prompt; act s: prompt to its spawn/message/stop call; spawn: the tool call;"
              " quiet: SCREEN files (stopped without a report)")
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
        missing = ", ".join(f"{n} {why}" for why, n in sorted(tot["lag_by"]["missing"].items(), key=lambda kv: -kv[1]))
        print(f"\n== lag found for {tot['lag']['n']} of {tot['reports']} reports (by token {tot['lag_by']['token']}, "
              f"by text {tot['lag_by']['text']}); the rest: {missing or 'none'}")
    print(f"\n== worker sessions by model: {len(workers)} (first prompt names .herdr-agents/<worker>/TASK.md)")
    if by_model:
        print("model                  sess    turns        input      cache-r      cache-w      output       cost")
        for model, m in sorted(by_model.items(), key=lambda kv: -kv[1]["cost"]):
            print(f"{model[:22]:22s} {m['sessions']:5d}  {m['turns']:7d}  {fmt_tok(m['inp']):>11s}  {fmt_tok(m['cr']):>11s}  "
                  f"{fmt_tok(m['cw']):>11s}  {fmt_tok(m['out']):>11s}  ${m['cost']:9,.2f}")
    print("\n   not counted: subagent transcripts (<session>/subagents/); Bash reads of RESULT files (only Read calls count)")
    if unpriced:
        print(f"   no price for {', '.join(sorted(unpriced))}: cost counted as 0")
    print(f"   transcripts from {root}")


def main():
    ap = argparse.ArgumentParser(description="Coordinator and worker time and tokens from Claude Code transcripts.")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--json", action="store_true", help="print JSON instead of the tables")
    args = ap.parse_args()
    since = time.time() - args.days * 86400
    root = os.path.join(os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude"), "projects")

    coords, workers = [], []
    for path in sorted(glob.glob(os.path.join(root, "*", "*.jsonl"))):
        if os.path.getmtime(path) < since:
            continue
        s = scan(path, since)
        if s.reports:
            resolve(s, since)
            coords.append(s)
        elif s.worker:
            workers.append(s)
    coords.sort(key=lambda s: s.start)
    rows = [coordinator_row(s) for s in coords]
    tot = totals(rows, coords)
    by_model = worker_models(workers)
    unpriced = {m for s in coords + workers for m in s.unpriced}

    if args.json:
        out = {
            "days": args.days,
            "coordinators": rows,
            "totals": tot,
            "workers": {"sessions": len(workers), "by_model": by_model},
            "unpriced": sorted(unpriced),
        }
        print(json.dumps(out, indent=2))
        return
    print_text(args.days, rows, tot, workers, by_model, unpriced, root)


if __name__ == "__main__":
    main()
