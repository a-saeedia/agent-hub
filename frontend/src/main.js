/**
 * main.js — Office Hub command center.
 *
 * A detailed 2D office scene rendered on a canvas. A character walks around
 * the room (smooth, animated), and when you run a task it walks to a desk,
 * sits down, and types on a keyboard with a blinking cursor while the hub
 * streams output back over WebSocket.
 *
 * Layout is a grid of walkable tiles; furniture (desks, plants, coffee
 * machine, water cooler) are obstacles. The character A* pathfinds between
 * tiles and interpolates smoothly between them.
 */

import { findPath } from "./astar.js";

// ---- canvas / grid ---------------------------------------------------------
const canvas = document.getElementById("office");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

const COLS = 30;
const ROWS = 20;
const CELL = 32; // px per tile
canvas.width = COLS * CELL;   // 960
canvas.height = ROWS * CELL;  // 640

// ---- DOM refs --------------------------------------------------------------
const statusEl = document.getElementById("status");
const directiveEl = document.getElementById("directive");
const goEl = document.getElementById("go");
const logEl = document.getElementById("log");
const connDot = document.getElementById("connDot");
const connText = document.getElementById("connText");

// ---- world -----------------------------------------------------------------
const walls = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
const desks = [];   // {x, y, facing} — character sits in front
const props = [];   // decorative furniture {x, y, kind}

function setWall(x, y, v = true) {
  if (x >= 0 && y >= 0 && x < COLS && y < ROWS) walls[y][x] = v;
}

// Build the room: outer walls
for (let x = 0; x < COLS; x++) { setWall(x, 0); setWall(x, ROWS - 1); }
for (let y = 0; y < ROWS; y++) { setWall(0, y); setWall(COLS - 1, y); }

// A window on the top wall (visual only, not an obstacle)
const windowCells = [];
for (let x = 6; x <= 12; x++) windowCells.push([x, 0]);

// Desks: a row of workstations along the top area, each with a chair in front
const deskSpots = [
  { x: 5,  y: 3 }, { x: 9,  y: 3 }, { x: 13, y: 3 },
  { x: 17, y: 3 }, { x: 21, y: 3 }, { x: 25, y: 3 },
];
deskSpots.forEach((d) => {
  setWall(d.x, d.y);
  desks.push({ x: d.x, y: d.y, facing: "down" });
});

// A couple of desks on the right wall facing left
const rightDesks = [{ x: COLS - 2, y: 6 }, { x: COLS - 2, y: 10 }];
rightDesks.forEach((d) => {
  setWall(d.x, d.y);
  desks.push({ x: d.x, y: d.y, facing: "left" });
});

// Decorative props (obstacles)
const propSpots = [
  { x: 2,  y: 6,  kind: "plant" },
  { x: 2,  y: 12, kind: "plant" },
  { x: 14, y: 16, kind: "coffee" },
  { x: 20, y: 16, kind: "water" },
  { x: 27, y: 3,  kind: "plant" },
];
propSpots.forEach((p) => {
  setWall(p.x, p.y);
  props.push(p);
});

// ---- character -------------------------------------------------------------
const char = {
  col: 1, row: ROWS - 2,       // current tile
  px: 1 * CELL, py: (ROWS - 2) * CELL, // pixel pos (top-left of tile)
  target: null,                 // {col,row} tile being walked to
  path: [],
  pathIdx: 0,
  moving: false,
  facing: "down",               // down/up/left/right
  walkPhase: 0,                 // leg swing
  blink: 0,                     // blink timer
  blinkState: 0,
  typing: false,                // typing at a desk
  typingHand: 0,                // hand bob
  cursorOn: true,
  cursorTimer: 0,
  desk: null,                   // desk being worked at
};

const WALK_SPEED = 0.12; // tiles per frame (60fps)
const TYPING_MS = 2600;

// ---- drawing helpers -------------------------------------------------------
function tileRect(col, row) {
  return [col * CELL, row * CELL, CELL, CELL];
}

function drawFloor() {
  // base floor
  ctx.fillStyle = "#1a1f2b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // subtle checkerboard tiles
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (walls[r][c]) continue;
      ctx.fillStyle = (c + r) % 2 === 0 ? "#1d2330" : "#191f2a";
      ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
    }
  }
  // faint grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.03)";
  ctx.lineWidth = 1;
  for (let c = 0; c <= COLS; c++) {
    ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, canvas.height); ctx.stroke();
  }
  for (let r = 0; r <= ROWS; r++) {
    ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(canvas.width, r * CELL); ctx.stroke();
  }
}

function drawWalls() {
  // top wall with window
  ctx.fillStyle = "#232a38";
  ctx.fillRect(0, 0, canvas.width, CELL);
  // window
  ctx.fillStyle = "#0e1a2b";
  ctx.fillRect(6 * CELL, 2, 7 * CELL, CELL - 4);
  // window panes + sky
  ctx.fillStyle = "#1b3a5c";
  ctx.fillRect(6 * CELL + 3, 5, 3 * CELL - 6, CELL - 12);
  ctx.fillRect(9 * CELL + 3, 5, 3 * CELL - 6, CELL - 12);
  ctx.fillStyle = "#2a4a6e";
  ctx.fillRect(6 * CELL + 3, 5, 3 * CELL - 6, 4);
  ctx.fillRect(9 * CELL + 3, 5, 3 * CELL - 6, 4);
  // window frame
  ctx.strokeStyle = "#3a4a5e";
  ctx.lineWidth = 2;
  ctx.strokeRect(6 * CELL, 2, 7 * CELL, CELL - 4);
  ctx.beginPath(); ctx.moveTo(9.5 * CELL, 2); ctx.lineTo(9.5 * CELL, CELL - 2); ctx.stroke();

  // other walls
  ctx.fillStyle = "#232a38";
  ctx.fillRect(0, 0, CELL, canvas.height);          // left
  ctx.fillRect(canvas.width - CELL, 0, CELL, canvas.height); // right
  ctx.fillRect(0, canvas.height - CELL, canvas.width, CELL); // bottom
  // door on bottom wall
  ctx.fillStyle = "#2c3a4a";
  ctx.fillRect(14 * CELL, canvas.height - CELL, 2 * CELL, CELL);
  ctx.fillStyle = "#3a4a5e";
  ctx.fillRect(14 * CELL + 4, canvas.height - CELL + 4, 2 * CELL - 8, CELL - 8);
  ctx.fillStyle = "#d29922";
  ctx.fillRect(15 * CELL + 4, canvas.height - CELL + 14, 3, 3); // handle
}

function drawDesk(d) {
  const [x, y] = [d.x, d.y];
  const px = x * CELL, py = y * CELL;
  // desk top
  ctx.fillStyle = "#3a4a5e";
  ctx.fillRect(px + 2, py + 4, CELL - 4, CELL - 8);
  // monitor
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(px + 6, py + 8, CELL - 12, CELL - 18);
  ctx.fillStyle = "#58a6ff";
  ctx.fillRect(px + 8, py + 10, CELL - 16, CELL - 24);
  // monitor stand
  ctx.fillStyle = "#2a3441";
  ctx.fillRect(px + CELL / 2 - 2, py + CELL - 14, 4, 6);
  // keyboard (in front, on the chair side)
  ctx.fillStyle = "#1c2330";
  ctx.fillRect(px + 4, py + CELL - 6, CELL - 8, 3);
}

function drawProp(p) {
  const [x, y] = [p.x, p.y];
  const px = x * CELL, py = y * CELL;
  if (p.kind === "plant") {
    // pot
    ctx.fillStyle = "#7a4a2a";
    ctx.fillRect(px + 8, py + CELL - 10, CELL - 16, 8);
    // leaves
    ctx.fillStyle = "#3fb950";
    ctx.fillRect(px + 12, py + 6, 4, CELL - 16);
    ctx.fillRect(px + 16, py + 8, 4, CELL - 18);
    ctx.fillRect(px + 8, py + 10, 4, CELL - 18);
  } else if (p.kind === "coffee") {
    // machine body
    ctx.fillStyle = "#2a3441";
    ctx.fillRect(px + 6, py + 8, CELL - 12, CELL - 16);
    ctx.fillStyle = "#1c2330";
    ctx.fillRect(px + 8, py + 10, CELL - 16, CELL - 20);
    // cup
    ctx.fillStyle = "#e6edf3";
    ctx.fillRect(px + 12, py + 4, 8, 6);
    ctx.fillStyle = "#7a4a2a";
    ctx.fillRect(px + 13, py + 5, 6, 4);
  } else if (p.kind === "water") {
    // cooler
    ctx.fillStyle = "#2a3441";
    ctx.fillRect(px + 8, py + 6, CELL - 16, CELL - 14);
    ctx.fillStyle = "#58a6ff";
    ctx.fillRect(px + 10, py + 8, CELL - 20, CELL - 20);
    // spigot
    ctx.fillStyle = "#8b98a9";
    ctx.fillRect(px + 14, py + CELL - 12, 4, 4);
  }
}

// ---- character drawing -----------------------------------------------------
function drawCharacter() {
  const px = char.px, py = char.py;
  const cx = px + CELL / 2, cy = py + CELL / 2;

  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath();
  ctx.ellipse(cx, py + CELL - 4, 9, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // legs (walking swing)
  const swing = char.moving ? Math.sin(char.walkPhase) * 3 : 0;
  ctx.fillStyle = "#2a3441";
  ctx.fillRect(cx - 5, py + CELL - 12, 4, 8 + swing);
  ctx.fillRect(cx + 1, py + CELL - 12, 4, 8 - swing);

  // body
  ctx.fillStyle = "#58a6ff";
  ctx.fillRect(cx - 6, py + 8, 12, 12);

  // arms (typing bob)
  if (char.typing) {
    const bob = Math.sin(char.typingHand) * 1.5;
    ctx.fillStyle = "#3b82f6";
    ctx.fillRect(cx - 8, py + 12 + bob, 4, 6);
    ctx.fillRect(cx + 4, py + 12 - bob, 4, 6);
  } else {
    ctx.fillStyle = "#3b82f6";
    ctx.fillRect(cx - 8, py + 12, 4, 6);
    ctx.fillRect(cx + 4, py + 12, 4, 6);
  }

  // head
  ctx.fillStyle = "#e6c9a8";
  ctx.fillRect(cx - 5, py + 1, 10, 9);

  // eyes (blink)
  const eyeY = py + 4;
  if (char.blinkState === 0) {
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(cx - 3, eyeY, 2, 2);
    ctx.fillRect(cx + 1, eyeY, 2, 2);
  } else {
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(cx - 3, eyeY + 1, 2, 1);
    ctx.fillRect(cx + 1, eyeY + 1, 2, 1);
  }

  // typing cursor bubble above head
  if (char.typing && char.cursorOn) {
    ctx.fillStyle = "#d29922";
    ctx.fillRect(cx - 1, py - 6, 3, 3);
  }
}

// ---- scene render ----------------------------------------------------------
function draw() {
  drawFloor();
  drawWalls();
  props.forEach(drawProp);
  desks.forEach(drawDesk);
  drawCharacter();
}

// ---- movement --------------------------------------------------------------
function startWalkTo(col, row) {
  const path = findPath([char.col, char.row], [col, row], walls);
  if (!path || path.length === 0) return;
  char.path = path;
  char.pathIdx = 0;
  char.moving = true;
}

function updateMovement() {
  if (!char.moving) return;
  const target = char.path[char.pathIdx];
  if (!target) { char.moving = false; return; }

  const [tc, tr] = target;
  const tx = tc * CELL, ty = tr * CELL;

  // face direction
  if (tx > char.px) char.facing = "right";
  else if (tx < char.px) char.facing = "left";
  else if (ty > char.py) char.facing = "down";
  else if (ty < char.py) char.facing = "up";

  // move toward target
  const dx = tx - char.px, dy = ty - char.py;
  const dist = Math.hypot(dx, dy);
  const step = WALK_SPEED * CELL;
  if (dist <= step) {
    char.px = tx; char.py = ty;
    char.col = tc; char.row = tr;
    char.pathIdx++;
    if (char.pathIdx >= char.path.length) {
      char.moving = false;
      char.path = [];
    }
  } else {
    char.px += (dx / dist) * step;
    char.py += (dy / dist) * step;
  }
  char.walkPhase += 0.35;
}

// ---- work / typing ---------------------------------------------------------
function goWork() {
  // pick nearest desk
  let best = null, bestDist = Infinity;
  desks.forEach((d) => {
    const dist = Math.abs(d.col - d.x) + Math.abs(d.row - d.y);
    if (dist < bestDist) { bestDist = dist; best = d; }
  });
  if (!best) return;
  // stand in front of the desk (facing side)
  let standCol = best.x, standRow = best.y;
  if (best.facing === "down") standRow = best.y + 1;
  else if (best.facing === "left") standCol = best.x - 1;
  else if (best.facing === "right") standCol = best.x + 1;
  else standRow = best.y - 1;

  char.desk = best;
  startWalkTo(standCol, standRow);
  // after arriving, start typing
  char.typing = false;
  char.typingUntil = 0;
}

function updateTyping() {
  if (char.typing) {
    char.typingHand += 0.4;
    char.cursorTimer++;
    if (char.cursorTimer > 20) { char.cursorTimer = 0; char.cursorOn = !char.cursorOn; }
    if (Date.now() > char.typingUntil) {
      char.typing = false;
      if (!running) setStatus("idle — type a task above", false, "");
    }
  }
}

// ---- status / log ----------------------------------------------------------
function setStatus(text, typing, cls) {
  statusEl.innerHTML = "";
  if (typing) {
    const p = document.createElement("span");
    p.className = "pulse";
    statusEl.appendChild(p);
  }
  statusEl.appendChild(document.createTextNode(text));
  statusEl.className = cls || "";
}

function logLine(text, cls) {
  if (logEl.firstElementChild && logEl.firstElementChild.classList.contains("empty")) {
    logEl.innerHTML = "";
  }
  const div = document.createElement("div");
  div.className = cls || "out";
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---- run lifecycle ---------------------------------------------------------
let running = false;

function onRunStart(directive) {
  running = true;
  goEl.disabled = true;
  setStatus(`running: ${directive}`, true, "running");
  logLine(`▶ ${directive}`, "meta");
  goWork();
}

function onOutput(line) {
  const cls = /error|traceback|failed|exception/i.test(line) ? "err" : "out";
  logLine(line, cls);
}

function onRunDone(exitCode) {
  running = false;
  goEl.disabled = false;
  const ok = exitCode === 0;
  setStatus(ok ? "done ✓" : `done ✗ (exit ${exitCode})`, false, ok ? "done-ok" : "done-err");
  logLine(ok ? "— finished (0) —" : `— finished (${exitCode}) —`, "meta");
  char.typing = false;
}

async function submit() {
  const directive = directiveEl.value.trim();
  if (!directive || running) return;
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directive }),
    });
    const data = await res.json();
    if (!data.accepted) logLine(`[hub] rejected: ${data.error || "unknown"}`, "err");
  } catch (err) {
    logLine(`[hub] could not reach server: ${err}`, "err");
  }
}

// ---- main loop -------------------------------------------------------------
let last = performance.now();
function loop(now) {
  const dt = Math.min(now - last, 50) / 16.67; // normalize to ~60fps
  last = now;

  updateMovement();
  updateTyping();

  // blink
  char.blink++;
  if (char.blink > 90) { char.blinkState = 1; }
  if (char.blink > 96) { char.blinkState = 0; char.blink = 0; }

  // when a walk finishes and we were heading to a desk, start typing
  if (!char.moving && char.desk && !char.typing && running) {
    char.typing = true;
    char.typingUntil = Date.now() + TYPING_MS;
  }

  draw();
  requestAnimationFrame(loop);
}

// ---- websocket -------------------------------------------------------------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws`;
  const ws = new WebSocket(url);
  ws.onopen = () => {
    connDot.className = "dot on";
    connText.textContent = "connected";
    setStatus("connected — type a task above", false, "");
  };
  ws.onclose = () => {
    connDot.className = "dot off";
    connText.textContent = "disconnected — retrying…";
    setTimeout(connect, 2000);
  };
  ws.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data.type === "RUN_START") onRunStart(data.directive);
      else if (data.type === "OUTPUT") onOutput(data.line);
      else if (data.type === "RUN_DONE") onRunDone(data.exit_code);
      else if (data.type === "WORK") { if (!running) goWork(); }
    } catch (e) { /* ignore malformed */ }
  };
}

// ---- events ----------------------------------------------------------------
goEl.addEventListener("click", submit);
directiveEl.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    directiveEl.value = chip.dataset.task;
    submit();
  });
});

// ---- boot ------------------------------------------------------------------
connect();
requestAnimationFrame(loop);
