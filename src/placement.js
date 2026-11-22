import { BANK_LIFT, TILE, edgeNoise } from './density.js';

// Fray only low, optically thin columns next to an opening, in bank-local space.
// Snapshot column mass first so erosion cannot propagate inward as we visit the tile.
export function fraySkirts(w, rows, dy, source, stride, channel, seed) {
  const mass = new Float32Array(w * w), roof = new Int32Array(w * w).fill(-1);
  const pitch = w * stride;
  for (let z = 0; z < w; z++) for (let y = 0; y < rows; y++) {
    let i = (z * rows + y) * pitch + channel;
    for (let x = 0; x < w; x++, i += stride) {
      const v = source[i], col = z * w + x;
      if (v) { mass[col] += v * dy / 255; roof[col] = y; }
    }
  }
  const reach = Math.min(w - 1, Math.max(1, Math.round(1.3 * w / TILE)));
  const patch = edgeNoise(16, seed ^ 0x49af2);
  const fade = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
    const col = z * w + x, top = (roof[col] + 0.5) * dy;
    if (roof[col] < 0 || top >= 2.6 || mass[col] >= 1.15) continue;
    const neighbor = Math.min(mass[z * w + (x + w - reach) % w], mass[z * w + (x + reach) % w],
      mass[((z + w - reach) % w) * w + x], mass[((z + reach) % w) * w + x]);
    const exposed = (1 - fade((neighbor - 0.02) / 0.16)) * (1 - fade((mass[col] - 0.25) / 0.90))
      * (1 - fade((top - 1.7) / 0.9));
    if (!exposed) continue;
    const u = (x + 0.5) / w, v = (z + 0.5) / w;
    for (let y = 0, i = z * rows * pitch + x * stride + channel; y <= roof[col]; y++, i += pitch) {
      if (!source[i]) continue;
      const h = (y + 0.5) * dy;
      // Broad cuts stretch along the wind; the finer octave interrupts their tips.
      const pattern = 0.72 * patch(16 * u, h, 32 * v) + 0.28 * patch(48 * u, h * 2 + 9, 64 * v);
      const cut = 180 * exposed * fade((pattern - 0.40) / 0.32);
      source[i] = Math.round(Math.max(0, source[i] - cut));
    }
  }
}

// Shift thin tips intact; taper the displacement to zero before the upper billows.
// Read from lower rows while descending, so this can operate on the bake in place.
export function shapeLowerRims(w, rows, dy, source, stride, channel, lifts) {
  const pitch = w * stride, ceiling = 2.4;
  const last = Math.min(rows - 1, Math.floor(ceiling / dy - 0.5));
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
    const lift = lifts[z * w + x];
    if (lift <= 0) continue;
    const base = (z * rows * w + x) * stride + channel;
    for (let y = last; y >= 0; y--) {
      const altitude = (y + 0.5) * dy;
      const t = Math.max(0, Math.min(1, (ceiling - altitude) / (ceiling - (lift + 0.55))));
      const src = y - (lift / dy) * t * t * (3 - 2 * t);
      const lo = Math.floor(src), f = src - lo;
      const a = lo >= 0 ? source[base + lo * pitch] : 0;
      const b = f > 0 && lo >= -1 ? source[base + (lo + 1) * pitch] : 0;
      source[base + y * pitch] = Math.round(a + (b - a) * f);
    }
  }
}

// Shorten the middle of the column; translate the detailed roof as one piece.
// Sampling upward in bottom-to-top order keeps the source bytes intact in place.
function lowerCrest(data, base, w, height, dy, dip) {
  let lo = 0, hi = height - 1;
  while (lo <= hi && !data[base + lo * w]) lo++;
  while (hi >= lo && !data[base + hi * w]) hi--;
  // Keep a shallow saddle even when a tall tower occupies this column.
  const span = hi - lo, drop = dip * Math.min(span, 3.6 / dy);
  const fixed = lo + 0.20 * span, moved = lo + 0.85 * span - drop;
  let sum = 0;
  for (let y = lo; y <= hi; y++) {
    const at = base + y * w;
    if (y > fixed) {
      const src = y + drop * Math.min(1, (y - fixed) / (moved - fixed));
      const row = Math.floor(src), f = src - row;
      data[at] = row > hi ? 0 : Math.round((1 - f) * data[base + row * w]
        + (row < hi ? f * data[base + (row + 1) * w] : 0));
    }
    sum += data[at];
  }
  return sum;
}

// Fractional placement splits each byte between adjacent rows, preserving mass.
// The optional crest pass changes thickness and updates the ocean's column map.
export function placeBanks(w, rows, dy, source, stride, channel, lifts, crestDips = null) {
  const columns = new Uint8Array(w * w * 2);
  let low = Infinity, high = -Infinity;
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
    const col = z * w + x, shift = lifts[col] / dy;
    let first = rows, last = -1, sum = 0;
    for (let y = 0, i = (z * rows * w + x) * stride + channel; y < rows; y++, i += w * stride) {
      if (!source[i]) continue;
      first = Math.min(first, y);
      last = y;
      sum += source[i];
    }
    columns[2 * col] = Math.round(sum / rows);
    columns[2 * col + 1] = 128 + Math.round(127 * lifts[col] / BANK_LIFT);
    if (last < 0) continue;
    low = Math.min(low, first + Math.floor(shift) - 1);
    high = Math.max(high, last + Math.ceil(shift) + 1);
  }
  if (!Number.isFinite(low)) { low = 0; high = 0; }
  const height = high - low + 1;
  const data = new Uint8Array(w * height * w);
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
    const col = z * w + x, shift = lifts[col] / dy, whole = Math.floor(shift), frac = shift - whole;
    let j = (z * height + whole - low) * w + x;
    for (let y = 0, i = (z * rows * w + x) * stride + channel; y < rows; y++, i += w * stride, j += w) {
      const v = source[i];
      if (!v) continue;
      const upper = Math.round(v * frac);
      data[j] += v - upper;
      if (upper) data[j + w] += upper;
    }
    if (crestDips && crestDips[col] > 0) {
      const sum = lowerCrest(data, z * height * w + x, w, height, dy, crestDips[col]);
      columns[2 * col] = Math.round(sum / rows);
    }
  }
  return { data, height, bottom: low * dy, extent: height * dy, columns };
}
