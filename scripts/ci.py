#!/usr/bin/env python3
"""Small, dependency-free CI helpers: conservative change detection and doc links."""
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SHA = re.compile(r"[0-9a-f]{40}")
LINK = re.compile(r"!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+\"[^\"]*\")?\)")


def docs_only(paths):
    """Unknown paths, scripts in docs, and empty diffs always take the full path."""
    return bool(paths) and all(
        path in {"README.md", "AGENTS.md"}
        or (PurePosixPath(path).parts[:1] == ("docs",)
            and ".." not in PurePosixPath(path).parts
            and PurePosixPath(path).suffix in {".md", ".txt", ".csv"})
        for path in paths
    )


def needs_runtime(event_name, event, head, root=ROOT):
    if event_name == "push":
        base = event.get("before", "")
    elif event_name == "pull_request":
        base = event.get("pull_request", {}).get("base", {}).get("sha", "")
    else:
        return True  # Manual releases and unfamiliar events never skip checks.
    if not SHA.fullmatch(base) or set(base) == {"0"} or not SHA.fullmatch(head):
        return True
    try:
        result = subprocess.run(
            ["git", "--no-pager", "diff", "--name-only", "-z", "--no-renames", base, head, "--"],
            cwd=root, capture_output=True, check=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return True  # Shallow/missing/force-pushed history must fail open to tests.
    paths = [os.fsdecode(path) for path in result.stdout.split(b"\0") if path]
    return not docs_only(paths)


def current_release(head, tip, comparison=None):
    """Do not publish superseded application code; later doc-only commits are OK."""
    if head == tip:
        return True
    if not comparison or comparison.get("status") != "ahead":
        return False
    files = comparison.get("files", [])
    # GitHub returns at most 300 changed files. An incomplete diff cannot approve release.
    if not files or len(files) >= 300:
        return False
    paths = []
    for file in files:
        paths.append(file["filename"])
        if "previous_filename" in file:
            paths.append(file["previous_filename"])
    return docs_only(paths)


def github_json(endpoint):
    result = subprocess.run(["gh", "api", endpoint], capture_output=True, check=True, timeout=30)
    return json.loads(result.stdout)


def broken_doc_links(root=ROOT):
    """Check local file targets, not external URLs or heading anchors."""
    failures = []
    files = [root / "README.md", root / "AGENTS.md", *sorted((root / "docs").rglob("*.md"))]
    for source in files:
        if not source.is_file():
            failures.append(f"Missing document: {source.relative_to(root)}")
            continue
        fenced = False
        for number, line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
            if line.lstrip().startswith(("```", "~~~")):
                fenced = not fenced
                continue
            if fenced:
                continue
            for match in LINK.finditer(line):
                target = urlsplit(match.group(1).strip("<>"))
                if target.scheme or target.netloc or not target.path:
                    continue
                path = unquote(target.path)
                # Absolute links in archived reports refer to machine-local evidence.
                if path.startswith("/"):
                    continue
                resolved = (source.parent / path).resolve()
                if not resolved.exists():
                    failures.append(f"{source.relative_to(root)}:{number}: missing {path}")
    return failures


def main():
    if sys.argv[1:] == ["changes"]:
        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as source:
            event = json.load(source)
        runtime = needs_runtime(os.environ["GITHUB_EVENT_NAME"], event, os.environ["GITHUB_SHA"])
        output = f"runtime={str(runtime).lower()}\n"
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as destination:
            destination.write(output)
        print(output, end="")
    elif sys.argv[1:] == ["current"]:
        repo = os.environ["GITHUB_REPOSITORY"]
        ref = os.environ["GITHUB_REF"]
        head = os.environ["GITHUB_SHA"]
        try:
            tip = github_json(f"repos/{repo}/git/ref/{ref.removeprefix('refs/')}")["object"]["sha"]
            comparison = None if head == tip else github_json(f"repos/{repo}/compare/{head}...{tip}")
            current = current_release(head, tip, comparison)
        except (OSError, subprocess.SubprocessError, ValueError, KeyError):
            print("Unable to verify release freshness; no deployment attempted", file=sys.stderr)
            return 1
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as destination:
            destination.write(f"current={str(current).lower()}\n")
        print("Release is current" if current else "Release superseded by application changes; deployment skipped")
    elif sys.argv[1:] == ["docs"]:
        failures = broken_doc_links()
        if failures:
            print("\n".join(failures), file=sys.stderr)
            return 1
        print("Local Markdown file links OK (external URLs and anchors not checked)")
    else:
        print("Usage: python3 scripts/ci.py {changes|current|docs}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
