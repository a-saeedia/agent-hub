/**
 * astar.js — tiny A* pathfinding over a 2D boolean grid.
 * walls[y][x] === true blocks movement. 4-directional movement.
 */

export function findPath(start, goal, walls) {
  const rows = walls.length;
  const cols = walls[0].length;

  const inBounds = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows;
  const walkable = (x, y) => inBounds(x, y) && !walls[y][x];

  if (!walkable(start[0], start[1]) || goal[0] === start[0] && goal[1] === start[1]) {
    return goal[0] === start[0] && goal[1] === start[1] ? [start] : [];
  }
  if (!walkable(goal[0], goal[1])) return [];

  const key = (x, y) => x + "," + y;
  const g = new Map([[key(start[0], start[1]), 0]]);
  const cameFrom = new Map();
  const open = new Set([key(start[0], start[1])]);
  const h = (x, y) => Math.abs(x - goal[0]) + Math.abs(y - goal[1]);

  const f = (k) => {
    const [x, y] = k.split(",").map(Number);
    return g.get(k) + h(x, y);
  };

  while (open.size) {
    // pick open node with lowest f (and lowest h as tiebreak)
    let cur = null;
    let bestF = Infinity;
    let bestH = Infinity;
    for (const k of open) {
      const fk = f(k);
      const [x, y] = k.split(",").map(Number);
      if (fk < bestF || (fk === bestF && h(x, y) < bestH)) {
        cur = k; bestF = fk; bestH = h(x, y);
      }
    }
    if (cur === key(goal[0], goal[1])) break;

    open.delete(cur);
    const [cx, cy] = cur.split(",").map(Number);
    const gcur = g.get(cur);

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (!walkable(nx, ny)) continue;
      const nk = key(nx, ny);
      const tentative = gcur + 1;
      if (tentative < (g.get(nk) ?? Infinity)) {
        g.set(nk, tentative);
        cameFrom.set(nk, cur);
        open.add(nk);
      }
    }
  }

  let cur = key(goal[0], goal[1]);
  if (!cameFrom.has(cur)) return []; // no path
  const path = [goal];
  while (cur !== key(start[0], start[1])) {
    cur = cameFrom.get(cur);
    if (!cur) break;
    path.push(cur.split(",").map(Number));
  }
  path.reverse();
  return path;
}
