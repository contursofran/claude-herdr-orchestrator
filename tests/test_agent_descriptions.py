import re
import unittest
from pathlib import Path

AGENTS = Path(__file__).resolve().parent.parent / "agents"


class AgentDescriptions(unittest.TestCase):
    # Orchestrating is opt-in (#249): a description tells the model what the agent is, not that every session should use it.
    def test_descriptions_do_not_push_every_session_to_use_them(self):
        files = sorted(AGENTS.glob("*.md"))
        self.assertTrue(files)
        for f in files:
            description = re.search(r"^description: (.*)$", f.read_text(), re.M).group(1)
            self.assertIsNone(re.search(r"\buse (for|after|before)\b", description, re.I), f"{f.name}: {description}")


if __name__ == "__main__":
    unittest.main()
