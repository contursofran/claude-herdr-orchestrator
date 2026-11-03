import glob
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# A tool-call hook that hands `next` a changed event rewrites the call after the model (and auto mode's review) saw it,
# and auto mode then refuses the call. #337 rewrote worker Bash commands that way; #340 reverted it. Denying is fine.
TOOL_CALL_HANDLER = re.compile(r"^\s*on\(\s*'tool\.call'", re.M)
HANDLER_START = re.compile(r"^\s*on\(", re.M)
NEXT_CALL = re.compile(r"\bnext\(([^)]*)\)")
UPDATED_INPUT = re.compile(r"updatedInput|updated_input|modifiedInput", re.I)


def tool_call_handlers(text):
    starts = [m.start() for m in HANDLER_START.finditer(text)] + [len(text)]
    for begin, end in zip(starts, starts[1:]):
        body = text[begin:end]
        if TOOL_CALL_HANDLER.match(body):
            yield body


class HooksKeepToolInput(unittest.TestCase):
    def hook_files(self):
        files = glob.glob(os.path.join(ROOT, "hooks", "*.ts")) + glob.glob(os.path.join(ROOT, "hooks", "*.tsx"))
        self.assertTrue(files)
        return files

    def test_tool_call_hooks_pass_the_event_on_unchanged(self):
        seen = 0
        for path in self.hook_files():
            with open(path) as f:
                text = f.read()
            for body in tool_call_handlers(text):
                seen += 1
                for arg in NEXT_CALL.findall(body):
                    self.assertEqual(arg.strip(), "e", f"{os.path.basename(path)}: a tool.call hook changes the tool input: next({arg})")
        self.assertGreater(seen, 0, "found no tool.call hooks: the scan is broken")

    def test_no_hook_returns_updated_input(self):
        for path in self.hook_files():
            with open(path) as f:
                self.assertIsNone(UPDATED_INPUT.search(f.read()), os.path.basename(path))

    def test_the_scan_catches_a_rewrite(self):
        bad = "  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {\n    return next({ ...e, command: 'x' })\n  })\n"
        found = [a for body in tool_call_handlers(bad) for a in NEXT_CALL.findall(body)]
        self.assertEqual(found, ["{ ...e, command: 'x' }"])


if __name__ == "__main__":
    unittest.main()
