"""Tests for scripts/hrd-eval/score.py on hand-built results folders.

Each run folder is written the way scripts/hrd-eval.py writes it (the Contract in the eval plan: run.json,
calls.jsonl, jobs/*/transcript.jsonl, gh/calls.log, grade/hidden.txt). Every expected number below is worked out
from the fixtures in the test, not copied from the script's output.
Run: python3 -m unittest discover -s tests -p 'test_*.py' -v
"""

import importlib.util
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "hrd-eval", "score.py")
spec = importlib.util.spec_from_file_location("hrd_eval_score", SCRIPT)
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)

EXPECTED = {"tests": ["t1", "t2"], "discriminating": ["t2"]}
DEFAULT_HIDDEN = "(pass) t1 [5.10ms]\n(pass) t2 [6ms]\n"
GREEN = {"ran": True, "kind": "plugin-test", "merged": True, "merge_error": None, "exit": 1, "own_exit": 0}
DEFAULT_CHANGED = ["hooks/workers.ts", "tests/test_x.py"]
LEAKS = ["scripts/hrd-eval", "plan-18"]
DECISION_MATCH = r"(?i)stack|combin|both|bulk|additive|compound|order"


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def write_json(path, data):
    write(path, json.dumps(data))


def tool(name, **inp):
    """One assistant transcript line that calls a tool, as Claude Code writes it."""
    rec = {
        "type": "assistant",
        "timestamp": "2026-10-24T10:00:00.000Z",
        "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": name, "input": inp}]},
    }
    return json.dumps(rec, separators=(",", ":"))


def scenario(tmp, name="rep", grade=True, expect=None, allowed=("hooks/workers.ts", "tests/**"), expected=EXPECTED):
    """scenario.json (and expected.json when given) under <tmp>/scenarios/<name>. A replay has a grade; a fixture
    without one has no expected.json."""
    d = os.path.join(tmp, "scenarios", name)
    data = {
        "title": name,
        "kind": "replay",
        "issue": {"number": 12, "file": "issue.json"},
        "source": {"commit": "abc"},
        "allowed": list(allowed),
        "expect": expect if expect is not None else {"decision": None, "testsChanged": False},
    }
    if grade:
        data["grade"] = {"cmd": ["python3", "-m", "unittest"], "parser": "plugin-test", "timeout": 300}
    write_json(os.path.join(d, "scenario.json"), data)
    if expected is not None:
        write_json(os.path.join(d, "expected.json"), expected)
    return d


def slice_(sid="S1", pr=14, fix_rounds=0, reviews=()):
    return {"id": sid, "branch": f"issue-12-{sid.lower()}", "pr": pr, "head": "abc", "fix_rounds": fix_rounds,
            "reviews": list(reviews)}


def review(call, verdict, blockers):
    return {"call": call, "sha": "abc", "verdict": verdict, "blockers": blockers, "how": "line"}


def call(n, role, cost, reported=None, started=0.0, ended=10.0, tokens=(0, 0, 0, 0), unpriced=(), resumed=False):
    inp, out, cr, cw = tokens
    return {
        "n": n, "role": role, "slice": "S1", "kind": "build", "profile": "opus", "argv": [], "session_id": f"s{n}",
        "resumed": resumed, "cwd": "/x", "started": started, "ended": ended, "exit": 0, "timed_out": False,
        "is_error": False, "report_source": "result_md", "job": f"jobs/{n:02d}-{role}", "cost_transcript": cost,
        "cost_reported": reported, "tokens": {"inp": inp, "out": out, "cr": cr, "cw": cw}, "models": {},
        "unpriced": list(unpriced),
    }


def make_run(tmp, scen_dir, name="rep", arm="A", repeat=1, status="done", slices=None, grade=None,
             changed=DEFAULT_CHANGED, decisions=(), plan_decisions=(), calls=(), hidden=DEFAULT_HIDDEN, jobs=None,
             gh_log="", leaks=LEAKS, started=1000.0, ended=1600.0, pr_opened=True):
    """One run folder under <tmp>/results/<name>/<arm>/r<repeat>. hidden=None writes no hidden.txt."""
    run_dir = os.path.join(tmp, "results", name, arm, f"r{repeat}")
    shutil.rmtree(run_dir, ignore_errors=True)  # a test may build the same folder twice
    run = {
        "scenario": name,
        "scenario_dir": scen_dir,
        "arm": arm,
        "repeat": repeat,
        "status": status,
        "error": None,
        "started": started,
        "ended": ended,
        "base": "b0",
        "pr_opened": pr_opened,
        "slices": slices if slices is not None else [slice_()],
        "decisions": [{"call": i + 1, "role": "builder", "text": t, "answered": None} for i, t in enumerate(decisions)],
        "plan_decisions": list(plan_decisions),
        "grade": dict(GREEN) if grade is None else grade,
        "changed_files": list(changed),
        "leak_patterns": list(leaks),
    }
    write_json(os.path.join(run_dir, "run.json"), run)
    write(os.path.join(run_dir, "calls.jsonl"), "".join(json.dumps(c) + "\n" for c in calls))
    for job, lines in (jobs or {}).items():
        write(os.path.join(run_dir, "jobs", job, "transcript.jsonl"), "\n".join(lines) + "\n")
    if hidden is not None:
        write(os.path.join(run_dir, "grade", "hidden.txt"), hidden)
    write(os.path.join(run_dir, "gh", "calls.log"), gh_log)
    return run_dir


class Folders(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.rep = scenario(self.tmp)


class PluginTestParser(unittest.TestCase):
    def test_rows_and_summary(self):
        text = (
            "\ntests/workers.test.tsx:\n"
            "(pass) workers: report lands in RESULT.md [220.31ms]\n"
            "(pass) workers: name has no slash [12ms]\n"
            "(fail) workers: wake waits for the turn [340.5ms]\n\n"
            " 2 pass\n 1 fail\nRan 3 tests across 1 files. [0.4s]\n"
        )
        self.assertEqual(sc.parse_plugin_test(text), {
            "workers: report lands in RESULT.md": "pass",
            "workers: name has no slash": "pass",
            "workers: wake waits for the turn": "fail",
        })

    def test_crashed_file_row_is_a_test(self):
        # 34 passing rows and 7 failing rows, plus the crashed-file row: 34 pass, 8 fail (reference table, PR #26).
        rows = [f"(pass) p{i} [1ms]" for i in range(34)] + [f"(fail) f{i} [2ms]" for i in range(7)]
        rows.append("(fail) the file ran to its end")
        got = sc.parse_plugin_test("\n".join(rows) + "\n 34 pass\n 8 fail\n")
        self.assertEqual(sum(v == "pass" for v in got.values()), 34)
        self.assertEqual(sum(v == "fail" for v in got.values()), 8)
        self.assertEqual(got["the file ran to its end"], "fail")

    def test_skip_row(self):
        self.assertEqual(sc.parse_plugin_test("(skip) later [1ms]\n"), {"later": "skip"})

    def test_no_rows(self):
        self.assertEqual(sc.parse_plugin_test("tests/a.test.tsx:\n 0 pass\n 0 fail\nRan 0 tests\n"), {})


class UnittestParser(unittest.TestCase):
    def test_statuses(self):
        text = (
            "test_add (test_cart.TestCart) ... ok\n"
            "test_bulk (test_cart.TestCart) ... FAIL\n"
            "test_crash (test_cart.TestCart) ... ERROR\n"
            "test_net (test_client.TestClient) ... skipped 'needs network'\n\n"
            "Ran 4 tests in 0.010s\n\nFAILED (failures=1, errors=1, skipped=1)\n"
        )
        self.assertEqual(sc.parse_unittest(text), {
            "test_add (test_cart.TestCart)": "pass",
            "test_bulk (test_cart.TestCart)": "fail",
            "test_crash (test_cart.TestCart)": "fail",
            "test_net (test_client.TestClient)": "skip",
        })

    def test_docstring_line_is_not_matched(self):
        # unittest -v prints a test's docstring instead of its name; such a test counts as missing.
        self.assertEqual(sc.parse_unittest("Adds two prices ... ok\n"), {})

    def test_python_3_11_names_with_the_method_are_the_same_tests(self):
        # Python 3.11+ prints test_x (mod.Class.test_x); 3.9 prints test_x (mod.Class). One name for both.
        text = "test_add (test_cart.TestCart.test_add) ... ok\ntest_bulk (test_cart.TestCart.test_bulk) ... FAIL\n"
        self.assertEqual(sc.parse_unittest(text), {"test_add (test_cart.TestCart)": "pass", "test_bulk (test_cart.TestCart)": "fail"})

    def test_a_name_whose_last_part_is_not_the_method_is_kept_as_it_is(self):
        self.assertEqual(sc.unittest_name("test_add (mod.Other)"), "test_add (mod.Other)")


class Globs(unittest.TestCase):
    def test_double_star_crosses_slashes(self):
        self.assertTrue(sc.glob_re("tests/**").match("tests/a/b.py"))
        self.assertFalse(sc.glob_re("tests/**").match("src/tests/a.py"))

    def test_single_star_stays_in_one_segment(self):
        self.assertTrue(sc.glob_re("*.md").match("README.md"))
        self.assertFalse(sc.glob_re("*.md").match("docs/a.md"))

    def test_double_star_slash_may_match_no_directory(self):
        self.assertTrue(sc.glob_re("**/conftest.py").match("conftest.py"))
        self.assertTrue(sc.glob_re("**/conftest.py").match("tests/conftest.py"))
        self.assertFalse(sc.glob_re("**/conftest.py").match("x_conftest.py"))

    def test_question_mark_and_literal_dot(self):
        self.assertTrue(sc.glob_re("a?.py").match("ab.py"))
        self.assertFalse(sc.glob_re("a?.py").match("a/.py"))
        self.assertFalse(sc.glob_re("hooks/workers.ts").match("hooks/workersXts"))

    def test_test_file_heuristic(self):
        for path in ["tests/test_x.py", "pkg/tests/a.py", "src/app.test.ts", "pkg/test_util.py", "x/y_test.go"]:
            self.assertTrue(sc.TEST_FILE.search(path), path)
        for path in ["hooks/workers.ts", "latest/notes.md", "attest.py", "README.md"]:
            self.assertFalse(sc.TEST_FILE.search(path), path)


class ReplayPass(Folders):
    def score(self, **kw):
        return sc.score_run(make_run(self.tmp, self.rep, **kw))

    def test_green_run_passes(self):
        s = self.score()
        self.assertTrue(s["pass"])
        self.assertEqual(s["reasons"], [])
        self.assertFalse(s["invalid"])
        self.assertEqual(s["hidden"], {"new_pass": 1, "new_total": 1, "failed": []})
        self.assertEqual(s["own_tests"], "pass")
        self.assertEqual(s["outside"], [])
        self.assertEqual(s["wall"], 600.0)
        self.assertTrue(s["pr_opened"])
        self.assertEqual(s["decision"], {"expected": False, "raised": False, "matched": False})

    def test_missing_expected_test_fails(self):
        s = self.score(hidden="(pass) t1 [5ms]\n")
        self.assertFalse(s["pass"])
        self.assertEqual(s["reasons"], ["missing tests: t2"])
        self.assertEqual(s["hidden"], {"new_pass": 0, "new_total": 1, "failed": ["t2"]})

    def test_failing_and_skipped_expected_tests_fail(self):
        self.assertEqual(self.score(hidden="(pass) t1\n(fail) t2\n")["reasons"], ["failing tests: t2"])
        self.assertEqual(self.score(hidden="(pass) t1\n(skip) t2\n")["reasons"], ["failing tests: t2"])

    def test_merge_conflict_fails(self):
        s = self.score(grade=dict(GREEN, merged=False, merge_error="CONFLICT (content): hooks/workers.ts"))
        self.assertFalse(s["pass"])
        self.assertEqual(s["reasons"], ["merge conflict"])

    def test_not_merged_without_an_error_fails(self):
        self.assertEqual(self.score(grade=dict(GREEN, merged=False))["reasons"], ["not merged"])

    def test_not_graded_fails_and_lists_every_test_as_failed(self):
        s = self.score(grade={"ran": False, "kind": None, "merged": False, "merge_error": None, "exit": None,
                              "own_exit": None}, hidden=None)
        self.assertFalse(s["pass"])
        self.assertEqual(s["reasons"], ["not graded"])
        self.assertEqual(s["own_tests"], "none")
        self.assertEqual(s["hidden"], {"new_pass": 0, "new_total": 1, "failed": ["t1", "t2"]})

    def test_missing_pr_fails(self):
        s = self.score(slices=[slice_("S1"), slice_("S2", pr=None)])
        self.assertFalse(s["pass"])
        self.assertEqual(s["reasons"], ["no PR: S2"])

    def test_error_and_timeout_statuses_fail(self):
        self.assertEqual(self.score(status="error")["reasons"], ["status error"])
        self.assertEqual(self.score(status="timeout")["reasons"], ["status timeout"])

    def test_unittest_grade_passes_when_every_expected_test_is_ok(self):
        scen = scenario(self.tmp, name="ut", expected={"tests": ["test_a (m.C)", "test_b (m.C)"],
                                                       "discriminating": ["test_b (m.C)"]})
        grade = dict(GREEN, kind="unittest")
        ok = "test_a (m.C) ... ok\ntest_b (m.C) ... ok\n"
        self.assertTrue(sc.score_run(make_run(self.tmp, scen, name="ut", grade=grade, hidden=ok))["pass"])
        bad = "test_a (m.C) ... ok\ntest_b (m.C) ... FAIL\n"
        s = sc.score_run(make_run(self.tmp, scen, name="ut", grade=grade, hidden=bad))
        self.assertEqual(s["reasons"], ["failing tests: test_b (m.C)"])
        self.assertEqual(s["hidden"]["new_pass"], 0)

    def test_tests_changed_needs_a_test_file(self):
        scen = scenario(self.tmp, name="tc", expect={"decision": None, "testsChanged": True})
        s = sc.score_run(make_run(self.tmp, scen, name="tc", changed=["hooks/workers.ts"]))
        self.assertEqual(s["reasons"], ["no test file changed"])
        self.assertTrue(sc.score_run(make_run(self.tmp, scen, name="tc", changed=["hooks/workers.ts",
                                                                                   "tests/harness.tsx"]))["pass"])

    def test_outside_lists_changed_files_no_allowed_glob_matches(self):
        changed = ["tests/a/b.py", "hooks/workers.ts", "README.md", "scripts/x.py", "docs/a.md"]
        scen = scenario(self.tmp, name="al", allowed=["hooks/workers.ts", "tests/**", "README.md"])
        s = sc.score_run(make_run(self.tmp, scen, name="al", changed=changed))
        self.assertEqual(s["outside"], ["scripts/x.py", "docs/a.md"])
        self.assertTrue(s["pass"])

    def test_no_allowed_key_means_every_changed_file_is_outside(self):
        scen = os.path.join(self.tmp, "scenarios", "noallow")
        write_json(os.path.join(scen, "scenario.json"), {"title": "x", "expect": {"decision": None},
                                                         "grade": {"cmd": ["x"], "parser": "plugin-test"}})
        write_json(os.path.join(scen, "expected.json"), EXPECTED)
        s = sc.score_run(make_run(self.tmp, scen, name="noallow", changed=["hooks/workers.ts"]))
        self.assertEqual(s["outside"], ["hooks/workers.ts"])


class DecisionRule(Folders):
    def setUp(self):
        super().setUp()
        self.dec = scenario(self.tmp, name="dec", grade=False, expected=None,
                            expect={"decision": {"match": DECISION_MATCH}, "testsChanged": False})

    def score(self, **kw):
        return sc.score_run(make_run(self.tmp, self.dec, name="dec", **kw))

    def test_matching_decision_passes(self):
        s = self.score(decisions=["Should the member discount stack with the bulk discount?"])
        self.assertTrue(s["pass"])
        self.assertEqual(s["reasons"], [])
        self.assertEqual(s["decision"], {"expected": True, "raised": True, "matched": True})

    def test_unmatched_decision_fails(self):
        s = self.score(decisions=["Which currency should totals use?"])
        self.assertFalse(s["pass"])
        self.assertEqual(s["reasons"], ["decision not matched"])
        self.assertEqual(s["decision"], {"expected": True, "raised": True, "matched": False})

    def test_no_decision_fails(self):
        s = self.score(decisions=[])
        self.assertFalse(s["pass"])
        self.assertEqual(s["reasons"], ["decision not raised"])

    def test_plan_only_decision_is_recorded_not_counted(self):
        s = self.score(plan_decisions=["Stack the discounts?"], decisions=[])
        self.assertFalse(s["pass"])
        self.assertEqual(s["plan_decisions"], ["Stack the discounts?"])
        self.assertFalse(s["decision"]["raised"])

    def test_decision_scenario_needs_no_expected_json(self):
        self.assertTrue(self.score(decisions=["Stack it?"])["pass"])


class Costs(Folders):
    def test_roles_tokens_secs_and_totals(self):
        calls = [
            call(1, "planner", 1.0, reported=1.2, started=1000, ended=1100, tokens=(10, 20, 30, 40)),
            call(2, "builder", 2.0, reported=2.0, started=1100, ended=1300, tokens=(1, 2, 3, 4), unpriced=["claude-fable-9"]),
            call(3, "builder", 0.6, reported=0.5, started=1300, ended=1350, tokens=(1, 1, 1, 1), resumed=True),
            call(4, "reviewer", 0.3, reported=None, started=1350, ended=1400, tokens=(5, 5, 5, 5)),
        ]
        s = sc.score_run(make_run(self.tmp, self.rep, calls=calls))
        planner, builder, reviewer = s["roles"]["planner"], s["roles"]["builder"], s["roles"]["reviewer"]
        self.assertEqual((planner["calls"], builder["calls"], reviewer["calls"]), (1, 2, 1))
        self.assertEqual(planner["secs"], 100)
        # cost of a call: the larger of the transcript sum and the reported total
        self.assertAlmostEqual(planner["cost"], 1.2)
        self.assertAlmostEqual(builder["cost"], 2.6)
        self.assertAlmostEqual(reviewer["cost"], 0.3)
        self.assertAlmostEqual(planner["cost_reported"], 1.2)
        self.assertAlmostEqual(builder["cost_reported"], 2.5)
        self.assertIsNone(reviewer["cost_reported"])
        self.assertAlmostEqual(s["cost"], 4.1)
        self.assertEqual(builder["tokens"], {"inp": 2, "out": 3, "cr": 4, "cw": 5})
        self.assertEqual(planner["tokens"], {"inp": 10, "out": 20, "cr": 30, "cw": 40})
        self.assertEqual(builder["secs"], 250)
        self.assertEqual(reviewer["secs"], 50)
        self.assertEqual(s["wall"], 600.0)
        self.assertEqual(s["unpriced"], ["claude-fable-9"])

    def test_roles_without_calls_are_zero(self):
        s = sc.score_run(make_run(self.tmp, self.rep, calls=[]))
        self.assertEqual(s["roles"]["reviewer"]["calls"], 0)
        self.assertEqual(s["roles"]["reviewer"]["cost"], 0.0)
        self.assertEqual(s["cost"], 0.0)

    def test_fix_rounds_and_blockers(self):
        slices = [
            slice_("S1", fix_rounds=2, reviews=[review(3, "changes", 2), review(5, "changes", 1)]),
            slice_("S2", fix_rounds=1, reviews=[review(4, None, None)]),
        ]
        s = sc.score_run(make_run(self.tmp, self.rep, slices=slices))
        self.assertEqual(s["fix_rounds"], 3)
        # first review of each slice: 2 and unknown; every review: 2, 1 and unknown
        self.assertEqual(s["blockers"], {"first": 2, "total": 3})

    def test_no_review_means_no_blocker_count(self):
        s = sc.score_run(make_run(self.tmp, self.rep))
        self.assertEqual(s["blockers"], {"first": None, "total": None})

    def test_unknown_blockers_stay_unknown(self):
        # a review with no verdict has no count: it is not a zero
        s = sc.score_run(make_run(self.tmp, self.rep, slices=[slice_(reviews=[review(3, None, None)])]))
        self.assertEqual(s["blockers"], {"first": None, "total": None})


class Leaks(Folders):
    def score(self, jobs, **kw):
        return sc.score_run(make_run(self.tmp, self.rep, jobs=jobs, **kw))

    def test_bash_command_with_a_leak_pattern_is_invalid(self):
        s = self.score({"01-plan": [tool("Bash", command="cat /work/plan-18/PLAN.md")]})
        self.assertTrue(s["invalid"])
        self.assertEqual(s["leak"], [{"job": "jobs/01-plan", "tool": "Bash", "pattern": "plan-18"}])
        self.assertTrue(s["pass"])  # the pass rule is not changed by a leak; the aggregate leaves the run out

    def test_read_glob_and_webfetch_inputs_are_scanned(self):
        jobs = {"02-build": [
            tool("Read", file_path="/src/scripts/hrd-eval/score.py"),
            tool("Glob", path="/src/plan-18", pattern="*"),
            tool("WebFetch", url="https://github.com/contursofran/x"),
        ]}
        s = self.score(jobs, leaks=["scripts/hrd-eval", "plan-18", "github.com/contursofran"])
        self.assertEqual(s["leak"], [
            {"job": "jobs/02-build", "tool": "Read", "pattern": "scripts/hrd-eval"},
            {"job": "jobs/02-build", "tool": "Glob", "pattern": "plan-18"},
            {"job": "jobs/02-build", "tool": "WebFetch", "pattern": "github.com/contursofran"},
        ])

    def test_tools_outside_the_list_are_not_scanned(self):
        s = self.score({"03-build": [tool("Write", file_path="/tmp/plan-18.md", content="plan-18")]})
        self.assertFalse(s["invalid"])
        self.assertEqual(s["leak"], [])

    def test_no_pattern_or_an_empty_pattern_is_no_leak(self):
        jobs = {"01-plan": [tool("Bash", command="cat plan-18")]}
        self.assertFalse(self.score(jobs, leaks=[])["invalid"])
        self.assertFalse(self.score(jobs, leaks=[""])["invalid"])


class ShimBypass(Folders):
    def test_gh_in_bash_with_an_empty_shim_log_counts(self):
        jobs = {"01-build": [tool("Bash", command="gh pr view 14"), tool("Bash", command="echo high pressure")]}
        s = sc.score_run(make_run(self.tmp, self.rep, jobs=jobs, gh_log=""))
        self.assertEqual(s["shim_bypassed"], 1)

    def test_shim_log_with_a_call_counts_zero(self):
        jobs = {"01-build": [tool("Bash", command="gh pr view 14")]}
        log = '{"t": 1.0, "cwd": "/x", "argv": ["pr", "view"], "exit": 0}\n'
        self.assertEqual(sc.score_run(make_run(self.tmp, self.rep, jobs=jobs, gh_log=log))["shim_bypassed"], 0)


class ExpectedRequired(Folders):
    def test_grade_scenario_needs_expected_json(self):
        scen = scenario(self.tmp, name="nogood", expected=None)
        with self.assertRaisesRegex(sc.ExpectedMissing, "nogood: no expected.json.*--check-scenarios --scenarios nogood"):
            sc.score_run(make_run(self.tmp, scen, name="nogood"))


class ReviewUnparsed(Folders):
    def test_a_run_whose_review_had_no_verdict_is_flagged_and_still_scored(self):
        run = make_run(self.tmp, self.rep, slices=[dict(slice_(), review_unparsed=True)])
        s = sc.score_run(run)
        self.assertTrue(s["review_unparsed"])
        self.assertTrue(s["pass"])  # the pass rule is not changed by it

    def test_a_run_whose_reviews_parsed_is_not_flagged(self):
        self.assertFalse(sc.score_run(make_run(self.tmp, self.rep, slices=[dict(slice_(), review_unparsed=False)]))["review_unparsed"])
        self.assertFalse(sc.score_run(make_run(self.tmp, self.rep, repeat=2))["review_unparsed"])

    def test_the_table_lists_the_flagged_runs(self):
        run = make_run(self.tmp, self.rep, slices=[dict(slice_(), review_unparsed=True)])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            sc.print_text(sc.aggregate([sc.score_run(run)]))
        self.assertIn("1 runs had a review with no VERDICT line", out.getvalue())
        self.assertIn(run, out.getvalue())


class Disagreements(Folders):
    def runs(self, arm, passes, total, leak=False):
        """`total` runs of arm `arm` on scenario "rates"; the first `passes` of them pass, the rest miss t2."""
        scen = scenario(self.tmp, name="rates")
        out = []
        for k in range(1, total + 1):
            hidden = DEFAULT_HIDDEN if k <= passes else "(pass) t1 [5ms]\n"
            jobs = {"01-build": [tool("Bash", command="ls plan-18")]} if leak else None
            out.append(sc.score_run(make_run(self.tmp, scen, name="rates", arm=arm, repeat=k, hidden=hidden, jobs=jobs)))
        return out

    def test_two_of_three_against_two_of_two_is_a_disagreement(self):
        agg = sc.aggregate(self.runs("A", 2, 3) + self.runs("B", 2, 2))
        self.assertEqual(len(agg["disagreements"]), 1)
        d = agg["disagreements"][0]
        self.assertEqual(d["arms"], {"A": {"pass": 2, "valid": 3}, "B": {"pass": 2, "valid": 2}})
        self.assertEqual([(f["arm"], f["reason"]) for f in d["failing"]], [("A", "missing tests: t2")])

    def test_one_of_one_against_two_of_two_is_not_a_disagreement(self):
        self.assertEqual(sc.aggregate(self.runs("A", 1, 1) + self.runs("B", 2, 2))["disagreements"], [])

    def test_an_arm_with_no_valid_run_has_no_rate_and_is_not_compared(self):
        agg = sc.aggregate(self.runs("A", 1, 2) + self.runs("B", 0, 2, leak=True))
        self.assertEqual(agg["disagreements"], [])


def equal_arms(scores):
    """The replay runs of arm A, and a copy of them as arm B: both arms have the same pass count."""
    a = [s for s in scores if s["scenario"] == "rep" and s["arm"] == "A"]
    return a + [dict(s, arm="B") for s in a]


def fixture(tmp):
    """Two arms, two scenarios. A and B ran `rep` (a replay) and `dec` (a decision scenario); see the expected
    cells in Aggregate."""
    rep = scenario(tmp)
    dec = scenario(tmp, name="dec", grade=False, expected=None, expect={"decision": {"match": DECISION_MATCH},
                                                                         "testsChanged": False})
    leak = [tool("Bash", command="ls plan-18")]
    runs = [
        # A, replay: pass (cost 1.0, wall 100, first blockers 2), pass (2.0, 300, fix 1), merge conflict (3.0, 200)
        make_run(tmp, rep, arm="A", repeat=1, ended=1100.0,
                 slices=[slice_(reviews=[review(2, "changes", 2)])],
                 calls=[call(1, "builder", 1.0, unpriced=["claude-fable-9"])]),
        make_run(tmp, rep, arm="A", repeat=2, ended=1300.0, slices=[slice_(fix_rounds=1)],
                 calls=[call(1, "builder", 2.0)]),
        make_run(tmp, rep, arm="A", repeat=3, ended=1200.0,
                 grade=dict(GREEN, merged=False, merge_error="CONFLICT (content): hooks/workers.ts"),
                 slices=[slice_(fix_rounds=2, reviews=[review(2, "changes", 1)])], calls=[call(1, "builder", 3.0)]),
        # B, replay: missing t2 (cost 0.5, wall 50), leak and missing t2 (0.5, 150), pass (1.0, 250)
        make_run(tmp, rep, arm="B", repeat=1, ended=1050.0, hidden="(pass) t1 [5ms]\n",
                 calls=[call(1, "builder", 0.5)]),
        make_run(tmp, rep, arm="B", repeat=2, ended=1150.0, hidden="(pass) t1 [5ms]\n",
                 jobs={"01-build": leak}, calls=[call(1, "builder", 0.5)]),
        make_run(tmp, rep, arm="B", repeat=3, ended=1250.0, calls=[call(1, "builder", 1.0)]),
        # A, decision: matched (0.2), not raised (0.3)
        make_run(tmp, dec, name="dec", arm="A", repeat=1, decisions=["Should totals stack?"],
                 calls=[call(1, "planner", 0.2)]),
        make_run(tmp, dec, name="dec", arm="A", repeat=2, calls=[call(1, "planner", 0.3)]),
        # B, decision: not matched (0.1), a matching decision with a leak (0.4): left out
        make_run(tmp, dec, name="dec", arm="B", repeat=1, decisions=["Which currency?"],
                 calls=[call(1, "planner", 0.1)]),
        make_run(tmp, dec, name="dec", arm="B", repeat=2, decisions=["Stack or not?"], jobs={"01-plan": leak},
                 calls=[call(1, "planner", 0.4)]),
    ]
    return [sc.score_run(r) for r in runs]


class Aggregate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.scores = fixture(self.tmp)
        self.agg = sc.aggregate(self.scores)
        self.cells = {(c["scenario"], c["arm"]): c for c in self.agg["cells"]}

    def test_replay_cells(self):
        a = self.cells[("rep", "A")]
        self.assertEqual((a["runs"], a["valid"], a["invalid"], a["pass"]), (3, 3, 0, 2))
        self.assertAlmostEqual(a["cost"], 2.0)
        self.assertEqual(a["wall"], 200)  # median of 100, 300, 200
        self.assertAlmostEqual(a["fix_rounds"], 1.0)
        self.assertAlmostEqual(a["blockers"], 1.5)  # first reviews: 2 and 1; the run with none is left out
        self.assertEqual(a["outside"], 0)
        b = self.cells[("rep", "B")]
        self.assertEqual((b["runs"], b["valid"], b["invalid"], b["pass"]), (3, 2, 1, 1))
        self.assertAlmostEqual(b["cost"], 2.0 / 3)  # the leaked run's cost is counted
        self.assertEqual(b["wall"], 150)  # median of 50, 150, 250
        self.assertIsNone(b["blockers"])

    def test_decision_cells(self):
        a = self.cells[("dec", "A")]
        self.assertEqual((a["valid"], a["pass"]), (2, 1))
        self.assertEqual(a["decision"], {"k": 1, "n": 2})
        self.assertAlmostEqual(a["cost"], 0.25)
        b = self.cells[("dec", "B")]
        self.assertEqual((b["runs"], b["valid"], b["invalid"], b["pass"]), (2, 1, 1, 0))
        self.assertEqual(b["decision"], {"k": 0, "n": 1})

    def test_arm_totals_and_roles(self):
        self.assertEqual(self.agg["arms"]["A"], {"runs": 5, "valid": 5, "invalid": 0, "pass": 3, "cost": 6.5})
        self.assertEqual(self.agg["arms"]["B"]["invalid"], 2)
        self.assertEqual(self.agg["arms"]["B"]["pass"], 1)
        self.assertAlmostEqual(self.agg["arms"]["B"]["cost"], 2.5)
        self.assertAlmostEqual(self.agg["roles"]["A"]["builder"], 6.0)
        self.assertAlmostEqual(self.agg["roles"]["A"]["planner"], 0.5)
        self.assertAlmostEqual(self.agg["roles"]["B"]["reviewer"], 0.0)

    def test_disagreements_list_the_failing_runs(self):
        dis = {d["scenario"]: d for d in self.agg["disagreements"]}
        self.assertEqual(sorted(dis), ["dec", "rep"])
        self.assertEqual(dis["rep"]["arms"], {"A": {"pass": 2, "valid": 3}, "B": {"pass": 1, "valid": 2}})
        self.assertEqual([(f["arm"], f["reason"]) for f in dis["rep"]["failing"]],
                         [("A", "merge conflict"), ("B", "missing tests: t2")])
        self.assertEqual([(f["arm"], f["reason"]) for f in dis["dec"]["failing"]],
                         [("A", "decision not raised"), ("B", "decision not matched")])
        self.assertEqual(dis["rep"]["failing"][0]["folder"], self.scores[2]["folder"])

    def test_no_disagreement_when_pass_counts_match(self):
        self.assertEqual(sc.aggregate(equal_arms(self.scores))["disagreements"], [])

    def test_json_keys(self):
        self.assertEqual(set(self.agg), {"matrix", "runs", "cells", "arms", "roles", "disagreements"})
        self.assertIsNone(self.agg["matrix"])
        self.assertEqual(len(self.agg["runs"]), 10)


class PrintText(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.agg = sc.aggregate(fixture(self.tmp))

    def render(self, agg=None):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            sc.print_text(agg or self.agg)
        return buf.getvalue()

    def rows(self, text):
        return [line.split() for line in text.splitlines() if line[:1].isalpha() and line.split()[0] in ("rep", "dec")]

    def test_header_and_cell_rows(self):
        text = self.render()
        lines = text.splitlines()
        self.assertEqual(lines[0], "== hrd-eval: 10 runs, 2 scenarios, 2 arms")
        self.assertEqual(lines[1].split(),
                         ["scenario", "arm", "pass", "decision", "cost", "wall", "s", "fix", "blockers", "outside",
                          "invalid"])
        self.assertIn(["rep", "A", "2/3", "-", "$2.00", "200", "1.00", "1.5", "0", "0"], self.rows(text))
        self.assertIn(["rep", "B", "1/2", "-", "$0.67", "150", "0.00", "-", "0", "1"], self.rows(text))
        self.assertIn(["dec", "A", "1/2", "1/2", "$0.25", "600", "0.00", "-", "0", "0"], self.rows(text))
        self.assertIn(["dec", "B", "0/1", "0/1", "$0.25", "600", "0.00", "-", "0", "1"], self.rows(text))

    def test_per_arm_rows_with_cost_by_role(self):
        text = self.render()
        self.assertIn(["A", "5", "5", "3", "$6.50", "$0.50", "$6.00", "$0.00"], [line.split() for line in text.splitlines()])
        self.assertIn(["B", "5", "3", "1", "$2.50", "$0.50", "$2.00", "$0.00"], [line.split() for line in text.splitlines()])

    def test_rows_are_fixed_width(self):
        lines = [line for line in self.render().splitlines() if line[:3] in ("rep", "dec", "sce")]
        self.assertEqual(len({len(line) for line in lines}), 1)

    def test_footers_for_unpriced_and_invalid_runs(self):
        text = self.render()
        self.assertIn("no price for claude-fable-9: cost counted as 0", text)
        self.assertIn("2 invalid runs (a leak), left out of the pass and decision rates", text)
        self.assertIn("Bash plan-18", text)

    def test_disagreements_section(self):
        text = self.render()
        self.assertIn("   rep: A 2/3, B 1/2", text)
        self.assertIn("      A " + self.agg["disagreements"][1]["failing"][0]["folder"] + ": merge conflict", text)

    def test_no_disagreements_says_none(self):
        agg = sc.aggregate(equal_arms(self.agg["runs"]))
        self.assertIn("== disagreements: scenarios whose pass counts differ between arms\n   none", self.render(agg))


class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.results = os.path.join(self.tmp, "results")
        rep = scenario(self.tmp)
        make_run(self.tmp, rep, repeat=1, arm="A")
        make_run(self.tmp, rep, repeat=1, arm="B", hidden="(pass) t1\n")
        write_json(os.path.join(self.results, "matrix.json"), {"started": 1000.0, "repeats": 3, "repo_root": "/r",
                                                               "scenarios": ["rep"], "arms": {}, "max_cost": 30.0,
                                                               "estimate": 1.0})

    def run_cli(self, *args):
        return subprocess.run([sys.executable, SCRIPT, self.results, *args], capture_output=True, text=True)

    def test_json_has_the_six_keys_and_the_matrix(self):
        out = self.run_cli("--json")
        self.assertEqual(out.returncode, 0, out.stderr)
        data = json.loads(out.stdout)
        self.assertEqual(set(data), {"matrix", "runs", "cells", "arms", "roles", "disagreements"})
        self.assertEqual(data["matrix"]["repeats"], 3)
        self.assertEqual(len(data["runs"]), 2)
        self.assertEqual(len(data["disagreements"]), 1)

    def test_table_header_names_the_matrix(self):
        out = self.run_cli()
        self.assertEqual(out.returncode, 0, out.stderr)
        head = out.stdout.splitlines()[0]
        self.assertTrue(head.startswith("== hrd-eval: 2 runs, 1 scenarios, 2 arms, repeats 3, started "), head)

    def test_no_run_json_is_an_error(self):
        empty = os.path.join(self.tmp, "empty")
        os.makedirs(empty)
        out = subprocess.run([sys.executable, SCRIPT, empty], capture_output=True, text=True)
        self.assertEqual(out.returncode, 1)
        self.assertIn("no run.json", out.stderr)

    def test_matrix_is_null_without_matrix_json(self):
        os.remove(os.path.join(self.results, "matrix.json"))
        self.assertIsNone(json.loads(self.run_cli("--json").stdout)["matrix"])

    def test_a_graded_scenario_without_expected_json_is_one_line_and_exit_1(self):
        make_run(self.tmp, scenario(self.tmp, name="nogood", expected=None), name="nogood")
        out = self.run_cli()
        self.assertEqual(out.returncode, 1)
        self.assertEqual(len(out.stderr.strip().splitlines()), 1, out.stderr)
        self.assertIn("nogood: no expected.json", out.stderr)
        self.assertNotIn("Traceback", out.stderr)
        self.assertEqual(out.stdout, "")


if __name__ == "__main__":
    unittest.main()
