# Agent Hub

Two ways to wire two agents (Hermes = planner, NVIDIA Qwen = coder) into
OpenCode, plus an **interactive command center**: type a task in the browser,
the hub runs it headlessly with `opencode run`, streams the output back live,
and a 2D "office" character animates while the work is in flight.

```
agent-hub/
├── opencode.json            Option 1: native agent split (plan/build)
├── .opencode/agent/*.md     plan.md (Hermes) + build.md (Qwen) personas
├── bridge.py                Option 2: autonomous Hermes->OpenCode Boss script
├── watcher/hook.py          tails OpenCode output, POSTs {type: WORK} events
├── server/main.py           FastAPI: /api/run worker + /api/event + WS + serves dist
└── frontend/                Vite office scene: detailed room, animated character, command box
```

---

## Option 1 — Native config bridge (single integrated CLI)

OpenCode is already multi-agent. Open the project from this folder and press
**Tab** to switch between the `plan` agent (Hermes) and `build` agent (Qwen);
they share the same workspace and context.

```text
opencode                  # launch inside agent-hub/
  Tab  -> plan   (Hermes, openrouter)  — architecture/spec
  Tab  -> build  (Qwen, nvidia)        — write code, run tests
```

`opencode.json` here only overrides the agent routing. Providers, permission
rules, and MCP servers inherit from your global
`~/.config/opencode/opencode.jsonc`. Models used:

| Agent | Model | Provider | Key |
|-------|-------|----------|-----|
| plan  | `gemini-3.6-flash` | aistudio | `GEMINI_API_KEY` |
| build | `gemini-3.6-flash` | aistudio | `GEMINI_API_KEY` |

> **Provider note:** the original plan used Hermes (OpenRouter) for planning and
> NVIDIA Qwen for building. Those need `OPENROUTER_API_KEY` / `NVIDIA_API_KEY`,
> which weren't valid/available here, so both agents are pointed at the working
> **Google Gemini** provider (`GEMINI_API_KEY` is set and verified). To switch
> back to Hermes/NVIDIA, set the matching key and update the `model` fields in
> `opencode.json` + `.opencode/agent/*.md`.

## Option 2 — Autonomous script bridge (Hermes bosses OpenCode)

`bridge.py` runs Hermes as an external "Boss" that decides each step, fires
OpenCode headlessly (`opencode run "<directive>"`), reads the result, and
iterates until the objective is met (`[STOP]` emitted by Hermes) or the cycle
budget runs out.

```bash
set OPENROUTER_API_KEY=...     # or put it in .env from .env.example
python bridge.py --goal "Build a FastAPI WS server in /backend and a Vite 16x16 canvas in /frontend"
python bridge.py --goal "..." --cycles 5 --dry-run   # preview without running
python bridge.py --goal "..." --keep-context         # dump context.jsonl
```

## The command center — type a task, watch it run

This is the interactive hub. Open the page, type a directive, hit **Run**; the
server enqueues it, runs `opencode run "<directive>"` headlessly, streams the
output back over WebSocket into the log panel, and the character in the office
scene A* pathfinds to a desk, sits down, and types while the run is active.

The office is a detailed room: desks with monitors, plants, a coffee machine,
a water cooler, a window with a view, and a door. The character walks smoothly
(animated legs, blinking), and types with moving hands and a blinking cursor
while your task runs.

```text
browser (type task) ──POST /api/run──> server worker ──> opencode run "<task>"
        ▲                                    │
        └──────── WS /ws (OUTPUT / RUN_START / RUN_DONE) ──┘
        └──────── canvas character animates while running ──┘
```

### One-click launch (recommended)

Double-click **`start-hub.cmd`**. It sets up the Python venv + deps, builds the
frontend if needed, starts the FastAPI server, and opens your browser to
http://127.0.0.1:8000. Close the window (or Ctrl+C) to stop the server.

### Manual launch

```bash
pip install -r server/requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000   # (from server/)
```

Set `OPENCODE_BIN` (and `HUB_WORKDIR`) in `.env` if `opencode` isn't on PATH
— on this machine: `OPENCODE_BIN=C:\Users\User\tools\node\opencode.cmd`
(`start-hub.cmd` sets this fallback automatically).

For dev with hot reload instead: `cd frontend && npm install && npm run dev`
→ http://localhost:5173 (Vite proxies `/ws` + `/api` to :8000).

### API

| Endpoint | Purpose |
|----------|---------|
| `POST /api/run` | enqueue `{"directive": "..."}` for the opencode worker |
| `GET  /api/status` | current run state (idle/running, last exit code) |
| `POST /api/event` | ingest an external WORK event (from `watcher/hook.py`) |
| `WS   /ws` | broadcast stream: `RUN_START` / `OUTPUT` / `RUN_DONE` / `WORK` |

### External log watcher (optional)

You can also feed the visualizer from any OpenCode session, not just hub runs:

```bash
opencode run "build the thing" 2>&1 | python watcher/hook.py
# or tail a transcript file:
python watcher/hook.py --source .opencode/some/session.jsonl
```

When `hook.py` spots an `edit_file` / `bash` / `read_file` tool call in the
stream, it POSTs `{"type":"WORK","kind":"EDIT"}` to `/api/event`; the server
broadcasts it over `/ws`; the pixel character A* pathfinds to the nearest desk
and plays a typing animation.

### Production (single process)

```bash
cd frontend && npm run build        # -> frontend/dist (served by FastAPI)
uvicorn main:app --port 8000        # serves the app at http://127.0.0.1:8000
```

---

## Files at a glance

| File | Purpose |
|------|---------|
| `opencode.json` | project-scoped agent routing (Option 1) |
| `.opencode/agent/plan.md` | Hermes Lead-Architect persona |
| `.opencode/agent/build.md` | Qwen Builder persona |
| `bridge.py` | Hermes-as-Boss -> `opencode run` loop (Option 2) |
| `start-hub.cmd` | one-click launcher: deps + build + server + open browser |
| `watcher/hook.py` | log watcher -> POSTs WORK events |
| `server/main.py` | FastAPI: `/api/run` worker + event ingest + WS broadcast + static hosting |
| `frontend/src/astar.js` | A* pathfinding over the 16x16 grid |
| `frontend/src/main.js` | command box, live output log, WS connection, typing animation |
