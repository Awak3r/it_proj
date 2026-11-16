"""Fast CI policy regressions; no network, Docker or production access."""

from contextlib import redirect_stdout, redirect_stderr
import importlib.util
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import tempfile
import unittest
from unittest.mock import patch

import ci

spec = importlib.util.spec_from_file_location("prepare_ci", ci.ROOT / "scripts/prepare-ci.py")
prepare_ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_ci)


class ChangesTests(unittest.TestCase):
    def test_only_known_documentation_can_skip_runtime(self):
        self.assertTrue(ci.docs_only(["README.md", "AGENTS.md", "docs/API.md",
                                      "docs/archive/qa/evidence/go.txt", "docs/archive/qa/EXECUTION.csv"]))
        for paths in [[], ["Dockerfile"], ["backend/schema.sql"], ["web/src/main.tsx"],
                      ["docs/check.py"], ["docs/../scripts/seed-demo.py"],
                      ["README.md", ".github/workflows/checks.yml"], [".dockerignore"],
                      ["scripts/ci.py"], ["scripts/prepare-ci.py"], ["unknown.md"], [".env.example"]]:
            with self.subTest(paths=paths):
                self.assertFalse(ci.docs_only(paths))

    def test_push_uses_complete_before_to_head_diff_with_deletions_and_renames(self):
        before, head = "a" * 40, "b" * 40
        result = subprocess.CompletedProcess([], 0, stdout=b"docs/old.md\0backend/renamed.go\0")
        with patch.object(ci.subprocess, "run", return_value=result) as run:
            self.assertTrue(ci.needs_runtime("push", {"before": before}, head))
        self.assertEqual(run.call_args.args[0], ["git", "--no-pager", "diff", "--name-only", "-z",
                                               "--no-renames", before, head, "--"])

    def test_doc_only_push_and_pr(self):
        result = subprocess.CompletedProcess([], 0, stdout=b"README.md\0docs/API.md\0")
        for event, payload in [("push", {"before": "a" * 40}),
                               ("pull_request", {"pull_request": {"base": {"sha": "a" * 40}}})]:
            with self.subTest(event=event), patch.object(ci.subprocess, "run", return_value=result):
                self.assertFalse(ci.needs_runtime(event, payload, "b" * 40))

    def test_manual_unknown_initial_invalid_and_unavailable_history_run_everything(self):
        for event, payload, head in [
            ("workflow_dispatch", {}, "a" * 40), ("schedule", {}, "a" * 40),
            ("push", {"before": "0" * 40}, "a" * 40),
            ("push", {"before": "--unsafe"}, "a" * 40),
            ("push", {"before": "a" * 40}, "invalid"),
        ]:
            with self.subTest(event=event, payload=payload), patch.object(ci.subprocess, "run") as run:
                self.assertTrue(ci.needs_runtime(event, payload, head))
                run.assert_not_called()
        with patch.object(ci.subprocess, "run", side_effect=subprocess.CalledProcessError(128, "git")):
            self.assertTrue(ci.needs_runtime("push", {"before": "a" * 40}, "b" * 40))
        with patch.object(ci.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=b"")):
            self.assertTrue(ci.needs_runtime("push", {"before": "a" * 40}, "b" * 40))


class FreshnessTests(unittest.TestCase):
    def test_current_or_documentation_only_descendant_can_release(self):
        self.assertTrue(ci.current_release("a", "a"))
        self.assertTrue(ci.current_release("a", "b", {"status": "ahead", "files": [{"filename": "docs/API.md"}]}))

    def test_new_application_code_divergence_and_incomplete_diff_cannot_release(self):
        for diff in [None, {"status": "behind"}, {"status": "diverged"},
                     {"status": "ahead", "files": []},
                     {"status": "ahead", "files": [{"filename": "web/src/main.tsx"}]},
                     {"status": "ahead", "files": [{"filename": "docs/file.md", "previous_filename": "backend/main.go"}]},
                     {"status": "ahead", "files": [{"filename": "docs/API.md"}] * 300}]:
            with self.subTest(diff=diff):
                self.assertFalse(ci.current_release("a", "b", diff))


class DocumentationTests(unittest.TestCase):
    def test_relative_file_links_and_external_or_archived_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs").mkdir()
            (root / "AGENTS.md").write_text("# Instructions\n")
            (root / "docs/API.md").write_text("[Home](../README.md)\n")
            (root / "README.md").write_text(
                "[API](docs/API.md#section) [external](https://example.invalid/no)\n"
                "[evidence](/tmp/historical.txt)\n```sh\n[not a link](no-such-file)\n```\n")
            self.assertEqual(ci.broken_doc_links(root), [])
            (root / "README.md").write_text("[broken](docs/missing.md)\n")
            self.assertEqual(ci.broken_doc_links(root), ["README.md:1: missing docs/missing.md"])

    def test_repository_links(self):
        self.assertEqual(ci.broken_doc_links(), [])


@unittest.skipUnless(os.name == "posix", "CI preparation uses Linux process groups")
class PreparationTests(unittest.TestCase):
    def stage(self, root, name, code):
        return (name, str(root), [sys.executable, "-c", code])

    def wait_for_file(self, path):
        deadline = time.monotonic() + 5
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(path.exists(), f"Child did not become ready: {path}")

    def assert_stopped(self, pid):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            # An orphan killed by the helper may briefly await reaping by init.
            stat = Path(f"/proc/{pid}/stat")
            if stat.exists() and stat.read_text().split(") ", 1)[1].startswith("Z"):
                return
            time.sleep(0.02)
        self.fail(f"Child {pid} survived cleanup")

    def test_exact_preparation_commands(self):
        go, web = prepare_ci.preparation()
        self.assertEqual([stage[2] for stage in go], [
            ["go", "test", "-race", "-count=1", "./..."],
            ["go", "vet", "./..."], ["go", "build", "-o", "../labturn", "."],
        ])
        self.assertEqual([stage[2] for stage in web], [
            ["npm", "ci"], ["npm", "run", "build"],
            ["npx", "playwright", "install", "--with-deps", "--only-shell", "chromium"],
        ])
        self.assertTrue(all(stage[1] == ci.ROOT / "backend" for stage in go))
        self.assertTrue(all(stage[1] == ci.ROOT / "web" for stage in web))

    def test_branches_overlap_but_each_stage_waits_for_its_predecessor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            branches = []
            for name, peer in [("go", "web"), ("web", "go")]:
                first = (
                    "from pathlib import Path; import time; "
                    f"Path('{name}').touch(); deadline = time.monotonic() + 5\n"
                    f"while not Path('{peer}').exists() and time.monotonic() < deadline: time.sleep(.02)\n"
                    f"assert Path('{peer}').exists(); Path('{name}-done').touch(); "
                    f"print('{name} output', flush=True)"
                )
                second = f"from pathlib import Path; assert Path('{name}-done').exists()"
                branches.append([self.stage(root, name, first), self.stage(root, name + " next", second)])
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(prepare_ci.run(branches), 0)
            for name in ("go", "web"):
                self.assertIn(f"{name} output", output.getvalue())
                self.assertRegex(output.getvalue(), rf"{name}: exit 0 \(\d+\.\d{{2}}s\)")
                self.assertIn(f"{name} next: exit 0", output.getvalue())

    def test_failure_in_either_branch_stops_peer_and_skips_next_stages(self):
        for failing_index in (0, 1):
            with self.subTest(failing_index=failing_index), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fail = self.stage(root, "failure", "import sys, time; from pathlib import Path\n"
                                  "deadline = time.monotonic() + 5\n"
                                  "while not Path('peer').exists() and time.monotonic() < deadline: time.sleep(.02)\n"
                                  "print('failure detail', file=sys.stderr); sys.exit(7)")
                peer = self.stage(root, "peer", "import os, time; from pathlib import Path; "
                                  "Path('peer').write_text(str(os.getpid())); time.sleep(30)")
                forbidden = self.stage(root, "forbidden", "from pathlib import Path; Path('forbidden').touch()")
                branches = [[fail, forbidden], [peer, forbidden]]
                if failing_index:
                    branches.reverse()
                output = io.StringIO()
                with redirect_stdout(output):
                    self.assertNotEqual(prepare_ci.run(branches), 0)
                self.assertFalse((root / "forbidden").exists())
                self.assertIn("failure: exit 7", output.getvalue())
                self.assertIn("failure detail", output.getvalue())
                self.assertIn("peer: stopped", output.getvalue())
                self.assert_stopped(int((root / "peer").read_text()))

    def test_spawn_failure_is_not_success(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            with redirect_stdout(output), redirect_stderr(output):
                self.assertEqual(prepare_ci.run([[("missing", directory, [directory + "/missing"])]]), 1)
            self.assertIn("missing: failed to start", output.getvalue())

    def test_cancellation_kills_descendants_even_if_they_ignore_term(self):
        for signum in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=signum), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                child_code = ("import os, signal, time; from pathlib import Path; "
                              "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                              "Path('child').write_text(str(os.getpid())); time.sleep(30)")
                parent_code = ("import os, signal, subprocess, sys, time; from pathlib import Path; "
                               "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                               f"subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
                               "Path('parent').write_text(str(os.getpid())); time.sleep(30)")
                branches = [[self.stage(root, "parent", parent_code)]]
                driver = ("import runpy; "
                          f"helper = runpy.run_path({str(ci.ROOT / 'scripts/prepare-ci.py')!r}); "
                          f"raise SystemExit(helper['run']({branches!r}))")
                process = subprocess.Popen([sys.executable, "-B", "-c", driver],
                                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                try:
                    self.wait_for_file(root / "child")
                    self.wait_for_file(root / "parent")
                    process.send_signal(signum)
                    output, _ = process.communicate(timeout=8)
                    self.assertEqual(process.returncode, 128 + signum, output)
                    self.assertIn("parent: stopped", output)
                    for name in ("parent", "child"):
                        self.assert_stopped(int((root / name).read_text()))
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate(timeout=5)
                    for name in ("parent", "child"):
                        if (root / name).exists():
                            try:
                                os.kill(int((root / name).read_text()), signal.SIGKILL)
                            except ProcessLookupError:
                                pass


class WorkflowTests(unittest.TestCase):
    def test_parallel_preparation_gates_app_and_browser_tests(self):
        checks = (ci.ROOT / ".github/workflows/checks.yml").read_text()
        prepare = checks.index("run: python3 scripts/prepare-ci.py")
        app = checks.index("- name: Start an isolated local app")
        browser = checks.index("- name: Browser tests")
        self.assertLess(prepare, app)
        self.assertLess(app, browser)
        self.assertNotIn("continue-on-error", checks[prepare:browser])
        self.assertNotIn("if: always()", checks[prepare:browser])
        self.assertIn("node-version: '22'", checks)
        self.assertIn("run: npm test", checks[browser:])
    def test_single_image_build_and_guarded_deployment(self):
        folder = ci.ROOT / ".github/workflows"
        checks = (folder / "checks.yml").read_text()
        deploy = (folder / "deploy.yml").read_text()
        self.assertEqual((checks + deploy).count("uses: docker/build-push-action@"), 1)
        self.assertNotIn("docker build -t", checks)
        self.assertNotIn("bash scripts/build-image.sh", deploy)
        self.assertIn("cache-from: type=gha", checks)
        self.assertIn("cache-to: type=gha", checks)
        self.assertIn("platforms: linux/amd64", checks)
        self.assertIn("load: true", checks)
        self.assertIn("needs: checks", deploy)
        self.assertIn("needs.checks.outputs.runtime == 'true'", deploy)
        self.assertIn("environment: production", deploy)
        self.assertIn("python3 scripts/ci.py current", deploy)
        self.assertEqual(deploy.count("if: steps.current.outputs.current == 'true'"), 2)
        self.assertIn("cancel-in-progress: false", deploy)
        self.assertNotIn("cancel-in-progress: true", deploy)
        self.assertEqual(checks.count("cancel-in-progress: true"), 2)
        self.assertEqual((checks + deploy).count("labturn-image-${{ github.run_id }}-${{ github.run_attempt }}"), 2)
        self.assertIn("StrictHostKeyChecking=yes", deploy)
        self.assertIn("sha256sum -c image.tar.gz.sha256", deploy)

    def test_image_and_compose_use_fast_startup_but_normal_steady_checks(self):
        dockerfile = (ci.ROOT / "Dockerfile").read_text()
        health = next(line for line in dockerfile.splitlines() if line.startswith("HEALTHCHECK "))
        for option in ["--interval=15s", "--timeout=5s", "--start-period=20s",
                       "--start-interval=1s", "--retries=3"]:
            self.assertIn(option, health)
        self.assertIn("http://localhost:8080/api/health", health)
        app = (ci.ROOT / "compose.yaml").read_text().split("  app:", 1)[1].split("  proxy:", 1)[0]
        for setting in ["interval: 15s", "start_period: 20s", "start_interval: 1s",
                        "timeout: 5s", "retries: 3"]:
            self.assertIn(setting, app)

    def test_local_outputs_and_sandbox_are_excluded_from_docker_context(self):
        ignore = (ci.ROOT / ".dockerignore").read_text().splitlines()
        for path in [".local", "backend/it_proj", "/labturn", "**/node_modules", "**/dist",
                             "backend/**/*_test.go", "web/tests", "web/playwright.config.ts"]:
            self.assertIn(path, ignore)


if __name__ == "__main__":
    unittest.main()
