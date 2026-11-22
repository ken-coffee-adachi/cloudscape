// Sea-level, clear-sky single scattering. Distances and coefficients are in km.
const RADIUS = 6360, OUTER = RADIUS + 75;
const RAYLEIGH = [0.0058, 0.0135, 0.0303];
const OZONE = [0.00065, 0.00188, 0.000085];
const MIE = 0.0045, G = 0.76, SUN_POWER = 12;
export const SUN_DIRECTION = [-0.58, 0.19, -0.79].map(v => v / Math.hypot(0.58, 0.19, 0.79));

const altitude = (r, mu, t) => Math.sqrt(r*r + t*(t + 2*r*mu)) - RADIUS;
const toSpace = (r, mu) => Math.sqrt((r*mu)**2 + (OUTER-r)*(OUTER+r)) - r*mu;
const ozoneAt = h => Math.max(0, 1 - Math.abs(h - 25) / 15);

function solarDepth(r, mu) {
  if (mu < 0 && r*r*(1 - mu*mu) <= RADIUS*RADIUS) return [Infinity, Infinity, Infinity];
  const length = toSpace(r, mu);
  let air = 0, aerosol = 0, ozone = 0, start = 0;
  for (let i = 1; i <= 12; i++) {
    const end = length * (i / 12)**2;
    const h = altitude(r, mu, (start + end) * 0.5);
    air += (end - start) * Math.exp(-h / 8);
    aerosol += (end - start) * Math.exp(-h / 1.2);
    ozone += (end - start) * ozoneAt(h);
    start = end;
  }
  return [air, aerosol, ozone];
}

function skyRay(up, mu, sunY) {
  const length = toSpace(RADIUS, up);
  const phaseR = (3 / (16 * Math.PI)) * (1 + mu*mu);
  const phaseM = (1 - G*G) / (4 * Math.PI * (1 + G*G - 2*G*mu)**1.5);
  const color = [0, 0, 0];
  let air = 0, aerosol = 0, ozone = 0, start = 0;
  for (let i = 1; i <= 24; i++) {
    const end = length * (i / 24)**2, t = 0.5 * (start + end);
    const h = altitude(RADIUS, up, t), r = RADIUS + h;
    const dr = (end - start) * Math.exp(-h / 8), dm = (end - start) * Math.exp(-h / 1.2);
    const dz = (end - start) * ozoneAt(h);
    const [sr, sm, sz] = solarDepth(r, (RADIUS * sunY + t * mu) / r);
    for (let c = 0; c < 3; c++) {
      const tau = RAYLEIGH[c] * (air + 0.5*dr + sr) + MIE * (aerosol + 0.5*dm + sm)
        + OZONE[c] * (ozone + 0.5*dz + sz);
      color[c] += SUN_POWER * Math.exp(-tau) * (phaseR * RAYLEIGH[c] * dr + phaseM * MIE * dm);
    }
    air += dr; aerosol += dm; ozone += dz; start = end;
  }
  return color;
}

export function bakeSky(sun = SUN_DIRECTION, width = 96, height = 48) {
  const data = new Float32Array(width * height * 4), ambient = [0, 0, 0];
  const sy = sun[1], horizontal = Math.hypot(sun[0], sun[2]);
  for (let y = 0; y < height; y++) {
    // More texels near the horizon. Integrate cos(theta) dOmega for the
    // diffuse sky color at the same time: normalized row weight = d(up^2).
    const up = (y / (height - 1))**2;
    const rowWeight = Math.min(1, (y+0.5)/(height-1))**4 - Math.max(0, (y-0.5)/(height-1))**4;
    for (let x = 0; x < width; x++) {
      const az = Math.PI * x / (width - 1);
      const mu = up * sy + Math.sqrt(1-up*up) * horizontal * Math.cos(az);
      const color = skyRay(up, mu, sy), k = 4 * (y*width+x);
      const weight = rowWeight * (x === 0 || x === width-1 ? 0.5 : 1) / (width-1);
      for (let c = 0; c < 3; c++) {
        data[k+c] = color[c];
        ambient[c] += weight * color[c];
      }
      data[k+3] = 1;
    }
  }
  const [air, aerosol, ozone] = solarDepth(RADIUS, sy);
  const sunlight = RAYLEIGH.map((k, c) => Math.exp(-k * air - MIE * aerosol - OZONE[c] * ozone));
  return { data, width, height, ambient, sunlight };
}
