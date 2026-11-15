"""Fast CI policy regressions; no network, Docker or production access."""

from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import ci


class ChangesTests(unittest.TestCase):
    def test_only_known_documentation_can_skip_runtime(self):
        self.assertTrue(ci.docs_only(["README.md", "AGENTS.md", "docs/API.md",
                                      "docs/archive/qa/evidence/go.txt", "docs/archive/qa/EXECUTION.csv"]))
        for paths in [[], ["Dockerfile"], ["backend/schema.sql"], ["web/src/main.tsx"],
                      ["docs/check.py"], ["docs/../scripts/seed-demo.py"],
                      ["README.md", ".github/workflows/checks.yml"], [".dockerignore"],
                      ["scripts/ci.py"], ["unknown.md"], [".env.example"]]:
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


class WorkflowTests(unittest.TestCase):
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

    def test_local_outputs_and_sandbox_are_excluded_from_docker_context(self):
        ignore = (ci.ROOT / ".dockerignore").read_text().splitlines()
        for path in [".local", "backend/it_proj", "/labturn", "**/node_modules", "**/dist"]:
            self.assertIn(path, ignore)


if __name__ == "__main__":
    unittest.main()
