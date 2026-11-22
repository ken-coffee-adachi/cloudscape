import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeSky, SUN_DIRECTION } from './sky.js';

const sky = bakeSky(SUN_DIRECTION, 32, 18);
const rgb = (map, x, y) => map.data.slice(4 * (y * map.width + x), 4 * (y * map.width + x) + 3);

test('clear-sky map contains finite linear radiance and has one zenith color', () => {
  assert.equal(sky.data.length, 4 * sky.width * sky.height);
  assert.ok(sky.data.every(v => Number.isFinite(v) && v >= 0));
  const zenith = rgb(sky, 0, sky.height - 1);
  assert.ok(zenith[2] > zenith[0]);
  for (let x = 1; x < sky.width; x++) assert.deepEqual(rgb(sky, x, sky.height - 1), zenith);
});

test('low sun produces warm direct light, cool diffuse fill and directional haze', () => {
  const [r, g, b] = sky.sunlight;
  assert.ok(1 >= r && r > g && g > b && b > 0);
  assert.ok(sky.ambient[2] > sky.ambient[0]);
  assert.ok(rgb(sky, 0, 0)[0] > rgb(sky, sky.width - 1, 0)[0]);
});

test('an overhead sun yields azimuth symmetry and less blue attenuation', () => {
  const noon = bakeSky([0, 1, 0], 8, 6);
  assert.ok(noon.sunlight[2] / noon.sunlight[0] > sky.sunlight[2] / sky.sunlight[0]);
  for (let y = 0; y < noon.height; y++) {
    assert.deepEqual(rgb(noon, 0, y), rgb(noon, noon.width - 1, y));
  }
});
