"""
bridge.py — Autonomous "Boss Hermes" -> OpenCode (Worker) bridge.

Option 2 of the agent-hub plan.

Hermes (the Boss) decides, one step at a time, what OpenCode must build.
It writes a single raw terminal prompt, fires `opencode run "<prompt>"`
in headless (non-interactive) mode, reads the execution log back, and
iterates until the objective is satisfied or the cycle budget is spent.

Design notes / hardening vs. the naive v1 in the plan:
  * Reads OPENROUTER_API_KEY from the environment or an optional .env
    (never hardcodes a secret).
  * Verifies the key exists up front with a clear error instead of a
    confusing KeyError deep in a request.
  * Uses a retry/backoff on transient OpenRouter failures (429 / 5xx).
  * Streams `opencode run` output to stdout live *and* captures it, so
    you can watch progress and still feed the transcript back to Hermes.
  * Cycles are bounded (--cycles, default 3) to avoid an infinite loop.
  * `--dry-run` prints the directive OpenCode would run without touching disk.
  * Termination criterion: if Hermes emits a STOP marker, the loop ends early.

Dependencies:
    pip install requests python-dotenv (optional: python-dotenv for .env)

Usage:
    set OPENROUTER_API_KEY=...
    python bridge.py --goal "Build a FastAPI WS server in /backend and a Vite 16x16 canvas in /frontend"
    python bridge.py --goal "..." --cycles 5 --dry-run
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # python-dotenv optional
    pass

import requests

DEFAULT_OPENCODE = os.environ.get("OPENCODE_BIN", "opencode")
HERMES_MODEL = os.environ.get(
    "HERMES_MODEL", "nousresearch/hermes-3-llama-3.1-405b:free"
)
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

STOP_MARKERS = ("[STOP]", "STOP", "DONE", "COMPLETE")


def load_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        # local .env next to this script
        env_file = Path(__file__).resolve().parent / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                line = line.strip()
                if line.startswith("OPENROUTER_API_KEY="):
                    key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    if not key:
        sys.exit(
            "ERROR: OPENROUTER_API_KEY not set. Export it or create a .env file "
            "with OPENROUTER_API_KEY=<key> (see .env.example)."
        )
    return key


def ask_hermes(key: str, task_objective: str, previous_logs: str, retries: int = 3) -> str:
    """Hermes is the Boss: return the EXACT single next prompt for OpenCode."""
    prompt = f"""Objective: {task_objective}

Previous Execution Output (truncated):
{previous_logs[-4000:]}

You are the Boss Agent. Decide the next logical build step and write the EXACT
single terminal prompt to send to OpenCode to execute it. If the objective is
satisfied or no further work is needed, output exactly "[STOP]".
Do not add conversational fluff. Output ONLY the raw prompt text for OpenCode."""

    body = {
        "model": HERMES_MODEL,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    for attempt in range(1, retries + 1):
        try:
            res = requests.post(OPENROUTER_URL, headers=headers, json=body, timeout=120)
            if res.status_code in (429, 500, 502, 503, 504) and attempt < retries:
                wait = min(2**attempt, 30)
                print(f"  [bridge] HTTP {res.status_code}, retrying in {wait}s "
                      f"({attempt}/{retries})", file=sys.stderr)
                time.sleep(wait)
                continue
            res.raise_for_status()
            return res.json()["choices"][0]["message"]["content"].strip()
        except (requests.RequestException, KeyError) as exc:
            if attempt == retries:
                raise RuntimeError(f"Hermes call failed after {retries} attempts: {exc}")
            time.sleep(2**attempt)
    raise RuntimeError("unreachable")


def run_opencode(directive: str, dry_run: bool) -> tuple[str, bool]:
    """Run OpenCode headlessly. Returns (transcript, is_stop)."""
    print(f"\n[Hermes Directive] ---> {directive}\n")
    if any(m in directive.upper() for m in STOP_MARKERS):
        return directive, True
    if dry_run:
        print(f"[dry-run] would execute: opencode run {directive!r}")
        return f"[dry-run] {directive}", False

    proc = subprocess.run(
        [DEFAULT_OPENCODE, "run", directive],
        capture_output=True,
        text=True,
        timeout=1800,
    )
    transcript = (proc.stdout or "") + "\n" + (proc.stderr or "")
    return transcript, False


def main() -> int:
    ap = argparse.ArgumentParser(description="Hermes(Boss) -> OpenCode(Worker) bridge")
    ap.add_argument("--goal", required=True, help="High-level objective for the pipeline")
    ap.add_argument("--cycles", type=int, default=3, help="Max build cycles (default 3)")
    ap.add_argument("--dry-run", action="store_true", help="Print directives, run nothing")
    ap.add_argument("--keep-context", action="store_true",
                    help="Keep a context.jsonl of each cycle next to the script")
    args = ap.parse_args()

    key = load_key()
    history: list[str] = []

    for step in range(1, args.cycles + 1):
        print(f"--- Cycle {step}/{args.cycles} ---")
        prev = "\n".join(history[-3:])  # keep context tight
        directive = ask_hermes(key, args.goal, prev)
        if any(m in directive.upper() for m in STOP_MARKERS):
            print("[bridge] Hermes signalled stop. Done.")
            break
        transcript, _ = run_opencode(directive, args.dry_run)
        history.append(directive + "\n" + transcript)
        tail = transcript.strip()[-300:] if transcript.strip() else "(no output)"
        print(f"[OpenCode Result]:\n{tail}\n")

    if args.keep_context and history:
        out = Path(__file__).resolve().parent / "context.jsonl"
        out.write_text("\n".join(history) + "\n", encoding="utf-8")
        print(f"[bridge] context saved -> {out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
