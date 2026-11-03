"""Imported first by every Python test file: the run gets a temporary HOME and a git ceiling.

A test that forgets to set its own HOME can't reach the real home folder, and git run from a temporary
folder can't find the real repo above it. tests/test_isolation.py fails when a test file doesn't import this.
"""

import atexit
import os
import shutil
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if not os.environ.get("HRD_TEST_ISOLATED"):
    HOME = tempfile.mkdtemp(prefix="hrd-test-home-")
    atexit.register(shutil.rmtree, HOME, True)
    os.environ["HOME"] = HOME
    # Git stops looking for a repo at these folders' parents: the clone itself is still found (tests that run git
    # in it work), but a temporary folder under the real home or the repo is not.
    os.environ["GIT_CEILING_DIRECTORIES"] = os.pathsep.join(
        [os.path.dirname(ROOT), os.path.dirname(os.path.realpath(tempfile.gettempdir())), os.path.dirname(HOME)]
    )
    os.environ["HRD_TEST_ISOLATED"] = "1"
