import { TILE, TOP, edgeNoise, makeWorleyF1, randomGenerator } from './density.js';

export const GROWTH_TOP = TOP * 1.875;
const smooth = v => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };

// Keep site selection and shape draws identical whether or not the sites are grouped.
export function planTowers(w, seed, depth, thickBanks, groups) {
  const zones = 4, layout = randomGenerator(seed ^ 34879), sites = [];
  for (let id = 0; id < zones * zones; id++) {
    const roll = layout(), extra = roll > 0.53;
    if (roll > (thickBanks ? 0.88 : 0.53)) continue;
    const rand = extra ? randomGenerator(seed ^ Math.imul(1 + id, 0x2c1b3c6d)) : layout;
    for (let trial = 0; trial < 10; trial++) {
      const x = Math.floor((id % zones + rand()) * w / zones);
      const z = Math.floor((Math.floor(id / zones) + rand()) * w / zones);
      if (depth[z * w + x] < 1.25) continue;
      sites.push({ id, extra, x, z, angle: rand() * 2 * Math.PI,
        rise: 2.20 + 1.75 * rand(), span: 1.85 + 0.95 * rand(), hasCrown: rand() < 0.68 });
      break;
    }
  }
  if (!groups || !thickBanks) return sites;
  const dx = TILE / w, wrap = ix => (ix % w + w) % w;
  const delta = a => a - w * Math.round(a / w);
  const distance = (a, b) => dx * Math.hypot(delta(a.x - b.x), delta(a.z - b.z));
  const anchors = sites.filter(s => !s.extra);
  const used = new Set();
  // Pair only isolated extra towers. Work on the torus so a tile edge is not a gap.
  for (const s of sites.filter(s => s.extra)) {
    if (used.size >= Math.floor(sites.length / 3)) break;
    if (sites.some(other => other !== s && distance(s, other) < 7.5)) continue;
    const anchor = anchors.filter(a => !used.has(a)).sort((a, b) => distance(s, a) - distance(s, b))[0];
    if (!anchor) continue;
    const rand = randomGenerator(seed ^ Math.imul(s.id + 1, 0x47a31d));
    let best = null, cost = Infinity;
    for (let k = 0; k < 72; k++) {
      const theta = 2 * Math.PI * rand(), r = (5.0 + 1.8 * rand()) / dx;
      const p = { x: wrap(Math.round(anchor.x + Math.cos(theta) * r)),
        z: wrap(Math.round(anchor.z + Math.sin(theta) * r)) };
      const support = depth[p.z * w + p.x], move = distance(s, p);
      if (move > 11 || support < 1.25 ||
          sites.some(other => other !== s && other !== anchor && distance(other, p) < 5)) continue;
      const score = move + 2 * Math.abs(support - depth[s.z * w + s.x]);
      if (score < cost) { best = p; cost = score; }
    }
    if (best) { s.x = best.x; s.z = best.z; used.add(anchor); }
  }
  return sites;
}

// RGBA preserves the four existing feather/Worley combinations at the same voxel pitch.
export function bakeGrowth(w, baseH, seed, plain, feather, lobes, { shoulders = true, billows = true, fine = true, headings = true, thickBanks = true, groups = true } = {}) {
  const h = Math.ceil(baseH * GROWTH_TOP / TOP), dy = TOP / baseH, dx = TILE / w;
  const data = new Uint8Array(w * h * w * 4);
  let usedRows = baseH;
  const depth = new Float32Array(w * w), roof = new Float32Array(w * w);
  const baseRow = thickBanks ? new Uint16Array(w * w).fill(baseH) : null;
  const wrap = i => (i % w + w) % w;
  for (let z = 0; z < w; z++) for (let y = 0; y < baseH; y++) for (let x = 0; x < w; x++) {
    const i = (z * baseH + y) * w + x, j = ((z * h + y) * w + x) * 4;
    data[j] = plain[i]; data[j + 1] = feather[i];
    data[j + 2] = lobes.tufts[i]; data[j + 3] = lobes.fringe[i];
    depth[z * w + x] += plain[i] * dy / 255;
    if (plain[i] > 96) roof[z * w + x] = (y + 0.5) * dy;
    if (baseRow && lobes.fringe[i] && baseRow[z * w + x] === baseH) baseRow[z * w + x] = y;
  }

  const depthAt = (x, z) => depth[wrap(Math.floor(z / dx)) * w + wrap(Math.floor(x / dx))];
  const rough = edgeNoise(29, seed ^ 4327), fringe = edgeNoise(52, seed ^ 1319);
  const f1 = makeWorleyF1(20, 29347 ^ seed);
  const crestTips = [];
  function addPuff(cx, cy, cz, rx, ry, rz, yaw = 0, skin = 1, oldRoof = null, extra = false) {
    // Disturb the ellipsoid in world space. The padding includes its feathered edge.
    const shortest = Math.min(rx, ry, rz), bound = 1 + 0.77 * skin / shortest;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const reachX = bound * Math.hypot(rx * cs, rz * sn), reachZ = bound * Math.hypot(rx * sn, rz * cs);
    for (let z = Math.floor((cz - reachZ) / dx); z <= Math.ceil((cz + reachZ) / dx); z++) {
      const iz = wrap(z), v = (iz + 0.5) / w, dz = (z + 0.5) * dx - cz;
      for (let x = Math.floor((cx - reachX) / dx); x <= Math.ceil((cx + reachX) / dx); x++) {
        const ix = wrap(x), col = iz * w + ix, u = (ix + 0.5) / w;
        // A tower can only grow over an existing bank, never over its wispy skirt.
        const support = smooth((depth[col] - 0.38) / 0.95);
        if (!support || (extra && baseRow[col] === baseH) || (oldRoof && oldRoof(ix, iz) < 0)) continue;
        const ex = (x + 0.5) * dx - cx;
        const nx = (cs * ex + sn * dz) / rx, nz = (-sn * ex + cs * dz) / rz;
        const horizontal = nx * nx + nz * nz;
        if (horizontal >= bound * bound) continue;
        const half = ry * Math.sqrt(bound * bound - horizontal);
        const floor = extra ? baseRow[col] + 1 : 0;
        for (let y = Math.max(floor, Math.floor((cy - half) / dy)); y < Math.min(h, Math.ceil((cy + half) / dy)); y++) {
          const alt = (y + 0.5) * dy, ny = (alt - cy) / ry;
          const edge = (1 - Math.sqrt(horizontal + ny * ny)) * shortest / skin
            + 0.40 * (2 * rough(u * 29, alt * 0.72, v * 29) - 1);
          if (edge <= -0.26) continue;
          const fray = 0.26 * (2 * fringe(u * 52, alt * 1.45, v * 52) - 1);
          const cut = 0.54 * smooth((f1(u * 20, alt * 20 / TILE, v * 20) - 0.24) / 0.58);
          const j = ((iz * h + y) * w + ix) * 4;
          const fill = 255 * support * smooth((alt - Math.max(0.32, roof[col] - 1.0)) / 0.65);
          for (let ch = 0; ch < 4; ch++) {
            const e = edge + ((ch & 1) ? fray : 0) - ((ch & 2) ? cut : 0);
            data[j + ch] = Math.max(data[j + ch], Math.round(fill * smooth(e / 0.65)));
          }
          if (data[j] || data[j + 1]) usedRows = Math.max(usedRows, y + 2);
        }
      }
    }
  }

  function addFamily(form, x, y, z, rx, ry, rz, extra = false) {
    if (!billows) { addPuff(x, y, z, rx, ry, rz, 0, 1, null, extra); return; }
    // A separate stream turns the whole family without rerolling its size or buds.
    const turn = randomGenerator(seed ^ Math.imul(Math.round(x * 64), 73856093)
      ^ Math.imul(Math.round(z * 64), 19349663) ^ Math.round(y * 64) ^ 0x35b547);
    const yaw = headings ? turn() * 2 * Math.PI : 0, cs = Math.cos(yaw), sn = Math.sin(yaw);
    const width = 0.74 + 0.51 * form();
    rx *= width;
    rz *= width * (0.85 + 0.32 * form());
    ry = Math.min(ry * (0.74 + 0.45 * form()), (GROWTH_TOP - y - 0.9) / 1.45);
    addPuff(x, y, z, rx, ry, rz, yaw, 1, null, extra);

    const count = 2 + Math.floor(3 * form());
    let angle = form() * 2 * Math.PI;
    for (let k = 0; k < count; k++) {
      const ring = 0.42 + 0.46 * form();
      const size = 0.27 + 0.31 * form();
      const bx = rx * size, bz = rz * size * (0.80 + 0.40 * form());
      const by = Math.min(ry * 0.70, (bx + bz) * (0.38 + 0.26 * form()));
      // Bury the root in the upper ellipsoid: even side-facing buds join the parent.
      const surface = y + ry * Math.sqrt(1 - ring * ring);
      const skin = Math.min(1, Math.min(bx, by, bz) / 1.05);
      const ox = rx * ring * Math.cos(angle), oz = rz * ring * Math.sin(angle);
      const cx = x + (cs * ox - sn * oz), cz = z + (sn * ox + cs * oz);
      const budYaw = yaw + (headings ? (turn() - 0.5) * 0.8 : 0);
      const cy = surface - 0.26 * by;
      addPuff(cx, cy, cz, bx, by, bz, budYaw, skin, null, extra);
      if (fine && Math.min(bx, bz) > 0.5) {
        // Key the third scale to this bud; never advance the layout or family stream.
        const roll = randomGenerator(seed ^ Math.imul(Math.round((x + ox) * 64), 73856093)
          ^ Math.imul(Math.round((z + oz) * 64), 19349663) ^ Math.round(cy * 64));
        if (roll() < 0.65) {
          const n = 4 + Math.floor(roll() * 4), start = angle - 1.65 + 0.60 * roll();
          const bcs = Math.cos(budYaw), bsn = Math.sin(budYaw);
          for (let k = 0; k < n; k++) {
            const a = start + 2.85 * (k + roll()) / n, r = 0.38 + 0.59 * roll();
            // Horizontal diameters span roughly 3-5 cells at the flight's voxel pitch.
            const radius = 0.28 + 0.19 * roll();
            const tx = bx * r * Math.cos(a), tz = bz * r * Math.sin(a);
            crestTips.push({
              x: cx + (bcs * tx - bsn * tz), z: cz + (bsn * tx + bcs * tz), yaw: budYaw, extra,
              surface: cy + by * Math.sqrt(1 - r * r),
              rx: radius, ry: radius * (0.83 + 0.42 * roll()), rz: radius * (0.88 + 0.20 * roll()),
            });
          }
        }
      }
      angle += 1.70 + 1.28 * form();
    }
  }

  // Low banks get shallow, embedded families only on already thick parts of
  // their roof. Read the original depth and roof, never a previous family's output.
  if (billows) {
    const patches = 7;
    for (let j = 0; j < patches; j++) for (let i = 0; i < patches; i++) {
      const form = randomGenerator(seed ^ Math.imul(1 + j * patches + i, 0x1bd11bdb));
      for (let trial = 0; trial < 5; trial++) {
        const x = Math.floor((i + form()) * w / patches), z = Math.floor((j + form()) * w / patches);
        const col = z * w + x;
        if (depth[col] < 1.30) continue;
        const span = 1.15 + 1.15 * form();
        addFamily(form, (x + 0.5) * dx, roof[col] - 0.45, (z + 0.5) * dx,
          span, 0.80 + 0.52 * form(), span * 0.93);
        break;
      }
    }
  }

  // Independent of bank width: choose a few cloudy shoulders per tile and stack
  // overlapping, successively offset puffs. Nearby banks keep their original roof.
  for (const site of planTowers(w, seed, depth, thickBanks, groups)) {
    const { id, x, z, extra, angle, span, hasCrown } = site;
    const col = z * w + x;
    const cx = (x + 0.5) * dx, cz = (z + 0.5) * dx;
    const ax = Math.cos(angle), az = Math.sin(angle);
    const cy = roof[col] - 0.25;
    const rise = Math.min(site.rise, (GROWTH_TOP - 1.25 - cy) / 1.42);
    // A separate stream per site keeps all subsequent bank positions unchanged.
    const form = randomGenerator(seed ^ Math.imul(id + 1, 0x45d9f3b));
    addFamily(form, cx, cy, cz, span * 1.18, rise * 0.58, span, extra);
    addFamily(form, cx + ax * span * 0.52, cy + rise * 0.43, cz + az * span * 0.52,
      span * 0.91, rise * 0.67, span * 0.85, extra);
    if (hasCrown) {
      addFamily(form, cx + (ax * 0.42 - az * 0.28) * span, cy + rise * 0.94, cz + (az * 0.42 + ax * 0.28) * span,
        span * 0.73, rise * 0.48, span * 0.68, extra);
    }
    if (shoulders) {
      // Grow sideways over the bank, not towards an opening. Check the
      // connecting neck too, so the shoulder reads as part of the same cloud.
      const mx = cx + ax * span * 0.24, mz = cz + az * span * 0.24;
      const sx = -az * span * 1.22, sz = ax * span * 1.22;
      const support = s => Math.min(depthAt(mx + s * sx, mz + s * sz),
        depthAt(mx + s * sx * 0.5, mz + s * sz * 0.5));
      const plus = support(1), minus = support(-1), side = plus >= minus ? 1 : -1;
      if (Math.max(plus, minus) > 0.75) {
        const ry = Math.min(span * 0.78, rise * (hasCrown ? 0.51 : 0.41));
        addFamily(form, mx + side * sx, cy + rise * (hasCrown ? 0.52 : 0.30), mz + side * sz,
          span * 0.92, ry, span * 0.86, extra);
      }
    }
  }
  // Keep one clear interpolation row above the tallest puff. Empty headroom
  // would otherwise consume march samples on shallow rays from above the deck.
  const rows = Math.min(h, usedRows), slice = rows * w * 4;
  if (crestTips.length) {
    // Snapshot each touched column before the first fine stamp writes to it.
    // Tips cannot seed more tips, grow over open water or land on unrelated towers.
    const saved = new Int16Array(w * w).fill(-2);
    const oldRoof = (ix, iz) => {
      const col = iz * w + ix;
      if (saved[col] !== -2) return saved[col];
      let row = rows - 2;
      while (row >= 0 && data[((iz * h + row) * w + ix) * 4 + 3] < 64) row--;
      saved[col] = row;
      return row;
    };
    for (const tip of crestTips) {
      const row = oldRoof(wrap(Math.floor(tip.x / dx)), wrap(Math.floor(tip.z / dx)));
      const surface = (row + 0.5) * dy;
      if (row < 0 || Math.abs(surface - tip.surface) > 0.7) continue;
      const y = surface - 0.15 * tip.ry;
      const skinRatio = 0.65;
      if (y + (1 + 0.77 * skinRatio) * tip.ry >= (rows - 1) * dy) continue;
      addPuff(tip.x, y, tip.z, tip.rx, tip.ry, tip.rz, tip.yaw,
        skinRatio * Math.min(tip.rx, tip.ry, tip.rz), oldRoof, tip.extra);
    }
  }
  if (rows < h) for (let z = 1; z < w; z++) {
    const src = z * h * w * 4;
    data.copyWithin(z * slice, src, src + slice);
  }
  return { data: data.subarray(0, w * slice), height: rows, top: rows * dy };
}
