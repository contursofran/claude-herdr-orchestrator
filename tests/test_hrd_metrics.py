"""Fixture tests for scripts/hrd-metrics.py: one small coordinator, three workers and a plain session.

Every expected number below is worked out by hand from the timeline in build(); none is copied from
the script's output. Run: python3 -m unittest discover -s tests -p 'test_*.py'
"""

import argparse
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "hrd-metrics.py")
spec = importlib.util.spec_from_file_location("hrd_metrics", SCRIPT)
hm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hm)

DAY = 86400
OPUS, HAIKU, SONNET = "claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"
PREAMBLE = "The herdr-agents plugin sent a message:\n"


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def usage(inp=0, out=0, cr=0, cw5=0, cw1h=0):
    return {
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read_input_tokens": cr,
        "cache_creation_input_tokens": cw5 + cw1h,
        "cache_creation": {"ephemeral_5m_input_tokens": cw5, "ephemeral_1h_input_tokens": cw1h},
    }


def call(uid, name, **args):
    return {"type": "tool_use", "id": uid, "name": name, "input": args}


def text(s):
    return {"type": "text", "text": s}


class Transcript:
    """Writes records the way Claude Code does: one JSON object per line, no spaces."""

    def __init__(self, base, cwd):
        self.base, self.cwd, self.lines = base, cwd, []

    def _rec(self, off, kind, message, **extra):
        rec = {"type": kind, "timestamp": iso(self.base + off), "cwd": self.cwd, "message": message, **extra}
        self.lines.append(json.dumps(rec, separators=(",", ":")))

    def human(self, off, body):
        self._rec(off, "user", {"role": "user", "content": body}, origin={"kind": "human"})

    def herdr(self, off, name, profile, status, body, extra=""):
        body = f'{PREAMBLE}<herdr-agent name="{name}" profile="{profile}" status="{status}"{extra}>\n{body}\n</herdr-agent>'
        self._rec(off, "user", {"role": "user", "content": body}, origin={"kind": "plugin", "name": "herdr-agents"})

    def meta(self, off, body):
        self._rec(off, "user", {"role": "user", "content": [text(body)]}, isMeta=True)

    def assistant(self, off, mid, model, u, blocks):
        self._rec(off, "assistant", {"id": mid, "model": model, "role": "assistant", "content": blocks, "usage": u})

    def result(self, off, use_id, is_error=False):
        block = {"type": "tool_result", "tool_use_id": use_id, "content": "ok", "is_error": is_error}
        self._rec(off, "user", {"role": "user", "content": [block]})

    def write(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write("\n".join(self.lines) + "\n")


def set_mtime(path, t):
    os.utime(path, (t, t))


def build(tmp):
    """The fixture. Offsets are seconds after `base`, one hour before now."""
    base = int(time.time()) - 3600
    now = time.time()
    coord = os.path.join(tmp, "coord")  # the coordinator's cwd: no .herdr-agents here
    wt = os.path.join(tmp, "wt")  # the worktree workers are spawned in
    claude = os.path.join(tmp, "claude")
    proj = os.path.join(claude, "projects")

    # The coordinator. An old record (30 days back) comes first and must be ignored.
    c = Transcript(base, coord)
    c._rec(-30 * DAY, "user", {"role": "user", "content": "an old prompt"}, origin={"kind": "human"})
    c.assistant(-30 * DAY, "old", OPUS, usage(inp=5000), [text("old")])
    c.human(0, "go")
    c.assistant(10, "a1", OPUS, usage(inp=10, out=5), [call("s1", "mcp__herdr-agents__spawn", worker="b1", cwd=wt, profile="builder")])
    c.result(13, "s1")  # spawn s1 took 3 s
    c.assistant(14, "a2", OPUS, usage(inp=10, out=5), [call("s2", "mcp__herdr-agents__spawn", worker="b2", cwd=wt, profile="builder")])
    c.result(15, "s2")  # spawn s2 took 1 s
    # Report 1: a long one, so the prompt points at its file.
    pointer = f"[Full report, 24 lines: {wt}/.herdr-agents/b1/RESULT-aaaa1111.md. Read it before acting on it.]"
    c.herdr(100, "b1", "builder", "done", f"# Done\n{pointer}")
    c.assistant(101, "m1", OPUS, usage(inp=100, out=10, cr=1000, cw1h=200), [text("reading")])
    read = call("r1", "Read", file_path=f"{wt}/.herdr-agents/b1/RESULT-aaaa1111.md")
    c.assistant(103, "m2", OPUS, usage(inp=100, out=20, cr=1000, cw5=300), [read])
    c.meta(104, "[Image: source: /tmp/clip.png]")  # a context record, not a prompt: must not end the reaction
    c.result(105, "r1")
    c.assistant(106, "m3", OPUS, usage(inp=100, out=30, cr=1000), [text("ok")])
    c.assistant(106, "m3", OPUS, usage(inp=100, out=30, cr=1000), [call("g1", "mcp__herdr-agents__message", worker="b1", text="more")])
    c.result(107, "g1")
    c.assistant(108, "m3", OPUS, usage(inp=100, out=30, cr=1000), [call("b0", "Bash", command=f"head -3 {wt}/.herdr-agents/b1/RESULT-aaaa1111.md")])
    c.result(109, "b0")  # a second Bash read, in report 1 (already read by Read)
    c.assistant(110, "m4", HAIKU, usage(inp=200000, out=1000), [text("late")])  # above the 100k tier
    c.human(111, "thanks")
    # Report 2: a short one, sent whole.
    c.herdr(130, "b2", "builder", "done", "Done: all green.", extra=' sender="herdr-agents mod"')
    c.assistant(131, "n1", OPUS, usage(inp=10, out=10), [call("s3", "mcp__herdr-agents__spawn", worker="b3", cwd=wt, profile="builder")])
    c.result(133, "s3")  # spawn s3 took 2 s
    c.assistant(134, "n2", OPUS, usage(inp=10, out=5, cw1h=100), [call("e1", "Edit", file_path=f"{coord}/COORDINATOR-STATE.md")])
    c.result(135, "e1")
    c.assistant(136, "n2", OPUS, usage(inp=10, out=5, cw1h=100), [call("b1", "Bash", command=f"cat {wt}/.herdr-agents/b2/RESULT-bbbb2222.md | head -3")])
    c.result(137, "b1")  # a Bash read of RESULT: counted with the Read calls
    c.assistant(140, "k1", OPUS, usage(inp=10, out=5), [call("s4", "mcp__herdr-agents__spawn", worker="b4", cwd=wt, profile="builder")])
    c.result(141, "s4")  # spawn s4 took 1 s
    # Report 3: blocked, so no report file; a denied spawn follows.
    c.herdr(150, "b3", "builder", "blocked", "The worker is waiting at an approval or question in its herdr tab.")
    c.assistant(151, "ra", OPUS, usage(inp=20, out=10), [text("asking")])
    c.assistant(155, "rb", OPUS, usage(inp=20, out=10), [call("s5", "mcp__herdr-agents__spawn", worker="b5", cwd=wt, profile="builder")])
    c.result(155, "s5", is_error=True)  # a denied spawn: left out of the spawn times
    c.human(160, "ok")
    # Report 4: its worker's folder is gone (the worktree was pruned).
    c.herdr(170, "gone1", "builder", "done", "All done.")
    c.assistant(171, "p1", OPUS, usage(inp=30, out=10, cr=500), [text("noted")])
    c.assistant(172, "syn", "<synthetic>", usage(inp=999, out=999), [text("api error")])
    # Bash calls on RESULT files that are not reads: an in-place sed and a wc.
    c.assistant(173, "p1", OPUS, usage(inp=30, out=10, cr=500), [call("b2", "Bash", command=f"sed -i 's/x/y/' {wt}/.herdr-agents/b2/RESULT-bbbb2222.md && wc -l {wt}/.herdr-agents/gone1/RESULT.md")])
    c.result(174, "b2")
    c.human(180, "bye")
    c.write(os.path.join(proj, "-coord", "coord-1.jsonl"))

    # A coordinator 30 days old, its file touched 30 days ago: outside the window.
    old = Transcript(base - 30 * DAY, coord)
    old.herdr(0, "x", "builder", "done", "old report")
    old.write(os.path.join(proj, "-coord", "old-1.jsonl"))
    set_mtime(os.path.join(proj, "-coord", "old-1.jsonl"), now - 30 * DAY)
    # A copy of the coordinator whose file was last written 30 days ago: skipped without being read.
    stale = os.path.join(proj, "-stale", "stale-1.jsonl")
    os.makedirs(os.path.dirname(stale))
    shutil.copy(os.path.join(proj, "-coord", "coord-1.jsonl"), stale)
    set_mtime(stale, now - 30 * DAY)

    # Worker b1 (haiku), two records for one message.
    w1 = Transcript(base, wt)
    w1.human(0, f"Your task is in {wt}/.herdr-agents/b1/TASK.md. Read it and do it.")
    w1.assistant(5, "w1", HAIKU, usage(inp=500, out=300, cw1h=1000), [text("working")])
    w1.assistant(5, "w1", HAIKU, usage(inp=500, out=300, cw1h=1000), [text("more")])
    # Its RESULT.md writes, one API message's records: an older report's token, the token on line 2, the
    # real write (report 1's det: 98 - 95 = 3 s), then an Edit at 97 that keeps the marker. The earliest
    # write with the token on its first line is the one that counts.
    haiku1 = usage(inp=500, out=300, cw1h=1000)
    result1 = f"{wt}/.herdr-agents/b1/RESULT.md"
    w1.assistant(40, "w1", HAIKU, haiku1, [call("q0", "Write", file_path=result1, content="<!-- report 0ld00000 -->\nan older report\n")])
    w1.assistant(60, "w1", HAIKU, haiku1, [call("q1", "Write", file_path=result1, content="# Notes\n<!-- report aaaa1111 -->\n")])
    w1.assistant(95, "w1", HAIKU, haiku1, [call("q2", "Write", file_path=result1, content="<!-- report aaaa1111 -->\n# Done\n")])
    w1.assistant(97, "w1", HAIKU, haiku1, [call("q3", "Edit", file_path=result1, old_string="# Done", new_string="<!-- report aaaa1111 -->\n# Done, edited")])
    w1.write(os.path.join(proj, "-wt", "w1.jsonl"))
    # Worker b2 (sonnet). Its RESULT.md is a Bash heredoc: report 2's det is 129 - 127 = 2 s.
    w2 = Transcript(base, wt)
    w2.human(0, f"Your task is in {wt}/.herdr-agents/b2/TASK.md. Read it and do it.")
    sonnet2 = usage(inp=1000, out=100, cr=2000, cw5=500)
    w2.assistant(5, "x1", SONNET, sonnet2, [text("working")])
    w2.assistant(127, "x1", SONNET, sonnet2, [call("q4", "Bash", command=f"cat > {wt}/.herdr-agents/b2/RESULT.md <<'EOF'\n<!-- report bbbb2222 -->\nDone: all green.\nEOF")])
    w2.write(os.path.join(proj, "-wt", "w2.jsonl"))
    # Worker b9 (a model the script has no price for). Two writes that must not match report 1: another
    # worker's folder with the same token, and the same worker name under another cwd.
    w3 = Transcript(base, wt)
    w3.human(0, f"Your task is in {wt}/.herdr-agents/b9/TASK.md. Read it and do it.")
    w3.assistant(5, "y1", "claude-mystery-9", usage(inp=10, out=10), [text("working")])
    w3.assistant(40, "y1", "claude-mystery-9", usage(inp=10, out=10), [call("q5", "Write", file_path=f"{wt}/.herdr-agents/b7/RESULT.md", content="<!-- report aaaa1111 -->\nnot b1\n")])
    w3.assistant(42, "y1", "claude-mystery-9", usage(inp=10, out=10), [call("q6", "Write", file_path=f"{tmp}/other/.herdr-agents/b1/RESULT.md", content="<!-- report aaaa1111 -->\nanother cwd\n")])
    w3.write(os.path.join(proj, "-wt", "w3.jsonl"))

    # A plain session: its prompt only mentions the tag, so it is neither a coordinator nor a worker.
    p = Transcript(base, os.path.join(tmp, "plain"))
    p.human(0, "what does <herdr-agent> mean?")
    p.assistant(5, "pl", OPUS, usage(inp=1000, out=1000), [text("it is a tag")])
    p.write(os.path.join(proj, "-plain", "p.jsonl"))

    # Files of the worker folders.
    folder = lambda w: os.path.join(wt, ".herdr-agents", w)
    for w in ("b1", "b2", "b3", "b4"):
        os.makedirs(folder(w), exist_ok=True)
        with open(os.path.join(folder(w), "TASK.md"), "w") as fh:
            fh.write("task\n")
    with open(os.path.join(folder("b1"), "RESULT-aaaa1111.md"), "w") as fh:
        fh.write("<!-- report aaaa1111 -->\n# Done\n")
    set_mtime(os.path.join(folder("b1"), "RESULT-aaaa1111.md"), base + 98)
    with open(os.path.join(folder("b2"), "RESULT-bbbb2222.md"), "w") as fh:
        fh.write("<!-- report bbbb2222 -->\nDone: all green.\n")
    set_mtime(os.path.join(folder("b2"), "RESULT-bbbb2222.md"), base + 129)
    with open(os.path.join(folder("b3"), "SCREEN-cccc3333.txt"), "w") as fh:
        fh.write("the worker's screen\n")
    set_mtime(os.path.join(folder("b3"), "SCREEN-cccc3333.txt"), base + 200)
    with open(os.path.join(folder("b4"), "SCREEN-old0000.txt"), "w") as fh:
        fh.write("an old screen\n")
    set_mtime(os.path.join(folder("b4"), "SCREEN-old0000.txt"), now - 30 * DAY)
    return {"base": base, "coord": coord, "wt": wt, "claude": claude, "proj": proj, "since": now - 7 * DAY}


def scanned(paths):
    """The coordinator session, resolved the way main() does it: against every transcript in the fixture."""
    coords, _ = hm.collect(paths["proj"], paths["since"])
    return next(s for s in coords if s.sid == "coord-1")


class Fixtures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="hrd-metrics-test-")
        cls.paths = build(cls.tmp)
        cls.session = scanned(cls.paths)
        cls.r1, cls.r2, cls.r3, cls.r4 = cls.session.reports

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def at(self, off):
        return self.paths["base"] + off


class CoordinatorSession(Fixtures):
    def test_only_sessions_with_a_herdr_prompt_are_coordinators(self):
        plain = hm.scan(os.path.join(self.paths["proj"], "-plain", "p.jsonl"), self.paths["since"])
        self.assertEqual(plain.reports, [])
        self.assertIsNone(plain.worker)
        self.assertEqual(len(self.session.reports), 4)

    def test_records_before_the_window_are_ignored(self):
        self.assertEqual(self.session.start, self.at(0))
        self.assertEqual(self.session.tot["inp"], 200_000 + 420)  # the 5000-token old record is not in it

    def test_each_api_message_counts_once_even_when_split_into_records(self):
        self.assertEqual(self.session.tot["turns"], 12)  # m3 is two records, counted once; <synthetic> is not counted

    def test_tokens_and_cost_for_the_session(self):
        t = self.session.tot
        self.assertEqual((t["inp"], t["out"], t["cr"], t["cw"]), (200_420, 1_120, 3_500, 600))
        # opus: 420*4 + 120*20 + 3500*0.2 + 300*5 (5 min) + 300*8 (1 h), per million; haiku 200000 is above the tier.
        opus = (420 * 4 + 120 * 20 + 3500 * 0.2 + 300 * 5 + 300 * 8) / 1e6
        haiku = (200_000 * 0.5 + 1000 * 2.5) / 1e6
        self.assertAlmostEqual(t["cost"], opus + haiku, places=9)
        self.assertAlmostEqual(self.session.by_model[HAIKU]["cost"], haiku, places=9)

    def test_reads_and_state_edits_are_counted(self):
        self.assertEqual(self.session.read_calls, 1)  # the Read call in report 1
        self.assertEqual(self.session.bash_reads, 2)  # a head in report 1 and a cat | head in report 2; the sed -i and wc in report 4 are not reads
        self.assertEqual(self.session.edits, 1)
        self.assertTrue(self.r1.read)
        self.assertTrue(self.r2.read)  # read by Bash only
        self.assertFalse(self.r3.read)
        self.assertFalse(self.r4.read)

    def test_spawn_durations_leave_out_the_denied_spawn(self):
        self.assertEqual(sorted(self.session.spawn_secs), [1, 1, 2, 3])


class Reports(Fixtures):
    def test_turns_stop_at_the_first_spawn_message_or_stop_call(self):
        self.assertEqual(len(self.r1.turns), 3)  # m1, m2, and m3 (the turn that makes the message call)
        self.assertEqual(len(self.r2.turns), 1)  # n1 makes the spawn call; n2 and k1 come after it
        self.assertEqual(len(self.r3.turns), 2)  # ra, and rb (the denied spawn still ends the window)
        self.assertEqual(len(self.r4.turns), 1)  # p1; the <synthetic> message is not a turn

    def test_action_is_the_first_boundary_call(self):
        self.assertEqual(self.r1.action, ("mcp__herdr-agents__message", self.at(106)))
        self.assertEqual(self.r2.action, ("mcp__herdr-agents__spawn", self.at(131)))
        self.assertIsNone(self.r4.action)

    def test_reaction_runs_to_the_next_user_prompt_and_meta_records_do_not_end_it(self):
        # m1..m3 and m4 (haiku at 110) are in report 1's reaction; the context record at 104 does not end it.
        self.assertEqual(self.r1.tot["turns"], 4)
        m1 = (100 * 4 + 10 * 20 + 1000 * 0.2 + 200 * 8) / 1e6
        m2 = (100 * 4 + 20 * 20 + 1000 * 0.2 + 300 * 5) / 1e6
        m3 = (100 * 4 + 30 * 20 + 1000 * 0.2) / 1e6
        m4 = (200_000 * 0.5 + 1000 * 2.5) / 1e6
        self.assertAlmostEqual(self.r1.tot["cost"], m1 + m2 + m3 + m4, places=9)
        self.assertEqual(self.r2.tot["turns"], 3)  # n1, n2, k1 before report 3's prompt
        self.assertAlmostEqual(self.r4.tot["cost"], (30 * 4 + 10 * 20 + 500 * 0.2) / 1e6, places=9)

    def test_a_pointer_report_is_joined_by_its_token(self):
        self.assertTrue(self.r1.pointer)
        self.assertEqual(self.r1.token, "aaaa1111")
        self.assertEqual((self.r1.queue, self.r1.queue_how), (2.0, "token"))  # RESULT-aaaa1111.md at 98, prompt at 100

    def test_a_short_report_is_joined_by_its_text(self):
        self.assertFalse(self.r2.pointer)
        self.assertEqual(self.r2.token, "bbbb2222")  # the token comes from the file the text matched
        self.assertEqual((self.r2.queue, self.r2.queue_how), (1.0, "text"))  # RESULT-bbbb2222.md at 129, prompt at 130

    def test_det_runs_from_the_worker_write_to_the_report_file(self):
        self.assertEqual(self.r1.det, 3.0)  # written at 95 (the earliest first-line write with the token), file at 98
        self.assertEqual(self.r2.det, 2.0)  # a Bash heredoc in worker b2's transcript at 127, file at 129

    def test_a_report_without_a_file_or_folder_says_why_it_has_no_queue(self):
        self.assertIsNone(self.r3.queue)
        self.assertEqual(self.r3.queue_miss, "no report file")  # the folder exists, its RESULT file does not
        self.assertIsNone(self.r3.det)
        self.assertIsNone(self.r4.queue)
        self.assertEqual(self.r4.queue_miss, "folder gone")
        self.assertIsNone(self.r4.det)

    def test_quiet_stops_count_screen_files_in_the_window_only(self):
        self.assertEqual(self.session.quiet, 1)  # b3's file; b4's is 30 days old


class Totals(Fixtures):
    def test_the_json_totals(self):
        out = self.run_json()
        self.assertEqual(len(out["coordinators"]), 1)
        t = out["totals"]
        self.assertEqual(t["reports"], 4)
        self.assertEqual(t["turns"]["median"], 1.5)  # [3, 1, 2, 1]
        self.assertEqual((t["read_share"], t["pointer_share"]), (0.5, 0.25))  # reports 1 and 2 were read
        self.assertEqual(t["reads"], {"read": 1, "bash": 2})
        self.assertEqual(t["edits_per_report"], 0.25)
        self.assertEqual(t["det"], {"n": 2, "median": 2.5, "p90": 3.0, "max": 3.0})  # [3, 2]
        self.assertEqual(t["det_est"], {"n": 0, "median": None, "p90": None, "max": None})  # no pointer report lost its queue here
        self.assertEqual(t["det_missing"], {"no report file": 1, "folder gone": 1})
        self.assertEqual(t["queue"], {"n": 2, "median": 1.5, "p90": 2.0, "max": 2.0})  # [2, 1]
        self.assertEqual(t["queue_by"], {"token": 1, "text": 1, "missing": {"no report file": 1, "folder gone": 1}})
        self.assertEqual(t["action"], {"n": 3, "median": 5, "p90": 6, "max": 6})  # 6, 1, 5
        self.assertEqual(t["spawn"], {"n": 4, "median": 1.5, "max": 3, "p90": 3})
        self.assertEqual(t["spawn_lead"], {"n": 4, "median": 1, "max": 2, "p90": 2})  # [1, 1, 1, 2]
        self.assertEqual((t["wt_calls"], t["wt_per_spawn"], t["branch_share"], t["start_failed"]), (0, 0.0, 0.0, 0))
        self.assertEqual(t["quiet"], 1)

    def test_worker_sessions_are_grouped_by_model(self):
        out = self.run_json()
        self.assertEqual(out["workers"]["sessions"], 3)
        by = out["workers"]["by_model"]
        self.assertEqual(by[HAIKU]["sessions"], 1)
        self.assertAlmostEqual(by[HAIKU]["cost"], (500 * 0.1 + 300 * 0.5 + 1000 * 0.2) / 1e6, places=9)
        self.assertAlmostEqual(by[SONNET]["cost"], (1000 * 2 + 100 * 10 + 2000 * 0.1 + 500 * 2.5) / 1e6, places=9)
        self.assertEqual(by["claude-mystery-9"]["cost"], 0.0)
        self.assertEqual(out["unpriced"], ["claude-mystery-9"])

    def test_the_text_table_has_the_totals_and_the_det_and_queue_lines(self):
        text_out = self.run_text()
        self.assertIn("== coordinator sessions, last 7 days: 1 with 4 reports", text_out)
        self.assertIn("det med  p90  max  queue med  p90  max", text_out)  # the two columns, det first
        self.assertIn("det found for 2 of 4 reports; the rest: 1 no report file, 1 folder gone", text_out)
        self.assertIn("queue found for 2 of 4 reports (by token 1, by text 1); the rest: 1 no report file, 1 folder gone", text_out)
        self.assertIn("reads of RESULT files: 1 Read calls and 2 Bash reads", text_out)
        self.assertIn("no price for claude-mystery-9", text_out)
        self.assertIn("det s: the worker's earliest RESULT.md write", text_out)

    def test_no_transcripts_in_the_window_prints_none(self):
        self.assertIn("none: no transcript in the window", self.run_text(days=0))

    def test_with_no_arguments_the_window_is_the_last_7_days(self):
        self.assertIn("== coordinator sessions, last 7 days: 1 with 4 reports", self.run_script([]))

    def test_since_sets_the_header_and_a_window_after_every_transcript_prints_none(self):
        text_out = self.run_script(["--since", "2100-01-01 00:00"])
        self.assertIn("== coordinator sessions, since 2100-01-01 00:00: 0 with 0 reports", text_out)
        self.assertIn("none: no transcript in the window", text_out)

    def test_days_and_since_together_use_the_later_start(self):
        # --since 2000 is older than 7 days, so the 7 days decide: the same coordinator as with --days alone.
        self.assertIn("1 with 4 reports", self.run_script(["--days", "7", "--since", "2000-01-01 00:00"]))
        # --days 0 starts now, which is later than --since 2000: nothing is in the window.
        self.assertIn("none: no transcript in the window", self.run_script(["--days", "0", "--since", "2000-01-01 00:00"]))

    def test_a_since_in_another_format_is_a_usage_error(self):
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.paths["claude"])
        proc = subprocess.run([sys.executable, SCRIPT, "--since", "2026-10-24T11:53"], capture_output=True, text=True, env=env)
        self.assertEqual(proc.returncode, 2)
        self.assertIn('expected YYYY-MM-DD HH:MM (local time), got', proc.stderr)

    def run_json(self):
        return json.loads(self.run_script(["--json"]))

    def run_text(self, days=7):
        return self.run_script(["--days", str(days)])

    def run_script(self, args):
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.paths["claude"])
        proc = subprocess.run([sys.executable, SCRIPT] + args, capture_output=True, text=True, env=env, check=True)
        return proc.stdout


class Window(unittest.TestCase):
    def test_since_is_local_time_to_the_minute(self):
        self.assertEqual(hm.since_arg("2026-10-24 11:53"), datetime(2026, 10, 24, 11, 53).timestamp())

    def test_since_rejects_any_other_format(self):
        for bad in ("2026-10-24T11:53", "2026-10-24", "2026-13-01 00:00", "24/10/2026 11:53"):
            with self.assertRaises(argparse.ArgumentTypeError, msg=bad):
                hm.since_arg(bad)

    def test_the_window_starts_at_the_later_of_days_and_since(self):
        now, day = 1_800_000_000.0, 86400
        self.assertEqual(hm.window_start(7, None, now), now - 7 * day)
        self.assertEqual(hm.window_start(None, now - 3 * day, now), now - 3 * day)
        self.assertEqual(hm.window_start(1, now - 3 * day, now), now - day)  # --days is the later start
        self.assertEqual(hm.window_start(1, now - day / 2, now), now - day / 2)  # --since is the later start
        self.assertEqual(hm.window_start(None, None, now), now - 7 * day)  # neither: the default 7 days
        self.assertEqual(hm.window_start(0, None, now), now)


class SinceCut(Fixtures):
    """--since: a report counts when its prompt is at or after the cut, whatever its session's start."""

    def cut(self, off):
        coords, _ = hm.collect(self.paths["proj"], self.at(off))
        return next(s for s in coords if s.sid == "coord-1")

    def test_a_report_before_the_cut_is_left_out_though_its_session_started_earlier(self):
        s = self.cut(131)  # report 2 is at 130, report 3 at 150, report 4 at 170
        self.assertEqual([r.ts for r in s.reports], [self.at(150), self.at(170)])
        self.assertEqual(s.start, self.at(131))  # the session's first record in the window, not its first ever

    def test_a_prompt_exactly_at_the_cut_counts(self):
        self.assertEqual([r.ts for r in self.cut(130).reports], [self.at(130), self.at(150), self.at(170)])

    def test_turns_and_cost_count_from_the_cut(self):
        t = self.cut(120).tot  # records from 130 on: n1, n2, k1, ra, rb, p1 (the <synthetic> one is not counted)
        self.assertEqual(t["turns"], 6)
        self.assertEqual((t["inp"], t["out"], t["cr"], t["cw"]), (100, 50, 500, 100))
        # opus, per request in micro-dollars: n1 240, n2 940 (1 h cache write), k1 140, ra 280, rb 280, p1 420
        self.assertAlmostEqual(t["cost"], 2300 / 1e6, places=12)


class DetEstimate(unittest.TestCase):
    """det_est: with no queue lag (the folder is gone, or the token file is missing), the prompt minus the worker's write."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hrd-det-est-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_gone_folder_takes_the_prompt_minus_the_worker_write(self):
        s, folder = gone_report(self.tmp)  # the prompt at 1000
        hm.resolve(s, 0, {(folder, "cafe0001"): 990.0})
        r = s.reports[0]
        self.assertIsNone(r.queue)
        self.assertEqual(r.queue_miss, "folder gone")
        self.assertIsNone(r.det)
        self.assertEqual(r.det_est, 10.0)
        self.assertEqual(hm.det_missing([r]), {})

    def test_a_gone_folder_uses_the_archived_report_file(self):
        s, folder = gone_report(self.tmp)  # the prompt at 1000
        reports = os.path.join(self.tmp, "reports")
        copy = os.path.join(reports, folder.lstrip("/"))
        os.makedirs(copy)
        path = os.path.join(copy, "RESULT-cafe0001.md")
        with open(path, "w") as fh:
            fh.write("<!-- report cafe0001 -->\nDone.\n")
        set_mtime(path, 995.0)
        hm.resolve(s, 0, {(folder, "cafe0001"): 990.0}, reports)
        r = s.reports[0]
        self.assertEqual((r.queue, r.queue_how), (5.0, "token"))
        self.assertEqual(r.det, 5.0)
        self.assertIsNone(r.det_est)
        self.assertIsNone(r.queue_miss)

    def test_a_gone_folder_without_an_archive_still_says_folder_gone(self):
        s, folder = gone_report(self.tmp)
        reports = os.path.join(self.tmp, "reports")
        os.makedirs(reports)  # an archive with nothing for this worker
        hm.resolve(s, 0, {(folder, "cafe0001"): 990.0}, reports)
        r = s.reports[0]
        self.assertEqual(r.queue_miss, "folder gone")
        self.assertEqual(r.det_est, 10.0)

    def test_a_missing_token_file_takes_the_same_estimate(self):
        s, folder = gone_report(self.tmp)
        os.makedirs(folder)  # the folder is there, the RESULT file is not
        hm.resolve(s, 0, {(folder, "cafe0001"): 990.0})
        self.assertEqual(s.reports[0].queue_miss, "token file missing")
        self.assertEqual(s.reports[0].det_est, 10.0)

    def test_a_present_file_keeps_its_exact_det_and_no_estimate(self):
        s, folder = gone_report(self.tmp)
        os.makedirs(folder)
        path = os.path.join(folder, "RESULT-cafe0001.md")
        with open(path, "w") as fh:
            fh.write("<!-- report cafe0001 -->\nDone.\n")
        set_mtime(path, 990.0)  # delivered 10 s before the prompt; written 3 s before that
        hm.resolve(s, 0, {(folder, "cafe0001"): 987.0})
        r = s.reports[0]
        self.assertEqual((r.queue, r.det), (10.0, 3.0))
        self.assertIsNone(r.det_est)

    def test_without_a_write_there_is_no_estimate_and_the_reason_is_no_worker_write(self):
        s, _ = gone_report(self.tmp)
        hm.resolve(s, 0, {})
        self.assertIsNone(s.reports[0].det_est)
        self.assertEqual(hm.det_missing(s.reports), {"no worker write": 1})

    def test_a_short_report_has_no_token_to_match_so_no_estimate(self):
        s, folder = gone_report(self.tmp, body="Done: all green.")
        hm.resolve(s, 0, {(folder, "cafe0001"): 990.0})
        r = s.reports[0]
        self.assertIsNone(r.token)
        self.assertIsNone(r.det_est)
        self.assertEqual(hm.det_missing([r]), {"folder gone": 1})

    def test_a_write_of_another_token_or_folder_is_not_this_report(self):
        s, folder = gone_report(self.tmp)
        hm.resolve(s, 0, {(folder, "other000"): 990.0, (folder + "x", "cafe0001"): 990.0})
        self.assertIsNone(s.reports[0].det_est)

    def test_the_transcripts_of_a_gone_worker_give_the_estimate(self):
        base = 1_790_000_000
        wt = os.path.join(self.tmp, "wt")  # the worktree was pruned: never created
        proj = os.path.join(self.tmp, "claude", "projects")
        c = Transcript(base, os.path.join(self.tmp, "coord"))
        c.assistant(10, "a1", OPUS, usage(inp=1), [call("s1", hm.SPAWN, worker="b7", cwd=wt, profile="builder")])
        c.herdr(100, "b7", "builder", "done", f"[Full report, 3 lines: {wt}/.herdr-agents/b7/RESULT-tok777.md. Read it before acting on it.]")
        c.write(os.path.join(proj, "-coord", "coord-1.jsonl"))
        w = Transcript(base, wt)
        w.human(0, f"Your task is in {wt}/.herdr-agents/b7/TASK.md. Read it and do it.")
        w.assistant(50, "w1", SONNET, usage(inp=1), [call("q1", "Write", file_path=f"{wt}/.herdr-agents/b7/RESULT.md", content="<!-- report tok777 -->\n# Done\n")])
        w.write(os.path.join(proj, "-wt", "w1.jsonl"))
        coords, workers = hm.collect(proj, base - 10)
        r = next(s for s in coords if s.sid == "coord-1").reports[0]
        self.assertEqual((r.ts, r.token, r.queue_miss), (base + 100, "tok777", "folder gone"))
        self.assertEqual(r.det_est, 50.0)  # written at 50, prompted at 100
        self.assertIsNone(r.det)
        self.assertEqual(len(workers), 1)

    def test_the_footer_counts_the_estimates_and_says_the_queue_lag_is_in_them(self):
        s, folder = gone_report(self.tmp)
        s.start = 1000.0
        hm.resolve(s, 0, {(folder, "cafe0001"): 990.0})
        rows = [hm.coordinator_row(s)]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            hm.print_text("since 2026-10-24 11:53", rows, hm.totals(rows, [s]), [], {}, set(), "/x")
        text_out = out.getvalue()
        self.assertIn("== coordinator sessions, since 2026-10-24 11:53: 1 with 1 reports", text_out)
        self.assertIn("== det found for 0 of 1 reports; prompt minus write, no queue lag known, for 1 more "
                      "(median 10 s, p90 10 s, max 10 s; queue lag included); the rest: none", text_out)
        self.assertIn("det s: the worker's earliest RESULT.md write", text_out)


def gone_report(tmp, body=None):
    """A report at 1000 from worker b1 whose folder is gone (its worktree was pruned). Its prompt is a pointer by default."""
    wt = os.path.join(tmp, "wt")  # never created
    folder = os.path.join(wt, ".herdr-agents", "b1")
    if body is None:
        body = f"[Full report, 9 lines: {folder}/RESULT-cafe0001.md. Read it before acting on it.]"
    s = hm.Session(os.path.join(tmp, "s.jsonl"))
    s.cwd = tmp
    s.spawn_cwd["b1"] = wt
    prompt = PREAMBLE + f'<herdr-agent name="b1" profile="builder" status="done">\n{body}\n</herdr-agent>'
    s.report(1000.0, hm.PROMPT_TAG.match(prompt), prompt)
    return s, folder


class Join(unittest.TestCase):
    def one_report(self, tmp, file_mtime=None):
        """A session with one pointer report from worker b1 (token cafe0001) whose RESULT file is written at file_mtime."""
        wt = os.path.join(tmp, "wt")
        folder = os.path.join(wt, ".herdr-agents", "b1")
        os.makedirs(folder, exist_ok=True)  # the folder is there
        if file_mtime is not None:
            path = os.path.join(folder, "RESULT-cafe0001.md")
            with open(path, "w") as fh:
                fh.write("<!-- report cafe0001 -->\nDone.\n")
            set_mtime(path, file_mtime)
        s = hm.Session(os.path.join(tmp, "s.jsonl"))
        s.cwd = tmp
        s.spawn_cwd["b1"] = wt
        body = f"[Full report, 9 lines: {wt}/.herdr-agents/b1/RESULT-cafe0001.md. Read it before acting on it.]"
        prompt = PREAMBLE + f'<herdr-agent name="b1" profile="builder" status="done">\n{body}\n</herdr-agent>'
        s.report(1000.0, hm.PROMPT_TAG.match(prompt), prompt)
        return s, wt

    def test_a_pointer_whose_file_is_gone_says_so(self):
        tmp = tempfile.mkdtemp(prefix="hrd-join-test-")
        try:
            s, _ = self.one_report(tmp)  # the report file is not there
            hm.resolve(s, 0, {})
            r = s.reports[0]
            self.assertEqual(r.token, "cafe0001")
            self.assertIsNone(r.queue)
            self.assertEqual(r.queue_miss, "token file missing")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_det_needs_a_worker_write_in_the_same_folder_with_the_same_token(self):
        tmp = tempfile.mkdtemp(prefix="hrd-det-test-")
        try:
            s, wt = self.one_report(tmp, file_mtime=1000.0 - 10)  # delivered 10 s before the prompt
            folder = os.path.join(wt, ".herdr-agents", "b1")
            hm.resolve(s, 0, {})  # no worker write at all
            r = s.reports[0]
            self.assertEqual(r.queue, 10.0)
            self.assertIsNone(r.det)
            self.assertEqual(hm.det_missing([r]), {"no worker write": 1})

            s, _ = self.one_report(tmp, file_mtime=1000.0 - 10)
            hm.resolve(s, 0, {(folder, "cafe0001"): 1000.0 - 13})
            self.assertEqual(s.reports[0].det, 3.0)  # written 13 s before the prompt, delivered 10 s before it

            s, _ = self.one_report(tmp, file_mtime=1000.0 - 10)
            hm.resolve(s, 0, {(folder, "other000"): 1000.0 - 13, (folder + "x", "cafe0001"): 1000.0 - 13})
            self.assertIsNone(s.reports[0].det)  # another token, or another folder: not this report's write
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class SpawnLead(unittest.TestCase):
    """spawn_lead, wt_calls, branch_share and start_failed on a small hand-written coordinator."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hrd-metrics-lead-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        base = int(time.time()) - 3600
        spawn = "mcp__herdr-agents__spawn"
        c = Transcript(base, self.tmp)
        c.human(0, "go")
        # Spawn 1: a worktree turn, then the spawn turn: lead 2, one git call.
        c.assistant(1, "w1", OPUS, usage(inp=1), [call("g1", "Bash", command="git fetch origin && git worktree add ../wt -b x origin/main")])
        c.result(2, "g1")
        c.assistant(3, "w2", OPUS, usage(inp=1), [call("s1", spawn, worker="b1", cwd="/wt", profile="builder", task="t")])
        c.result(4, "s1")
        # Spawn 2: the previous spawn's result is the boundary; one turn, `branch`, no Bash: lead 1.
        c.assistant(5, "w3", OPUS, usage(inp=1), [call("s2", spawn, worker="b2", branch="b2", profile="builder", task="t")])
        c.result(6, "s2")
        # A denied spawn counts nowhere; a message resets the boundary.
        c.assistant(7, "w4", OPUS, usage(inp=1), [call("s3", spawn, worker="b3", branch="b3", profile="builder", task="t")])
        c.result(7, "s3", is_error=True)
        c.assistant(8, "w5", OPUS, usage(inp=1), [call("m1", "mcp__herdr-agents__message", worker="b1", text="hi")])
        c.result(9, "m1")
        # Spawn 3 after a new prompt: two turns since the prompt, a non-git Bash call among them.
        c.herdr(20, "b1", "builder", "failed", "The worker did not start: boom. Its tab was closed.")
        c.herdr(21, "b2", "builder", "failed", "Something else failed.")
        c.herdr(22, "b3", "builder", "done", "The worker did not start is only a quote.")
        c.assistant(23, "w6", OPUS, usage(inp=1), [call("l1", "Bash", command="ls")])
        c.result(24, "l1")
        c.assistant(25, "w7", OPUS, usage(inp=1), [call("s4", spawn, worker="b4", cwd="/wt", profile="builder", task="t")])
        c.result(26, "s4")
        self.path = os.path.join(self.tmp, "c.jsonl")
        c.write(self.path)
        self.session = hm.scan(self.path, base - 10)

    def test_lead_counts_turns_since_the_previous_boundary(self):
        self.assertEqual(self.session.spawn_lead, [2, 1, 2])  # s3 was denied and is left out

    def test_worktree_calls_and_branch_share(self):
        self.assertEqual(self.session.wt_calls, 1)  # the ls is not one
        row = hm.coordinator_row(self.session)
        self.assertEqual(row["wt_calls"], 1)
        self.assertAlmostEqual(row["wt_per_spawn"], 1 / 3)
        self.assertAlmostEqual(row["branch_share"], 1 / 3)
        self.assertEqual(row["spawn_lead"]["median"], 2)

    def test_only_a_failed_report_that_says_the_worker_did_not_start_counts(self):
        self.assertEqual(self.session.start_failed, 1)
        self.assertEqual(hm.totals([hm.coordinator_row(self.session)], [self.session])["start_failed"], 1)

    def test_no_spawns_give_no_ratios(self):
        s = hm.Session(self.path)
        row = hm.coordinator_row(s)
        self.assertEqual((row["wt_per_spawn"], row["branch_share"], row["spawn_lead"]["n"]), (None, None, 0))


class StateWritesAndBatches(unittest.TestCase):
    """Items from #71: Bash writes to the state file, git fetch counting, several blocks in one prompt."""

    def scan_commands(self, commands):
        tmp = tempfile.mkdtemp(prefix="hrd-metrics-bash-")
        self.addCleanup(shutil.rmtree, tmp, True)
        base = int(time.time()) - 3600
        c = Transcript(base, tmp)
        c.herdr(0, "b1", "builder", "done", "ok")
        for i, cmd in enumerate(commands):
            c.assistant(1 + i, f"x{i}", OPUS, usage(inp=1), [call(f"c{i}", "Bash", command=cmd)])
            c.result(1 + i, f"c{i}")
        path = os.path.join(tmp, "c.jsonl")
        c.write(path)
        return hm.scan(path, base - 10)

    def test_bash_writes_to_the_state_file_count_as_edits(self):
        writes = [
            "sed -i 's/a/b/' COORDINATOR-STATE.md",
            "sed -i.bak 's/a/b/' /x/COORDINATOR-STATE.md",
            "echo hi >> /x/COORDINATOR-STATE.md",
            "cat > COORDINATOR-STATE.md <<'EOF'\nbody\nEOF",
            "echo hi | tee -a COORDINATOR-STATE.md",
            "python3 -c \"open('/x/COORDINATOR-STATE.md', 'w').write('x')\"",
            "python3 - <<'EOF'\nfrom pathlib import Path\nPath('COORDINATOR-STATE.md').write_text('x')\nEOF",
        ]
        self.assertEqual(self.scan_commands(writes).edits, len(writes))

    def test_bash_reads_of_the_state_file_are_not_edits(self):
        reads = [
            "cat COORDINATOR-STATE.md",
            "grep x COORDINATOR-STATE.md > /tmp/out",
            "sed -n 1,5p COORDINATOR-STATE.md",
            "python3 -c \"open('COORDINATOR-STATE.md').read()\"",
            "sed -i 's/a/b/' other.md",
            "ls",
        ]
        self.assertEqual(self.scan_commands(reads).edits, 0)

    def test_a_fetch_counts_only_right_before_a_worktree_add(self):
        s = self.scan_commands(["git fetch origin", "ls", "git fetch origin main"])
        self.assertEqual(s.wt_calls, 0)  # no worktree add follows
        s = self.scan_commands(["git fetch origin", "git worktree add ../wt -b x origin/main"])
        self.assertEqual(s.wt_calls, 2)
        s = self.scan_commands(["git fetch origin", "ls", "git worktree add ../wt -b x origin/main"])
        self.assertEqual(s.wt_calls, 1)  # the ls came between
        s = self.scan_commands(["git -C /r fetch origin && git -C /r worktree add ../wt"])
        self.assertEqual(s.wt_calls, 1)

    def test_every_block_in_a_prompt_is_a_report(self):
        tmp = tempfile.mkdtemp(prefix="hrd-metrics-batch-")
        self.addCleanup(shutil.rmtree, tmp, True)
        base = int(time.time()) - 3600
        c = Transcript(base, tmp)
        c.herdr(0, "b1", "builder", "done", "first")
        batch = f'{PREAMBLE}<herdr-agent name="b2" profile="builder" status="done">\nsecond\n</herdr-agent>\n\n'
        batch += '<herdr-agent name="b3" profile="builder" status="failed">\nThe worker did not start: boom.\n</herdr-agent>\n'
        batch += 'quoted <herdr-agent name="b4" status="done"> inside text'
        c._rec(5, "user", {"role": "user", "content": batch}, origin={"kind": "plugin", "name": "herdr-agents"})
        path = os.path.join(tmp, "c.jsonl")
        c.write(path)
        s = hm.scan(path, base - 10)
        self.assertEqual(len(s.reports), 3)  # the quote in the text is not a block
        self.assertEqual(s.start_failed, 1)


class Units(unittest.TestCase):
    def test_the_price_uses_the_one_hour_cache_write_rate(self):
        self.assertAlmostEqual(hm.price(OPUS, hm.usage({"usage": usage(cw1h=1_000_000)})), 8.0)
        self.assertAlmostEqual(hm.price(OPUS, hm.usage({"usage": usage(cw5=1_000_000)})), 5.0)

    def test_haiku_switches_to_its_tier_above_100k_prompt_tokens(self):
        small = hm.usage({"usage": usage(inp=100_000)})
        big = hm.usage({"usage": usage(inp=100_001)})
        self.assertAlmostEqual(hm.price(HAIKU, small), 100_000 * 0.1 / 1e6)
        self.assertAlmostEqual(hm.price(HAIKU, big), 100_001 * 0.5 / 1e6)

    def test_an_unknown_model_has_no_price(self):
        self.assertIsNone(hm.price("claude-mystery-9", hm.usage({"usage": usage(inp=1)})))

    def test_the_epoch_reads_the_z_suffix_and_milliseconds(self):
        self.assertAlmostEqual(hm.epoch("2026-10-23T16:37:06.190Z"), 1792773426.19, places=6)

    def test_p90_is_nearest_rank_and_empty_lists_give_none(self):
        self.assertEqual(hm.dist(list(range(1, 11))), {"n": 10, "median": 5.5, "p90": 9, "max": 10})
        self.assertEqual(hm.dist([])["median"], None)

    def test_the_pointer_wording_must_carry_a_token(self):
        long = "[Full report, 24 lines: /x/.herdr-agents/b1/RESULT-0a1b2c3d.md. Read it before acting on it.]"
        cut = "[Report cut to its summary. Full report (3971 chars): /x/RESULT-9f8e7d6c.md]"
        self.assertEqual(hm.POINTER.search(long).group(1), "0a1b2c3d")
        self.assertEqual(hm.POINTER.search(cut).group(1), "9f8e7d6c")
        self.assertIsNone(hm.POINTER.search("[see RESULT-0a1b2c3d.md for details]"))  # no pointer wording

    def test_the_tag_takes_any_attributes_after_status(self):
        m = hm.PROMPT_TAG.match(PREAMBLE + '<herdr-agent name="b1" profile="builder" status="done" sender="x">\nbody')
        self.assertIsNotNone(m)
        self.assertEqual(dict(hm.ATTR.findall(m.group(1))), {"name": "b1", "profile": "builder", "status": "done", "sender": "x"})
        self.assertIsNone(hm.PROMPT_TAG.match("Please explain <herdr-agent> to me"))


class ResultFiles(unittest.TestCase):
    """Bash reads and writes of RESULT files, and the Edit write, one case each."""

    def test_a_bash_command_that_reads_a_result_file_is_a_read(self):
        reads = [
            "cat /w/.herdr-agents/b1/RESULT-aaaa1111.md",
            "head -5 RESULT.md",
            "tail -n 3 RESULT.md",
            "sed -n '1,20p' RESULT.md",
            "less RESULT.md",
            "/bin/cat RESULT.md",
            "cd /w/.herdr-agents/b1 && cat RESULT.md",
            "cat RESULT-x1.md | head -2",
            "cat RESULT.md > /tmp/copy.md",
            'D=/w/.herdr-agents/b1; sed -n 1p "$D/RESULT.md"',
        ]
        for cmd in reads:
            self.assertTrue(hm.bash_reads(cmd), cmd)

    def test_a_bash_command_that_writes_or_names_a_result_file_is_not_a_read(self):
        not_reads = [
            "cat > RESULT.md <<'EOF'\n<!-- report x1 -->\nEOF",  # a write
            "cat > /w/.herdr-agents/b1/RESULT.md",
            "sed -i 's/a/b/' RESULT.md",  # an in-place edit
            "sed -ni 's/a/b/p' RESULT.md",
            "tee RESULT.md",
            "wc -l RESULT.md",
            "grep -n x RESULT.md",
            "cat README.md",
            'echo "cat RESULT.md"',
            "ls RESULT.md; cat other.md",
        ]
        for cmd in not_reads:
            self.assertFalse(hm.bash_reads(cmd), cmd)

    def test_a_bash_heredoc_write_gives_its_folder_and_the_token_on_its_first_line(self):
        cases = [
            # (command, cwd of the record, expected (folder, token) list)
            ("cat > /w/.herdr-agents/b1/RESULT.md <<'EOF'\n<!-- report t1 -->\nbody\nEOF", "/x", [("/w/.herdr-agents/b1", "t1")]),
            ("cat > .herdr-agents/b2/RESULT.md <<'EOF'\n<!-- report t2 -->\nEOF", "/w", [("/w/.herdr-agents/b2", "t2")]),
            ("cd /w/.herdr-agents/b3 && cat > RESULT.md <<'EOF'\n<!-- report t3 -->\nEOF", "/x", [("/w/.herdr-agents/b3", "t3")]),
            ("D=/w/.herdr-agents/b4; cat > $D/RESULT.md <<'EOF'\n<!-- report t4 -->\nEOF", "/x", [("/w/.herdr-agents/b4", "t4")]),
            ("D=/w/.herdr-agents/b5; { cat <<'EOF'\n<!-- report t5 -->\nbody\nEOF\n} > $D/RESULT.md", "/x", [("/w/.herdr-agents/b5", "t5")]),
            (
                "cat > /w/.herdr-agents/b6/PLAN.md <<'EOF'\n# plan\nEOF\ncat > /w/.herdr-agents/b6/RESULT.md <<'EOF'\n<!-- report t6 -->\nEOF",
                "/x",
                [("/w/.herdr-agents/b6", "t6")],  # the plan's heredoc has no token; the report's does
            ),
            (
                "cat > /w/.herdr-agents/b6/PLAN.md <<'EOF'\n<!-- report planX -->\n# plan\nEOF\ncat > /w/.herdr-agents/b6/RESULT.md <<'EOF'\n<!-- report t6 -->\nEOF",
                "/x",
                [("/w/.herdr-agents/b6", "t6")],  # a redirect takes the token of the heredoc after it, not the earlier one's
            ),
            ("printf '%s\\n' '<!-- report t8 -->' 'body' > /w/.herdr-agents/b8/RESULT.md", "/x", [("/w/.herdr-agents/b8", "t8")]),
            # Not a write this metric counts:
            ("cat > /w/.herdr-agents/b7/RESULT.md <<'EOF'\n# x\n<!-- report t7 -->\nEOF", "/x", []),  # the token is not on the first line
            ("cat > /w/RESULT.md <<'EOF'\n<!-- report t9 -->\nEOF", "/x", []),  # not in a worker's .herdr-agents folder
            ("cat > /w/.herdr-agents/b1/RESULT-t9.md <<'EOF'\n<!-- report t9 -->\nEOF", "/x", []),  # not RESULT.md
            ("cat /w/.herdr-agents/b1/RESULT.md; echo '<!-- report t10 -->'", "/x", []),  # a read
            ("cat > /w/.herdr-agents/b1/RESULT.md <<'EOF'\nno marker here\nEOF", "/x", []),  # no token
            ("cat > /w/.herdr-agents/b1/PLAN.md <<'EOF'\n<!-- report t11 -->\nsee RESULT.md\nEOF", "/x", []),  # not RESULT.md
        ]
        for cmd, cwd, expected in cases:
            self.assertEqual(hm.bash_result_writes(cmd, cwd), expected, cmd)

    def test_the_token_is_the_first_line_after_blank_lines(self):
        self.assertEqual(hm.first_line_token("\n  <!-- report abc -->\nx"), "abc")
        self.assertIsNone(hm.first_line_token("x\n<!-- report abc -->"))

    def test_an_assignment_is_expanded_in_later_paths(self):
        self.assertEqual(hm.expand_assignments("D=/a; cat $D/RESULT.md ${D}x"), "D=/a; cat /a/RESULT.md /ax")

    def test_an_edit_of_result_md_is_a_write_when_its_new_text_starts_with_the_token(self):
        tmp = tempfile.mkdtemp(prefix="hrd-edit-test-")
        try:
            base, wt = 1_790_000_000, os.path.join(tmp, "wt")
            t = Transcript(base, wt)
            t.assistant(10, "e1", HAIKU, usage(inp=1), [call("x", "Edit", file_path=f"{wt}/.herdr-agents/b1/RESULT.md", old_string="a", new_string="<!-- report tok1 -->\nb")])
            t.assistant(11, "e2", HAIKU, usage(inp=1), [call("y", "Edit", file_path=f"{wt}/.herdr-agents/b1/RESULT.md", old_string="a", new_string="no marker")])
            path = os.path.join(tmp, "w.jsonl")
            t.write(path)
            s = hm.scan(path, 0)
            self.assertEqual(s.result_writes, [(f"{wt}/.herdr-agents/b1", "tok1", float(base + 10))])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_the_write_index_keeps_the_earliest_write_of_each_folder_and_token(self):
        a, b = hm.Session("a.jsonl"), hm.Session("b.jsonl")
        a.result_writes = [("f", "t", 5.0), ("f", "t", 3.0)]
        b.result_writes = [("f", "t", 4.0), ("f", "u", 9.0)]
        self.assertEqual(hm.write_index([a, b]), {("f", "t"): 3.0, ("f", "u"): 9.0})



class TranscriptsPath(unittest.TestCase):
    """The footer's "transcripts from" path: under the home folder it reads ~/..., elsewhere it is printed in full."""

    def footer(self, root):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            hm.print_text("last 7 days", [], hm.totals([], []), [], {}, set(), root)
        return out.getvalue().splitlines()[-1]

    def test_a_root_under_the_home_folder_reads_with_a_tilde(self):
        with mock.patch.dict(os.environ, {"HOME": "/Users/t"}):
            self.assertEqual(self.footer("/Users/t/.claude/projects"), "   transcripts from ~/.claude/projects")

    def test_the_home_folder_itself_reads_as_a_tilde(self):
        with mock.patch.dict(os.environ, {"HOME": "/Users/t"}):
            self.assertEqual(self.footer("/Users/t"), "   transcripts from ~")

    def test_a_folder_that_only_starts_with_the_home_name_is_printed_in_full(self):
        with mock.patch.dict(os.environ, {"HOME": "/Users/t"}):
            self.assertEqual(self.footer("/Users/tt/.claude/projects"), "   transcripts from /Users/tt/.claude/projects")

    def test_a_root_outside_the_home_folder_is_printed_in_full(self):
        with mock.patch.dict(os.environ, {"HOME": "/Users/t"}):
            self.assertEqual(self.footer("/srv/claude/projects"), "   transcripts from /srv/claude/projects")

    def test_the_script_prints_its_default_root_with_a_tilde(self):
        home = tempfile.mkdtemp(prefix="hrd-metrics-home-")
        self.addCleanup(shutil.rmtree, home, True)
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CONFIG_DIR"}
        env["HOME"] = home
        proc = subprocess.run([sys.executable, SCRIPT], capture_output=True, text=True, env=env, check=True)
        self.assertEqual(proc.stdout.splitlines()[-1], "   transcripts from ~/.claude/projects")


if __name__ == "__main__":
    unittest.main()
