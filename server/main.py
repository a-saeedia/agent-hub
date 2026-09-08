"""
main.py — Office Hub: interactive command center (FastAPI).

This is a real hub, not a passive monitor. You type a directive in the browser,
the server runs it headlessly with `opencode run "<directive>"`, streams the
output back over WebSocket, and the 2D canvas character animates while work is
in flight.

Endpoints
    GET  /health          -> status + connected clients
    POST /api/event       -> ingest an external WORK event (watcher/hook.py)
    POST /api/run         -> enqueue a directive for the opencode worker
    GET  /api/status      -> current run state (idle/running, last result)
    WS   /ws              -> broadcast stream (WORK / OUTPUT / RUN_START / RUN_DONE)

Run:
    pip install -r requirements.txt
    uvicorn main:app --host 127.0.0.1 --port 8000

Env:
    OPENCODE_BIN   path to the opencode binary (default: "opencode")
    HUB_WORKDIR    working directory for opencode runs (default: project root)
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

app = FastAPI(title="Office Hub", version="0.2.0")

# The visualizer may be served from a different origin during dev.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend" / "dist"

OPENCODE_BIN = os.environ.get("OPENCODE_BIN", "opencode")
HUB_WORKDIR = os.environ.get("HUB_WORKDIR", str(PROJECT_ROOT))


# --------------------------------------------------------------------------
# WebSocket connection manager
# --------------------------------------------------------------------------
class ConnectionManager:
    def __init__(self) -> None:
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, message: dict[str, Any]) -> None:
        data = json.dumps(message)
        for ws in list(self.active):
            try:
                await ws.send_text(data)
            except Exception:
                self.disconnect(ws)


manager = ConnectionManager()


# --------------------------------------------------------------------------
# Run worker: thread -> asyncio bridge
# --------------------------------------------------------------------------
class RunState:
    """Shared, thread-safe state for the currently running job."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.run_id: str | None = None
        self.directive: str | None = None
        self.exit_code: int | None = None
        self.started_at: float | None = None
        self.finished_at: float | None = None

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "run_id": self.run_id,
                "directive": self.directive,
                "exit_code": self.exit_code,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "running": self.run_id is not None and self.exit_code is None,
            }


state = RunState()

# Thread-safe queue of directives; the worker thread consumes it.
run_queue: "queue.Queue[str]" = queue.Queue()

# asyncio.Queue that the worker fills and a broadcaster task drains.
out_queue: "asyncio.Queue[dict[str, Any]]" = asyncio.Queue()

# The main event loop, captured at startup so worker threads can schedule
# broadcasts thread-safely (get_running_loop() fails inside a worker thread).
_loop: asyncio.AbstractEventLoop | None = None


def _emit(msg: dict[str, Any]) -> None:
    """Thread-safe: schedule a broadcast on the main event loop."""
    loop = _loop
    if loop is not None and loop.is_running():
        loop.call_soon_threadsafe(out_queue.put_nowait, msg)


def _worker() -> None:
    """Consume directives and run `opencode run "<directive>"` headlessly."""
    while True:
        directive = run_queue.get()
        run_id = f"run-{int(time.time() * 1000)}"
        with state.lock:
            state.run_id = run_id
            state.directive = directive
            state.exit_code = None
            state.started_at = time.time()
            state.finished_at = None

        _emit({"type": "RUN_START", "run_id": run_id, "directive": directive})
        _emit({"type": "WORK", "kind": "RUN", "detail": directive[:200]})

        try:
            proc = subprocess.Popen(
                [OPENCODE_BIN, "run", directive],
                cwd=HUB_WORKDIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                _emit({"type": "OUTPUT", "run_id": run_id, "line": line.rstrip("\n")})
            proc.wait()
            exit_code = proc.returncode
        except FileNotFoundError:
            _emit({"type": "OUTPUT", "run_id": run_id,
                   "line": f"[hub] ERROR: '{OPENCODE_BIN}' not found. Set OPENCODE_BIN."})
            exit_code = 127
        except Exception as exc:  # noqa: BLE001
            _emit({"type": "OUTPUT", "run_id": run_id, "line": f"[hub] ERROR: {exc}"})
            exit_code = 1

        with state.lock:
            state.exit_code = exit_code
            state.finished_at = time.time()
        _emit({"type": "RUN_DONE", "run_id": run_id, "exit_code": exit_code})
        run_queue.task_done()


async def _broadcaster() -> None:
    """Drain out_queue and broadcast to all WS clients."""
    while True:
        msg = await out_queue.get()
        await manager.broadcast(msg)


@app.on_event("startup")
async def _startup() -> None:
    global _loop
    _loop = asyncio.get_running_loop()
    threading.Thread(target=_worker, daemon=True, name="opencode-worker").start()
    asyncio.create_task(_broadcaster())


# --------------------------------------------------------------------------
# HTTP + WS routes
# --------------------------------------------------------------------------
class Event(BaseModel):
    type: str = Field(..., description="Event type, e.g. WORK")
    kind: str | None = None
    detail: str | None = None
    at: float | None = None


class RunRequest(BaseModel):
    directive: str = Field(..., min_length=1, description="Directive to run via opencode")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "clients": len(manager.active)}


@app.get("/api/status")
async def api_status() -> dict[str, Any]:
    return state.snapshot()


@app.post("/api/event")
async def api_event(event: Event) -> dict[str, Any]:
    """Ingest an external work event (from watcher/hook.py) and broadcast it."""
    payload = {
        "type": event.type,
        "kind": event.kind,
        "detail": event.detail,
        "at": event.at if event.at is not None else time.time(),
    }
    await manager.broadcast(payload)
    return {"received": True, "clients": len(manager.active)}


@app.post("/api/run")
async def api_run(req: RunRequest) -> dict[str, Any]:
    """Enqueue a directive for the opencode worker."""
    directive = req.directive.strip()
    if not directive:
        return {"accepted": False, "error": "empty directive"}
    run_queue.put(directive)
    return {"accepted": True, "queued": run_queue.qsize()}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await manager.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(ws)


# Serve the built canvas app if it exists (frontend/dist).
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
