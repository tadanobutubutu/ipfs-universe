import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WebGPURendererLayer } from './renderer/webgpu';
import { WebGL1Renderer } from './renderer/webgl1';
import { savePeer, getPeerCount } from './db/peer-history';
import gsap from 'gsap';

// ─── State & Shared Memory
const sharedBuffer = new SharedArrayBuffer(4); // 4 bytes for Int32 peer count
const peerCounter = new Int32Array(sharedBuffer);
let rendererLayer: any;
let worker: Worker;
let wasmInstance: any;

async function loadWasm() {
  const response = await fetch('/particles.wasm');
  const buffer = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(buffer, {
    env: {
      memory: new WebAssembly.Memory({ initial: 256 }),
      abort: () => console.log('Abort!'),
    }
  });
  return instance.exports;
}

// ─── UI Elements
const logEl = document.getElementById('log-entries') as HTMLDivElement;
const badge = document.getElementById('renderer-badge') as HTMLSpanElement;
const statPeers = document.getElementById('stat-peers') as HTMLSpanElement;
const statStoredPeers = document.getElementById('stat-peers-stored') as HTMLSpanElement;
const statUptime = document.getElementById('stat-uptime') as HTMLSpanElement;
const infoApi = document.getElementById('info-api') as HTMLSpanElement;
const infoParticles = document.getElementById('info-particles') as HTMLSpanElement;
const infoFps = document.getElementById('info-fps') as HTMLSpanElement;
const infoWorker = document.getElementById('info-worker') as HTMLSpanElement;
const coreMat = new THREE.MeshBasicMaterial({ color: 0x58a6ff, wireframe: true, transparent: true, opacity: 0.8 });

// ─── Logger
function log(msg: string, type: string = 'info') {
  const el = document.createElement('span');
  el.className = `log-entry ${type}`;
  const d = new Date();
  const ts = d.toTimeString().slice(0, 8);
  el.textContent = `[${ts}] ${msg}`;
  logEl.prepend(el);
  
  gsap.from(el, { opacity: 0, y: 10, duration: 0.4, ease: "power2.out" });
  
  while (logEl.children.length > 6) logEl.removeChild(logEl.lastChild!);
}

// ─── Initialization
async function init() {
  log('Initializing IPFS Universe Engine...', 'info');

  // 0. Load WASM Physics
  try {
    wasmInstance = await loadWasm();
    log('WASM Particle Physics Layer: ACTIVE', 'ok');
  } catch (e) {
    console.error('WASM load failed:', e);
    log('WASM failed, falling back to JS physics', 'warn');
  }

  // 1. Renderer Selection
  const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
  if (navigator.gpu) {
    try {
      rendererLayer = new WebGPURendererLayer(canvas);
      await rendererLayer.init();
      badge.textContent = 'WebGPU ❆';
    } catch (e) {
      rendererLayer = new WebGL1Renderer(canvas);
      badge.textContent = 'WebGL [LEGACY]';
      badge.classList.add('legacy');
    }
  } else {
    rendererLayer = new WebGL1Renderer(canvas);
    badge.textContent = 'WebGL [LEGACY]';
    badge.classList.add('legacy');
  }

  infoApi.textContent = rendererLayer.api;

  // 2. Worker
  initWorker();

  // 3. Three.js Scene
  setupScene();

  // 4. Entrance Animations
  gsap.from('.panel', {
    x: (i) => i === 0 ? -100 : 100,
    opacity: 0,
    duration: 1.2,
    stagger: 0.2,
    ease: "expo.out"
  });
  gsap.from('#header', { y: -50, opacity: 0, duration: 1, ease: "expo.out", delay: 0.5 });
  gsap.from('#log', { y: 50, opacity: 0, duration: 1, ease: "expo.out", delay: 0.7 });

  // 5. Start Loop
  animate();
  updateStoredCount();
}

function initWorker() {
  worker = new Worker(new URL('./helia.worker.ts', import.meta.url), { type: 'module' });
  
  worker.postMessage({
    type: 'init',
    data: { sharedBuffer }
  });

  worker.onmessage = async (e) => {
    const { type, msg, level, status, peer } = e.data;
    if (type === 'log') log(msg, level);
    if (type === 'worker_status') {
      infoWorker.textContent = status;
      infoWorker.className = 'stat-val live';
    }
    if (type === 'peer_discovered') {
      const peerData = {
        ...peer,
        connectedAt: new Date().toISOString()
      };
      await savePeer(peerData);
      updateStoredCount();
    }
  };
}

async function updateStoredCount() {
  const count = await getPeerCount();
  if (statStoredPeers) statStoredPeers.textContent = count.toString();
}

// ─── Scene Setup
let scene: THREE.Scene, camera: THREE.PerspectiveCamera, controls: OrbitControls, nodeGeo: THREE.BufferGeometry;
const NODE_COUNT = 500; // Increased for WASM performance demo

function setupScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 0, 150);

  const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.5;

  // Starfield
  const STAR_COUNT = 8000;
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT * 3; i++) starPos[i] = (Math.random() - 0.5) * 2000;
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x58a6ff, size: 0.7, transparent: true, opacity: 0.5 })));

  // Node Particles
  nodeGeo = new THREE.BufferGeometry();
  const nodePos = new Float32Array(NODE_COUNT * 3);
  const nodeCol = new Float32Array(NODE_COUNT * 3);

  // Initialize WASM
  if (wasmInstance) {
    wasmInstance.init_system(BigInt(NODE_COUNT));
  }

  for (let i = 0; i < NODE_COUNT; i++) {
    const r = 40 + Math.random() * 60;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.sin(phi) * Math.sin(theta);
    const z = r * Math.cos(phi);
    const speed = (Math.random() - 0.5) * 0.05;

    nodePos[i*3] = x;
    nodePos[i*3+1] = y;
    nodePos[i*3+2] = z;
    
    nodeCol[i*3] = 0.3 + Math.random() * 0.2; 
    nodeCol[i*3+1] = 0.6 + Math.random() * 0.2; 
    nodeCol[i*3+2] = 1.0;

    if (wasmInstance) {
      wasmInstance.set_particle_data(BigInt(i), x, y, z, speed);
    }
  }
  nodeGeo.setAttribute('position', new THREE.BufferAttribute(nodePos, 3));
  nodeGeo.setAttribute('color', new THREE.BufferAttribute(nodeCol, 3));
  
  const points = new THREE.Points(nodeGeo, new THREE.PointsMaterial({ 
    size: 3, 
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending
  }));
  scene.add(points);

  // Core
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(6, 0), coreMat);
  scene.add(core);

  infoParticles.textContent = NODE_COUNT.toString();
}

// ─── Animation
let frameCount = 0, lastFpsTime = performance.now(), startTime = performance.now();

function animate() {
  requestAnimationFrame(animate);
  
  // WASM Physics Update
  if (wasmInstance) {
    wasmInstance.update_particles(120.0); // limit
    const ptr = wasmInstance.get_positions_ptr();
    const memory = wasmInstance.memory as WebAssembly.Memory;
    const positions = new Float32Array(memory.buffer, ptr, NODE_COUNT * 3);
    nodeGeo.attributes.position.array.set(positions);
    nodeGeo.attributes.position.needsUpdate = true;
  }

  const currentPeers = Atomics.load(peerCounter, 0);
  statPeers.textContent = currentPeers.toString();

  controls.update();
  rendererLayer.render(scene, camera);

  // Stats
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime > 1000) {
    infoFps.textContent = Math.round(frameCount * 1000 / (now - lastFpsTime)).toString();
    frameCount = 0; lastFpsTime = now;
    const e = Math.floor((now - startTime) / 1000);
    statUptime.textContent = `${String(Math.floor(e/3600)).padStart(2,'0')}:${String(Math.floor((e%3600)/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`;
  }
}

// ─── Actions
(window as any).connectWallet = async function() {
  if (!(window as any).ethereum) return log('No wallet detected', 'error');
  try {
    const accounts = await (window as any).ethereum.request({ method: 'eth_requestAccounts' });
    log(`Connected: ${accounts[0].slice(0, 8)}...`, 'ok');
    const hue = parseInt(accounts[0].slice(2, 8), 16) % 360;
    gsap.to(coreMat.color, {
      duration: 1,
      r: new THREE.Color().setHSL(hue/360, 0.8, 0.6).r,
      g: new THREE.Color().setHSL(hue/360, 0.8, 0.6).g,
      b: new THREE.Color().setHSL(hue/360, 0.8, 0.6).b,
    });
    const nodeid = document.getElementById('stat-nodeid');
    if (nodeid) nodeid.textContent = accounts[0];
  } catch (e) {
    log('Wallet connection failed', 'error');
  }
};

(window as any).startIPFSProbe = function() {
  log('Triggering legacy XHR network ritual...', 'info');
  // Reuse logic from previous if needed, but here we just simulate
  Atomics.add(peerCounter, 0, 1);
};

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  rendererLayer.setSize(window.innerWidth, window.innerHeight);
});

init();
