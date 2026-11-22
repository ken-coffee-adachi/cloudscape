import { TILE } from './density.js';

export const FLIGHT_DURATION = 36;
export const SEA_LEVEL = -10;

export function flightPose(seconds) {
  const phase = seconds / FLIGHT_DURATION * 2 * Math.PI;
  const climb = Math.cos(phase);
  const originalY = 3.5 + 6.7 * climb;
  // Extend only the part below the cloud base, ending 0.8 units above water.
  const originalLow = 3.5 - 6.7;
  const dive = Math.max(0, (2 - originalY) / (2 - originalLow));
  return {
    x: 11 + 2.4 * Math.sin(phase),
    y: originalY + (SEA_LEVEL + 0.8 - originalLow) * dive * dive * (3 - 2 * dive),
    z: 17 - TILE * seconds / FLIGHT_DURATION,
    pitch: 0.04 + 0.34 * climb,
    yaw: 0.10 * climb,
  };
}
