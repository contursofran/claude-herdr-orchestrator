#!/usr/bin/env python3
"""Scores the runs of an hrd-eval results folder and prints the comparison table.

Usage: score.py RESULTS_DIR [--json]

Reads what scripts/hrd-eval.py writes for each run (<results>/<scenario>/<arm>/r<k>/): run.json, calls.jsonl,
jobs/*/transcript.jsonl, gh/calls.log and grade/hidden.txt. The scenario comes from run.json's scenario_dir:
its scenario.json, and its expected.json (the tests of the reference run). See the Contract in the eval plan.

score_run(run_dir) -> dict   one run: pass, invalid (a leak), status, reasons (why it failed), hidden, own_tests,
                             fix_rounds, blockers, decision, pr_opened, plan_decisions, questions, outside, roles,
                             cost, wall, leak, leak_blocked, shim_bypassed, unpriced, review_unparsed
aggregate(scores, matrix=None) -> dict   {"matrix", "runs", "cells", "arms", "roles", "disagreements"}
print_text(agg)              the table, in the style of hrd-metrics.py's print_text
ExpectedMissing              a graded scenario has no expected.json (a ValueError; main() prints it as one line)

Pass rule. A scenario with expect.decision passes when some DECISION in the run's decisions matches its regex
(DECISION lines only in PLAN.md are not counted). Otherwise the run passes when every slice has a PR, the grade
merged main, every expected test passes in hidden.txt (a missing test counts as failing), and, with testsChanged,
a test file is among the changed files. A test expected.json lists as flaky (it failed in some reference runs) is set
aside when it fails, unless it is discriminating: hidden.flaky_failed lists it. A run with a leak is invalid: it is
left out of the pass rate and the decision rate, and listed. The pass rule itself is not changed by a leak. A leak is
a leak pattern in a tool call's input (a Bash command, minus the text it writes into a .md file through a quoted
heredoc; a Read, Grep or Glob path; a WebFetch url) whose result does not show the read refused; refused ones are
listed as leak_blocked.

Cost of a call is the larger of its transcript sum and the CLI's total_cost_usd difference, the runner's rule;
calls.jsonl keeps both. A resumed call's values are already differences from its session's previous call.
"""

import argparse
import collections
import fractions
import glob
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("hrd_metrics", os.path.join(HERE, "..", "hrd-metrics.py"))
hm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hm)


class ExpectedMissing(ValueError):
    """A graded scenario has no expected.json: the message is the one line main() prints."""


ROLES = ("planner", "builder", "reviewer")
TOKEN_KEYS = ("inp", "out", "cr", "cw")
FAILED_STATUS = ("error", "timeout")
PLUGIN_ROW = re.compile(r"^\s*\((pass|fail|skip)\)\s+(.+?)\s*$")
PLUGIN_MS = re.compile(r"\s+\[\d+(?:\.\d+)?\s*ms\]$")
UNITTEST_ROW = re.compile(r"^(\w+ \([\w.]+\)) \.\.\. (ok|FAIL|ERROR|skipped\b.*)$")
UNITTEST_STATUS = {"ok": "pass", "FAIL": "fail", "ERROR": "fail"}
TEST_FILE = re.compile(r"(^|/)(tests?/|test_[^/]*$|[^/]*\.test\.[^/]*$|[^/]*_test\.[^/]*$)")
# The tool inputs a leak is looked for in: the Bash command, the paths Read/Grep/Glob take, a WebFetch url.
LEAK_FIELDS = {"Bash": ("command",), "WebFetch": ("url",), "Read": ("file_path",), "Grep": ("path",), "Glob": ("path",)}
GH_CALL = re.compile(r"(^|[\s;&|(`/])gh\s")
# A quoted heredoc (<<'EOF', <<"EOF", <<\EOF: its body is text, never run) whose line writes a Markdown file: a report
# or plan the worker writes, such as RESULT.md or PLAN.md. A leak pattern it quotes is not a read.
HEREDOC = re.compile(r"<<-?\s*(?:'([^']+)'|\"([^\"]+)\"|\\(\w+))")
WRITES_MD = re.compile(r"(?:>>?|\btee\s+(?:-a\s+)?)\s*[\"']?[^\s;&|<>\"']*\.md\b")
# A tool result that says the read was refused: the sandbox, a permission rule, or nothing there.
REFUSED = re.compile(r"(?i)operation not permitted|permission denied|has been denied|denied by|no such file or directory")


def parse_plugin_test(text):
    """{name: "pass"|"fail"|"skip"} from `claude plugin test` output: one `(pass) <name> [ms]` or `(fail) <name>` row
    per test. The summary lines (` N pass`, ` N fail`, `Ran …`) are not rows. A crashed file has its own row,
    "the file ran to its end"."""
    out = {}
    for line in text.splitlines():
        m = PLUGIN_ROW.match(line)
        if m:
            out[PLUGIN_MS.sub("", m.group(2))] = m.group(1)
    return out


def unittest_name(name):
    """`test_x (mod.Class.test_x)`, which Python 3.11+ prints, is the name `test_x (mod.Class)` that Python 3.9 prints:
    the same test, so one name whichever Python ran it (expected.json is written by one and checked by the other)."""
    m = re.match(r"^(\w+) \(([\w.]+)\)$", name)
    if m and m.group(2).endswith("." + m.group(1)):
        return f"{m.group(1)} ({m.group(2)[: -len(m.group(1)) - 1]})"
    return name


def parse_unittest(text):
    """{name: "pass"|"fail"|"skip"} from `python3 -m unittest -v` output: `test_x (mod.Class) ... ok|FAIL|ERROR|skipped`.
    The name is the text before " ... ", as unittest_name() gives it. A test with a docstring prints the docstring
    instead of its name; it is not matched, so it counts as missing."""
    out = {}
    for line in text.splitlines():
        m = UNITTEST_ROW.match(line)
        if m:
            status = m.group(2)
            out[unittest_name(m.group(1))] = "skip" if status.startswith("skipped") else UNITTEST_STATUS[status]
    return out


GRADE_PARSERS = {"plugin-test": parse_plugin_test, "unittest": parse_unittest}


def glob_re(pattern):
    """A regex for an `allowed` glob: "**" matches across "/", "**/" may match no directory, "*" and "?" do not
    cross "/". The regex is anchored at both ends."""
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        else:
            c = pattern[i]
            out.append({"*": "[^/]*", "?": "[^/]"}.get(c) or re.escape(c))
            i += 1
    return re.compile("".join(out) + r"\Z")


def read_text(path):
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_calls(run_dir):
    path = os.path.join(run_dir, "calls.jsonl")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def load_expected(scen_dir, scenario):
    """The reference run's test names. A scenario with a grade needs expected.json (--check-scenarios writes it)."""
    path = os.path.join(scen_dir, "expected.json")
    if os.path.exists(path):
        exp = load_json(path)
    elif "grade" in scenario:
        sid = os.path.basename(os.path.normpath(scen_dir))
        raise ExpectedMissing(
            f"{sid}: no expected.json; run scripts/hrd-eval.py --check-scenarios --scenarios {sid} --update-expected"
        )
    else:
        exp = {}
    return {"tests": exp.get("tests", []), "discriminating": exp.get("discriminating", []), "flaky": exp.get("flaky", [])}


def call_cost(c):
    return max(c.get("cost_transcript") or 0.0, c.get("cost_reported") or 0.0)


def known_sum(xs):
    known = [x for x in xs if x is not None]
    return sum(known) if known else None


def mean(xs):
    return sum(xs) / len(xs) if xs else None


def strip_md_heredocs(command):
    """The command without the bodies of quoted heredocs that write a .md file (see HEREDOC)."""
    out, lines, i = [], command.split("\n"), 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        m = HEREDOC.search(line)
        if m and WRITES_MD.search(line):
            delim = next(g for g in m.groups() if g)
            while i < len(lines) and lines[i].lstrip("\t") != delim:
                i += 1
    return "\n".join(out)


def result_text(block):
    content = block.get("content")
    if isinstance(content, list):
        return "\n".join(str(c.get("text", "")) for c in content if isinstance(c, dict))
    return str(content or "")


def pattern_tail(pattern):
    """The part of a leak pattern an error message shows whichever way the path was spelled: no ~/ or home prefix."""
    home = os.path.expanduser("~")
    if pattern.startswith("~/"):
        return pattern[2:]
    if pattern.startswith(home + os.sep):
        return pattern[len(home) + 1 :]
    return pattern


def refused(tool, res, pattern, isolated):
    """Whether a tool call's result shows that its read of `pattern` was refused. Read, Grep and Glob: an error result,
    a refusal message, or (isolated) nothing. Bash: a refusal line that names the pattern's path (a command can do
    several things, so an error elsewhere in it says nothing), or (isolated) no output at all."""
    if not res:
        return False
    text = result_text(res)
    if isolated and not text.strip():
        return True
    if tool != "Bash":
        return bool(res.get("is_error")) or bool(REFUSED.search(text))
    tail = pattern_tail(pattern)
    return any(REFUSED.search(line) and tail in line for line in text.splitlines())


def scan_transcripts(run_dir, patterns, isolated=False):
    """Leak hits and Bash commands, from the tool calls in every job's transcript. Text a worker writes into a .md
    file through a quoted heredoc (its RESULT.md, PLAN.md) is not looked at. A hit is `blocked` when its result shows
    the read was refused (see refused(); isolated: run.json's isolation, the paths the worker's tools and sandbox
    cannot read)."""
    hits, commands = [], []
    for path in sorted(glob.glob(os.path.join(run_dir, "jobs", "*", "transcript.jsonl"))):
        job = os.path.relpath(os.path.dirname(path), run_dir)
        uses, results = [], {}
        for rec in hm.records(path):
            content = (rec.get("message") or {}).get("content")
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_result":
                    results[block.get("tool_use_id")] = block
                elif block.get("type") == "tool_use":
                    uses.append(block)
        for block in uses:
            name, inp = block.get("name"), block.get("input") or {}
            if name == "Bash" and isinstance(inp.get("command"), str):
                commands.append(inp["command"])
            for field in LEAK_FIELDS.get(name, ()):
                value = inp.get(field)
                if not isinstance(value, str):
                    continue
                if name == "Bash":
                    value = strip_md_heredocs(value)
                res = results.get(block.get("id"))
                for p in patterns:
                    if not p or p not in value:
                        continue
                    hit = {"job": job, "tool": name, "pattern": p, "blocked": refused(name, res, p, isolated)}
                    if hit not in hits:
                        hits.append(hit)
    return hits, commands


def role_stats(calls):
    roles = {}
    for role in ROLES:
        mine = [c for c in calls if c.get("role") == role]
        reported = [c["cost_reported"] for c in mine if c.get("cost_reported") is not None]
        roles[role] = {
            "calls": len(mine),
            "cost": sum(call_cost(c) for c in mine),
            "cost_reported": sum(reported) if reported else None,
            "tokens": {k: sum(c["tokens"][k] for c in mine) for k in TOKEN_KEYS},
            "secs": sum(c["ended"] - c["started"] for c in mine),
        }
    return roles


def score_run(run_dir):
    run_dir = os.path.abspath(run_dir)
    run = load_json(os.path.join(run_dir, "run.json"))
    scen_dir = run["scenario_dir"]
    scenario = load_json(os.path.join(scen_dir, "scenario.json"))
    expected = load_expected(scen_dir, scenario)
    expect = scenario.get("expect") or {}
    grade = run.get("grade") or {}
    slices = run.get("slices") or []
    changed = run.get("changed_files") or []
    calls = load_calls(run_dir)
    isolated = bool((run.get("isolation") or {}).get("sandbox"))
    hits, commands = scan_transcripts(run_dir, run.get("leak_patterns") or [], isolated)
    leaks = [{k: h[k] for k in ("job", "tool", "pattern")} for h in hits if not h["blocked"]]
    blocked = [{k: h[k] for k in ("job", "tool", "pattern")} for h in hits if h["blocked"]]
    shim_bypassed = 0 if read_text(os.path.join(run_dir, "gh", "calls.log")).strip() else sum(
        1 for c in commands if GH_CALL.search(c))

    got = GRADE_PARSERS.get(grade.get("kind"), lambda text: {})(read_text(os.path.join(run_dir, "grade", "hidden.txt")))
    tests = expected["tests"]
    new = expected["discriminating"]
    # A flaky test (expected.json's flaky) that fails is set aside, unless it is discriminating.
    ignorable = set(expected["flaky"]) - set(new)
    ran = bool(grade.get("ran"))
    failed = [n for n in tests if got.get(n) != "pass"] if ran else []
    hidden = {
        "new_pass": sum(got.get(n) == "pass" for n in new),
        "new_total": len(new),
        "failed": [n for n in failed if n not in ignorable],
        "flaky_failed": [n for n in failed if n in ignorable],
    }

    texts = [d["text"] for d in run.get("decisions") or []]
    want = expect.get("decision")
    decision = {
        "expected": want is not None,
        "raised": bool(texts),
        "matched": want is not None and any(re.search(want["match"], t) for t in texts),
    }

    reasons = []
    if want is not None:
        if not texts:
            reasons.append("decision not raised")
        elif not decision["matched"]:
            reasons.append("decision not matched")
    else:
        if run["status"] in FAILED_STATUS:
            reasons.append(f"status {run['status']}")
        no_pr = [s["id"] for s in slices if s.get("pr") is None]
        if no_pr:
            reasons.append("no PR: " + ", ".join(no_pr))
        if grade.get("merge_error"):
            err = grade["merge_error"]
            reasons.append("merge conflict" if "CONFLICT" in err else "not merged: " + err.splitlines()[0])
        elif not grade.get("merged"):
            reasons.append("not merged")
        if not ran:
            reasons.append("not graded")
        else:
            missing = [n for n in tests if n not in got and n not in ignorable]
            failing = [n for n in tests if n in got and got[n] != "pass" and n not in ignorable]
            if missing:
                reasons.append("missing tests: " + ", ".join(missing))
            if failing:
                reasons.append("failing tests: " + ", ".join(failing))
        if expect.get("testsChanged") and not any(TEST_FILE.search(f) for f in changed):
            reasons.append("no test file changed")

    allowed = scenario.get("allowed") or []
    firsts = [s["reviews"][0]["blockers"] for s in slices if s.get("reviews")]
    every = [rv["blockers"] for s in slices for rv in s.get("reviews") or []]
    own = grade.get("own_exit")
    started, ended = run.get("started"), run.get("ended")
    return {
        "scenario": run["scenario"],
        "arm": run["arm"],
        "repeat": run["repeat"],
        "folder": run_dir,
        "status": run["status"],
        "pass": not reasons,
        "invalid": bool(leaks),
        "leak_blocked": blocked,
        "reasons": reasons,
        "hidden": hidden,
        "own_tests": "none" if own is None else ("pass" if own == 0 else "fail"),
        "fix_rounds": sum(s.get("fix_rounds") or 0 for s in slices),
        "blockers": {"first": known_sum(firsts), "total": known_sum(every)},
        "decision": decision,
        "pr_opened": bool(run.get("pr_opened")),
        "plan_decisions": run.get("plan_decisions") or [],
        "questions": run.get("questions") or {},
        "outside": [f for f in changed if not any(glob_re(g).match(f) for g in allowed)],
        "roles": role_stats(calls),
        "cost": sum(call_cost(c) for c in calls),
        "wall": ended - started if started is not None and ended is not None else None,
        "leak": leaks,
        "shim_bypassed": shim_bypassed,
        "unpriced": sorted({m for c in calls for m in c.get("unpriced") or []}),
        "review_unparsed": any(bool(s.get("review_unparsed")) for s in slices),
    }


def cell(scenario, arm, runs):
    valid = [s for s in runs if not s["invalid"]]
    dec = [s for s in valid if s["decision"]["expected"]]
    firsts = [s["blockers"]["first"] for s in runs if s["blockers"]["first"] is not None]
    return {
        "scenario": scenario,
        "arm": arm,
        "runs": len(runs),
        "valid": len(valid),
        "invalid": len(runs) - len(valid),
        "pass": sum(s["pass"] for s in valid),
        "decision": {"k": sum(s["decision"]["matched"] for s in dec), "n": len(dec)},
        "cost": mean([s["cost"] for s in runs]),
        "wall": hm.dist([s["wall"] for s in runs if s["wall"] is not None])["median"],
        "fix_rounds": mean([s["fix_rounds"] for s in runs]),
        "blockers": mean(firsts),
        "outside": sum(len(s["outside"]) for s in runs),
    }


def disagreements(cells, scores):
    """Scenarios whose pass RATES differ between arms: pass / valid runs, so 2/3 and 2/2 differ and 1/1 and 2/2 do not.
    An arm with no valid run has no rate and is not compared."""
    out = []
    for scenario in sorted({c["scenario"] for c in cells}):
        mine = [c for c in cells if c["scenario"] == scenario and c["valid"]]
        if len({fractions.Fraction(c["pass"], c["valid"]) for c in mine}) < 2:
            continue
        failing = [
            {"folder": s["folder"], "arm": s["arm"], "reason": "; ".join(s["reasons"])}
            for s in scores
            if s["scenario"] == scenario and not s["invalid"] and not s["pass"]
        ]
        out.append({
            "scenario": scenario,
            "arms": {c["arm"]: {"pass": c["pass"], "valid": c["valid"]} for c in mine},
            "failing": failing,
        })
    return out


def aggregate(scores, matrix=None):
    groups = collections.OrderedDict()
    for s in sorted(scores, key=lambda s: (s["scenario"], s["arm"], s["repeat"])):
        groups.setdefault((s["scenario"], s["arm"]), []).append(s)
    cells = [cell(scenario, arm, runs) for (scenario, arm), runs in groups.items()]
    arms, roles = {}, {}
    for arm in sorted({s["arm"] for s in scores}):
        mine = [s for s in scores if s["arm"] == arm]
        valid = [s for s in mine if not s["invalid"]]
        arms[arm] = {
            "runs": len(mine),
            "valid": len(valid),
            "invalid": len(mine) - len(valid),
            "pass": sum(s["pass"] for s in valid),
            "cost": sum(s["cost"] for s in mine),
        }
        roles[arm] = {role: sum(s["roles"][role]["cost"] for s in mine) for role in ROLES}
    return {
        "matrix": matrix,
        "runs": scores,
        "cells": cells,
        "arms": arms,
        "roles": roles,
        "disagreements": disagreements(cells, scores),
    }


CELL_COLUMNS = [("scenario", 20, "<"), ("arm", 4, "<"), ("pass", 6, ">"), ("decision", 8, ">"), ("cost", 8, ">"),
                ("wall s", 6, ">"), ("fix", 5, ">"), ("blockers", 8, ">"), ("outside", 7, ">"), ("invalid", 7, ">")]
ARM_COLUMNS = [("arm", 4, "<"), ("runs", 5, ">"), ("valid", 6, ">"), ("pass", 6, ">"), ("cost", 9, ">"),
               ("planner", 9, ">"), ("builder", 9, ">"), ("reviewer", 9, ">")]


def table_row(columns, values):
    return " ".join(f"{v:{align}{width}}" for v, (_, width, align) in zip(values, columns))


def print_text(agg):
    runs = agg["runs"]
    scenarios = {s["scenario"] for s in runs}
    invalid = [s for s in runs if s["invalid"]]
    head = f"== hrd-eval: {len(runs)} runs, {len(scenarios)} scenarios, {len(agg['arms'])} arms"
    matrix = agg["matrix"] or {}
    if "repeats" in matrix:
        head += f", repeats {matrix['repeats']}"
    if "started" in matrix:
        head += f", started {hm.when(matrix['started'])}"
    print(head)
    print(table_row(CELL_COLUMNS, [t for t, _, _ in CELL_COLUMNS]))
    for c in agg["cells"]:
        dec = c["decision"]
        print(table_row(CELL_COLUMNS, [
            hm.short(c["scenario"], 20),
            c["arm"],
            f"{c['pass']}/{c['valid']}" if c["valid"] else "-",
            f"{dec['k']}/{dec['n']}" if dec["n"] else "-",
            hm.fmt_money(c["cost"]),
            hm.fmt_s(c["wall"]),
            hm.fmt_ratio(c["fix_rounds"]),
            hm.fmt_1(c["blockers"]),
            str(c["outside"]),
            str(c["invalid"]),
        ]))
    print("   pass: valid runs that pass the rule; decision: valid runs with an expected DECISION that matched;"
          " outside: changed files no allowed glob matches")
    print("   cost: all runs; wall: median seconds; fix: mean fix rounds; blockers: mean of the first reviews' blockers")
    print("\n== per arm (cost by the role that made each call)")
    print(table_row(ARM_COLUMNS, [t for t, _, _ in ARM_COLUMNS]))
    for arm, a in agg["arms"].items():
        r = agg["roles"][arm]
        print(table_row(ARM_COLUMNS, [arm, str(a["runs"]), str(a["valid"]), str(a["pass"]), hm.fmt_money(a["cost"]),
                                      hm.fmt_money(r["planner"]), hm.fmt_money(r["builder"]),
                                      hm.fmt_money(r["reviewer"])]))
    print("\n== disagreements: scenarios whose pass counts differ between arms")
    if not agg["disagreements"]:
        print("   none")
    for d in agg["disagreements"]:
        print(f"   {d['scenario']}: " + ", ".join(f"{arm} {v['pass']}/{v['valid']}" for arm, v in d["arms"].items()))
        for f in d["failing"]:
            print(f"      {f['arm']} {f['folder']}: {f['reason']}")
    unparsed = [s for s in runs if s["review_unparsed"]]
    if unparsed:
        print(f"\n   {len(unparsed)} runs had a review with no VERDICT line and no blocker count; the fix loop counted"
              " it as no blockers:")
        for s in unparsed:
            print(f"      {s['folder']}")
    flaky = [s for s in runs if s["hidden"].get("flaky_failed")]
    if flaky:
        print(f"\n   {len(flaky)} runs failed tests that are flaky in the reference (expected.json); set aside, not failures:")
        for s in flaky:
            print(f"      {s['folder']}: " + ", ".join(s["hidden"]["flaky_failed"]))
    asked = [s for s in runs if (s.get("questions") or {}).get("auto") or (s.get("questions") or {}).get("unanswered")]
    if asked:
        print(f"\n   {len(asked)} runs asked past the answer cap; auto: answered with no owner answer, unanswered: left so:")
        for s in asked:
            q = s["questions"]
            print(f"      {s['folder']}: auto {q.get('auto', 0)}, unanswered {q.get('unanswered', 0)}")
    tried = [s for s in runs if s.get("leak_blocked")]
    if tried:
        print(f"\n   {len(tried)} runs tried to read a leak path and were refused (not invalid):")
        for s in tried:
            print(f"      {s['folder']}: " + ", ".join(f"{h['tool']} {h['pattern']}" for h in s["leak_blocked"]))
    unpriced = sorted({m for s in runs for m in s["unpriced"]})
    if unpriced:
        print(f"\n   no price for {', '.join(unpriced)}: cost counted as 0")
    if invalid:
        print(f"   {len(invalid)} invalid runs (a leak), left out of the pass and decision rates:")
        for s in invalid:
            print(f"      {s['folder']}: " + ", ".join(f"{h['tool']} {h['pattern']}" for h in s["leak"]))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Scores the runs of an hrd-eval results folder and prints the table.")
    ap.add_argument("results", metavar="RESULTS_DIR", help="the folder scripts/hrd-eval.py wrote")
    ap.add_argument("--json", action="store_true", help="print JSON instead of the table")
    args = ap.parse_args(argv)
    run_dirs = sorted(os.path.dirname(p) for p in glob.glob(os.path.join(args.results, "*", "*", "r*", "run.json")))
    if not run_dirs:
        print(f"no run.json under {args.results}", file=sys.stderr)
        return 1
    matrix_path = os.path.join(args.results, "matrix.json")
    matrix = load_json(matrix_path) if os.path.exists(matrix_path) else None
    try:
        agg = aggregate([score_run(d) for d in run_dirs], matrix)
    except ExpectedMissing as e:
        print(f"score.py: {e}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(agg, indent=2))
    else:
        print_text(agg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
