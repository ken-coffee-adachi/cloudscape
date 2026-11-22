export const TILE = 48;
export const TOP = 5;
export const BANK_LIFT = 3;

const clamp = (t) => Math.max(0, Math.min(t, 1));
const fade = (x) => { const t = clamp(x); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

export function randomGenerator(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function edgeNoise(size, seed = 3929) {
  const random = randomGenerator(seed);
  // Duplicate the first faces at the far edge so corner lookups need no individual wrapping.
  const pitch = size + 1, plane = pitch * pitch, grid = new Float32Array(pitch ** 3);
  for (let z = 0; z < size; z++) {
    const slab = z * plane;
    for (let y = 0; y < size; y++) {
      const row = slab + y * pitch;
      for (let x = 0; x < size; x++) grid[row + x] = random();
      grid[row + size] = grid[row];
    }
    grid.copyWithin(slab + size * pitch, slab, slab + pitch);
  }
  grid.copyWithin(size * plane, 0, plane);
  const wrap = i => { const r = i % size; return r < 0 ? r + size : r; };
  return (x, y, z) => {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    const u = fade(x - i), v = fade(y - j), w = fade(z - k);
    const n = wrap(k) * plane + wrap(j) * pitch + wrap(i);
    const a = mix(grid[n], grid[n + 1], u);
    const b = mix(grid[n + pitch], grid[n + pitch + 1], u);
    const c = mix(grid[n + plane], grid[n + plane + 1], u);
    const d = mix(grid[n + plane + pitch], grid[n + plane + pitch + 1], u);
    return mix(mix(a, b, v), mix(c, d, v), w);
  };
}

// One jittered feature per cell. F1 is capped at one cell, so 27 neighbors suffice.
export function makeWorleyF1(cells, seed) {
  const points = Float32Array.from({ length: cells ** 3 * 3 }, randomGenerator(seed));
  const wrap = i => (i % cells + cells) % cells;
  return (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    let best = 1;
    for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) {
      const row = (wrap(iz + k) * cells + wrap(iy + j)) * cells;
      for (let i = -1; i <= 1; i++) {
        const n = 3 * (row + wrap(ix + i));
        const dx = i + points[n] - fx, dy = j + points[n + 1] - fy, dz = k + points[n + 2] - fz;
        best = Math.min(best, dx * dx + dy * dy + dz * dz);
      }
    }
    return Math.sqrt(best);
  };
}

const MAX_LOBE_CUT = 0.72;
function lobeMask(edge, depth, distance) {
  const cut = MAX_LOBE_CUT * fade((depth - 0.75) / 1.15) * fade((distance - 0.24) / 0.58);
  // Retract the shoulder between features, retaining the baked wisps within it.
  const ramp = e => fade((e + 0.34) / 0.99);
  return ramp(edge - cut) / ramp(edge);
}

// Move the outer end of the density ramp, leaving its dense inner end fixed.
export function featherDensity(inside, pattern, room) {
  const shift = mix(-0.29, 0.34, fade((pattern - 0.32) / 0.42));
  const reach = shift > 0 ? shift * room : shift;
  return fade((inside + reach) / (0.65 + reach));
}

const MAX_BANK_RADIUS = 1.38; // In placement cells.

export function bankDimensions(sizeRoll, widthRoll, riseRoll) {
  const width = sizeRoll < 0.27 ? mix(0.49, 0.67, widthRoll)
    : sizeRoll < 0.82 ? mix(0.81, 1.02, widthRoll)
    : mix(1.15, MAX_BANK_RADIUS, widthRoll);
  const height = 0.65 + 2.13 * width + 0.24 * (riseRoll - 0.5);
  return { width, height };
}

export function bankSurface(r2, along, peak, slope) {
  const dome = mix(-1.4, peak, fade(1 - r2));
  if (dome <= 0 || along * slope <= 0) return dome;
  // Bend only the positive shoulder: the crown and the zero-height shoreline stay put.
  const weight = Math.abs(slope) * fade(Math.abs(along) / 0.42);
  return dome * mix(1, (dome / peak) ** 2, weight);
}

// A short saddle with a higher summit on +u and a broad, lower shoulder on -u.
export function crestDip(u, v) {
  const r2 = u * u + v * v;
  const neck = (u + 0.06 - 0.18 * v) / 0.48;
  const notch = fade(1 - neck * neck - (v / 0.74) ** 2);
  return fade((0.90 - r2) / 0.55) * (0.37 * notch + 0.18 * fade((0.30 - u) / 0.72));
}

// Banks that overlap through a substantial depth share a local condensation level.
// Only borrow from a broader bank that retains its own level, never across a chain.
function shareBankLifts(banks, cells) {
  const order = banks.map((_, i) => i).sort((i, j) => banks[j].width - banks[i].width);
  const anchors = [];
  const wrapDelta = d => d - cells * Math.round(d / cells);
  const topAt = (bank, dx, dz) => {
    const u = (dx * bank.cs + dz * bank.sn) / bank.width;
    const v = (dz * bank.cs - dx * bank.sn) / bank.depth;
    return bankSurface(u * u + v * v, u, bank.height, bank.slope);
  };
  for (const i of order) {
    const a = banks[i];
    let best = 0, level = a.lift;
    for (const j of anchors) {
      const b = banks[j];
      const dx = wrapDelta(j % cells + b.x - (i % cells + a.x));
      const dz = wrapDelta(Math.floor(j / cells) + b.z - (Math.floor(i / cells) + a.z));
      if (dx * dx + dz * dz >= (a.width + b.width) ** 2) continue;
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        const neck = Math.min(topAt(a, dx * t, dz * t), topAt(b, dx * (t - 1), dz * (t - 1)));
        if (neck > best) { best = neck; level = b.lift; }
      }
    }
    // A thin wisp does not join two bases; a 1.35-unit overlap fully joins them.
    const w = fade(best - 0.35);
    if (w === 0) anchors.push(i);
    else a.lift = mix(a.lift, level, w);
  }
}

// Coordinates are fractions of a tile. Large banks reach beyond adjacent cells.
function scatteredBankHeight(seed, altitudes, crestDips, altitudeScale, sharedBases) {
  const cells = 7, rand = randomGenerator(4371 ^ seed);
  const sizeRoll = randomGenerator(6231 ^ seed);
  const elevationRoll = randomGenerator(31469 ^ seed);
  const crestRoll = randomGenerator(0x56e91 ^ seed);
  const reach = Math.ceil(MAX_BANK_RADIUS);
  const bend = edgeNoise(9, 10169 ^ seed);
  const banks = Array.from({ length: cells * cells }, () => {
    const angle = rand() * Math.PI;
    const widthRoll = rand(), x = rand(), z = rand(), aspect = 0.65 + 0.3 * rand();
    const { width, height } = bankDimensions(sizeRoll(), widthRoll, rand());
    const crestAngle = crestRoll() * 2 * Math.PI;
    const strength = crestRoll() < 0.55 && width >= 0.75 ? 0.78 + 0.24 * crestRoll() : 0;
    return {
      x, z, cs: Math.cos(angle), sn: Math.sin(angle), width, depth: width * aspect, height, slope: 0,
      lift: (2 * elevationRoll() - 1) * BANK_LIFT * altitudeScale,
      crestCos: Math.cos(crestAngle), crestSin: Math.sin(crestAngle), strength,
    };
  });
  const wrap = (i) => (i % cells + cells) % cells;
  function heightAt(x, z, column = -1) {
    const cx = Math.floor(x), cz = Math.floor(z);
    let top = -1.4;
    let weightedLift = 0, weightedDip = 0, weights = 0;
    for (let j = cz - reach; j <= cz + reach; j++) for (let i = cx - reach; i <= cx + reach; i++) {
      const b = banks[wrap(j) * cells + wrap(i)];
      const dx = x - (i + b.x), dz = z - (j + b.z);
      const a = (dx * b.cs + dz * b.sn) / b.width, c = (dz * b.cs - dx * b.sn) / b.depth;
      const r2 = a * a + c * c;
      if (r2 >= 1) continue;
      top = Math.max(top, bankSurface(r2, a, b.height, b.slope));
      if ((altitudes || crestDips) && column >= 0) {
        const weight = (1 - r2) ** 3;
        weightedLift += b.lift * weight;
        if (crestDips && b.strength) {
          const u = a * b.crestCos + c * b.crestSin, v = c * b.crestCos - a * b.crestSin;
          weightedDip += weight * b.strength * crestDip(u, v);
        }
        weights += weight;
      }
    }
    if (altitudes && column >= 0) altitudes[column] = weightedLift / Math.max(0.015, weights);
    if (crestDips && column >= 0) crestDips[column] = weightedDip / Math.max(0.12, weights);
    return top;
  }
  // Probe both ends on the original domes before applying any slopes.
  const randSlope = randomGenerator(14557 ^ seed);
  const slopes = banks.map((b, i) => {
    if (randSlope() < 0.25) return 0;
    const x = i % cells + b.x, z = Math.floor(i / cells) + b.z;
    const dx = b.cs * b.width, dz = b.sn * b.width;
    const delta = heightAt(x - dx, z - dz) - heightAt(x + dx, z + dz);
    const side = Math.abs(delta) < 0.1 ? (randSlope() < 0.5 ? -1 : 1) : Math.sign(delta);
    return side * mix(0.8, 0.96, randSlope());
  });
  banks.forEach((b, i) => { b.slope = slopes[i]; });
  if (altitudes && sharedBases) shareBankLifts(banks, cells);
  return (u, w, column) => {
    const x = u * cells + 0.55 * (bend(u * 9, 0, w * 9) - 0.5);
    const z = w * cells + 0.55 * (bend(u * 9, 1, w * 9) - 0.5);
    return heightAt(x, z, column);
  };
}

export function bakeDensity(width = 160, height = 48, wisps = null, relief = null, tufts = null, fringe = null, layoutSeed = 0, lobes = null, { banksOnly = false, altitudes, crestDips, rimLifts, altitudeScale = 0.5, sharedBases = true } = {}) {
  const count = width * height * width;
  const data = banksOnly ? null : new Uint8Array(count * 4);
  const shape = banksOnly ? null : new Float32Array(count);
  const billowed = banksOnly ? null : new Float32Array(count);
  const offset = banksOnly ? null : new Float32Array(count);
  const index = (x, y, z) => (z * height + y) * width + x;
  const wrap = (v) => (v % width + width) % width;
  const dx = TILE / width;
  const dy = TOP / height;
  const random = randomGenerator(9143 ^ layoutSeed);
  const medium = edgeNoise(24, 8173);
  const fine = edgeNoise(60, 1917);
  const mediumStrength = 0.54;
  const fineStrength = 0.22;
  const maxRadius = Math.sqrt(1 + mediumStrength + fineStrength);

  const offsetAt = (x, y, z) => {
    const u = (x + 0.5) / width, v = (y + 0.5) * dy, w = (z + 0.5) / width;
    return Math.fround(mediumStrength * (2 * medium(u * 24, v / 2, w * 24) - 1)
      + fineStrength * (2 * fine(u * 60, v / 0.8, w * 60) - 1));
  };
  // Only the comparison lobes reuse offsets across multiple passes.
  if (offset) for (let z = 0; z < width; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        offset[index(x, y, z)] = offsetAt(x, y, z);
      }
    }
  }

  // Give each cluster a main body and two smaller, overlapping lobes.
  function addLobe(cx, cy, cz, rx, ry, rz) {
    for (let z = Math.floor((cz - rz * maxRadius) / dx); z < Math.ceil((cz + rz * maxRadius) / dx); z++) {
      const z2 = (((z + 0.5) * dx - cz) / rz) ** 2;
      for (let y = 0; y < height; y++) {
        const yz2 = z2 + (((y + 0.5) * dy - cy) / ry) ** 2;
        if (yz2 >= maxRadius ** 2) continue;
        for (let x = Math.floor((cx - rx * maxRadius) / dx); x < Math.ceil((cx + rx * maxRadius) / dx); x++) {
          const radius2 = yz2 + (((x + 0.5) * dx - cx) / rx) ** 2;
          const lobe = fade((1 - radius2) / 0.78);
          const i = index(wrap(x), y, wrap(z));
          shape[i] += (1 - shape[i]) * lobe;
          // Leave the core round and move the density boundary in both directions.
          const edgeWeight = fade((radius2 - 0.22) / 0.6);
          const distorted = fade((1 - radius2 + offset[i] * edgeWeight) / 0.78);
          billowed[i] += (1 - billowed[i]) * distorted;
        }
      }
    }
  }

  if (!banksOnly) for (let z = 0; z < 8; z++) {
    for (let x = 0; x < 8; x++) {
      const cx = (x + random()) * TILE / 8;
      const cz = (z + random()) * TILE / 8;
      const s = 0.65 + 0.7 * random();
      addLobe(cx, 1.7, cz, 3.2 * s, 1.9 * s, 2.7 * s);
      for (let lobe = 0; lobe < 2; lobe++) {
        const angle = random() * 2 * Math.PI;
        addLobe(cx + 1.7 * s * Math.cos(angle), 1.7 + 0.7 * random(),
          cz + 1.7 * s * Math.sin(angle), 1.65 * s, 1.35 * s, 1.5 * s);
      }
    }
  }

  const noise = edgeNoise(64);
  // Seed zero retains the original broad weather map for comparison.
  const legacyWeather = edgeNoise(4, 4371);
  const bankHeight = layoutSeed === 0
    ? (u, w) => mix(-1.4, 3.6, fade((legacyWeather(4 * u, 1, 4 * w) - 0.25) / 0.48))
    : scatteredBankHeight(layoutSeed, altitudes, crestDips, altitudeScale, sharedBases);
  const deckTop = new Float32Array(width);
  const deckBottom = new Float32Array(width);
  // Upper bound includes both noise scales, the largest cap rise, and the feathered fringe.
  const maxDetailRise = 1.3 * Math.fround(mediumStrength + fineStrength) + (1 - 0.32) * 0.7 + 0.34;
  const lobeCells = 20;
  const worley = lobes && makeWorleyF1(lobeCells, 29347 ^ layoutSeed);
  // Overlapping rounded caps in a periodic horizontal field, evaluated once per column.
  const caps = new Float32Array(width * width);
  if (tufts || fringe || lobes) {
    const rand = randomGenerator(7319 ^ layoutSeed), cells = 25, spacing = width / cells;
    for (let j = 0; j < cells; j++) for (let k = 0; k < cells; k++) {
      const cx = (k + rand()) * spacing, cz = (j + rand()) * spacing;
      const radius = spacing * (0.53 + 0.42 * rand());
      for (let z = Math.floor(cz - radius); z <= cz + radius; z++) {
        for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
          const r2 = ((x + 0.5 - cx) ** 2 + (z + 0.5 - cz) ** 2) / radius ** 2;
          const i = wrap(z) * width + wrap(x);
          caps[i] = Math.max(caps[i], Math.max(0, 1 - r2) ** 1.5);
        }
      }
    }
  }
  const underside = edgeNoise(10, 5171 ^ layoutSeed);
  const wispPatches = edgeNoise(36, 2819);
  function wispByte(inside, x, altitude, z, topFade) {
    let d = fade(inside / 0.65);
    if (d > 0 && d < 0.9) {
      const u = (x + 0.5) / width, w = (z + 0.5) / width;
      const grain = noise(u * 64, altitude * 2.1, w * 64);
      const patch = wispPatches(u * 36, altitude * 1.2, w * 36);
      const erosion = 0.73 * fade((mix(grain, patch, 0.7) - 0.25) / 0.48);
      d = Math.max(0, d - erosion * (1 - fade(d / 0.9)));
    }
    return Math.round(255 * d * topFade);
  }
  for (let z = 0; z < width; z++) {
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width, w = (z + 0.5) / width;
      const col = z * width + x;
      deckTop[x] = bankHeight(u, w, col);
      const floorRelief = 0.9 * fade(underside(u * 10, 2, w * 10));
      const thick = fade(deckTop[x] / 2);
      deckBottom[x] = floorRelief * thick;
      if (rimLifts && thick < 1) {
        // Carry the body's local floor out to the skirt, keeping its small billows.
        const cap = 0.25 - 0.85 * caps[col];
        const level = Math.max(0, floorRelief + cap) - Math.max(0, deckBottom[x] + cap);
        const upturn = 0.32 * fade((underside(u * 10, 7, w * 10) - 0.50) / 0.28);
        rimLifts[col] = level + (1 - thick) * upturn;
      } else if (rimLifts) rimLifts[col] = 0;
    }
    for (let y = 0; y < height; y++) {
      const altitude = (y + 0.5) * dy;
      const bottomFade = fade(altitude / 0.32);
      const topFade = fade((TOP - 0.10 - altitude) / 0.45);
      const base = 0.8 * bottomFade * fade((1.3 - altitude) / 0.68);
      for (let x = 0; x < width; x++) {
        const i = index(x, y, z);
        if (!banksOnly) {
          const body = shape[i] * bottomFade;
          // Only remove density from the lobe transition, never from the deck.
          const erosion = body > 0 && body < 0.8
            ? 0.32 * noise((x + 0.5) * 64 / width, altitude * 1.9, (z + 0.5) * 64 / width)
              * (1 - fade((body - 0.26) / 0.54))
            : 0;
          const carved = Math.max(0, body - erosion);
          data[4 * i] = Math.round(255 * mix(base, 1, body));
          data[4 * i + 1] = Math.round(255 * mix(base, 1, carved));
          data[4 * i + 2] = Math.round(255 * mix(base, 1, billowed[i] * bottomFade * topFade));
        }
        // A negative top leaves open water; signed 3D detail roughens the banks.
        const roughness = offset ? offset[i] : (altitude <= deckTop[x] + maxDetailRise ? offsetAt(x, y, z) : 0);
        const roughTop = deckTop[x] + roughness * 1.3;
        const inside = Math.min(altitude, roughTop - altitude);
        if (data) data[4 * i + 3] = Math.round(255 * fade(inside / 0.65) * topFade);
        if (wisps) wisps[i] = wispByte(inside, x, altitude, z, topFade);
        if (relief) relief[i] = wispByte(Math.min(inside, altitude - deckBottom[x]), x, altitude, z, topFade);
        if (tufts || fringe || lobes) {
          const cap = caps[z * width + x];
          const bottom = Math.max(0, deckBottom[x] + 0.25 - 0.85 * cap);
          const bank = fade(deckTop[x] / 0.65) * (1 - fade((deckTop[x] - 1.5) / 1.5));
          const top = roughTop + bank * (cap - 0.32) * 0.7;
          const edge = Math.min(altitude - bottom, top - altitude);
          const original = wispByte(edge, x, altitude, z, topFade);
          if (tufts) tufts[i] = original;
          let feathered = original;
          if ((fringe || lobes) && edge > -0.34 && edge < 0.53) {
            const u = (x + 0.5) / width, w = (z + 0.5) / width;
            // Stretch the patches along the wind, with finer breaks across them.
            const patch = wispPatches(u * 36, altitude * 2.3, w * 72);
            const grain = noise(u * 64, altitude * 3.2, w * 64);
            const room = fade((top - bottom) / 0.65) * fade(altitude / 0.32);
            const thin = 255 * topFade * featherDensity(edge, mix(patch, grain, 0.3), room);
            feathered = Math.round(mix(thin, original, fade((edge - 0.22) / 0.31)));
          }
          if (fringe) fringe[i] = feathered;
          if (lobes) {
            let keep = 1;
            const depth = top - bottom;
            if ((original || feathered) && depth > 0.75 && edge > -0.34 && edge < 0.65 + MAX_LOBE_CUT) {
              const scale = lobeCells / TILE;
              const f1 = worley((x + 0.5) * dx * scale, altitude * scale, (z + 0.5) * dx * scale);
              keep = lobeMask(edge, depth, f1);
            }
            lobes.tufts[i] = Math.round(keep * original);
            lobes.fringe[i] = Math.round(keep * feathered);
          }
        }
      }
    }
  }
  return data;
}
