import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_in_copy(setup):
    """Copy scripts/ and types-pinned/ to a temp folder, apply setup(dir), run --if-missing."""
    with tempfile.TemporaryDirectory() as d:
        os.mkdir(os.path.join(d, ".claude-plugin"))
        shutil.copytree(os.path.join(ROOT, "scripts"), os.path.join(d, "scripts"))
        shutil.copytree(os.path.join(ROOT, "types-pinned"), os.path.join(d, "types-pinned"))
        setup(d)
        r = subprocess.run(
            [os.path.join(d, "scripts", "types.sh"), "--if-missing"], capture_output=True, text=True
        )
        tsconfig = os.path.join(d, ".claude-plugin", "types", "tsconfig.json")
        content = open(tsconfig).read() if os.path.exists(tsconfig) else None
        return r.returncode, content


class IfMissing(unittest.TestCase):
    def test_copies_pinned_types_when_folder_is_missing(self):
        code, content = run_in_copy(lambda d: None)
        self.assertEqual(code, 0)
        with open(os.path.join(ROOT, "types-pinned", "tsconfig.json")) as f:
            self.assertEqual(content, f.read())

    def test_keeps_an_existing_copy(self):
        def setup(d):
            os.mkdir(os.path.join(d, ".claude-plugin", "types"))
            with open(os.path.join(d, ".claude-plugin", "types", "tsconfig.json"), "w") as f:
                f.write("local")

        code, content = run_in_copy(setup)
        self.assertEqual(code, 0)
        self.assertEqual(content, "local")


if __name__ == "__main__":
    unittest.main()
