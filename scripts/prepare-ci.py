#!/usr/bin/env python3
"""Parallel CI preparation on Linux/WSL; no app launch or browser tests here."""

import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def preparation(root=ROOT):
    return [
        [
            ("Go race tests", root / "backend", ["go", "test", "-race", "-count=1", "./..."]),
            ("Go vet", root / "backend", ["go", "vet", "./..."]),
            ("Go UI server build", root / "backend", ["go", "build", "-o", "../labturn", "."]),
        ],
        [
            ("npm ci", root / "web", ["npm", "ci"]),
            ("Build UI", root / "web", ["npm", "run", "build"]),
            ("Install headless Chromium", root / "web",
             ["npx", "playwright", "install", "--with-deps", "--only-shell", "chromium"]),
        ],
    ]


def signal_group(process, signum):
    try:
        os.killpg(process.pid, signum)
    except ProcessLookupError:
        pass


def report(stage, status):
    name, process, log, started = stage
    print(f"::group::{name}: {status} ({time.monotonic() - started:.2f}s)", flush=True)
    log.seek(0)
    shutil.copyfileobj(log, sys.stdout)
    print("\n::endgroup::", flush=True)
    log.close()


def run(branches):
    """Fail fast, retain each stage's output, and reap entire child process groups."""
    active = {}
    pending = {index: iter(stages) for index, stages in enumerate(branches)}
    cancelled = 0
    previous = {}

    def cancel(signum, _frame):
        nonlocal cancelled
        cancelled = signum

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.signal(signum, cancel)
        while pending or active:
            if cancelled:
                print(f"Preparation cancelled by signal {cancelled}", flush=True)
                return 128 + cancelled
            # Observe every running branch before starting any dependent stage.
            for index, stage in list(active.items()):
                process = stage[1]
                code = process.poll()
                if code is None:
                    continue
                signal_group(process, signal.SIGKILL)  # No stage may leave background children.
                del active[index]
                report(stage, f"exit {code}")
                if code:
                    return 1
            for index, stages in list(pending.items()):
                if index in active:
                    continue
                stage = next(stages, None)
                if stage is None:
                    del pending[index]
                    continue
                name, cwd, command = stage
                print(f"Starting {name}: {shlex.join(command)}", flush=True)
                started = time.monotonic()
                log = tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace")
                try:
                    process = subprocess.Popen(
                        command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT,
                        start_new_session=True,
                    )
                except OSError as error:
                    log.close()
                    print(f"{name}: failed to start ({time.monotonic() - started:.2f}s): {error}",
                          file=sys.stderr, flush=True)
                    return 1
                active[index] = (name, process, log, started)
            if active:
                time.sleep(0.05)
        return 0
    finally:
        if active:
            for stage in active.values():
                signal_group(stage[1], signal.SIGTERM)
            deadline = time.monotonic() + 2
            # Keep the grace period bounded even if a tool ignores SIGTERM.
            while any(stage[1].poll() is None for stage in active.values()) and time.monotonic() < deadline:
                time.sleep(0.05)
            for stage in active.values():
                signal_group(stage[1], signal.SIGKILL)
                stage[1].wait()
                report(stage, "stopped")
        for signum, handler in previous.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(run(preparation()))
