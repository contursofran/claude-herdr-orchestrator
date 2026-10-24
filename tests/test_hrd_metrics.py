"""Fixture tests for scripts/hrd-metrics.py: one small coordinator, two workers and a plain session.

Every expected number below is worked out by hand from the timeline in build(); none is copied from
the script's output. Run: python3 -m unittest discover -s tests -p 'test_*.py'
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone

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
    c.assistant(110, "m4", HAIKU, usage(inp=200000, out=1000), [text("late")])  # above the 100k tier
    c.human(111, "thanks")
    # Report 2: a short one, sent whole.
    c.herdr(130, "b2", "builder", "done", "Done: all green.", extra=' sender="herdr-agents mod"')
    c.assistant(131, "n1", OPUS, usage(inp=10, out=10), [call("s3", "mcp__herdr-agents__spawn", worker="b3", cwd=wt, profile="builder")])
    c.result(133, "s3")  # spawn s3 took 2 s
    c.assistant(134, "n2", OPUS, usage(inp=10, out=5, cw1h=100), [call("e1", "Edit", file_path=f"{coord}/COORDINATOR-STATE.md")])
    c.result(135, "e1")
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
    w1.write(os.path.join(proj, "-wt", "w1.jsonl"))
    # Worker b2 (sonnet).
    w2 = Transcript(base, wt)
    w2.human(0, f"Your task is in {wt}/.herdr-agents/b2/TASK.md. Read it and do it.")
    w2.assistant(5, "x1", SONNET, usage(inp=1000, out=100, cr=2000, cw5=500), [text("working")])
    w2.write(os.path.join(proj, "-wt", "w2.jsonl"))
    # Worker b9 (a model the script has no price for).
    w3 = Transcript(base, wt)
    w3.human(0, f"Your task is in {wt}/.herdr-agents/b9/TASK.md. Read it and do it.")
    w3.assistant(5, "y1", "claude-mystery-9", usage(inp=10, out=10), [text("working")])
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


def coordinator_file(paths):
    return os.path.join(paths["proj"], "-coord", "coord-1.jsonl")


def scanned(paths):
    s = hm.scan(coordinator_file(paths), paths["since"])
    hm.resolve(s, paths["since"])
    return s


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
        self.assertEqual(self.session.reads, 1)
        self.assertEqual(self.session.edits, 1)
        self.assertTrue(self.r1.read)
        self.assertFalse(self.r2.read)

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
        self.assertEqual((self.r1.lag, self.r1.lag_how), (2.0, "token"))

    def test_a_short_report_is_joined_by_its_text(self):
        self.assertFalse(self.r2.pointer)
        self.assertEqual((self.r2.lag, self.r2.lag_how), (1.0, "text"))

    def test_a_report_without_a_file_or_folder_says_why_it_has_no_lag(self):
        self.assertIsNone(self.r3.lag)
        self.assertEqual(self.r3.lag_miss, "no report file")  # the folder exists, its RESULT file does not
        self.assertIsNone(self.r4.lag)
        self.assertEqual(self.r4.lag_miss, "folder gone")

    def test_quiet_stops_count_screen_files_in_the_window_only(self):
        self.assertEqual(self.session.quiet, 1)  # b3's file; b4's is 30 days old


class Totals(Fixtures):
    def test_the_json_totals(self):
        out = self.run_json()
        self.assertEqual(len(out["coordinators"]), 1)
        t = out["totals"]
        self.assertEqual(t["reports"], 4)
        self.assertEqual(t["turns"]["median"], 1.5)  # [3, 1, 2, 1]
        self.assertEqual((t["read_share"], t["pointer_share"]), (0.25, 0.25))
        self.assertEqual(t["reads"], 1)
        self.assertEqual(t["edits_per_report"], 0.25)
        self.assertEqual(t["lag"]["n"], 2)
        self.assertEqual(t["lag"]["median"], 1.5)
        self.assertEqual(t["lag_by"], {"token": 1, "text": 1, "missing": {"no report file": 1, "folder gone": 1}})
        self.assertEqual(t["action"], {"n": 3, "median": 5, "p90": 6, "max": 6})  # 6, 1, 5
        self.assertEqual(t["spawn"], {"n": 4, "median": 1.5, "max": 3, "p90": 3})
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

    def test_the_text_table_has_the_totals_and_the_lag_line(self):
        text_out = self.run_text()
        self.assertIn("== coordinator sessions, last 7 days: 1 with 4 reports", text_out)
        self.assertIn("lag found for 2 of 4 reports (by token 1, by text 1)", text_out)
        self.assertIn("no price for claude-mystery-9", text_out)

    def test_no_transcripts_in_the_window_prints_none(self):
        self.assertIn("none: no transcript in the window", self.run_text(days=0))

    def run_json(self):
        return json.loads(self.run_script(["--json"]))

    def run_text(self, days=7):
        return self.run_script(["--days", str(days)])

    def run_script(self, args):
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.paths["claude"])
        proc = subprocess.run([sys.executable, SCRIPT] + args, capture_output=True, text=True, env=env, check=True)
        return proc.stdout


class Join(unittest.TestCase):
    def test_a_pointer_whose_file_is_gone_says_so(self):
        tmp = tempfile.mkdtemp(prefix="hrd-join-test-")
        try:
            wt = os.path.join(tmp, "wt")
            os.makedirs(os.path.join(wt, ".herdr-agents", "b1"))  # the folder is there; the report file is not
            s = hm.Session(os.path.join(tmp, "s.jsonl"))
            s.cwd = tmp
            s.spawn_cwd["b1"] = wt
            body = f"[Full report, 9 lines: {wt}/.herdr-agents/b1/RESULT-cafe0001.md. Read it before acting on it.]"
            prompt = PREAMBLE + f'<herdr-agent name="b1" profile="builder" status="done">\n{body}\n</herdr-agent>'
            r = s.report(1000.0, hm.PROMPT_TAG.match(prompt), prompt)
            hm.resolve(s, 0)
            self.assertEqual(r.token, "cafe0001")
            self.assertIsNone(r.lag)
            self.assertEqual(r.lag_miss, "token file missing")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


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


if __name__ == "__main__":
    unittest.main()
