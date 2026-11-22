import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeDensity, bankDimensions, bankSurface, edgeNoise, featherDensity, makeWorleyF1, TOP } from './density.js';

test('value noise wraps continuously across faces, edges and corners', () => {
  const size = 7, noise = edgeNoise(size, 391);
  for (const x of [-0.25, 0, 2.5]) for (const y of [-0.5, 0.25]) for (const z of [-0.125, 0.75]) {
    const value = noise(x, y, z);
    assert.ok(value >= 0 && value <= 1);
    assert.equal(noise(x + size, y, z), value);
    assert.equal(noise(x, y + size, z), value);
    assert.equal(noise(x, y, z + size), value);
  }
});

test('the banks-only bake preserves every density channel from the full bake', () => {
  const w = 40, h = 27;
  function channels(seed, banksOnly) {
    const field = () => new Uint8Array(w * h * w).fill(123);
    const [wisps, relief, tufts, fringe, lobeTufts, lobeFringe] = Array.from({ length: 6 }, field);
    bakeDensity(w, h, wisps, relief, tufts, fringe, seed, { tufts: lobeTufts, fringe: lobeFringe }, { banksOnly });
    return [wisps, relief, tufts, fringe, lobeTufts, lobeFringe];
  }
  for (const seed of [0, 739146852]) assert.deepEqual(channels(seed, true), channels(seed, false));
});

test('Worley F1 measures distance in 3D and wraps across the tile', () => {
  const seed = 213, cells = 5, field = makeWorleyF1(cells, seed);
  // Reconstruct just the first feature; no other cell can reach this interior point first.
  let s = seed;
  const next = () => Math.fround((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const x = next(), y = next(), z = next();
  assert.equal(field(x, y, z), 0);
  assert.ok(Math.abs(field(x, y + 0.01, z) - 0.01) < 1e-6);
  for (const p of [-0.03, 0.1, 2.76]) {
    const d = field(p, 0.3, -0.15);
    assert.ok(d >= 0 && d <= 1);
    assert.ok(Math.abs(d - field(p + cells, 0.3, cells - 0.15)) < 1e-6);
  }
});

test('Worley variants only carve existing cloud and leave the comparison volumes intact', () => {
  const w = 48, h = 32, seed = 1862305441;
  const volume = () => new Uint8Array(w * h * w);
  const reference = [volume(), volume()], plain = volume(), feather = volume();
  bakeDensity(w, h, null, null, ...reference, seed);
  const carved = { tufts: volume(), fringe: volume() };
  bakeDensity(w, h, null, null, plain, feather, seed, carved);
  assert.deepEqual([plain, feather], reference);
  for (const [before, after] of [[plain, carved.tufts], [feather, carved.fringe]]) {
    let hollowed = 0, solid = 0, thinKept = 0;
    for (let i = 0; i < before.length; i++) {
      assert.ok(after[i] <= before[i]);
      if (before[i] - after[i] > 20) hollowed++;
      if (after[i] === 255) solid++;
      if (before[i] > 0 && before[i] < 30 && after[i] === before[i]) thinKept++;
    }
    assert.ok(hollowed > w * w && solid && thinKept);
  }
});

test('a sloping bank keeps the crown, opposite flank and open-water boundary', () => {
  const peak = 3;
  assert.equal(bankSurface(0, 0, peak, 0.9), bankSurface(0, 0, peak, 0));
  for (let n = 1; n <= 100; n++) {
    const a = n / 100, r2 = a * a;
    const round = bankSurface(r2, a, peak, 0);
    assert.equal(bankSurface(r2, -a, peak, 0.9), round);
    const skirt = bankSurface(r2, a, peak, 0.9);
    assert.equal(bankSurface(r2, -a, peak, -0.9), skirt);
    if (round <= 0) assert.equal(skirt, round);
    else assert.ok(skirt > 0 && skirt < round);
  }
  assert.ok(bankSurface(0.36, 0.6, peak, 0.9) < bankSurface(0.36, 0.6, peak, 0) * 0.6);
});

test('larger banks have broader footprints and higher crowns, with room for edge detail', () => {
  const groups = [0.1, 0.5, 0.9].map(roll => [
    bankDimensions(roll, 0, 0), bankDimensions(roll, 1, 1),
  ]);
  for (const [lo, hi] of groups) {
    assert.ok(lo.width < hi.width && lo.height < hi.height);
  }
  for (let i = 1; i < groups.length; i++) {
    assert.ok(groups[i - 1][1].width < groups[i][0].width);
    assert.ok(groups[i - 1][1].height < groups[i][0].height);
  }
  assert.ok(groups[2][1].height + 1 < TOP);
});

test('a seed reproduces the cloud field; different seeds move the openings', () => {
  const w = 40, h = 20;
  function generate(seed) {
    const feathered = new Uint8Array(w * h * w);
    bakeDensity(w, h, null, null, null, feathered, seed);
    return feathered;
  }
  function openWater(volume) {
    return Array.from({ length: w * w }, (_, column) => {
      const x = column % w, z = Math.floor(column / w);
      for (let y = 0; y < h; y++) if (volume[(z * h + y) * w + x]) return false;
      return true;
    });
  }
  const first = generate(127);
  assert.deepEqual(first, generate(127));
  const a = openWater(first), b = openWater(generate(0xf1234567));
  for (const map of [a, b, openWater(generate(1862305441))]) {
    const fraction = map.filter(Boolean).length / map.length;
    assert.ok(fraction > 0.10 && fraction < 0.35, `open-water fraction: ${fraction}`);
  }
  assert.ok(a.filter((open, i) => open !== b[i]).length > w * w * 0.1);
});

test('feathering can leave a faint outer tuft or clear a neighboring edge', () => {
  assert.equal(featherDensity(-0.35, 1, 1), 0);
  assert.equal(featherDensity(-0.12, 1, 0), 0);
  const tail = featherDensity(-0.12, 1, 1);
  assert.ok(tail > 0 && tail < 0.2);
  assert.equal(featherDensity(0.12, 0, 1), 0);
  assert.equal(featherDensity(0.7, 0, 1), 1);
});

test('small billows extend and retract the lower silhouette while keeping open water', () => {
  const w = 64, h = 32, relief = new Uint8Array(w*w*h), tufts = relief.slice();
  bakeDensity(w, h, null, relief, tufts);
  let added = 0, removed = 0, open = 0;
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
    let peak = 0;
    for (let y = 0; y < h; y++) {
      const i = (z*h+y)*w+x;
      if (y < 8 && relief[i] === 0 && tufts[i] > 0) added++;
      if (y < 8 && relief[i] > 0 && tufts[i] === 0) removed++;
      peak = Math.max(peak, tufts[i]);
    }
    if (!peak) open++;
  }
  assert.ok(added && removed && open);
});

test('base relief only removes lower cloud and leaves the upper volume intact', () => {
  const w = 64, h = 32, original = new Uint8Array(w * h * w), relief = original.slice();
  bakeDensity(w, h, original, relief);
  let changed = 0;
  for (let i = 0; i < relief.length; i++) {
    assert.ok(relief[i] <= original[i]);
    if ((Math.floor(i / w) % h + 0.5) * 5 / h >= 1.55) assert.equal(relief[i], original[i]);
    if (relief[i] < original[i]) changed++;
  }
  assert.ok(changed > w * w);
});

test('wispy edges clear some faint voxels without changing clear air or dense cores', () => {
  const wisps = new Uint8Array(64 * 32 * 64);
  const baseline = bakeDensity(64, 32, wisps);
  let cleared = 0;
  for (let i = 0; i < wisps.length; i++) {
    const original = baseline[4 * i + 3];
    assert.ok(wisps[i] <= original);
    if (original >= 230 || original === 0) assert.equal(wisps[i], original);
    if (original > 0 && wisps[i] === 0) cleared++;
  }
  assert.ok(cleared > 0);
});

test('broken deck has clear columns, shallow banks and deep cloud', () => {
  const w = 64, h = 32, data = bakeDensity(w, h);
  let open = 0, shallow = 0, deep = 0;
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
    let peak = -1;
    for (let y = 0; y < h; y++) {
      if (data[4 * ((z * h + y) * w + x) + 3]) peak = y;
    }
    if (peak < 0) open++;
    else if (peak < h / 5) shallow++;
    else if (peak > h / 2) deep++;
  }
  for (const count of [open, shallow, deep]) assert.ok(count > w * w * 0.02);
});

test('erosion changes the transition without adding density or carving the dense core', () => {
  const width = 80, height = 36;
  const data = bakeDensity(width, height);
  assert.deepEqual(data, bakeDensity(width, height));
  let carved = 0, dense = 0;
  for (let i = 0; i < data.length; i += 4) {
    assert.ok(data[i + 1] <= data[i]);
    if (data[i + 1] < data[i]) carved++;
    if (data[i] >= 245) {
      assert.equal(data[i + 1], data[i]);
      dense++;
    }
    const y = Math.floor(i / 4 / width) % height;
    if (y === 4) assert.ok(data[i + 1] >= 180);
    if (y === height - 1) assert.equal(data[i], 0);
  }
  assert.ok(carved > 0 && dense > 0);
});

test('billows extend and retract the silhouette without punching through the deck', () => {
  const width = 80, height = 36;
  const data = bakeDensity(width, height);
  let expanded = 0, retracted = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = Math.floor(i / 4 / width) % height;
    if (data[i] <= 12 && data[i + 2] > 12) expanded++;
    if (data[i] > 12 && data[i + 2] <= 12) retracted++;
    if (y === 4) assert.ok(data[i + 2] >= 180);
    if (y === height - 1) assert.equal(data[i + 2], 0);
  }
  assert.ok(expanded > 0 && retracted > 0);
});

