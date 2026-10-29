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
DECISION_MATCH = r"(?i)stack|combin|both|additive|compound|on top|instead of|larger|greater|higher|bigger|max|together"


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def write_json(path, data):
    write(path, json.dumps(data))


def tool(name, _id="t1", **inp):
    """One assistant transcript line that calls a tool, as Claude Code writes it."""
    rec = {
        "type": "assistant",
        "timestamp": "2026-10-24T10:00:00.000Z",
        "message": {"role": "assistant", "content": [{"type": "tool_use", "id": _id, "name": name, "input": inp}]},
    }
    return json.dumps(rec, separators=(",", ":"))


def result(_id, text, is_error=False):
    """The user transcript line with a tool's result, as Claude Code writes it."""
    block = {"type": "tool_result", "tool_use_id": _id, "content": text, "is_error": is_error}
    rec = {"type": "user", "timestamp": "2026-10-24T10:00:01.000Z", "message": {"role": "user", "content": [block]}}
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
             gh_log="", leaks=LEAKS, started=1000.0, ended=1600.0, pr_opened=True, isolation=None, questions=None):
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
    if isolation is not None:
        run["isolation"] = isolation
    if questions is not None:
        run["questions"] = questions
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
        self.assertEqual(s["hidden"], {"new_pass": 1, "new_total": 1, "failed": [], "flaky_failed": []})
        self.assertEqual(s["own_tests"], "pass")
        self.assertEqual(s["outside"], [])
        self.assertEqual(s["wall"], 600.0)
        self.assertTrue(s["pr_opened"])
        self.assertEqual(s["decision"], {"expected": False, "raised": False, "matched": False})

    def test_missing_expected_test_fails(self):
        s = self.score(hidden="(pass) t1 [5ms]\n")
        self.assertFalse(s["pass"])
        self.assertEqual(s["reasons"], ["missing tests: t2"])
        self.assertEqual(s["hidden"], {"new_pass": 0, "new_total": 1, "failed": ["t2"], "flaky_failed": []})

    def test_failing_and_skipped_expected_tests_fail(self):
        self.assertEqual(self.score(hidden="(pass) t1\n(fail) t2\n")["reasons"], ["failing tests: t2"])
        self.assertEqual(self.score(hidden="(pass) t1\n(skip) t2\n")["reasons"], ["failing tests: t2"])

    def test_merge_conflict_fails(self):
        s = self.score(grade=dict(GREEN, merged=False, merge_error="CONFLICT (content): hooks/workers.ts"))
        self.assertFalse(s["pass"])
        self.assertEqual(s["reasons"], ["merge conflict"])

    def test_not_merged_without_an_error_fails(self):
        self.assertEqual(self.score(grade=dict(GREEN, merged=False))["reasons"], ["not merged"])

    def test_not_graded_fails_and_lists_no_test_as_failed(self):
        # contract/R (20261026-172215) was not graded, and every hidden test, cart tests included, read as failed.
        s = self.score(grade={"ran": False, "kind": None, "merged": False, "merge_error": None, "exit": None,
                              "own_exit": None}, hidden=None)
        self.assertFalse(s["pass"])
        self.assertEqual(s["reasons"], ["not merged", "not graded"])
        self.assertEqual(s["own_tests"], "none")
        self.assertEqual(s["hidden"], {"new_pass": 0, "new_total": 1, "failed": [], "flaky_failed": []})

    def test_a_graded_run_with_a_slice_left_out_fails_on_the_merge_and_shows_its_tests(self):
        s = self.score(grade=dict(GREEN, merged=False, merge_error="issue-12-s2: no branch on the remote (no PR)"),
                       hidden="(pass) t1\n(fail) t2\n")
        self.assertEqual(s["reasons"], ["not merged: issue-12-s2: no branch on the remote (no PR)", "failing tests: t2"])

    def test_a_flaky_test_that_fails_is_set_aside_unless_it_is_discriminating(self):
        scen = scenario(self.tmp, name="fl", expected={"tests": ["t1", "t2", "t3"], "discriminating": ["t2"],
                                                       "flaky": ["t1", "t2"]})
        s = sc.score_run(make_run(self.tmp, scen, name="fl", hidden="(fail) t1\n(pass) t2\n(pass) t3\n"))
        self.assertTrue(s["pass"], s["reasons"])
        self.assertEqual(s["hidden"]["flaky_failed"], ["t1"])
        self.assertEqual(s["hidden"]["failed"], [])
        s = sc.score_run(make_run(self.tmp, scen, name="fl", hidden="(pass) t1\n(fail) t2\n(pass) t3\n"))
        self.assertEqual(s["reasons"], ["failing tests: t2"])  # t2 is flaky but discriminating: it counts
        s = sc.score_run(make_run(self.tmp, scen, name="fl", hidden="(pass) t2\n(pass) t3\n"))
        self.assertTrue(s["pass"], s["reasons"])  # a flaky test that is missing is set aside too
        self.assertEqual(s["hidden"]["flaky_failed"], ["t1"])

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

    def test_a_report_a_worker_writes_through_a_quoted_heredoc_is_not_a_leak(self):
        # replay-14/B (20261026-172215): the builder's RESULT.md quoted the issue's link.
        command = ("cd /r/jobs/04-builder-S1 && cat > RESULT.md <<'E'\n<!-- report 4c470ff2 -->\nPR: "
                   "https://github.com/contursofran/x/pull/11\nE")
        s = self.score({"04-build": [tool("Bash", command=command)]}, leaks=["github.com/contursofran"])
        self.assertFalse(s["invalid"])
        for heredoc in ('<<"EOF"', "<<\\EOF", "<<-'EOF'"):
            command = f"cat >> /r/jobs/01-plan/PLAN.md {heredoc}\nsee plan-18\nEOF"
            self.assertFalse(self.score({"01-plan": [tool("Bash", command=command)]})["invalid"], heredoc)

    def test_a_read_after_a_report_heredoc_or_inside_an_unquoted_one_is_still_a_leak(self):
        after = "cat > RESULT.md <<'E'\nnotes\nE\ncat ~/plan-18/PLAN.md"
        self.assertTrue(self.score({"01-plan": [tool("Bash", command=after)]})["invalid"])
        unquoted = "cat > RESULT.md <<E\n$(cat ~/plan-18/PLAN.md)\nE"  # an unquoted heredoc runs its $(...)
        self.assertTrue(self.score({"01-plan": [tool("Bash", command=unquoted)]})["invalid"])
        to_code = "cat > hooks/x.ts <<'E'\nplan-18\nE"  # only a .md file is a report
        self.assertTrue(self.score({"01-plan": [tool("Bash", command=to_code)]})["invalid"])

    def test_a_read_the_sandbox_refused_is_blocked_not_a_leak(self):
        mods = "~/.claude/mods/herdr-agents"
        home = os.path.expanduser("~")
        jobs = {"01-build": [
            tool("Bash", _id="a", command=f"npm test 2>&1 | tail -3; ls {mods}/.claude-plugin/types 2>&1 | head"),
            result("a", f" 21 pass\nls: {home}/.claude/mods/herdr-agents/.claude-plugin/types: Operation not permitted"),
            tool("Read", _id="b", file_path=f"{home}/.claude/mods/herdr-agents/hooks/state.ts"),
            result("b", "Permission to read this file has been denied.", is_error=True),
        ]}
        s = self.score(jobs, leaks=[mods, f"{home}/.claude/mods/herdr-agents"])
        self.assertFalse(s["invalid"])
        self.assertEqual(s["leak"], [])
        self.assertEqual(s["leak_blocked"], [
            {"job": "jobs/01-build", "tool": "Bash", "pattern": mods},
            {"job": "jobs/01-build", "tool": "Read", "pattern": f"{home}/.claude/mods/herdr-agents"},
        ])

    def test_a_claude_code_permission_denial_is_blocked_not_a_leak(self):
        # replay-15/B and B2 (20261026-201836): the auto mode classifier refused the grep, and its text names no path.
        classifier = ("Permission for this action was denied by the Claude Code auto mode classifier. Reason: The "
                      "server-side auto mode classifier judged this action dangerous (it gave no explanation).")
        mods = "~/.claude/mods/herdr-agents"
        for text in (classifier, "Permission to use Bash with command ls has been denied.",
                     "Permission for this action has been denied."):
            jobs = {"01-build": [
                tool("Bash", _id="a", command=f"grep -rn store {mods} | head"),
                result("a", text, is_error=True),
            ]}
            s = self.score(jobs, leaks=[mods])
            self.assertFalse(s["invalid"], text)
            self.assertEqual(s["leak"], [])
            self.assertEqual(s["leak_blocked"], [{"job": "jobs/01-build", "tool": "Bash", "pattern": mods}])

    def test_a_denial_quoted_inside_other_output_is_not_a_refusal(self):
        jobs = {"01-build": [
            tool("Bash", _id="a", command="ls ~/.claude/mods/herdr-agents"),
            result("a", "index.d.ts\nnote: Permission for this action was denied earlier"),
        ]}
        self.assertTrue(self.score(jobs, leaks=["~/.claude/mods/herdr-agents"])["invalid"])

    def test_output_that_starts_like_a_denial_is_not_one_without_is_error(self):
        # Claude Code marks its own denials is_error; a command that ran can print the same words first.
        jobs = {"01-build": [
            tool("Bash", _id="a", command='echo "Permission was denied"; ls ~/.claude/mods/herdr-agents'),
            result("a", "Permission was denied\nindex.d.ts"),
        ]}
        self.assertTrue(self.score(jobs, leaks=["~/.claude/mods/herdr-agents"])["invalid"])

    def test_a_refusal_that_names_another_path_does_not_block_a_read(self):
        # replay-15/B (20261026-172215): the listing came back; an error elsewhere in the output says nothing.
        jobs = {"01-build": [
            tool("Bash", _id="a", command="ls nope; ls ~/.claude/mods/herdr-agents/.claude-plugin/types"),
            result("a", "ls: nope: No such file or directory\nclaude-code\nindex.d.ts", is_error=True),
        ]}
        s = self.score(jobs, leaks=["~/.claude/mods/herdr-agents"])
        self.assertTrue(s["invalid"])

    def test_an_empty_result_is_blocked_only_in_an_isolated_run(self):
        jobs = {"01-build": [tool("Bash", _id="a", command="grep -rn store ~/.claude/mods/herdr-agents 2>/dev/null"),
                             result("a", "")]}
        leaks = ["~/.claude/mods/herdr-agents"]
        self.assertTrue(self.score(jobs, leaks=leaks)["invalid"])
        s = self.score(jobs, leaks=leaks, isolation={"sandbox": True, "deny_read": ["/home/x/.claude/mods"]})
        self.assertFalse(s["invalid"])
        self.assertEqual(len(s["leak_blocked"]), 1)

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


class Footers(Folders):
    """The notes under the table for runs that set a flaky failure aside, asked past the answer cap, or were refused a
    leak path."""

    def test_flaky_failures_questions_past_the_cap_and_refused_reads_are_listed(self):
        scen = scenario(self.tmp, name="fl", expected={"tests": ["t1", "t2"], "discriminating": ["t2"], "flaky": ["t1"]})
        jobs = {"01-build": [tool("Bash", _id="a", command="ls ~/.claude/mods/herdr-agents"),
                             result("a", "ls: /h/.claude/mods/herdr-agents: Operation not permitted")]}
        run = make_run(self.tmp, scen, name="fl", hidden="(fail) t1\n(pass) t2\n", jobs=jobs,
                       leaks=["~/.claude/mods/herdr-agents"],
                       questions={"recommended": 2, "auto": 1, "unanswered": 1, "stop": 0})
        s = sc.score_run(run)
        self.assertTrue(s["pass"], s["reasons"])
        self.assertFalse(s["invalid"])
        self.assertEqual(s["questions"]["unanswered"], 1)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            sc.print_text(sc.aggregate([s]))
        text = buf.getvalue()
        self.assertIn("1 runs failed tests that are flaky in the reference (expected.json); set aside, not failures:", text)
        self.assertIn(f"      {run}: t1", text)
        self.assertIn(f"      {run}: auto 1, unanswered 1", text)
        self.assertIn("1 runs tried to read a leak path and were refused (not invalid):", text)
        self.assertIn(f"      {run}: Bash ~/.claude/mods/herdr-agents", text)


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


def review_item(tmp, item, seed, audit=None):
    """reviews/<item>/scenario.json (kind review, no expected.json) and an optional audit.json."""
    d = os.path.join(tmp, "reviews", item)
    write_json(os.path.join(d, "scenario.json"), {"title": item, "kind": "review", "base": "../x", "seed": seed})
    if audit is not None:
        write_json(os.path.join(d, "audit.json"), audit)
    return d


def seed_(type_="logic", quiet=True, origin="seeded"):
    return {"type": type_, "quiet": quiet, "check": "none", "match": "discount", "origin": origin}


def make_review(tmp, item, scen_dir, arm="RL", repeat=1, verdict="changes", how="header", matched=False, seed_type="logic",
                quiet=True, text="x", cost=0.2, wall=60.0, status="done"):
    """A review run folder under <tmp>/results/<item>/<arm>/r<repeat>, as the Contract's run.json additions say."""
    run_dir = os.path.join(tmp, "results", item, arm, f"r{repeat}")
    block = {"item": item, "seed_type": seed_type, "quiet": quiet, "verdict": verdict, "how": how,
             "blockers": None if verdict is None else int(verdict == "changes"), "blockers_text": text,
             "matched_blockers": matched, "matched_report": matched, "cost": cost, "wall": wall, "turns": 5}
    run = {"scenario": item, "scenario_dir": scen_dir, "arm": arm, "repeat": repeat, "status": status, "started": 0.0,
           "ended": wall, "slices": [{"id": "S1", "pr": 13, "head": "abc", "reviews": []}], "grade": {"ran": False},
           "review": block}
    write_json(os.path.join(run_dir, "run.json"), run)
    return run_dir


class Wilson(unittest.TestCase):
    def test_known_values(self):
        lo, hi = sc.wilson(27, 30)
        self.assertAlmostEqual(lo, 0.7438, places=3)
        self.assertAlmostEqual(hi, 0.9654, places=3)
        lo, hi = sc.wilson(0, 5)
        self.assertEqual(lo, 0.0)
        self.assertAlmostEqual(hi, 0.4345, places=3)
        lo, hi = sc.wilson(5, 5)
        self.assertAlmostEqual(lo, 0.5655, places=3)
        self.assertEqual(hi, 1.0)

    def test_no_reviews_has_no_interval(self):
        self.assertEqual(sc.wilson(0, 0), (None, None))


class ReviewRuns(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        t = self.tmp
        self.logic = review_item(t, "rv-14-logic", seed_())
        self.edge = review_item(t, "rv-15-edge", seed_("edge"))
        self.scope = review_item(t, "rv-26-scope-h1", seed_("scope", False, "harvested:r/replay-26/A/r1"))
        self.clean = review_item(t, "rv-14-clean", None, audit={"results/RL/r1": "valid"})
        # RL: logic caught, edge blocked without a match, scope noticed (approve, but the report names it)
        make_review(t, "rv-14-logic", self.logic, matched=True, text="discount is skipped")
        make_review(t, "rv-15-edge", self.edge, seed_type="edge", text="something else")
        make_review(t, "rv-26-scope-h1", self.scope, verdict="approve", matched=True, seed_type="scope", quiet=False)
        # clean: r1 is a false blocker audited valid, r2 an unaudited false blocker, r3 approves
        make_review(t, "rv-14-clean", self.clean, seed_type=None, quiet=None, text="nit as blocker")
        make_review(t, "rv-14-clean", self.clean, repeat=2, seed_type=None, quiet=None, text="another")
        make_review(t, "rv-14-clean", self.clean, repeat=3, verdict="approve", seed_type=None, quiet=None)
        # RM: an unparsed review of the logic item, edge blocked, scope blocked
        make_review(t, "rv-14-logic", self.logic, arm="RM", verdict=None, how="none")
        make_review(t, "rv-15-edge", self.edge, arm="RM", seed_type="edge", matched=True)
        make_review(t, "rv-26-scope-h1", self.scope, arm="RM", seed_type="scope", quiet=False, matched=True)
        self.results = os.path.join(t, "results")
        # audit.json keys are "<results folder>/<arm>/r<k>": the results folder here is the fixture's "results"
        self.agg = sc.aggregate([sc.score_run(os.path.dirname(p)) for p in sorted(glob_runs(self.results))])
        self.rv = self.agg["review"]

    def test_builder_sections_are_empty_and_review_is_added(self):
        self.assertEqual(self.agg["runs"], [])
        self.assertEqual(self.agg["cells"], [])
        self.assertIn("review", self.agg)

    def test_score_run_passes_the_review_block_through(self):
        s = sc.score_run(os.path.join(self.results, "rv-14-logic", "RL", "r1"))
        self.assertEqual(s["review"]["verdict"], "changes")
        self.assertTrue(s["review"]["matched_blockers"])
        self.assertEqual(s["cost"], 0.2)

    def test_caught_blocked_not_matched_and_noticed(self):
        rl = self.rv["arms"]["RL"]
        q = rl["quiet"]
        self.assertEqual((q["n"], q["blocked"], q["caught"]), (2, 2, 1))  # logic caught, edge blocked not matched
        o = rl["other"]
        self.assertEqual((o["n"], o["blocked"], o["caught"]), (1, 0, 0))  # scope: noticed, approve = a miss
        self.assertEqual(rl["by_type"]["scope"]["blocked"], 0)
        self.assertEqual(rl["by_type"]["edge"]["caught"], 0)
        self.assertEqual(rl["by_type"]["logic"]["caught"], 1)

    def test_quiet_rate_has_a_wilson_interval(self):
        q = self.rv["arms"]["RL"]["quiet"]
        self.assertEqual(q["rate"], 1.0)
        self.assertEqual((q["lo"], q["hi"]), sc.wilson(2, 2))

    def test_clean_false_blocker_audited_valid_is_not_counted(self):
        c = self.rv["arms"]["RL"]["clean"]
        self.assertEqual((c["n"], c["false_blockers"], c["audited_false"]), (3, 2, 1))
        self.assertAlmostEqual(c["rate"], 1 / 3)
        listed = self.rv["false_blockers"]
        self.assertEqual([(f["arm"], f["audit"], f["blockers_text"]) for f in listed],
                         [("RL", "valid", "nit as blocker"), ("RL", None, "another")])

    def test_unparsed_review_is_counted_apart_and_is_not_blocked(self):
        rm = self.rv["arms"]["RM"]
        self.assertEqual(rm["unparsed"], 1)
        self.assertEqual(rm["quiet"]["n"], 2)
        self.assertEqual(rm["quiet"]["blocked"], 1)
        self.assertEqual(self.rv["arms"]["RL"]["unparsed"], 0)

    def test_cost_wall_and_items(self):
        rl = self.rv["arms"]["RL"]
        self.assertEqual(rl["reviews"], 6)
        self.assertAlmostEqual(rl["cost"], 1.2)
        self.assertAlmostEqual(rl["cost_per_review"], 0.2)
        self.assertEqual(rl["wall_median"], 60.0)
        self.assertEqual(self.rv["items"]["rv-14-clean"]["RL"], {"blocked": 2, "n": 3})
        self.assertEqual(self.rv["items"]["rv-14-logic"]["RM"], {"blocked": 0, "n": 1})

    def test_disagreements_are_items_with_different_blocked_rates(self):
        self.assertEqual(self.rv["disagreements"], ["rv-14-logic", "rv-26-scope-h1"])

    def test_default_gate_fails_on_a_missed_real_item_and_names_it(self):
        g = self.rv["arms"]["RL"]["gate"]
        self.assertFalse(g["pass"])
        self.assertEqual(g["checks"]["real_misses"]["weak"], ["rv-26-scope-h1"])
        self.assertTrue(g["checks"]["quiet_rate"]["ok"])
        self.assertFalse(g["checks"]["quiet_lo"]["ok"])  # 2 reviews: the lower bound is far below 0.75
        self.assertEqual(self.rv["gate"], sc.GATE)

    def test_gate_thresholds_are_parameters(self):
        runs = [sc.score_run(os.path.dirname(p)) for p in glob_runs(self.results)]
        loose = sc.aggregate(runs, gate={"lo": 0.1, "miss": 0.0, "false": 0.5, "unparsed": 0.5})["review"]
        self.assertTrue(loose["arms"]["RL"]["gate"]["pass"])
        self.assertEqual(loose["gate"]["rate"], 0.90)  # not overridden: the default stays
        strict = sc.aggregate(runs, gate={"rate": 1.1})["review"]
        self.assertFalse(strict["arms"]["RL"]["gate"]["checks"]["quiet_rate"]["ok"])

    def test_a_review_that_did_not_finish_is_left_out_and_counted(self):
        make_review(self.tmp, "rv-14-logic", self.logic, repeat=2, status="timeout", verdict=None, how="none")
        rv = sc.aggregate([sc.score_run(os.path.dirname(p)) for p in glob_runs(self.results)])["review"]
        self.assertEqual(rv["arms"]["RL"]["errors"], 1)
        self.assertEqual(rv["arms"]["RL"]["reviews"], 6)
        self.assertEqual(rv["arms"]["RL"]["unparsed"], 0)

    def test_cli_text_and_json(self):
        out = subprocess.run([sys.executable, SCRIPT, self.results], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        text = out.stdout
        self.assertTrue(text.startswith("== review eval: 9 reviews, 4 items, 2 arms"), text)
        self.assertIn("== per seed type", text)
        self.assertIn("rv-14-clean", text)
        self.assertIn("RL 2/3", text)
        self.assertIn("rv-14-logic, rv-26-scope-h1", text)
        self.assertIn("RL: FAIL (quiet_lo, real_misses", text)
        self.assertIn("[audit: valid]", text)
        self.assertNotIn("== hrd-eval", text)
        js = subprocess.run([sys.executable, SCRIPT, self.results, "--json", "--gate-rate", "0.5"], capture_output=True,
                            text=True)
        self.assertEqual(json.loads(js.stdout)["review"]["gate"]["rate"], 0.5)


def glob_runs(results):
    out = []
    for root, _, files in os.walk(results):
        if "run.json" in files:
            out.append(os.path.join(root, "run.json"))
    return out


class BuilderOutputUnchanged(unittest.TestCase):
    def test_no_review_key_without_review_runs(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        make_run(tmp, scenario(tmp))
        agg = sc.aggregate([sc.score_run(os.path.join(tmp, "results", "rep", "A", "r1"))])
        self.assertNotIn("review", agg)


if __name__ == "__main__":
    unittest.main()
