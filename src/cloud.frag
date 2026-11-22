precision highp float;
precision highp int;
precision highp sampler3D;

in vec2 vScreen;
out vec4 fragColor;
uniform sampler3D uDensity;
uniform sampler2D uWaveSlopes;
uniform sampler2D uCloudColumns;
uniform int uSamples;
uniform float uAspect;
uniform float uTile;
uniform float uBottomOffset;
uniform float uExtent;
uniform float uColumnDepth;
uniform float uBankLift;
uniform float uDeckTop;
uniform vec3 uEye;
uniform vec2 uViewAngles;
uniform float uPhase;
uniform vec2 uWindUV;

const float FLIGHT_CLOUD_BASE = 2.0;
uniform float uSeaLevel;
uniform sampler2D uSkyMap;
uniform vec3 uSunDir;
uniform vec3 uSunlight;
uniform vec3 uSkylight;
const float EXTINCTION = 1.85;

vec2 cloudCoordinates(vec2 uv, float layerHeight) {
  return uv - vec2(uWindUV.x, uWindUV.y * layerHeight);
}

// Pair four cubic B-spline weights into two hardware-linear lookups per axis.
vec3 gridFilter(float uv, float size, float amount) {
  float cell = uv * size - 0.5;
  float f = fract(cell), g = 1.0 - f;
  vec4 cubic = vec4(g*g*g, 4.0 - 6.0*f*f + 3.0*f*f*f,
                    4.0 - 6.0*g*g + 3.0*g*g*g, f*f*f) / 6.0;
  vec4 w = mix(vec4(0.0, g, f, 0.0), cubic, amount);
  float lo = w.x + w.y, hi = w.z + w.w;
  vec2 centers = floor(cell) + vec2(-0.5, 1.5);
  return vec3((centers + vec2(w.y / max(lo, 1e-6), w.w / max(hi, 1e-6))) / size, hi);
}

float densityAt(vec3 p) {
  float height = p.y - FLIGHT_CLOUD_BASE;
  float h = (height - uBottomOffset) / uExtent;
  if (h <= 0.0 || h >= 1.0) return 0.0;
  vec2 uv = cloudCoordinates(p.xz / uTile, height);
  vec3 uvw = vec3(uv.x, h, uv.y);
  float nearFilter = 1.0 - smoothstep(8.0, 20.0, distance(p, uEye));
  if (nearFilter > 0.0) {
    vec2 size = vec2(textureSize(uDensity, 0).xz);
    vec3 x = gridFilter(uv.x, size.x, nearFilter);
    vec3 z = gridFilter(uv.y, size.y, nearFilter);
    vec4 a = mix(textureLod(uDensity, vec3(x.x, h, z.x), 0.0),
                 textureLod(uDensity, vec3(x.y, h, z.x), 0.0), x.z);
    vec4 b = mix(textureLod(uDensity, vec3(x.x, h, z.y), 0.0),
                 textureLod(uDensity, vec3(x.y, h, z.y), 0.0), x.z);
    return mix(a, b, z.z).r;
  }
  return textureLod(uDensity, uvw, 0.0).r;
}

float sunTransmittance(vec3 p) {
  float top = FLIGHT_CLOUD_BASE + uBottomOffset + uExtent;
  float exitDistance = (top - p.y) / uSunDir.y;
  float travel = 0.0;
  float segment = 0.55;
  float opticalDepth = 0.0;
  // Fine near the sample, coarser farther away to catch neighboring lobes.
  for (int i = 0; i < 6; ++i) {
    float ds = min(segment, exitDistance - travel);
    if (ds <= 0.0) break;
    opticalDepth += densityAt(p + uSunDir * (travel + 0.5 * ds)) * ds;
    travel += ds;
    segment *= 1.48;
  }
  return exp(-EXTINCTION * opticalDepth);
}

vec3 sky(vec3 ray) {
  float az = dot(ray.xz, uSunDir.xz) * inversesqrt(max(1e-10, dot(ray.xz, ray.xz) * dot(uSunDir.xz, uSunDir.xz)));
  vec2 uv = vec2(acos(clamp(az, -1.0, 1.0)) / 3.14159265, sqrt(max(ray.y, 0.0)));
  vec2 size = vec2(textureSize(uSkyMap, 0));
  return textureLod(uSkyMap, (uv * (size - 1.0) + 0.5) / size, 0.0).rgb;
}

vec3 cloudLight(float direct) {
  // Soft sky fill and a small bounce keep dense, occluded cloud readable.
  return 2.2 * uSkylight + (0.12 + 0.90 * direct) * uSunlight;
}

const float TAU = 6.2831853;
const vec2 SWELL_A = vec2(2.0, 3.0), SWELL_B = vec2(-1.0, 4.0);
const vec2 SWELL_AMPLITUDE = vec2(0.22, 0.09);
const vec2 BEND_DIR = vec2(-1.0, 1.0), BEND_AMOUNT = vec2(1.05, -0.75);

vec2 swellPhase(vec2 tile) {
  // Integer tile and time frequencies close the flight loop in both dimensions.
  float bend = TAU * dot(tile, BEND_DIR) - 2.0 * uPhase;
  return TAU * vec2(dot(tile, SWELL_A), dot(tile, SWELL_B))
    - uPhase * vec2(5.0, 6.0) + vec2(0.7, 2.4) + BEND_AMOUNT * sin(bend);
}

// Intersect an approximate cloud sheet, then correct its height once. Red is
// vertical optical thickness before extinction, green the bank's altitude.
float cloudColumnAlong(vec2 tile, float waterY, vec3 direction) {
  vec2 slope = direction.xz / (max(direction.y, 0.035) * uTile);
  vec2 uv = tile + slope * (FLIGHT_CLOUD_BASE + 0.5 - waterY);
  float encoded = texture(uCloudColumns, cloudCoordinates(uv, 0.5)).g;
  float lift = (255.0 * encoded - 128.0) * uBankLift / 127.0;
  return texture(uCloudColumns, cloudCoordinates(uv + slope * lift, 0.5 + lift)).r * uColumnDepth;
}

vec3 ocean(vec3 ray, inout float distanceToWater, vec3 haze) {
  // One near-field height correction. Fade back to a plane at grazing angles,
  // where a small height error would move the hit a long way along the ray.
  vec2 flatTile = (uEye + ray * distanceToWater).xz / uTile;
  float displace = smoothstep(0.045, 0.22, -ray.y) * (1.0 - smoothstep(25.0, 65.0, distanceToWater));
  float waterY = uSeaLevel;
  if (displace > 0.0) {
    float height = displace * dot(SWELL_AMPLITUDE, sin(swellPhase(flatTile)));
    distanceToWater -= height / -ray.y;
    waterY += height;
  }
  vec2 tile = (uEye + ray * distanceToWater).xz / uTile;
  vec2 uv = tile * TAU;
  float cycle = uPhase / TAU;
  // Swell moves the water hit; the irregular ripple field breaks up reflected light.
  vec2 longWave = texture(uWaveSlopes, tile + vec2(cycle, 0.31)).rg * 2.0 - 1.0;
  float group = sin(dot(uv, vec2(1, 2)) + uPhase + 2.0 * longWave.y);
  vec2 drift = 0.18 * longWave;
  vec2 coarse = texture(uWaveSlopes, tile * 3.0 + vec2(2.0, -1.0) * cycle + drift).rg * 2.0 - 1.0;
  vec2 fine = texture(uWaveSlopes, tile.yx * 7.0 + vec2(-3.0, 2.0) * cycle - drift.yx).gr * 2.0 - 1.0;
  vec2 slope = 0.28 * longWave + (0.29 + 0.14 * group) * coarse + (0.23 + 0.07 * group) * fine;
  vec3 normal = normalize(vec3(slope.x, 1.0, slope.y));
  vec3 reflection = reflect(ray, normal);
  float fresnel = 0.04 + 0.96 * pow(1.0 - clamp(dot(-ray, normal), 0.0, 1.0), 5.0);
  vec3 water = vec3(0.018, 0.14, 0.18) * (4.0 * uSkylight + 1.5 * uSunDir.y * uSunlight);
  vec3 environment = sky(reflection);
  float depth = cloudColumnAlong(tile, waterY, reflection);
  float cover = (1.0 - exp(-depth * EXTINCTION)) * smoothstep(0.035, 0.17, reflection.y);
  vec3 underside = cloudLight(mix(0.65, 0.04, smoothstep(0.0, 2.8, depth)));
  environment = mix(environment, underside, cover);
  water = mix(water, environment, fresnel);
  float gloss = mix(145.0, 48.0, smoothstep(6.0, 55.0, distanceToWater));
  float glint = (gloss / 90.0) * pow(max(dot(reflection, uSunDir), 0.0), gloss);
  float sunDepth = cloudColumnAlong(tile, waterY, uSunDir);
  water += exp(-EXTINCTION * sunDepth / uSunDir.y) * 0.72 * uSunlight * glint;
  return mix(water, haze, smoothstep(45.0, 155.0, distanceToWater));
}

float pixelOffset() {
  uvec2 pixel = uvec2(gl_FragCoord.xy);
  uint bits = (pixel.x + 1u) * 73856093u ^ (pixel.y + 1u) * 19349663u;
  bits ^= bits >> 16u;
  bits *= 1597334677u;
  return float((bits ^ (bits >> 15u)) >> 8u) / 16777216.0;
}

void accumulateCloud(vec3 ray, vec3 haze, float t, float mass, inout vec3 color, inout float transmission) {
  if (mass <= 0.0) return;
  float directLight = sunTransmittance(uEye + ray * t);
  vec3 shade = mix(cloudLight(directLight), haze, 1.0 - exp(-0.00038 * t * t));
  float attenuation = exp(-EXTINCTION * mass);
  color += transmission * (1.0 - attenuation) * shade;
  transmission *= attenuation;
}

void integrateSegment(vec3 ray, vec3 haze, float t, float ds, inout vec3 color, inout float transmission) {
  vec3 center = uEye + ray * t;
  float spread = smoothstep(0.18, 0.31, ds);
  if (spread == 0.0) {
    accumulateCloud(ray, haze, t, ds * densityAt(center), color, transmission);
    return;
  }
  // Two-point Gauss quadrature for both extinction and incoming sunlight.
  float radius = 0.2886751 * ds * spread;
  float front = densityAt(center - ray * radius);
  float back = densityAt(center + ray * radius);
  float sum = front + back;
  if (sum == 0.0) return;
  float meanT = t + radius * (back - front) / sum;
  // Merge the light probes smoothly inside a dense or already obscured segment.
  float split = (1.0 - smoothstep(0.70, 0.90, min(front, back))) * smoothstep(0.04, 0.12, transmission);
  if (split == 0.0) {
    accumulateCloud(ray, haze, meanT, ds * sum * 0.5, color, transmission);
    return;
  }
  accumulateCloud(ray, haze, mix(meanT, t - radius, split), ds * front * 0.5, color, transmission);
  if (transmission >= 0.005) accumulateCloud(ray, haze, mix(meanT, t + radius, split), ds * back * 0.5, color, transmission);
}

vec3 cloudSea(vec3 ray, vec3 background, vec3 haze, float sceneDepth) {
  float bottom = FLIGHT_CLOUD_BASE + uBottomOffset;
  float top = bottom + uExtent;
  float entry = 0.0;
  float end = min(120.0, sceneDepth);
  if (abs(ray.y) < 0.00001) {
    if (uEye.y < bottom || uEye.y > top) return background;
  } else {
    float a = (bottom - uEye.y) / ray.y;
    float b = (top - uEye.y) / ray.y;
    entry = max(0.0, min(a, b));
    end = min(end, max(a, b));
  }
  if (entry >= end) return background;
  float span = end - entry;
  float invSamples = 1.0 / float(uSamples);
  float biasEntry = entry;
  // A few tall crowns are not a dense layer next to the eye. From above,
  // distribute samples according to where the ray actually reaches the main deck.
  float deckCeiling = FLIGHT_CLOUD_BASE + uDeckTop;
  if (top > deckCeiling && uEye.y > deckCeiling) {
    float deckEntry = (uEye.y - deckCeiling) / max(-ray.y, 0.00001);
    biasEntry = mix(entry, max(entry, deckEntry), smoothstep(0.0, 1.0, uEye.y - deckCeiling));
  }
  // Favor nearby cloud without leaving very wide steps across the middle distance.
  float nearBias = 0.56 * smoothstep(8.0, 36.0, span) * (1.0 - smoothstep(0.0, 12.0, biasEntry));
  float jitter = pixelOffset() - 0.5;
  float transmission = 1.0;
  vec3 color = vec3(0.0);
  float segmentStart = entry;
  for (int i = 0; i < 144; ++i) {
    if (i >= uSamples) break;
    float u = float(i + 1) * invSamples;
    float segmentEnd = i + 1 == uSamples ? end : entry + span * mix(u, u * u * u, nearBias);
    float stepSize = segmentEnd - segmentStart;
    // Keep a little static jitter for banding; don't shift the entire interval
    // from one side of a thin cloud to the other on adjacent pixels.
    float t = segmentStart + 0.5 * stepSize + jitter * min(0.12 * stepSize, 0.035);
    segmentStart = segmentEnd;
    integrateSegment(ray, haze, t, stepSize, color, transmission);
    if (transmission < 0.005) break;
  }
  return color + transmission * background;
}

void main() {
  vec3 ray = normalize(vec3(vScreen * vec2(uAspect, 1.0) * 0.36, -1.0));
  float pitch = uViewAngles.x;
  float yaw = uViewAngles.y;
  ray.yz = mat2(cos(pitch), -sin(pitch), sin(pitch), cos(pitch)) * ray.yz;
  ray.xz = mat2(cos(yaw), sin(yaw), -sin(yaw), cos(yaw)) * ray.xz;
  vec3 clearSky = sky(ray);
  // Looking down, the air between banks sees the whole sky, not just the
  // bright grazing direction. Match the sky exactly at the geometric horizon.
  vec3 haze = mix(clearSky, 2.2 * uSkylight, smoothstep(0.0, 0.35, -ray.y));
  // Keep the small solar disc out of both the low-res map and the haze.
  float mu = dot(ray, uSunDir), aa = max(0.5 * fwidth(mu), 1e-7);
  float disc = smoothstep(0.9999892 - aa, 0.9999892 + aa, mu);
  float waterDepth = ray.y < 0.0 ? (uEye.y - uSeaLevel) / -ray.y : 1e6;
  vec3 background = haze + disc * 8.0 * uSunlight;
  if (waterDepth < 155.0) background = ocean(ray, waterDepth, haze);
  vec3 color = cloudSea(ray, background, haze, waterDepth);
  vec3 highlights = max(color - 0.72, 0.0);
  color = min(color, 0.72) + highlights / (1.0 + highlights / 0.28);
  fragColor = sRGBTransferOETF(vec4(color, 1.0));
}
