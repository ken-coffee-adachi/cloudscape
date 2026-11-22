import * as THREE from 'three';

export function makeWaveSlopes() {
  const size = 128, data = new Uint8Array(size * size * 2);
  const slopes = new Float32Array(data.length);
  // Integer frequencies make both slope components seamless at the tile edges.
  for (let i = 1; i <= 30; i++) {
    const angle = i * 2.399963;
    const frequency = 2 + (i * 7 % 19);
    const x = Math.round(Math.cos(angle) * frequency);
    const z = Math.round(Math.sin(angle) * frequency);
    const weight = 0.25 / Math.sqrt(frequency);
    for (let v = 0; v < size; v++) for (let u = 0; u < size; u++) {
      const wave = Math.cos((x*u + z*v) * 2*Math.PI / size + i*i) * weight;
      const j = 2 * (v*size + u);
      slopes[j] += wave * x / frequency;
      slopes[j+1] += wave * z / frequency;
    }
  }
  for (let j = 0; j < data.length; j++) {
    data[j] = Math.round(127.5 * (1 + Math.max(-1, Math.min(1, slopes[j]))));
  }
  const map = new THREE.DataTexture(data, size, size, THREE.RGFormat);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  return map;
}
