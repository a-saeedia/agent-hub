"""
hook.py — Log Watcher: tails OpenCode output and reports work to the visualizer.

Watches a stream (a live `opencode run` stdout/stderr pipe OR a session
transcript file) and, when it sees a work signal — a tool invocation like
edit_file / bash / read_file, or a line that looks like a streamed edit —
POSTs {type: WORK, ...} to the FastAPI server at /api/event.

The FastAPI server broadcasts the event over WebSocket to the 2D canvas
character, which pathfinds to a desk and animates typing.

Design notes:
  * Reads config from env: PRPR_HOST? no — this is the office hub, so:
      WATCHER_SERVER_URL   (default http://127.0.0.1:8000)
      WATCHER_SOURCE       (default "stdin"; or a path to a log file)
      WATCHER_HTTP_TIMEOUT (seconds, default 5)
  * Tails with a line buffer so partial / interleaved lines still match.

Usage:
    # Live pipe: opencode run "do it" 2>&1 | python watcher/hook.py
    # File watch: python watcher/hook.py --source .opencode/session.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

import requests

SERVER_URL = os.environ.get("WATCHER_SERVER_URL", "http://127.0.0.1:8000")
HTTP_TIMEOUT = float(os.environ.get("WATCHER_HTTP_TIMEOUT", "5"))

# Work signals: OpenCode tool calls surfaced in the transcript.
WORK_PATTERNS = {
    "EDIT": re.compile(r'"(?:edit|write|apply)_?file|edit_file|"type"\s*:\s*"edit"', re.I),
    "BASH": re.compile(r'("(?:bash|run|execute)"|"type"\s*:\s*"bash"|bash\s+-c)', re.I),
    "READ": re.compile(r'\b(read|grep|glob|search)_?file\b', re.I),
}


def _classify(line: str) -> str | None:
    for kind, pat in WORK_PATTERNS.items():
        if pat.search(line):
            return kind
    return None


def _post(kind: str, sample: str) -> None:
    payload = {"type": "WORK", "kind": kind, "at": time.time(), "detail": sample[:200]}
    try:
        requests.post(f"{SERVER_URL.rstrip('/')}/api/event", json=payload, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        print(f"[hook] WARN: could not reach {SERVER_URL}: {exc}", file=sys.stderr)


def _tail_stream(stream) -> int:
    """Read lines from an open stream, posting on work signals."""
    count = 0
    buf = ""
    for raw in stream:
        buf += raw
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            kind = _classify(line)
            if kind:
                _post(kind, line)
                count += 1
    if buf:  # flush trailing partial line
        kind = _classify(buf)
        if kind:
            _post(kind, buf)
            count += 1
    return count


def _tail_file(path: str) -> int:
    """Tail a file (follow new lines appended)."""
    count = 0
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        fh.seek(0, os.SEEK_END)  # start at end: only new work
        while True:
            line = fh.readline()
            if line:
                kind = _classify(line)
                if kind:
                    _post(kind, line)
                    count += 1
            else:
                time.sleep(0.5)
    return count


def main() -> int:
    ap = argparse.ArgumentParser(description="OpenCode log watcher -> FastAPI event POSTer")
    ap.add_argument("--source", default=os.environ.get("WATCHER_SOURCE", "stdin"),
                    help="'stdin' or a path to a log file to tail")
    ap.add_argument("--once", action="store_true",
                    help="Exit after reading currently-available input (no loop tail)")
    args = ap.parse_args()

    if args.source.lower() == "stdin":
        n = 0
        for line in sys.stdin:
            kind = _classify(line)
            if kind:
                _post(kind, line)
                n += 1
        print(f"[hook] EOF: posted {n} work event(s)")
        return 0

    if args.once:
        with open(args.source, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
            n = 0
            for line in text.splitlines():
                kind = _classify(line)
                if kind:
                    _post(kind, line)
                    n += 1
        print(f"[hook] scanned {args.source}: posted {n} work event(s)")
        return 0

    try:
        print(f"[hook] tailing {args.source} -> {SERVER_URL}")
        return _tail_file(args.source)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
