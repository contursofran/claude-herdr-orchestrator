"""Tests for scripts/hrd-eval/bin/gh, the gh stand-in the eval runner puts on PATH.

Each test makes a bare remote with a main branch, a clone where the worker works, and a state folder
with repo.json and issues 3 and 12, then runs the shim the way a worker's gh call would. No model is called.
Run: python3 -m unittest discover -s tests -p 'test_*.py'
"""

import fcntl
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SHIM = os.path.join(HERE, "..", "scripts", "hrd-eval", "bin", "gh")
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
HAS_JQ = shutil.which("jq") is not None
REPO_URL = "https://github.com/hrd-eval/scenario-x"


def git_out(*args, cwd=None):
    return subprocess.run(GIT + list(args), cwd=cwd, check=True, capture_output=True, text=True).stdout


def git(*args, cwd=None):
    return git_out(*args, cwd=cwd).strip()


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class ShimCase(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="hrd-eval-gh-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.remote = os.path.join(self.tmp, "remote.git")
        self.work = os.path.join(self.tmp, "work")
        self.state = os.path.join(self.tmp, "gh")
        seed = os.path.join(self.tmp, "seed")
        git("init", "--bare", "-b", "main", self.remote)
        git("init", "-b", "main", seed)
        write(seed, "shop/cart.py", "def total(items):\n    return sum(items)\n")
        write(seed, "README.md", "shop\n")
        git("add", "-A", cwd=seed)
        git("commit", "-q", "-m", "Base", cwd=seed)
        git("push", "-q", self.remote, "main", cwd=seed)
        git("clone", "-q", self.remote, self.work)
        self.save("repo.json", {"remote": self.remote, "name": "scenario-x", "owner": "hrd-eval"})
        self.save_issue(3, title="Old")
        self.save_issue(
            12,
            title="Add cart totals",
            body="Sum the cart.",
            comments=[{"author": {"login": "franco"}, "body": "Use the bulk rule.", "createdAt": "2026-10-01T00:00:00Z"}],
        )

    def save(self, rel, obj):
        write(self.state, rel, json.dumps(obj))

    def save_issue(self, n, **fields):
        rec = {"number": n, "title": "", "body": "", "state": "OPEN", "labels": [], "comments": [], "author": {"login": "franco"}, "createdAt": "2026-10-01T00:00:00Z"}
        rec.update(fields)
        self.save(f"issues/{n}.json", rec)

    def commit(self, files, message="Change", push_as=None):
        """Commit files on the clone's checked-out branch, and push that branch as push_as when given."""
        for rel, text in files.items():
            write(self.work, rel, text)
        git("add", "-A", cwd=self.work)
        git("commit", "-q", "-m", message, cwd=self.work)
        if push_as:
            git("push", "-q", "-u", "origin", push_as, cwd=self.work)

    def branch(self, name, files, message="Change", push=True):
        """A branch off origin/main with one commit, checked out in the clone; pushed unless push is False."""
        git("checkout", "-q", "-B", name, "origin/main", cwd=self.work)
        self.commit(files, message, name if push else None)

    def open_pr(self, files=None, title="Add server"):
        """Branch issue-12-eval and PR #13 for it (the first PR number after issue 12)."""
        self.branch("issue-12-eval", files or {"shop/server.py": "x = 1\n"}, title)
        self.ok("pr", "create", "--title", title, "--body", "Closes #12")

    def gh(self, *args, cwd=None, stdin=None, state=True):
        env = dict(os.environ)
        env.pop("HRD_EVAL_GH_STATE", None)
        if state:
            env["HRD_EVAL_GH_STATE"] = self.state
        return subprocess.run([SHIM, *args], cwd=cwd or self.work, input=stdin, capture_output=True, text=True, env=env, timeout=60)

    def ok(self, *args, **kw):
        p = self.gh(*args, **kw)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout

    def pr(self, n, fields):
        return json.loads(self.ok("pr", "view", str(n), "--json", fields))

    def numbers(self, *args):
        return [p["number"] for p in json.loads(self.ok(*args, "--json", "number"))]

    def set_pr_state(self, n, state):
        path = os.path.join(self.state, "prs", f"{n}.json")
        with open(path, encoding="utf-8") as f:
            rec = json.load(f)
        rec["state"] = state
        with open(path, "w", encoding="utf-8") as f:
            json.dump(rec, f)

    def remote_sha(self, branch):
        return git("--git-dir", self.remote, "rev-parse", f"refs/heads/{branch}")

    def calls(self):
        with open(os.path.join(self.state, "calls.log"), encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]


class RepoAndIssueTests(ShimCase):
    def test_repo_view_json_reports_the_remote_default_branch(self):
        self.assertEqual(json.loads(self.ok("repo", "view", "--json", "defaultBranchRef")), {"defaultBranchRef": {"name": "main"}})

    @unittest.skipUnless(HAS_JQ, "needs jq")
    def test_repo_view_jq_prints_the_branch_name(self):
        self.assertEqual(self.ok("repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"), "main\n")

    def test_issue_view_text_has_the_body_and_the_comments_only_with_the_flag(self):
        plain = self.ok("issue", "view", "12")
        self.assertIn("Add cart totals", plain)
        self.assertIn("Sum the cart.", plain)
        self.assertNotIn("Use the bulk rule.", plain)
        with_comments = self.ok("issue", "view", "12", "--comments")
        self.assertIn("franco commented at 2026-10-01T00:00:00Z", with_comments)
        self.assertIn("Use the bulk rule.", with_comments)

    def test_issue_view_of_an_unknown_number_exits_1(self):
        p = self.gh("issue", "view", "99")
        self.assertEqual(p.returncode, 1)
        self.assertIn("Could not resolve to an Issue with the number of 99", p.stderr)

    def test_issue_comment_is_added_to_the_issue(self):
        self.assertEqual(self.ok("issue", "comment", "12", "--body", "On it").strip(), f"{REPO_URL}/issues/12")
        comments = json.loads(self.ok("issue", "view", "12", "--json", "comments"))["comments"]
        self.assertEqual([c["body"] for c in comments], ["Use the bulk rule.", "On it"])
        self.assertEqual(comments[-1]["author"]["login"], "hrd-eval")

    def test_issue_list_is_newest_first_and_filters_by_state(self):
        self.save_issue(20, title="Closed one", state="CLOSED")
        self.assertEqual(self.numbers("issue", "list"), [12, 3])
        self.assertEqual(self.numbers("issue", "list", "--state", "closed"), [20])


class PrCreateTests(ShimCase):
    def test_pr_create_refuses_a_head_that_is_not_on_the_remote(self):
        git("checkout", "-q", "-B", "issue-12-eval", "origin/main", cwd=self.work)
        self.commit({"shop/server.py": "x = 1\n"}, "Add server")
        p = self.gh("pr", "create", "--title", "Add server", "--body", "b")
        self.assertEqual(p.returncode, 1)
        self.assertIn("not on the remote", p.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.state, "prs", "13.json")))

    def test_pr_create_prints_the_url_numbered_after_the_highest_issue(self):
        self.branch("issue-12-eval", {"shop/server.py": "x = 1\n"}, "Add server")
        self.assertEqual(self.ok("pr", "create", "--title", "Add server", "--body", "Closes #12"), f"{REPO_URL}/pull/13\n")
        self.assertEqual(json.loads(self.ok("pr", "view", "13", "--json", "number,headRefName")), {"number": 13, "headRefName": "issue-12-eval"})

    def test_a_second_pr_for_the_same_head_exits_1_with_its_url(self):
        self.open_pr()
        p = self.gh("pr", "create", "--title", "Again", "--body", "b")
        self.assertEqual(p.returncode, 1)
        self.assertIn("already exists", p.stderr)
        self.assertIn(f"{REPO_URL}/pull/13", p.stderr)

    def test_no_commits_ahead_of_main_exits_1(self):
        git("checkout", "-q", "-B", "issue-12-eval", "origin/main", cwd=self.work)
        git("push", "-q", "-u", "origin", "issue-12-eval", cwd=self.work)
        p = self.gh("pr", "create", "--title", "t", "--body", "b")
        self.assertEqual(p.returncode, 1)
        self.assertIn("no commits between main and issue-12-eval", p.stderr)

    def test_fill_takes_the_title_and_body_of_a_single_commit(self):
        self.branch("issue-12-eval", {"shop/server.py": "x = 1\n"}, "Add server\n\nHandles the ping request.")
        self.ok("pr", "create", "--fill")
        self.assertEqual(self.pr(13, "title,body"), {"title": "Add server", "body": "Handles the ping request."})

    def test_fill_with_two_commits_uses_the_branch_name_and_a_list(self):
        git("checkout", "-q", "-B", "issue-12-eval", "origin/main", cwd=self.work)
        self.commit({"shop/server.py": "x = 1\n"}, "First")
        self.commit({"shop/client.py": "y = 2\n"}, "Second")
        git("push", "-q", "-u", "origin", "issue-12-eval", cwd=self.work)
        self.ok("pr", "create", "--fill")
        self.assertEqual(self.pr(13, "title,body"), {"title": "issue-12-eval", "body": "- First\n- Second"})

    def test_body_file_dash_reads_the_body_from_stdin(self):
        self.branch("issue-12-eval", {"shop/server.py": "x = 1\n"})
        self.ok("pr", "create", "--title", "Add server", "--body-file", "-", stdin="From stdin\n")
        self.assertEqual(self.pr(13, "body"), {"body": "From stdin\n"})

    def test_pr_create_without_a_title_or_fill_exits_1(self):
        self.branch("issue-12-eval", {"shop/server.py": "x = 1\n"})
        p = self.gh("pr", "create", "--body", "b")
        self.assertEqual(p.returncode, 1)
        self.assertIn("--title (or --fill) is required", p.stderr)


class PrViewTests(ShimCase):
    def test_pr_view_finds_the_pr_by_number_url_branch_and_cwd(self):
        self.open_pr()
        for sel in ["13", f"{REPO_URL}/pull/13", "issue-12-eval"]:
            self.assertEqual(json.loads(self.ok("pr", "view", sel, "--json", "number"))["number"], 13, sel)
        self.assertEqual(json.loads(self.ok("pr", "view", "--json", "number"))["number"], 13)

    def test_a_branch_without_a_pr_says_so(self):
        p = self.gh("pr", "view")
        self.assertEqual(p.returncode, 1)
        self.assertIn('no pull requests found for branch "main"', p.stderr)

    def test_head_oid_is_the_remote_ref_and_files_come_from_the_diff(self):
        self.open_pr({"shop/server.py": "x = 1\n", "shop/cart.py": "def total(items):\n    return sum(items) * 1\n"})
        full = json.loads(self.ok("pr", "view", "13", "--json", "headRefOid,files,additions,deletions"))
        self.assertEqual(full["headRefOid"], self.remote_sha("issue-12-eval"))
        self.assertEqual(
            full["files"],
            [{"path": "shop/cart.py", "additions": 1, "deletions": 1}, {"path": "shop/server.py", "additions": 1, "deletions": 0}],
        )
        self.assertEqual((full["additions"], full["deletions"]), (2, 1))

    def test_mergeable_says_conflicting_once_main_changes_the_same_line(self):
        self.open_pr({"shop/cart.py": "def total(items):\n    return sum(items) + 1\n"})
        self.assertEqual(self.pr(13, "mergeable,mergeStateStatus"), {"mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN"})
        git("checkout", "-q", "main", cwd=self.work)
        self.commit({"shop/cart.py": "def total(items):\n    return sum(items) + 2\n"}, "Main changes the same line")
        git("push", "-q", "origin", "main", cwd=self.work)
        self.assertEqual(self.pr(13, "mergeable,mergeStateStatus"), {"mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"})

    def test_an_unknown_json_field_exits_1(self):
        self.open_pr()
        p = self.gh("pr", "view", "13", "--json", "number,nope")
        self.assertEqual(p.returncode, 1)
        self.assertIn('Unknown JSON field: "nope"', p.stderr)

    def test_pr_view_of_an_unknown_number_exits_1(self):
        p = self.gh("pr", "view", "99")
        self.assertEqual(p.returncode, 1)
        self.assertIn("Could not resolve to a PullRequest with the number of 99", p.stderr)

    @unittest.skipUnless(HAS_JQ, "needs jq")
    def test_jq_filters_the_json(self):
        self.open_pr()
        self.assertEqual(self.ok("pr", "view", "13", "--json", "number", "--jq", ".number"), "13\n")

    def test_jq_without_json_exits_1(self):
        self.open_pr()
        p = self.gh("pr", "view", "13", "--jq", ".number")
        self.assertEqual(p.returncode, 1)
        self.assertIn("--jq needs --json", p.stderr)


class PrDiffAndListTests(ShimCase):
    def test_pr_diff_is_the_same_as_git_diff_main_to_the_head(self):
        self.open_pr({"shop/server.py": "x = 1\n", "shop/cart.py": "def total(items):\n    return sum(items) * 1\n"})
        # main moves on after the branch was cut, so only a three-dot diff leaves main's own change out
        git("checkout", "-q", "main", cwd=self.work)
        self.commit({"README.md": "shop, moved on\n"}, "Main moves on")
        git("push", "-q", "origin", "main", cwd=self.work)
        want = git_out("diff", "main...issue-12-eval", cwd=self.work)
        self.assertNotIn("README.md", want)
        self.assertEqual(self.ok("pr", "diff", "13"), want)

    def test_pr_diff_name_only_lists_the_changed_files(self):
        self.open_pr({"shop/server.py": "x = 1\n", "shop/cart.py": "def total(items):\n    return sum(items) * 1\n"})
        want = git_out("diff", "--name-only", "main...issue-12-eval", cwd=self.work).splitlines()
        self.assertEqual(want, ["shop/cart.py", "shop/server.py"])
        self.assertEqual(self.ok("pr", "diff", "13", "--name-only").splitlines(), want)

    def test_name_only_and_patch_together_exit_1(self):
        self.open_pr()
        p = self.gh("pr", "diff", "13", "--name-only", "--patch")
        self.assertEqual(p.returncode, 1)
        self.assertIn("can't be used together", p.stderr)

    def test_search_by_a_path_matches_only_the_pr_that_touches_it(self):
        self.open_pr()
        self.branch("issue-14-eval", {"scripts/b.py": "print(1)\n"}, "Add b")
        self.ok("pr", "create", "--title", "Add b", "--body", "b")
        self.assertEqual(self.numbers("pr", "list", "--search", "scripts/b.py"), [14])
        self.assertEqual(self.numbers("pr", "list", "--search", "shop/server.py"), [13])

    def test_state_filters_open_closed_and_all(self):
        self.open_pr()
        self.branch("issue-14-eval", {"scripts/b.py": "print(1)\n"}, "Add b")
        self.ok("pr", "create", "--title", "Add b", "--body", "b")
        self.set_pr_state(13, "CLOSED")
        self.assertEqual(self.numbers("pr", "list"), [14])
        self.assertEqual(self.numbers("pr", "list", "--state", "closed"), [13])
        self.assertEqual(self.numbers("pr", "list", "--state", "all"), [14, 13])

    def test_search_qualifiers_filter_by_head_and_state_and_reject_others(self):
        self.open_pr()
        self.branch("issue-14-eval", {"scripts/b.py": "print(1)\n"}, "Add b")
        self.ok("pr", "create", "--title", "Add b", "--body", "b")
        self.assertEqual(self.numbers("pr", "list", "--search", "head:issue-12-eval"), [13])
        self.assertEqual(self.numbers("pr", "list", "--search", "is:open head:issue-14-eval"), [14])
        p = self.gh("pr", "list", "--search", "draft:true")
        self.assertEqual(p.returncode, 1)
        self.assertIn("unsupported search qualifier: draft:true", p.stderr)


class PrWriteTests(ShimCase):
    def test_edit_ready_comment_and_review_show_in_pr_view(self):
        self.branch("issue-12-eval", {"shop/server.py": "x = 1\n"}, "Add server")
        self.ok("pr", "create", "--title", "Add server", "--body", "b", "--draft", "--label", "bug")
        self.assertTrue(self.pr(13, "isDraft")["isDraft"])
        self.ok("pr", "edit", "13", "--title", "Add the server", "--add-label", "eval,ready", "--remove-label", "bug", "--body-file", "-", stdin="New body\n")
        self.ok("pr", "ready", "13")
        self.ok("pr", "comment", "13", "--body", "Looks good so far")
        self.ok("pr", "review", "13", "--approve", "--body", "Ship it")
        full = json.loads(self.ok("pr", "view", "13", "--json", "title,body,isDraft,labels,comments,reviews"))
        self.assertEqual(full["title"], "Add the server")
        self.assertEqual(full["body"], "New body\n")
        self.assertFalse(full["isDraft"])
        self.assertEqual([label["name"] for label in full["labels"]], ["eval", "ready"])
        self.assertEqual([c["body"] for c in full["comments"]], ["Looks good so far"])
        self.assertEqual([(r["state"], r["body"]) for r in full["reviews"]], [("APPROVED", "Ship it")])
        self.assertIn("Looks good so far", self.ok("pr", "view", "13", "--comments"))

    def test_review_needs_exactly_one_kind_and_a_body_for_changes_or_comment(self):
        self.open_pr()
        self.assertEqual(self.gh("pr", "review", "13").returncode, 1)
        self.assertEqual(self.gh("pr", "review", "13", "--approve", "--comment", "--body", "x").returncode, 1)
        p = self.gh("pr", "review", "13", "--request-changes")
        self.assertEqual(p.returncode, 1)
        self.assertIn("--request-changes needs --body", p.stderr)
        self.assertEqual(self.pr(13, "reviews")["reviews"], [])

    def test_edit_base_must_be_on_the_remote(self):
        self.open_pr()
        git("push", "-q", "origin", "main:develop", cwd=self.work)
        p = self.gh("pr", "edit", "13", "--base", "nope")
        self.assertEqual(p.returncode, 1)
        self.assertIn('base branch "nope" is not on the remote', p.stderr)
        self.ok("pr", "edit", "13", "--base", "develop")
        self.assertEqual(self.pr(13, "baseRefName"), {"baseRefName": "develop"})


class ErrorAndLogTests(ShimCase):
    def test_pr_checks_exits_1_with_the_gh_message(self):
        self.open_pr()
        p = self.gh("pr", "checks", "13")
        self.assertEqual(p.returncode, 1)
        self.assertIn("no checks reported on the 'issue-12-eval' branch", p.stderr)

    def test_api_and_pr_merge_are_unsupported_and_logged(self):
        p = self.gh("api", "repos/hrd-eval/scenario-x")
        self.assertEqual(p.returncode, 1)
        self.assertIn("hrd-eval gh shim: unsupported: gh api repos/hrd-eval/scenario-x", p.stderr)
        self.assertEqual(self.gh("pr", "merge", "13").returncode, 1)
        logged = self.calls()
        self.assertEqual([c["argv"] for c in logged], [["api", "repos/hrd-eval/scenario-x"], ["pr", "merge", "13"]])
        self.assertEqual([c["exit"] for c in logged], [1, 1])

    def test_a_missing_state_variable_exits_1_and_logs_nothing(self):
        p = self.gh("repo", "view", state=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn("HRD_EVAL_GH_STATE is not set", p.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.state, "calls.log")))

    def test_repo_flag_is_ignored_wherever_it_is(self):
        self.open_pr()
        want = json.loads(self.ok("pr", "view", "13", "--json", "number"))
        self.assertEqual(json.loads(self.ok("-R", "x/y", "pr", "view", "13", "--json", "number")), want)
        self.assertEqual(json.loads(self.ok("pr", "view", "--repo", "x/y", "13", "--json", "number")), want)
        self.assertEqual(json.loads(self.ok("pr", "view", "-R", "x/y", "13", "--json", "number")), want)
        self.assertEqual(json.loads(self.ok("pr", "view", "--repo=x/y", "13", "--json", "number")), want)
        self.assertEqual(json.loads(self.ok("repo", "view", "-Rx/y", "--json", "name")), {"name": "scenario-x"})

    def test_every_call_is_logged_with_its_argv_cwd_and_exit_code(self):
        self.ok("repo", "view", "--json", "name")
        self.assertEqual(self.gh("issue", "view", "99").returncode, 1)
        self.ok("auth", "status")
        logged = self.calls()
        self.assertEqual([c["argv"] for c in logged], [["repo", "view", "--json", "name"], ["issue", "view", "99"], ["auth", "status"]])
        self.assertEqual([c["exit"] for c in logged], [0, 1, 0])
        self.assertEqual(os.path.realpath(logged[0]["cwd"]), self.work)
        self.assertIsInstance(logged[0]["t"], float)

    def test_run_list_and_view_say_there_are_no_runs(self):
        for args in (("run", "list"), ("run", "view", "123")):
            p = self.gh(*args)
            self.assertEqual(p.returncode, 0)
            self.assertEqual(p.stdout, "no runs found\n")

    def test_auth_status_says_logged_in(self):
        p = self.gh("auth", "status")
        self.assertEqual(p.returncode, 0)
        self.assertIn("logged in", p.stdout)

    def test_an_unknown_flag_exits_1(self):
        p = self.gh("pr", "view", "--web")
        self.assertEqual(p.returncode, 1)
        self.assertIn("unknown flag: --web", p.stderr)

    def test_a_write_waits_for_the_lock_held_by_another_process(self):
        self.open_pr()
        fd = os.open(os.path.join(self.state, "lock"), os.O_RDWR | os.O_CREAT, 0o644)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX)
        env = dict(os.environ, HRD_EVAL_GH_STATE=self.state)
        proc = subprocess.Popen([SHIM, "pr", "comment", "13", "--body", "later"], cwd=self.work, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(proc.kill)
        time.sleep(1.0)
        self.assertIsNone(proc.poll(), "the write finished while the lock was held")
        fcntl.flock(fd, fcntl.LOCK_UN)
        _, err = proc.communicate(timeout=30)
        self.assertEqual(proc.returncode, 0, err)
        self.assertEqual([c["body"] for c in self.pr(13, "comments")["comments"]], ["later"])


if __name__ == "__main__":
    unittest.main()
