import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TILE, TOP } from './density.js';
import { FLIGHT_DURATION, SEA_LEVEL, flightPose } from './flight.js';

test('the flight descends below the cloud layer and loops after one texture tile', () => {
  const start = flightPose(0);
  const low = flightPose(FLIGHT_DURATION / 2);
  const end = flightPose(FLIGHT_DURATION);
  assert.ok(start.y > TOP + 2);
  assert.ok(Math.abs(low.y - SEA_LEVEL - 0.8) < 1e-9);
  for (let i = 0; i <= 360; i++) {
    const seconds = FLIGHT_DURATION * i / 360;
    const originalY = 3.5 + 6.7 * Math.cos(2 * Math.PI * i / 360);
    const { y } = flightPose(seconds);
    if (originalY >= 2) assert.ok(Math.abs(y - originalY) < 1e-9);
    assert.ok(y >= low.y - 1e-9);
  }
  assert.ok(start.pitch > 0.3 && low.pitch < -0.25);
  assert.ok(start.z > low.z && low.z > end.z);
  assert.equal(start.z - end.z, TILE);
  for (const key of ['x', 'y', 'pitch', 'yaw']) assert.ok(Math.abs(start[key] - end[key]) < 1e-9);
});
