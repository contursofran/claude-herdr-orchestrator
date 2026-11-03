import isolation  # noqa: F401
import glob
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


class Isolation(unittest.TestCase):
    def test_home_is_a_temporary_folder(self):
        self.assertIn("hrd-test-home-", os.environ["HOME"])
        self.assertTrue(os.environ["GIT_CEILING_DIRECTORIES"])

    def test_every_test_file_imports_isolation_first(self):
        for path in sorted(glob.glob(os.path.join(HERE, "test_*.py"))):
            with open(path, encoding="utf-8") as f:
                code = re.sub(r'^\s*(""".*?"""|#.*)\n', "", f.read(), flags=re.S | re.M)
            self.assertIn("import isolation", code, f"{os.path.basename(path)} must import isolation")


if __name__ == "__main__":
    unittest.main()
