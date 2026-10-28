// LunaLattice battle controller v1 (season 2 "Drafted")
// Strategy: role-based squad. Scout = spotter (keeps distance, spots enemies),
// MBT = objective pusher (holds ground, focus fire), artillery = standoff
// support (stays beyond enemy direct range, fires on priority targets).
// All positions fixed-point (tiles x 65536); angles 0..4095; ints only.

const FP = 65536;
const FULL = 4096;

let rules, map, side, hill;
let lastSeen = {};      // unitId -> [x,y,tick] memory of contacts
let tickCount = 0;

function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
function angleTo(ax, ay, bx, by) { return Math.round((Math.atan2(by - ay, bx - ax) / (2 * Math.PI)) * FULL) & (FULL - 1); }
function angDiff(a, b) { let d = (b - a) & (FULL - 1); return d > FULL / 2 ? d - FULL : d; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function passable(x, y) {
  const tx = Math.floor(x / FP), ty = Math.floor(y / FP);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return false;
  const t = map.terrain[ty * map.width + tx];
  return t !== 2 && t !== 4 && t !== 6; // 2 water, 4 rock, 6 ruin
}
function objectiveScore(o, x, y) {
  return o.weight / (1 + dist(x, y, o.x, o.y) / FP);
}
// physically closest objective: light units hold whatever they stand on
// (a held point scores while you are in it; abandoning it hands points back)
function guardPoint(objectives, x, y) {
  let best = null, bestD = Infinity;
  for (const o of objectives || []) {
    const d = dist(x, y, o.x, o.y);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best ? [best.x, best.y] : null;
}
function pickObjective(objectives, x, y, preferClose) {
  // candidates: not owned by us; prefer enemy-held (flip) > empty (claim)
  let best = null, bestScore = -Infinity;
  for (const o of objectives || []) {
    if (o.owner === side && o.state === "held") continue; // already ours
    let s = (o.weight || 1) * 1e6 - dist(x, y, o.x, o.y); // nearest valuable point
    if (o.owner === (1 - side)) s += 5e5; // slight preference for flips
    if (s > bestScore) { bestScore = s; best = o; }
  }
  return best ? [best.x, best.y] : hill;
}
// priority target: closest low-hp enemy; remember last position if unseen
function priorityTarget(u, contacts) {
  let best = null, bestScore = -Infinity;
  for (const c of contacts) {
    const d = dist(u.x, u.y, c.x, c.y);
    const score = (c.hp || 100) * -1 + 200000 / (1 + d / FP);
    if (score > bestScore) { bestScore = score; best = { x: c.x, y: c.y, hp: c.hp, d: d, id: c.id }; }
  }
  return best;
}
// per-unit stuck memory for backoff
const stuckMem = new Map();
function steerTowards(u, gx, gy, spec) {
  let chosen = angleTo(u.x, u.y, gx, gy);
  // stuck backoff: if blocked (or barely moving) for several ticks, reverse then swing
  let sm = stuckMem.get(u.id);
  if (!sm) { sm = { lastX: u.x, lastY: u.y, still: 0, until: 0, steer: 0 }; stuckMem.set(u.id, sm); }
  if (tickCount < sm.until) {
    const d0 = angDiff(u.heading, sm.steer);
    return { id: u.id,
      steer: clamp(Math.round((d0 * FP) / Math.max(1, spec.turnRate)), -FP, FP),
      throttle: -Math.round(FP * 0.5) };
  }
  const moved = Math.abs(u.x - sm.lastX) + Math.abs(u.y - sm.lastY) > FP * 0.5;
  if (u.blocked && !moved) sm.still++;
  else sm.still = Math.max(0, sm.still - 1);
  sm.lastX = u.x; sm.lastY = u.y;
  if (sm.still > 8) {
    sm.until = tickCount + 14;
    sm.steer = (u.id + (tickCount >> 4)) % 2 === 0 ? FP : -FP;
    sm.still = 0;
  }
  const d = angDiff(u.heading, chosen);
  const order = { id: u.id };
  // steer = fraction of turnRate this tick; d in ANG units, turnRate in ANG/tick.
  order.steer = clamp(Math.round((d * FP) / Math.max(1, spec.turnRate)), -FP, FP);
  order.throttle = Math.abs(d) > 512 ? Math.round(FP * 0.25) : FP;
  return order;
}

globalThis.controller = {
  draft(h) {
    const d = h.draft;
    if (!d) return undefined;
    // role-based squad: MBT (push) + artillery (standoff) + scout (spot) + drone (cheap screen)
    // cost = mbt4 + artillery4 + scout2 + drone2 = 12 = budget exactly
    const pick = ["mbt", "artillery", "scout", "drone"];
    const cost = pick.reduce((c, k) => c + (d.costs[k] ?? 99), 0);
    return cost <= d.budget && pick.every(k => d.roster.includes(k)) ? pick : undefined;
  },

  hello(h) {
    rules = h.rules; map = h.map; side = h.side;
    hill = [Math.floor(map.width / 2) * FP + FP / 2, Math.floor(map.height / 2) * FP + FP / 2];
    tickCount = 0;
    lastSeen = {};
  },

  tick(o) {
    tickCount++;
    const units = [];
    const orders = {};
    // first pass: gather targets per unit
    const plan = [];
    for (const u of o.units) {
      if (!u.alive) continue;
      const spec = rules.units[u.kind];
      const tgt = priorityTarget(u, o.contacts);
      if (tgt) lastSeen[tgt.id || (tgt.x + ":" + tgt.y)] = [tgt.x, tgt.y, tickCount];
      plan.push({ u, spec, tgt });
    }
    // focus fire: pick the enemy most of our units can hit (cluster)
    let focus = null, focusCount = 0;
    const tally = {};
    for (const p of plan) {
      if (p.tgt) {
        const key = p.tgt.x + ":" + p.tgt.y;
        tally[key] = (tally[key] || 0) + 1;
        if (tally[key] > focusCount) { focusCount = tally[key]; focus = p.tgt; }
      }
    }
    for (const p of plan) {
      const u = p.u, spec = p.spec;
      const order = { id: u.id };
      const tgt = p.tgt || (focus ? { x: focus.x, y: focus.y, d: dist(u.x, u.y, focus.x, focus.y) } : null);
      const hpFrac = (u.hp || 1) / (spec.hp || 1);

      if (u.kind === "scout" || u.kind === "drone") {
        // spotter/screen: guard the closest un-owned objective (hold it), only
        // back off from direct-fire threats that come inside our own range
        let goal;
        const guard = guardPoint(o.objectives, u.x, u.y);
        if (tgt && tgt.d < spec.gun.maxRange * 0.9) {
          goal = [u.x * 2 - tgt.x, u.y * 2 - tgt.y]; // back off
        } else if (guard && dist(u.x, u.y, guard[0], guard[1]) > FP * 3) {
          goal = guard; // push in and hold
        } else if (guard) {
          goal = [guard[0] + ((u.id % 3) - 1) * FP * 2, guard[1] + ((u.id % 2) - 0.5) * FP * 2]; // jitter inside
        } else {
          goal = pickObjective(o.objectives, u.x, u.y, true);
        }
        if (goal && o.canMove) Object.assign(order, steerTowards(u, goal[0], goal[1], spec));
        if (tgt && spec.gun.mode === "direct") {
          order.aimAt = [tgt.x, tgt.y];
          const aimed = Math.abs(angDiff(u.turret, angleTo(u.x, u.y, tgt.x, tgt.y))) <= spec.gun.aimTolerance;
          if (u.reload === 0 && u.ammo !== 0 && aimed && tgt.d <= spec.gun.maxRange) order.fire = true;
        }
      } else if (u.kind === "artillery") {
        // standoff: keep beyond minRange+margin of direct enemies, bomb priority
        let goal = null;
        if (tgt && tgt.d < spec.gun.minRange * 1.6) goal = [u.x * 2 - tgt.x, u.y * 2 - tgt.y];
        if (!goal) goal = pickObjective(o.objectives, u.x, u.y, false);
        if (goal && o.canMove) Object.assign(order, steerTowards(u, goal[0], goal[1], spec));
        if (tgt && u.reload === 0 && u.ammo !== 0 && tgt.d >= spec.gun.minRange && tgt.d <= spec.gun.maxRange) {
          order.fire = [tgt.x, tgt.y];
        }
      } else {
        // MBT: push objective unless close enemy or hurt
        let goal;
        if (hpFrac < 0.3 && tgt && tgt.d < spec.gun.maxRange) {
          goal = [u.x * 2 - tgt.x, u.y * 2 - tgt.y]; // retreat when hurt
        } else if (tgt && tgt.d < spec.gun.maxRange * 0.8) {
          goal = null; // hold and shoot
        } else {
          goal = pickObjective(o.objectives, u.x, u.y, false);
        }
        if (goal && o.canMove) Object.assign(order, steerTowards(u, goal[0], goal[1], spec));
        if (tgt && spec.gun.mode === "direct") {
          order.aimAt = [tgt.x, tgt.y];
          const aimed = Math.abs(angDiff(u.turret, angleTo(u.x, u.y, tgt.x, tgt.y))) <= spec.gun.aimTolerance;
          if (u.reload === 0 && u.ammo !== 0 && aimed && tgt.d <= spec.gun.maxRange) order.fire = true;
        } else if (tgt && spec.gun.mode !== "none" && u.reload === 0 && u.ammo !== 0 && tgt.d >= (spec.gun.minRange || 0) && tgt.d <= spec.gun.maxRange) {
          order.fire = [tgt.x, tgt.y];
        }
      }
      units.push(order);
    }
    return { units };
  },
};
