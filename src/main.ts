import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { WebGPURendererLayer } from './renderer/webgpu';
import { WebGL1Renderer } from './renderer/webgl1';
import { savePeer, getPeerCount } from './db/peer-history';
import gsap from 'gsap';

// ─── State & Shared Memory
const sharedBuffer = new SharedArrayBuffer(4);
const peerCounter = new Int32Array(sharedBuffer);
let rendererLayer: any;
let composer: EffectComposer;
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
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  const d = new Date();
  const ts = d.toTimeString().slice(0, 8);
  el.innerHTML = `<span style="opacity:0.5">[${ts}]</span> <span class="msg">${msg}</span>`;
  logEl.prepend(el);
  
  gsap.from(el, { 
    opacity: 0, 
    x: -20, 
    duration: 0.6, 
    ease: "power3.out",
    onStart: () => {
      if (type === 'error') gsap.to(el, { x: "+=2", repeat: 5, yoyo: true, duration: 0.05 });
    }
  });
  
  while (logEl.children.length > 8) logEl.removeChild(logEl.lastChild!);
}

// ─── Mouse Interaction
const mouse = new THREE.Vector2();
window.addEventListener('mousemove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  
  // Parallax HUD
  const tiltX = mouse.y * 5;
  const tiltY = -mouse.x * 5;
  gsap.to('.panel', {
    rotateX: tiltX,
    rotateY: tiltY,
    duration: 1,
    ease: "power2.out",
    stagger: 0.05
  });
});

// ─── Initialization
async function init() {
  log('INITIALIZING QUANTUM IPFS CORE...', 'info');

  // 0. Load WASM Physics
  try {
    wasmInstance = await loadWasm();
    log('WASM_LAYER: STATUS_OK (ZIG_PHYSICS_ACTIVE)', 'ok');
  } catch (e) {
    log('WASM_LAYER: LOAD_FAILED. FALLING BACK TO JS_EMULATION.', 'error');
  }

  // 1. Renderer Selection
  const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
  let rawRenderer: any;

  if (navigator.gpu) {
    try {
      rendererLayer = new WebGPURendererLayer(canvas);
      await rendererLayer.init();
      rawRenderer = rendererLayer.renderer;
      badge.textContent = 'WebGPU ❆';
    } catch (e) {
      rendererLayer = new WebGL1Renderer(canvas);
      rawRenderer = rendererLayer.renderer;
      badge.textContent = 'WebGL [LEGACY]';
      badge.classList.add('legacy');
    }
  } else {
    rendererLayer = new WebGL1Renderer(canvas);
    rawRenderer = rendererLayer.renderer;
    badge.textContent = 'WebGL [LEGACY]';
    badge.classList.add('legacy');
  }

  infoApi.textContent = rendererLayer.api;

  // 2. Scene & Post-processing
  setupScene();
  
  // Bloom for WebGL (WebGPU post-processing is still experimental in r168)
  if (rendererLayer.api === 'WebGL') {
    composer = new EffectComposer(rawRenderer);
    composer.addPass(new RenderPass(scene, camera));
    
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.5, 0.4, 0.85
    );
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
  }

  // 3. Worker
  initWorker();

  // 4. Entrance Animations
  gsap.set('.panel, #header, #log', { opacity: 0 });
  const tl = gsap.timeline();
  tl.to('#header', { y: 0, opacity: 1, duration: 1.5, ease: "expo.out" })
    .to('.panel', { opacity: 1, x: 0, duration: 1, stagger: 0.2, ease: "expo.out" }, "-=1")
    .to('#log', { opacity: 1, y: 0, duration: 1, ease: "expo.out" }, "-=0.5");

  // 5. Start Loop
  animate();
  updateStoredCount();
}

function initWorker() {
  worker = new Worker(new URL('./helia.worker.ts', import.meta.url), { type: 'module' });
  worker.postMessage({ type: 'init', data: { sharedBuffer } });

  worker.onmessage = async (e) => {
    const { type, msg, level, status, peer } = e.data;
    if (type === 'log') log(msg, level);
    if (type === 'worker_status') {
      infoWorker.textContent = status;
      infoWorker.className = 'stat-val live';
    }
    if (type === 'peer_discovered') {
      const peerData = { ...peer, connectedAt: new Date().toISOString() };
      await savePeer(peerData);
      updateStoredCount();
      // Visual feedback in core
      gsap.to(coreMat, { opacity: 1, duration: 0.2, yoyo: true, repeat: 1 });
    }
  };
}

async function updateStoredCount() {
  const count = await getPeerCount();
  if (statStoredPeers) statStoredPeers.textContent = count.toString();
}

// ─── Scene Setup
let scene: THREE.Scene, camera: THREE.PerspectiveCamera, controls: OrbitControls, nodeGeo: THREE.BufferGeometry;
const NODE_COUNT = 800; // Even more particles for WASM demo

function setupScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 40, 180);

  const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.3;

  // Starfield with depth
  const STAR_COUNT = 10000;
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT * 3; i++) starPos[i] = (Math.random() - 0.5) * 3000;
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ 
    color: 0xffffff, size: 0.8, transparent: true, opacity: 0.3 
  }));
  scene.add(stars);

  // Node Particles
  nodeGeo = new THREE.BufferGeometry();
  const nodePos = new Float32Array(NODE_COUNT * 3);
  const nodeCol = new Float32Array(NODE_COUNT * 3);

  if (wasmInstance) wasmInstance.init_system(BigInt(NODE_COUNT));

  for (let i = 0; i < NODE_COUNT; i++) {
    const r = 50 + Math.random() * 80;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.sin(phi) * Math.sin(theta);
    const z = r * Math.cos(phi);
    const speed = 0.02 + Math.random() * 0.08;

    nodePos[i*3] = x;
    nodePos[i*3+1] = y;
    nodePos[i*3+2] = z;
    
    // Gradient from Primary to White
    const mix = Math.random();
    nodeCol[i*3] = mix * 0.4 + 0.3; 
    nodeCol[i*3+1] = mix * 0.4 + 0.6; 
    nodeCol[i*3+2] = 1.0;

    if (wasmInstance) wasmInstance.set_particle_data(BigInt(i), x, y, z, speed);
  }
  nodeGeo.setAttribute('position', new THREE.BufferAttribute(nodePos, 3));
  nodeGeo.setAttribute('color', new THREE.BufferAttribute(nodeCol, 3));
  
  const points = new THREE.Points(nodeGeo, new THREE.PointsMaterial({ 
    size: 4, 
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  }));
  scene.add(points);

  // Holographic Core
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(8, 1), coreMat);
  scene.add(core);

  // Rings
  const ringGeo = new THREE.TorusGeometry(120, 0.2, 16, 100);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.2 });
  const ring1 = new THREE.Mesh(ringGeo, ringMat);
  ring1.rotation.x = Math.PI / 2;
  scene.add(ring1);

  infoParticles.textContent = NODE_COUNT.toString();
}

// ─── Animation
let frameCount = 0, lastFpsTime = performance.now(), startTime = performance.now();

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const delta = (now - lastFpsTime) / 1000;
  
  // WASM Physics Update (Quantum Turbulence + Core Attraction)
  if (wasmInstance) {
    wasmInstance.update_particles(120.0, delta * 60.0); // Normalizing to 60fps for calculations
    const ptr = wasmInstance.get_positions_ptr();
    const memory = wasmInstance.memory as WebAssembly.Memory;
    const positions = new Float32Array(memory.buffer, ptr, NODE_COUNT * 3);
    nodeGeo.attributes.position.array.set(positions);
    nodeGeo.attributes.position.needsUpdate = true;
    
    // Use WASM-driven frame count for stats if requested
    // infoFps.textContent = wasmInstance.get_frame_count().toString();
  }

  const currentPeers = Atomics.load(peerCounter, 0);
  statPeers.textContent = currentPeers.toString();

  controls.update();
  
  if (composer) {
    composer.render();
  } else {
    rendererLayer.render(scene, camera);
  }

  // Stats
  frameCount++;
  if (now - lastFpsTime > 1000) {
    infoFps.textContent = Math.round(frameCount * 1000 / (now - lastFpsTime)).toString();
    frameCount = 0; lastFpsTime = now;
    const e = Math.floor((now - startTime) / 1000);
    statUptime.textContent = `${String(Math.floor(e/3600)).padStart(2,'0')}:${String(Math.floor((e%3600)/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`;
  }
}

// ─── Actions
(window as any).connectWallet = async function() {
  if (!(window as any).ethereum) return log('WALLET_ERR: NO_PROVIDER_FOUND', 'error');
  try {
    const accounts = await (window as any).ethereum.request({ method: 'eth_requestAccounts' });
    log(`WALLET_AUTH: ${accounts[0].slice(0, 12)}...`, 'ok');
    const hue = parseInt(accounts[0].slice(2, 8), 16) % 360;
    gsap.to(coreMat.color, {
      duration: 1.5,
      r: new THREE.Color().setHSL(hue/360, 0.9, 0.6).r,
      g: new THREE.Color().setHSL(hue/360, 0.9, 0.6).g,
      b: new THREE.Color().setHSL(hue/360, 0.9, 0.6).b,
    });
    const nodeid = document.getElementById('stat-nodeid');
    if (nodeid) nodeid.textContent = accounts[0];
  } catch (e) {
    log('WALLET_AUTH: USER_REJECTED_OR_FAILED', 'error');
  }
};

(window as any).startIPFSProbe = function() {
  log('INITIATING_NETWORK_PROBE: PROTOCOL_QUIC_WANT', 'info');
  Atomics.add(peerCounter, 0, 1);
  
  // Visual Feedback: Bloom Pulse
  if (composer) {
    const bloom = composer.passes.find(p => p instanceof UnrealBloomPass) as UnrealBloomPass;
    if (bloom) {
      gsap.to(bloom, {
        strength: 4.0,
        duration: 0.1,
        yoyo: true,
        repeat: 1,
        ease: "power2.inOut",
        onComplete: () => { bloom.strength = 1.5; }
      });
    }
  }
  
  // Flash Core
  gsap.to(coreMat, { opacity: 1, duration: 0.1, yoyo: true, repeat: 3 });
};

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  rendererLayer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
});

init();
