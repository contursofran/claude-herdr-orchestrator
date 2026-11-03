import isolation  # noqa: F401
import glob
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# A tool-call hook that hands `next` a changed event rewrites the call after the model (and auto mode's review) saw it,
# and auto mode then refuses the call. #337 rewrote worker Bash commands that way; #340 reverted it. Denying is fine.
TOOL_CALL_HANDLER = re.compile(r"^\s*on\(\s*'tool\.call'", re.M)
HANDLER_START = re.compile(r"^\s*on\(", re.M)
# The handler's own names for the event and for next, e.g. `async ($, e, next) =>`.
PARAMS = re.compile(r"\(\s*\$\s*,\s*(\w+)\s*(?:,\s*(\w+)\s*)?\)\s*=>")
UPDATED_INPUT = re.compile(r"updatedInput|updated_input|modifiedInput", re.I)


def violations(body):
    """What a tool.call handler does to the tool input: passes next() something other than the event, or edits the event in place."""
    params = PARAMS.search(body)
    if not params:
        return []
    evt, nxt = params.group(1), params.group(2)
    found = []
    if nxt:
        for arg in re.findall(r"\b%s\(([^)]*)\)" % re.escape(nxt), body):
            if arg.strip() != evt:
                found.append("%s(%s)" % (nxt, arg))
    e = re.escape(evt)
    edits = [
        r"\b%s\s*(?:\.\s*\w+|\[[^\]]*\])\s*(?:[-+*/|&?]{0,2}=(?!=)|\+\+|--)" % e,
        r"\bdelete\s+%s\b" % e,
        r"\bObject\.(?:assign|defineProperty|setPrototypeOf)\(\s*%s\b" % e,
    ]
    for pattern in edits:
        for m in re.finditer(pattern, body):
            found.append(m.group(0))
    return found


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
                for bad in violations(body):
                    self.assertEqual([], [bad], f"{os.path.basename(path)}: a tool.call hook changes the tool input")
        self.assertGreater(seen, 0, "found no tool.call hooks: the scan is broken")

    def test_no_hook_returns_updated_input(self):
        for path in self.hook_files():
            with open(path) as f:
                self.assertIsNone(UPDATED_INPUT.search(f.read()), os.path.basename(path))

    def test_the_scan_catches_a_rewrite(self):
        cases = {
            "returned copy": "return next({ ...e, command: 'x' })",
            "copy in a variable": "const x = { ...e }\n    return next(x)",
            "in-place edit": "e.command = 'x'\n    return next(e)",
            "in-place edit by index": "e['command'] += 'x'\n    return next(e)",
            "delete": "delete e.command\n    return next(e)",
            "Object.assign": "Object.assign(e, { command: 'x' })\n    return next(e)",
            "renamed next": "return nxt({ ...e })",
        }
        for name, code in cases.items():
            params = "ev, nxt" if name == "renamed next" else "e, next"
            body = f"  on('tool.call', {{ tool: 'Bash' }}, async ($, {params}) => {{\n    {code}\n  }})\n"
            if name == "renamed next":
                body = body.replace("{ ...e }", "{ ...ev }")
            handlers = list(tool_call_handlers(body))
            self.assertEqual(len(handlers), 1, name)
            self.assertTrue(violations(handlers[0]), name)

    def test_the_scan_allows_reads_denies_and_a_plain_pass(self):
        ok = "  on('tool.call', { tool: 'Write' }, async ($, e, next) => {\n    if (e.file_path === '/x') return deny\n    const out = await next(e)\n    return out\n  })\n"
        self.assertEqual([], violations(next(tool_call_handlers(ok))))


if __name__ == "__main__":
    unittest.main()
