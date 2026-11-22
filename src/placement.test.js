import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeDensity, bankSurface, BANK_LIFT, crestDip } from './density.js';
import { fraySkirts, placeBanks, shapeLowerRims } from './placement.js';

test('fraying breaks exposed skirts in patches but preserves crowns, sheltered thin cloud and open water', () => {
  const w = 96, h = 32, dy = 0.125, stride = 2, ch = 1;
  const idx = (x, y, z) => ((z*h + y)*w + x)*stride + ch;
  const data = new Uint8Array(w*w*h*stride);
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
    if (x < 16 || x > 80) continue;
    for (let y = 4; y < 10; y++) data[idx(x,y,z)] = 100;
    if (z >= 24 && z < 40) data[idx(x,26,z)] = 120;
    if (z >= 50 && z < 65) for (let y = 2; y < 15; y++) data[idx(x,y,z)] = 245;
  }
  const before = data.slice(), repeat = data.slice();
  fraySkirts(w,h,dy,data,stride,ch,4257);
  fraySkirts(w,h,dy,repeat,stride,ch,4257);
  assert.deepEqual(data, repeat);
  let removed = 0, retained = 0;
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    const i = idx(x,y,z);
    assert.ok(data[i] <= before[i]); assert.equal(data[i-1], before[i-1]);
    if ((z >= 24 && z < 40) || (z >= 50 && z < 65) || (x > 20 && x < 76)) assert.equal(data[i], before[i]);
    if (x === 16 && y === 5 && before[i] === 100) {
      if (!data[i]) removed++;
      if (data[i] === 100) retained++;
    }
  }
  assert.ok(removed && retained);
});

test('placement translates signed and fractional columns without clipping or filling clear air', () => {
  const w = 2, h = 4, source = new Uint8Array(w * w * h * 4);
  const profiles = [[12, 100, 225, 0], [15, 255, 255, 197], [0, 0, 0, 0], [0, 20, 76, 194]];
  const lifts = new Float32Array([-1.5, 2, 0, 0.25]);
  const at = (x, y, z, rows) => (z * rows + y) * w + x;
  for (let c = 0; c < 4; c++) profiles[c].forEach((v, y) => {
    source[4 * at(c % w, y, c >> 1, h) + 3] = v;
  });
  const vol = placeBanks(w, h, 1, source, 4, 3, lifts);
  for (let c = 0; c < 4; c++) {
    const after = Array.from({ length: vol.height }, (_, y) => vol.data[at(c % w, y, c >> 1, vol.height)]);
    const sum = a => a.reduce((a, v) => a + v, 0);
    assert.equal(sum(after), sum(profiles[c]));
    assert.equal(after[0], 0);
    assert.equal(after.at(-1), 0);
    assert.equal(vol.columns[c * 2], Math.round(sum(profiles[c]) / h));
    if (sum(after)) {
      const center = a => a.reduce((s, v, i) => s + v * i, 0) / sum(a);
      assert.ok(Math.abs(center(after) + vol.bottom - center(profiles[c]) - lifts[c]) < 0.01);
    }
  }
});

test('rims lift thin tips intact, keep upper billows fixed and never fill open water', () => {
  const w = 3, rows = 36, dy = 0.125, stride = 4, ch = 3;
  const data = new Uint8Array(w * w * rows * stride);
  const at = (x, y) => (y * w + x) * stride + ch;
  const tip = [17, 60, 28];
  tip.forEach((v, y) => { data[at(0, y + 1)] = v; });
  for (let y = 1; y < 27; y++) data[at(1, y)] = 40 + y % 7;
  const before = data.slice();
  const offsets = new Float32Array(w * w).fill(0.375);
  shapeLowerRims(w, rows, dy, data, stride, ch, offsets);
  for (let y = 0; y < rows; y++) {
    assert.equal(data[at(0, y)], tip[y - 4] ?? 0);
    if ((y + 0.5) * dy >= 2.4) assert.equal(data[at(1, y)], before[at(1, y)]);
    assert.equal(data[at(2, y)], 0);
  }
  assert.ok(data.every((v, i) => i % stride === ch || v === before[i]));
});

test('rim corrections vary along the deck without rerolling the bank or growth inputs', () => {
  const w = 64, h = 32, seed = 739146852;
  const bake = rimLifts => {
    const plain = new Uint8Array(w * w * h), fringe = new Uint8Array(plain.length);
    const altitudes = new Float32Array(w * w), crestDips = new Float32Array(w * w);
    bakeDensity(w, h, null, null, plain, fringe, seed, null, { banksOnly: true, altitudes, crestDips, rimLifts });
    return { plain, fringe, altitudes, crestDips };
  };
  const rims = new Float32Array(w * w), old = bake(), next = bake(rims);
  assert.deepEqual(old, next);
  let fixed = 0, lifted = 0;
  for (let col = 0; col < rims.length; col++) {
    const start = Math.floor(col / w) * w * h + col % w;
    if (!Array.from({ length: h }, (_, y) => next.fringe[start + y * w]).some(v => v > 32)) continue;
    if (rims[col] === 0) fixed++;
    if (rims[col] > 0.25) lifted++;
  }
  assert.ok(fixed > 0 && lifted > 0);
});

test('bank heights vary reproducibly while the same seed retains its unplaced shapes', () => {
  function bake(seed, banksOnly, altitudeScale) {
    const w = 32, h = 12, tufts = new Uint8Array(w * w * h), altitudes = new Float32Array(w * w);
    bakeDensity(w, h, null, null, tufts, null, seed, null, { banksOnly, altitudes, altitudeScale });
    return { altitudes, tufts };
  }
  const a = bake(1862305441, true), b = bake(1862305441, false);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.altitudes, bake(127, true).altitudes);
  assert.ok(Math.min(...a.altitudes) < -0.9 && Math.max(...a.altitudes) > 0.9);
  const full = bake(1862305441, true, 1), flat = bake(1862305441, true, 0);
  assert.deepEqual(full.tufts, a.tufts);
  assert.deepEqual(flat.tufts, a.tufts);
  assert.ok(a.altitudes.every((v, i) => v === 0.5 * full.altitudes[i] && Math.abs(v) <= BANK_LIFT / 2));
  assert.ok(flat.altitudes.every(v => v === 0));
  assert.ok(bake(0, true).altitudes.every(v => v === 0));
});

test('linked banks share a base through a deep overlap, without changing shapes or leveling the tile', () => {
  const w = 256, h = 1;
  function layout(sharedBases) {
    const altitudes = new Float32Array(w*w), crestDips = new Float32Array(w*w);
    const rimLifts = new Float32Array(w*w), fringe = new Uint8Array(w*w*h);
    bakeDensity(w, h, null, null, null, fringe, 739146852, null,
      { banksOnly: true, altitudes, crestDips, rimLifts, sharedBases });
    return { altitudes, crestDips, rimLifts, fringe };
  }
  const old = layout(false), next = layout(true);
  for (const key of ['crestDips', 'rimLifts', 'fringe']) assert.deepEqual(next[key], old[key]);
  // D slice: two overlapping bodies on the left and a separate bank across the gap.
  const at = (field, x) => field.altitudes[119*w+x];
  assert.ok(Math.abs(at(old, 41) - at(old, 71)) > 1);
  assert.ok(Math.abs(at(next, 41) - at(next, 71)) < 0.05);
  assert.ok(Math.abs(at(next, 41) - at(next, 97)) > 1);
});

test('a domed bank keeps its base with an offset summit and a lower shoulder beyond the saddle', () => {
  const w = 61, h = 100, dy = 0.05, src = new Uint8Array(w * w * h);
  const dip = new Float32Array(w * w), lifts = new Float32Array(w * w);
  const z = 0;
  for (let x = 0; x < w; x++) {
    const u = (x - 30) / 30, roof = bankSurface(u * u, u, 3, 0);
    dip[x] = crestDip(u, 0);
    for (let y = 4; (y - 4) * dy < roof; y++) src[y*w + x] = 220;
  }
  const old = placeBanks(w, h, dy, src, 1, 0, lifts);
  const next = placeBanks(w, h, dy, src, 1, 0, lifts, dip);
  const peaks = [];
  for (let x = 0; x < w; x++) {
    let peak = -1, sum = 0;
    for (let y = 0; y < next.height; y++) {
      const i = (z * next.height + y) * w + x, v = next.data[i];
      if (v >= 110) peak = y;
      if (y <= 4 || dip[x] === 0) assert.equal(v, old.data[i]);
      sum += v;
    }
    assert.equal(next.columns[2 * x], Math.round(sum / h));
    peaks.push(peak);
  }
  const shoulder = peaks[16], saddle = peaks[23], summit = peaks[42];
  assert.ok(summit > shoulder && shoulder > saddle && saddle > 0);
  assert.ok(peaks.indexOf(Math.max(...peaks)) > w / 2);
});

test('only selected banks receive a crest profile; layout and lift do not depend on it', () => {
  const w = 48, h = 24;
  function bake(saddles) {
    const tufts = new Uint8Array(w*w*h), altitudes = new Float32Array(w*w);
    const crestDips = saddles ? new Float32Array(w*w) : null;
    bakeDensity(w, h, null, null, tufts, null, 739146852, null, { banksOnly: true, altitudes, crestDips });
    return { tufts, altitudes, crestDips };
  }
  const a = bake(false), b = bake(true);
  assert.deepEqual(a.tufts, b.tufts);
  assert.deepEqual(a.altitudes, b.altitudes);
  assert.ok(b.crestDips.some(v => v > 0.25));
  assert.ok(b.crestDips.some(v => v === 0));
});
