import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeDensity, TILE, TOP } from './density.js';
import { bakeGrowth, planTowers } from './growth.js';
import { fraySkirts, placeBanks, shapeLowerRims } from './placement.js';

test('grouping pairs existing tower sites on supported banks without rerolling their shapes', () => {
  const w = 96, h = 32, make = () => new Uint8Array(w*w*h);
  for (const seed of [739146852, 1862305441, 127]) {
    const plain = make(), depth = new Float32Array(w*w);
    bakeDensity(w, h, null, null, plain, null, seed, null, { banksOnly: true });
    for (let z = 0; z < w; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      depth[z*w+x] += plain[(z*h+y)*w+x] * (TOP/h) / 255;
    }
    const old = planTowers(w, seed, depth, true, false), next = planTowers(w, seed, depth, true, true);
    const delta = i => i - w * Math.round(i/w);
    const dist = (a, b) => TILE/w * Math.hypot(delta(a.x-b.x), delta(a.z-b.z));
    assert.equal(next.length, old.length);
    assert.deepEqual(next, planTowers(w, seed, depth, true, true));
    let moved = 0;
    for (const [i, { x, z, ...shape }] of next.entries()) {
      const { x: ox, z: oz, ...prev } = old[i];
      assert.deepEqual(shape, prev);
      if (x === ox && z === oz) continue;
      assert.ok(shape.extra && depth[z*w+x] >= 1.25);
      assert.ok(next.some(other => !other.extra && dist(next[i], other) <= 6.8 + TILE/w));
      moved++;
    }
    assert.ok(moved <= Math.floor(next.length/3));
    if (seed === 739146852) assert.ok(moved > 0);
  }
});

test('the reference flight keeps its open-water columns after grouping, fraying and placement', () => {
  // The fringe is quantized to bytes; compare the actual flight texture, not a coarse proxy.
  const w = 256, h = 48, seed = 739146852, dy = TOP/h, make = () => new Uint8Array(w*w*h);
  const field = () => new Float32Array(w*w), altitudes = field(), crestDips = field(), rimLifts = field();
  const p = make(), f = make(), l = { tufts: make(), fringe: make() };
  bakeDensity(w, h, null, null, p, f, seed, l, { banksOnly: true, altitudes, crestDips, rimLifts });
  function map(groups) {
    const g = bakeGrowth(w, h, seed, p, f, l, { groups });
    shapeLowerRims(w, g.height, dy, g.data, 4, 3, rimLifts);
    fraySkirts(w, g.height, dy, g.data, 4, 3, seed);
    const v = placeBanks(w, g.height, dy, g.data, 4, 3, altitudes, crestDips);
    const water = new Uint8Array(w*w).fill(1);
    for (let z = 0; z < w; z++) for (let y = 0; y < v.height; y++) for (let x = 0; x < w; x++) {
      if (v.data[(z*v.height+y)*w+x]) water[z*w+x] = 0;
    }
    return water;
  }
  assert.deepEqual(map(true), map(false));
});

test('more developed banks increase thick cloud cover without filling water openings or lifting the base', () => {
  const w = 96, h = 32, dy = TOP / h, channel = () => new Uint8Array(w * w * h);
  for (const seed of [739146852, 1862305441]) {
    const plain = channel(), feather = channel(), lobes = { tufts: channel(), fringe: channel() };
    bakeDensity(w, h, null, null, plain, feather, seed, lobes, { banksOnly: true });
    const old = bakeGrowth(w, h, seed, plain, feather, lobes, { thickBanks: false });
    const next = bakeGrowth(w, h, seed, plain, feather, lobes);
    const profile = (vol, x, z) => {
      let bottom = -1, denseRows = 0;
      for (let y = 0; y < vol.height; y++) {
        const v = vol.data[((z * vol.height + y) * w + x) * 4 + 3];
        if (v && bottom < 0) bottom = y;
        if (v >= 26) denseRows++;
      }
      return { bottom, thick: denseRows * dy >= 3 };
    };
    let newlyThick = 0, previouslyThick = 0, stillThick = 0, stillThin = 0;
    for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
      const a = profile(old, x, z), b = profile(next, x, z);
      assert.equal(b.bottom, a.bottom);
      if (a.thick) previouslyThick++;
      if (a.thick && b.thick) stillThick++;
      if (!a.thick && b.thick) newlyThick++;
      if (b.bottom >= 0 && !b.thick) stillThin++;
    }
    assert.ok(newlyThick > previouslyThick * 0.1);
    assert.equal(stillThick, previouslyThick);
    assert.ok(stillThin > stillThick + newlyThick);
  }
});

test('growth adds sparse crowns above the deck without moving the sea gaps or clipping the roof', () => {
  const w = 64, h = 32;
  for (const seed of [1862305441, 127, 123, 0]) {
    const make = () => new Uint8Array(w * w * h);
    const original = Array.from({ length: 4 }, make);
    const lobes = { tufts: original[2], fringe: original[3] };
    bakeDensity(w, h, null, null, original[0], original[1], seed, lobes);
    const grow = () => bakeGrowth(w, h, seed, original[0], original[1], lobes);
    const { data, height, top } = grow();
    assert.equal(top / height, TOP / h);
    if (seed === 127) assert.deepEqual(data, grow().data);
    let changedColumns = 0, above = 0;
    for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
      let changed = false, mass = 0;
      for (let y = 0; y < height; y++) {
        const i = (z * h + y) * w + x, j = ((z * height + y) * w + x) * 4;
        if (y < h) mass += original[0][i] * TOP / (255 * h);
        for (let ch = 0; ch < 4; ch++) {
          const before = y < h ? original[ch][i] : 0;
          assert.ok(data[j + ch] >= before);
          if (y === height - 1) assert.equal(data[j + ch], 0);
          changed ||= data[j + ch] !== before;
        }
        if (y >= h && data[j + 3] > 64) above++;
      }
      if (mass < 0.37) assert.equal(changed, false);
      if (changed) changedColumns++;
    }
    assert.ok(above > 0);
    assert.ok(changedColumns > 0 && changedColumns < w * w / 3);
  }
});

test('the shoulder broadens an existing bank without closing a sea gap or raising the tallest crown', () => {
  const w = 96, h = 32, seed = 1862305441;
  const channel = () => new Uint8Array(w * w * h);
  const plain = channel(), feather = channel(), lobes = { tufts: channel(), fringe: channel() };
  bakeDensity(w, h, null, null, plain, feather, seed, lobes);
  const bake = shoulders => bakeGrowth(w, h, seed, plain, feather, lobes, { shoulders });
  const before = bake(false), after = bake(true);
  const profile = (volume, x, z) => {
    let peak = -1, clear = true;
    for (let y = 0; y < volume.height; y++) {
      const v = volume.data[((z * volume.height + y) * w + x) * 4 + 3];
      if (v > 64) peak = y;
      if (v > 0) clear = false;
    }
    return { peak, clear };
  };
  let oldTop = -1, newTop = -1, raised = 0;
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
    const old = profile(before, x, z), now = profile(after, x, z);
    assert.equal(now.clear, old.clear);
    assert.ok(now.peak >= old.peak);
    oldTop = Math.max(oldTop, old.peak);
    newTop = Math.max(newTop, now.peak);
    if (now.peak > old.peak) raised++;
  }
  assert.equal(newTop, oldTop);
  assert.ok(raised > 0 && raised < w * w / 10);
});

test('nested billows reshape the roof without moving water openings or the tower sites', () => {
  const w = 96, h = 32, channel = () => new Uint8Array(w * w * h);
  for (const seed of [739146852, 1862305441]) {
    const plain = channel(), feather = channel(), lobes = { tufts: channel(), fringe: channel() };
    bakeDensity(w, h, null, null, plain, feather, seed, lobes, { banksOnly: true });
    const bake = billows => bakeGrowth(w, h, seed, plain, feather, lobes, { billows });
    const old = bake(false), next = bake(true);
    const roof = (v, x, z) => {
      for (let y = v.height - 1; y >= 0; y--) {
        if (v.data[((z * v.height + y) * w + x) * 4 + 3]) return y;
      }
      return -1;
    };
    let raised = 0, lowered = 0, tallSites = 0;
    for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
      const a = roof(old, x, z), b = roof(next, x, z);
      assert.equal(b < 0, a < 0);
      if (b > a + 1) raised++;
      if (b < a - 1) lowered++;
      if (a > h * 1.25) {
        tallSites++;
        assert.ok(b >= h, 'a tall tower still grows over this same bank');
      }
    }
    assert.ok(raised > 0 && lowered > 0 && tallSites > 0);
  }
});

test('turning billow families redistributes upper density while keeping the same open columns', () => {
  const w = 96, h = 32, seed = 739146852, channel = () => new Uint8Array(w * w * h);
  const plain = channel(), feather = channel(), lobes = { tufts: channel(), fringe: channel() };
  bakeDensity(w, h, null, null, plain, feather, seed, lobes, { banksOnly: true });
  const bake = headings => bakeGrowth(w, h, seed, plain, feather, lobes, { headings });
  const old = bake(false), next = bake(true);
  const density = (v, x, y, z) => y >= v.height ? 0 : v.data[((z * v.height + y) * w + x) * 4 + 3];
  let gained = 0, lost = 0;
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
    let oldMass = 0, newMass = 0;
    for (let y = 0; y < Math.max(old.height, next.height); y++) {
      const a = density(old, x, y, z), b = density(next, x, y, z);
      oldMass += a; newMass += b;
      if (y >= h / 2 && b > a) gained++;
      if (y >= h / 2 && b < a) lost++;
    }
    assert.equal(oldMass === 0, newMass === 0);
  }
  assert.ok(gained > 0 && lost > 0);
});

test('fine clusters add local crest relief without changing the volume size or opening mask', () => {
  const w = 160, h = 48, seed = 739146852, channel = () => new Uint8Array(w * w * h);
  const plain = channel(), feather = channel(), lobes = { tufts: channel(), fringe: channel() };
  bakeDensity(w, h, null, null, plain, feather, seed, lobes, { banksOnly: true });
  const bake = fine => bakeGrowth(w, h, seed, plain, feather, lobes, { fine });
  const old = bake(false), next = bake(true);
  assert.equal(next.height, old.height);
  let touched = 0, raised = 0;
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) {
    let top = -1, newTop = -1, changed = false;
    for (let y = 0; y < old.height; y++) {
      const i = ((z * old.height + y) * w + x) * 4 + 3, a = old.data[i], b = next.data[i];
      assert.ok(b >= a);
      if (a) top = y;
      if (b) newTop = y;
      if (a !== b) changed = true;
    }
    assert.equal(top < 0, newTop < 0);
    assert.ok(newTop < old.height - 1);
    if (changed) touched++;
    if (newTop > top) raised++;
  }
  assert.ok(raised > 0 && touched < w * w / 10);
});
