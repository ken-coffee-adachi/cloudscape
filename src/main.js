import * as THREE from 'three';
import { makeWaveSlopes } from './waves.js';
import { bakeSky, SUN_DIRECTION } from './sky.js';
import { bakeDensity, BANK_LIFT, TILE, TOP } from './density.js';
import { bakeGrowth } from './growth.js';
import { fraySkirts, placeBanks, shapeLowerRims } from './placement.js';
import { FLIGHT_DURATION, SEA_LEVEL, flightPose } from './flight.js';
import fragmentShader from './cloud.frag?raw';
import './style.css';

const canvas = document.querySelector('canvas');
const play = document.querySelector('#play');
const fps = document.querySelector('#fps');
const MAX_RENDER_PIXELS = 640 * 360;

function bakeScene(seed, params) {
  const w = 256, h = 48;
  const channel = () => new Uint8Array(w * h * w);
  const tufts = channel(), feathered = channel();
  const lobes = { tufts: channel(), fringe: channel() };
  const lifts = new Float32Array(w * w);
  const altitudeParam = params.get('altitude')?.trim();
  const scale = altitudeParam ? Number(altitudeParam) : NaN;
  const altitudeScale = Number.isFinite(scale) ? THREE.MathUtils.clamp(scale, 0, 1) : undefined;
  const crestDips = seed !== 0 && params.get('saddles') !== '0' ? new Float32Array(w * w) : null;
  const rimLifts = seed !== 0 && params.get('rims') !== '0' ? new Float32Array(w * w) : null;
  bakeDensity(w, h, null, null, tufts, feathered, seed, lobes, {
    banksOnly: true, altitudes: altitudeScale === 0 ? null : lifts, altitudeScale, crestDips, rimLifts,
    sharedBases: params.get('sharedBases') !== '0',
  });
  const grown = seed !== 0 ? bakeGrowth(w, h, seed, tufts, feathered, lobes, {
    shoulders: params.get('shoulders') !== '0', billows: params.get('billows') !== '0',
    fine: params.get('fine') !== '0', headings: params.get('headings') !== '0',
    thickBanks: params.get('thick') !== '0',
    groups: params.get('groups') !== '0',
  }) : null;
  const rows = grown?.height ?? h;
  const source = grown?.data ?? lobes.fringe, stride = grown ? 4 : 1, channelIndex = grown ? 3 : 0;
  if (rimLifts) shapeLowerRims(w, rows, TOP / h, source, stride, channelIndex, rimLifts);
  if (seed !== 0 && params.get('fray') !== '0') fraySkirts(w, rows, TOP / h, source, stride, channelIndex, seed);
  const placed = placeBanks(w, rows, TOP / h, source, stride, channelIndex, lifts, crestDips);
  const density = new THREE.Data3DTexture(placed.data, w, placed.height, w);
  density.format = THREE.RedFormat;
  density.wrapS = density.wrapR = THREE.RepeatWrapping;
  density.minFilter = density.magFilter = THREE.LinearFilter;
  density.needsUpdate = true;
  const columns = new THREE.DataTexture(placed.columns, w, w, THREE.RGFormat);
  columns.wrapS = columns.wrapT = THREE.RepeatWrapping;
  columns.generateMipmaps = true;
  columns.minFilter = THREE.LinearMipmapLinearFilter;
  columns.magFilter = THREE.LinearFilter;
  columns.needsUpdate = true;
  return { density, columns, bottom: placed.bottom, extent: placed.extent, columnDepth: rows * TOP / h };
}

function start() {
  // One full-screen quad; cloud edges and visibility are resolved inside the raymarch.
  const context = canvas.getContext('webgl2', { alpha: false, depth: false, antialias: false });
  if (!context) throw new Error('WebGL 2 is unavailable.');
  const renderer = new THREE.WebGLRenderer({ canvas, context });
  const url = new URL(location.href);
  const requested = url.searchParams.get('seed');
  const seed = requested !== null && /^\d+$/.test(requested) && Number(requested) <= 0xffffffff
    ? Number(requested) : (crypto.getRandomValues(new Uint32Array(1))[0] || 1);
  const volume = bakeScene(seed, url.searchParams);
  const sky = bakeSky();
  const skyMap = new THREE.DataTexture(Uint16Array.from(sky.data, THREE.DataUtils.toHalfFloat),
    sky.width, sky.height, THREE.RGBAFormat, THREE.HalfFloatType);
  skyMap.minFilter = skyMap.magFilter = THREE.LinearFilter;
  skyMap.needsUpdate = true;
  const uniforms = {
    uSkyMap: { value: skyMap },
    uSunDir: { value: new THREE.Vector3(...SUN_DIRECTION) },
    uSunlight: { value: new THREE.Vector3(...sky.sunlight) },
    uSkylight: { value: new THREE.Vector3(...sky.ambient) },
    uSeaLevel: { value: SEA_LEVEL },
    uCloudColumns: { value: volume.columns },
    uWaveSlopes: { value: makeWaveSlopes() },
    uDensity: { value: volume.density },
    uSamples: { value: 96 },
    uAspect: { value: 16 / 9 },
    uTile: { value: TILE },
    uBottomOffset: { value: volume.bottom },
    uExtent: { value: volume.extent },
    uDeckTop: { value: TOP },
    uColumnDepth: { value: volume.columnDepth },
    uBankLift: { value: BANK_LIFT },
    uEye: { value: new THREE.Vector3() },
    uViewAngles: { value: new THREE.Vector2() },
    uPhase: { value: 0 },
    uWindUV: { value: new THREE.Vector2() },
  };
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms, fragmentShader, depthTest: false, depthWrite: false,
    vertexShader: `
      out vec2 vScreen;
      void main() {
        vScreen = position.xy;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
  });
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  const camera = new THREE.Camera();
  const startTime = Number(url.searchParams.get('time'));
  let flightTime = Number.isFinite(startTime) ? Math.max(0, Math.min(startTime, FLIGHT_DURATION)) : 0;
  const windPeriod = FLIGHT_DURATION * 8;
  let environmentTime = flightTime, frame = 0, lastFrame = null, fpsStart = 0, fpsFrames = 0;

  function resize() {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    // Limit shaded pixels, not CSS dimensions. The same budget works in portrait.
    const scale = Math.min(1, Math.sqrt(MAX_RENDER_PIXELS / (width * height)));
    const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
    if (canvas.width === w && canvas.height === h && uniforms.uAspect.value === width / height) return;
    if (canvas.width !== w || canvas.height !== h) renderer.setSize(w, h, false);
    uniforms.uAspect.value = width / height;
    if (!frame) draw();
  }

  function draw() {
    const { x, y, z, pitch, yaw } = flightPose(flightTime);
    uniforms.uEye.value.set(x, y, z);
    uniforms.uViewAngles.value.set(pitch, yaw);
    uniforms.uPhase.value = environmentTime % FLIGHT_DURATION / FLIGHT_DURATION * 2 * Math.PI;
    const wind = environmentTime / windPeriod;
    uniforms.uWindUV.value.set(wind, 0.018 * Math.sin(4 * Math.PI * wind) / TOP);
    renderer.render(scene, camera);
  }

  function tick(now) {
    if (lastFrame === null) fpsStart = now;
    else {
      const dt = Math.min((now - lastFrame) / 1000, 0.1);
      environmentTime = (environmentTime + dt) % windPeriod;
      flightTime = (flightTime + dt) % FLIGHT_DURATION;
      fpsFrames++;
    }
    lastFrame = now;
    if (now - fpsStart >= 500) {
      fps.textContent = Math.round(fpsFrames * 1000 / (now - fpsStart));
      fpsStart = now;
      fpsFrames = 0;
    }
    draw();
    frame = requestAnimationFrame(tick);
  }

  function setPlayButton(playing) {
    play.classList.toggle('playing', playing);
    play.firstElementChild.textContent = playing ? '\u23f8\ufe0e' : '\u25b6\ufe0e';
    play.title = playing ? 'Pause flight' : 'Play flight';
    play.setAttribute('aria-label', play.title);
  }
  function pauseFlight() {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
    fps.textContent = '--';
    setPlayButton(false);
  }
  function resumeFlight() {
    if (frame) return;
    setPlayButton(true);
    lastFrame = null;
    fpsFrames = 0;
    frame = requestAnimationFrame(tick);
  }
  play.addEventListener('click', () => {
    if (frame) pauseFlight();
    else resumeFlight();
  });
  resumeFlight();
  resize();
  new ResizeObserver(resize).observe(canvas);
}

try {
  start();
} catch (cause) {
  const error = document.querySelector('#error');
  error.textContent = cause.message;
  error.hidden = false;
  play.disabled = true;
}
