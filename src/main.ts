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

// ─── Peer Node Visualization (Real-time Sync)
const peerNodes = new Map<string, { mesh: THREE.Mesh, line: THREE.Line, targetPos: THREE.Vector3 }>();
let peerGroup: THREE.Group;
const peerNodeMat = new THREE.MeshBasicMaterial({ color: 0x3fb950, wireframe: true, transparent: true, opacity: 0 });
const peerLineMat = new THREE.LineBasicMaterial({ color: 0x3fb950, transparent: true, opacity: 0 });
let coreMesh: THREE.Mesh;

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
const ttEl = document.getElementById('node-tooltip') as HTMLDivElement;
const ttId = document.getElementById('tt-id') as HTMLSpanElement;
const ttLat = document.getElementById('tt-lat') as HTMLSpanElement;
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
const raycaster = new THREE.Raycaster();
let selectedPeerId: string | null = null;

window.addEventListener('click', (e) => {
  if (camera && peerGroup) {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(peerGroup.children, false);
    
    let found = false;
    for (let i = 0; i < intersects.length; i++) {
      const obj = intersects[i].object;
      if (obj.userData && obj.userData.peerId) {
        selectedPeerId = obj.userData.peerId;
        showTooltip(e.clientX, e.clientY, obj.userData, true);
        found = true;
        
        // Visual feedback for selection
        const node = peerNodes.get(selectedPeerId!);
        if (node) {
          gsap.to(node.mesh.scale, { x: 2.5, y: 2.5, z: 2.5, duration: 0.4, ease: 'back.out(2)' });
        }
        break;
      }
    }
    
    if (!found) {
      selectedPeerId = null;
      ttEl.style.opacity = '0';
      // Reset all node scales
      peerNodes.forEach(n => {
        gsap.to(n.mesh.scale, { x: 1, y: 1, z: 1, duration: 0.3 });
      });
    }
  }
});

function showTooltip(x: number, y: number, data: any, persistent = false) {
  const ttPath = document.getElementById('tt-path') as HTMLSpanElement;
  const ttStatus = document.getElementById('tt-status') as HTMLSpanElement;
  const ttLoc = document.getElementById('tt-loc') as HTMLSpanElement;
  const ttProgress = document.getElementById('tt-progress') as HTMLDivElement;
  const hudBars = document.querySelectorAll('.hud-bar-inner') as NodeListOf<HTMLDivElement>;
  
  gsap.to(ttEl, { 
    opacity: 1, 
    duration: 0.3, 
    scale: persistent ? 1.02 : 1,
    ease: "back.out(1.7)",
    onStart: () => {
      const overlay = ttEl.querySelector('.glitch-overlay') as HTMLElement;
      if (overlay) {
        gsap.fromTo(overlay, { opacity: 0.8 }, { opacity: 0.1, duration: 0.5, repeat: 1, yoyo: true });
      }
    }
  });
  
  ttEl.style.left = x + 'px';
  ttEl.style.top = y + 'px';
  
  ttId.textContent = data.peerId; 
  ttLat.textContent = data.latency + 'ms';
  if (ttPath) ttPath.textContent = data.gatewayUsed || 'libp2p-direct';
  if (ttLoc) {
    const locs = ['GENEVA_RELAY', 'TOKYO_CLUSTER', 'US_EAST_GATEWAY', 'BERLIN_NODE', 'SINGAPORE_HOP'];
    ttLoc.textContent = data.location || locs[Math.floor(Math.random() * locs.length)];
  }
  
  // High-fidelity HUD additions
  const ttProtocol = document.getElementById('tt-protocol');
  const ttStability = document.getElementById('tt-stability');
  if (ttProtocol) {
    const protocols = ['QUIC_V1', 'TCP/TLS', 'WS/NOISE', 'WTRC/SIGNAL'];
    ttProtocol.textContent = protocols[Math.floor(Math.random() * protocols.length)];
  }
  if (ttStability) {
    const stability = (Math.random() * 20 + 80).toFixed(2);
    ttStability.textContent = stability + '%';
  }
  
  if (ttStatus) {
    ttStatus.textContent = persistent ? 'LOCKED_ON' : 'ACTIVE_STREAM';
    ttStatus.style.color = persistent ? 'var(--color-accent)' : 'var(--color-primary)';
  }

  // Randomize HUD bars for "real-time data" look
  hudBars.forEach(bar => {
    gsap.to(bar, { width: (Math.random() * 80 + 20) + '%', duration: 0.4 });
  });

  if (ttProgress) {
    gsap.fromTo(ttProgress, { x: '-100%' }, { x: '200%', duration: 1.5, ease: "none", repeat: -1 });
  }
  
  if (persistent) {
    ttEl.style.borderColor = 'var(--color-accent)';
    ttEl.style.boxShadow = '0 0 40px rgba(63, 185, 80, 0.4), inset 0 0 20px rgba(63, 185, 80, 0.1)';
  } else {
    ttEl.style.borderColor = 'var(--color-primary)';
    ttEl.style.boxShadow = '0 0 30px rgba(88, 166, 255, 0.3), inset 0 0 15px rgba(88, 166, 255, 0.05)';
  }
}


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

  // Raycaster intersection for Tooltip (Hover)
  if (camera && peerGroup && !selectedPeerId) {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(peerGroup.children, false);
    let found = false;
    for (let i = 0; i < intersects.length; i++) {
      const obj = intersects[i].object;
      if (obj.userData && obj.userData.peerId) {
        found = true;
        showTooltip(e.clientX, e.clientY, obj.userData);
        document.body.style.cursor = 'crosshair';
        break;
      }
    }
    if (!found) {
      ttEl.style.opacity = '0';
      document.body.style.cursor = 'default';
    }
  }
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

  const forceWebGL = localStorage.getItem('ipfs-renderer') === 'webgl';

  if ((navigator as any).gpu && !forceWebGL) {
    try {
      rendererLayer = new WebGPURendererLayer(canvas);
      await rendererLayer.init();
      rawRenderer = rendererLayer.renderer;
      badge.textContent = 'WebGPU ❆';
    } catch (e) {
      fallbackToWebGL(canvas);
      rawRenderer = rendererLayer.renderer;
    }
  } else {
    fallbackToWebGL(canvas);
    rawRenderer = rendererLayer.renderer;
  }

  infoApi.textContent = rendererLayer.api;

  // 2. Scene & Post-processing
  setupScene();
  if (rendererLayer.api === 'WebGL') {
    setupPostProcessing(rawRenderer);
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
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  
  // Initialize worker with relative path support for Vite
  worker = new Worker(new URL('./helia.worker.ts', import.meta.url), { type: 'module' });
  
  worker.postMessage({ type: 'init', data: { sharedBuffer, isLocal } });

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
      addPeerNode(peer.peerId, peer.latency, peer.gatewayUsed);
      
      // Dynamic core reaction
      gsap.to(coreMat, { opacity: 1, duration: 0.1, yoyo: true, repeat: 3 });
      gsap.to(coreAura.scale, { x: 1.5, y: 1.5, z: 1.5, duration: 0.2, yoyo: true, repeat: 1 });
      
      pulseNode(peer.peerId);
      createDataPulse(peer.peerId);
    }
    if (type === 'peer_disconnected') {
      removePeerNode(peer.peerId);
      log(`PEER_DISCONNECTED: ${peer.peerId.substring(0, 8)}...`, 'warn');
    }
  };
}

async function updateStoredCount() {
  const count = await getPeerCount();
  if (statStoredPeers) statStoredPeers.textContent = count.toString();
}

// ─── Scene Setup
let scene: THREE.Scene, camera: THREE.PerspectiveCamera, controls: OrbitControls, nodeGeo: THREE.BufferGeometry;
let coreAura: THREE.Mesh;
const NODE_COUNT = 800; // Even more particles for WASM demo

function setupScene() {
  scene = new THREE.Scene();
  setupCamera();
  setupStars();
  setupNodes();
  setupCore();
  setupRings();

  peerGroup = new THREE.Group();
  scene.add(peerGroup);

  infoParticles.textContent = NODE_COUNT.toString();

  // Data transfer pulse simulation
  setInterval(() => {
    if (peerNodes.size > 0) {
      const keys = Array.from(peerNodes.keys());
      const randomId = keys[Math.floor(Math.random() * keys.length)];
      pulseNode(randomId);
      createDataPulse(randomId);
    }
  }, 1000);
}

function setupCamera() {
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 40, 180);

  const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.3;
}

function setupStars() {
  const STAR_COUNT = 10000;
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT * 3; i++) starPos[i] = (Math.random() - 0.5) * 3000;
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ 
    color: 0xffffff, size: 0.8, transparent: true, opacity: 0.3 
  }));
  scene.add(stars);
}

function setupNodes() {
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
    
    const mix = Math.random();
    nodeCol[i*3] = mix * 0.4 + 0.3; 
    nodeCol[i*3+1] = mix * 0.4 + 0.6; 
    nodeCol[i*3+2] = 1.0;

    if (wasmInstance) wasmInstance.set_particle_data(BigInt(i), x, y, z, speed);
  }
  nodeGeo.setAttribute('position', new THREE.BufferAttribute(nodePos, 3));
  nodeGeo.setAttribute('color', new THREE.BufferAttribute(nodeCol, 3));
  
  const points = new THREE.Points(nodeGeo, new THREE.PointsMaterial({ 
    size: 4, vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false
  }));
  scene.add(points);
}

function setupCore() {
  coreMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(8, 1), coreMat);
  scene.add(coreMesh);
  
  const coreGlowGeo = new THREE.IcosahedronGeometry(8.5, 1);
  const coreGlowMat = new THREE.MeshBasicMaterial({ 
    color: 0x58a6ff, wireframe: true, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending 
  });
  const coreGlow = new THREE.Mesh(coreGlowGeo, coreGlowMat);
  coreMesh.add(coreGlow);
  
  gsap.to(coreGlow.scale, { x: 1.1, y: 1.1, z: 1.1, duration: 2, repeat: -1, yoyo: true, ease: "sine.inOut" });

  coreAura = new THREE.Mesh(
    new THREE.IcosahedronGeometry(10, 2),
    new THREE.MeshBasicMaterial({ color: 0x58a6ff, wireframe: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending })
  );
  scene.add(coreAura);
}

function setupRings() {
  const ringGeo = new THREE.TorusGeometry(120, 0.2, 16, 100);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.2 });
  const ring1 = new THREE.Mesh(ringGeo, ringMat);
  ring1.rotation.x = Math.PI / 2;
  scene.add(ring1);
}

function fallbackToWebGL(canvas: HTMLCanvasElement) {
  rendererLayer = new WebGL1Renderer(canvas);
  badge.textContent = 'WebGL [LEGACY]';
  badge.classList.add('legacy');
}

function setupPostProcessing(rawRenderer: any) {
  composer = new EffectComposer(rawRenderer);
  composer.addPass(new RenderPass(scene, camera));
  
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.5, 0.4, 0.85
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
}

function createDataPulse(peerId: string) {
  const node = peerNodes.get(peerId);
  if (!node) return;

  const pulseCount = 3;
  const userColor = coreAura ? (coreAura.material as THREE.MeshBasicMaterial).color : new THREE.Color(0x58a6ff);

  // Core shockwave
  gsap.to(coreMesh.scale, { x: 1.2, y: 1.2, z: 1.2, duration: 0.1, yoyo: true, repeat: 1 });

  for (let i = 0; i < pulseCount; i++) {
    // 1. Particle pulse (Energy flow from core to node)
    const pulseGeo = new THREE.SphereGeometry(0.8, 8, 8);
    const pulseMat = new THREE.MeshBasicMaterial({ 
      color: userColor, 
      transparent: true, 
      opacity: 1.0,
      blending: THREE.AdditiveBlending 
    });
    const pulse = new THREE.Mesh(pulseGeo, pulseMat);
    scene.add(pulse);

    const start = new THREE.Vector3(0, 0, 0);
    const end = node.targetPos;

    gsap.to(pulse.position, {
      x: end.x,
      y: end.y,
      z: end.z,
      duration: 1.2 + (i * 0.3),
      delay: i * 0.1,
      ease: "power2.in",
      onUpdate: () => {
        const dist = pulse.position.distanceTo(start);
        const totalDist = end.length();
        const progress = dist / totalDist;
        const scale = Math.sin(progress * Math.PI) * 4.0 + 0.5;
        pulse.scale.set(scale, scale, scale);
        pulseMat.opacity = Math.sin(progress * Math.PI) * 0.9;
      },
      onComplete: () => {
        scene.remove(pulse);
        pulseGeo.dispose();
        pulseMat.dispose();
      }
    });
    
    // 2. Wave pulse (Expanding shockwave at target)
    if (i === 0) {
      setTimeout(() => {
        const shockGeo = new THREE.RingGeometry(0.5, 2.0, 32);
        const shockMat = new THREE.MeshBasicMaterial({ 
          color: userColor, 
          transparent: true, 
          opacity: 0.9, 
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide
        });
        const shock = new THREE.Mesh(shockGeo, shockMat);
        shock.position.copy(end);
        shock.lookAt(new THREE.Vector3(0,0,0));
        scene.add(shock);
        
        gsap.to(shock.scale, { x: 15, y: 15, z: 15, duration: 1.5, ease: "expo.out" });
        gsap.to(shockMat, { opacity: 0, duration: 1.5, ease: "expo.out", onComplete: () => {
          scene.remove(shock);
          shockGeo.dispose();
          shockMat.dispose();
        }});
        
        // Node pulse
        pulseNode(peerId);

        // Inter-node pulse (Pulse to another random node)
        if (peerNodes.size > 1) {
          const others = Array.from(peerNodes.keys()).filter(id => id !== peerId);
          const nextPeerId = others[Math.floor(Math.random() * others.length)];
          createInterNodePulse(peerId, nextPeerId);
        }
      }, 1100);
    }
  }
}

function createInterNodePulse(fromId: string, toId: string) {
  const from = peerNodes.get(fromId);
  const to = peerNodes.get(toId);
  if (!from || !to) return;

  const pulseGeo = new THREE.SphereGeometry(0.5, 8, 8);
  const pulseMat = new THREE.MeshBasicMaterial({ 
    color: 0x3fb950, 
    transparent: true, 
    opacity: 1.0,
    blending: THREE.AdditiveBlending 
  });
  const pulse = new THREE.Mesh(pulseGeo, pulseMat);
  scene.add(pulse);

  pulse.position.copy(from.targetPos);

  gsap.to(pulse.position, {
    x: to.targetPos.x,
    y: to.targetPos.y,
    z: to.targetPos.z,
    duration: 1.5,
    ease: "power1.inOut",
    onUpdate: () => {
      pulseMat.opacity = 0.8;
    },
    onComplete: () => {
      scene.remove(pulse);
      pulseGeo.dispose();
      pulseMat.dispose();
      pulseNode(toId);
    }
  });
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
    const userColor = new THREE.Color().setHSL(hue/360, 0.9, 0.6);
    gsap.to(coreMat.color, {
      duration: 1.5,
      r: userColor.r, g: userColor.g, b: userColor.b,
    });
    
    // Enhanced Metamask aura effects
    if (coreAura) {
      gsap.to((coreAura.material as THREE.MeshBasicMaterial).color, {
        duration: 1.5,
        r: userColor.r, g: userColor.g, b: userColor.b,
      });
      gsap.to(coreAura.material as THREE.MeshBasicMaterial, { opacity: 0.8, duration: 1.5 });
      
      // Layered complex aura
      const auraTimeline = gsap.timeline({ repeat: -1 });
      auraTimeline
        .to(coreAura.scale, { x: 1.8, y: 1.8, z: 1.8, duration: 2.0, ease: 'sine.inOut' })
        .to(coreAura.scale, { x: 1.3, y: 1.3, z: 1.3, duration: 2.0, ease: 'sine.inOut' });
      
      gsap.to(coreAura.rotation, { x: Math.PI * 2, y: Math.PI * 2, duration: 20, repeat: -1, ease: 'none' });

      // Core "Energy Flux" Particles
      const fluxGeo = new THREE.BufferGeometry();
      const fluxCount = 200;
      const fluxPos = new Float32Array(fluxCount * 3);
      for(let i=0; i<fluxCount; i++) {
        const r = 10 + Math.random() * 5;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        fluxPos[i*3] = r * Math.sin(phi) * Math.cos(theta);
        fluxPos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
        fluxPos[i*3+2] = r * Math.cos(phi);
      }
      fluxGeo.setAttribute('position', new THREE.BufferAttribute(fluxPos, 3));
      const fluxMat = new THREE.PointsMaterial({ color: userColor, size: 0.5, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending });
      const fluxPoints = new THREE.Points(fluxGeo, fluxMat);
      coreMesh.add(fluxPoints);
      gsap.to(fluxPoints.rotation, { y: Math.PI * 2, duration: 5, repeat: -1, ease: "none" });

      // Dynamic Core Geometry Evolution
      const newGeo = new THREE.TorusKnotGeometry(6, 1.5, 100, 16);
      coreMesh.geometry.dispose();
      coreMesh.geometry = newGeo;
      gsap.from(coreMesh.scale, { x: 0, y: 0, z: 0, duration: 1.5, ease: "elastic.out(1, 0.3)" });

      // Shield effect (Multiple Rotating Rings)
      for (let i = 0; i < 4; i++) {
        const shieldGeo = new THREE.TorusGeometry(12 + i * 4, 0.08, 16, 100);
        const shieldMat = new THREE.MeshBasicMaterial({ 
          color: userColor, 
          transparent: true, 
          opacity: 0.3 - (i * 0.05),
          blending: THREE.AdditiveBlending 
        });
        const shield = new THREE.Mesh(shieldGeo, shieldMat);
        shield.rotation.x = Math.PI / 2;
        shield.rotation.y = (Math.PI / 4) * i;
        scene.add(shield);
        
        gsap.to(shield.rotation, { 
          z: Math.PI * 2, 
          y: Math.PI * 2,
          duration: 6 + i * 3, 
          repeat: -1, 
          ease: 'none' 
        });
      }
      
      // Infinite expansion pulse wave
      const createExpansionPulse = () => {
        const pulseRingGeo = new THREE.TorusGeometry(10, 0.15, 16, 100);
        const pulseRingMat = new THREE.MeshBasicMaterial({ color: userColor, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending });
        const pulseRing = new THREE.Mesh(pulseRingGeo, pulseRingMat);
        pulseRing.rotation.x = Math.PI / 2;
        scene.add(pulseRing);
        
        gsap.to(pulseRing.scale, { 
          x: 15, y: 15, z: 15, 
          duration: 3, 
          ease: 'power2.out',
          onUpdate: function() {
            pulseRingMat.opacity = 0.8 * (1 - this.progress());
          },
          onComplete: () => {
            scene.remove(pulseRing);
            pulseRingGeo.dispose();
            pulseRingMat.dispose();
          }
        });
      };
      
      setInterval(createExpansionPulse, 1500);
      createExpansionPulse();
    }
    
    const nodeid = document.getElementById('stat-nodeid');
    if (nodeid) nodeid.textContent = accounts[0];
  } catch (e) {
    log('WALLET_AUTH: USER_REJECTED_OR_FAILED', 'error');
  }
};


// ─── Renderer Toggle
(window as any).toggleRenderer = function() {
  const current = localStorage.getItem('ipfs-renderer');
  if (current === 'webgl') {
    localStorage.removeItem('ipfs-renderer');
    log('RENDERER_SWITCH: → WebGPU (reload)', 'info');
  } else {
    localStorage.setItem('ipfs-renderer', 'webgl');
    log('RENDERER_SWITCH: → WebGL [LEGACY] (reload)', 'info');
  }
  setTimeout(() => window.location.reload(), 400);
};

// ─── Peer Node Real-time Sync
function addPeerNode(peerId: string, latency: number = 20, gatewayUsed: string = 'libp2p-direct') {
  if (peerNodes.has(peerId)) return;
  const r = 60 + Math.random() * 50;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  const targetPos = new THREE.Vector3(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.sin(phi) * Math.sin(theta),
    r * Math.cos(phi)
  );

  const mesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(2, 1),
    peerNodeMat.clone()
  );
  mesh.position.copy(targetPos);
  mesh.scale.set(0, 0, 0);

  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), targetPos
  ]);
  const line = new THREE.Line(lineGeo, peerLineMat.clone());

  peerGroup.add(mesh);
  peerGroup.add(line);
  
  // Attach user data for raycaster
  mesh.userData = { peerId, latency, gatewayUsed };
  
  peerNodes.set(peerId, { mesh, line, targetPos });

  gsap.to(mesh.scale, { x: 1, y: 1, z: 1, duration: 0.8, ease: 'elastic.out(1, 0.5)' });
  gsap.to(mesh.material as THREE.MeshBasicMaterial, { opacity: 0.9, duration: 0.5 });
  gsap.to(line.material as THREE.LineBasicMaterial, { opacity: 0.3, duration: 0.5 });
}

function pulseNode(peerId: string) {
  const node = peerNodes.get(peerId);
  if (!node) return;
  gsap.to(node.mesh.scale, { x: 1.8, y: 1.8, z: 1.8, duration: 0.2, yoyo: true, repeat: 1 });
  gsap.to((node.line.material as THREE.LineBasicMaterial), { opacity: 0.8, duration: 0.2, yoyo: true, repeat: 1 });
  
  // Core reaction
  gsap.to(coreMat, { opacity: 1, duration: 0.2, yoyo: true, repeat: 1 });
  if (coreMesh) {
    gsap.to(coreMesh.scale, { x: 1.1, y: 1.1, z: 1.1, duration: 0.15, yoyo: true, repeat: 1, ease: "power2.out" });
  }
}

function removePeerNode(peerId: string) {
  const node = peerNodes.get(peerId);
  if (!node) return;
  const { mesh, line } = node;
  gsap.to(mesh.scale, {
    x: 0, y: 0, z: 0,
    duration: 0.6,
    ease: 'power2.in',
    onComplete: () => {
      peerGroup.remove(mesh);
      peerGroup.remove(line);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      peerNodes.delete(peerId);
    }
  });
  gsap.to(line.material as THREE.LineBasicMaterial, { opacity: 0, duration: 0.4 });
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  rendererLayer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Notion Hub Actions
(window as any).notionAction = async function(type: string) {
  const input = document.getElementById('notion-search-input') as HTMLInputElement;
  const status = document.getElementById('notion-status') as HTMLDivElement;
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  
  if (isLocal) {
    let url = `/api/notion?type=${type}`;
    if (type === 'search') url += `&query=${encodeURIComponent(input.value || 'IPFS')}`;
    if (type === 'create') url += `&title=${encodeURIComponent(input.value || 'New Project Update')}`;
    if (type === 'comment') url += `&content=${encodeURIComponent(input.value || 'Automated node status update.')}`;

    log(`NOTION_LOCAL_CMD: EXECUTING_${type.toUpperCase()}...`, 'info');
    status.textContent = 'STATUS: COMMUNICATING_WITH_NCLI_BRIDGE...';

    try {
      const response = await fetch(url);
      const data = await response.json();
      if (data.success) {
        log(`NOTION_RES: ${type.toUpperCase()}_SUCCESSful`, 'ok');
        console.log('NCLI Output:', data.output);
        status.textContent = `LAST_${type.toUpperCase()}: SUCCESS (LOCAL_NODE)`;
      } else {
        log(`NOTION_ERR: ${data.error}`, 'error');
        status.textContent = 'STATUS: NCLI_EXECUTION_FAILED';
      }
    } catch (e: any) {
      log(`NOTION_BRIDGE_ERR: ${e.message}`, 'error');
      status.textContent = 'STATUS: BRIDGE_CONNECTION_ERROR';
    }
  } else {
    // Web Simulation Mode
    if (type === 'search') {
      const query = input.value || 'General';
      log(`NOTION_QUERY: SEARCHING_FOR "${query}" (SIM_MODE)...`, 'info');
      status.textContent = 'STATUS: SEARCHING_REMOTE_WORKSPACE...';
      setTimeout(() => {
        log('NOTION_RES: SYNC_COMPLETE. LIVE_NETWORK_REFLECTED_BY_DEFAULT.', 'ok');
        status.textContent = 'LAST_SEARCH: ' + query + ' (SIM)';
      }, 1500);
    } else if (type === 'create') {
      log('NOTION_CMD: INITIALIZING_NEW_PAGE_TEMPLATE (SIM_MODE)...', 'info');
      status.textContent = 'STATUS: CREATING_BLOCKS...';
      setTimeout(() => {
        log('NOTION_RES: PAGE_CREATED_SUCCESSFULLY (ID: 35ea55d2...)', 'ok');
        status.textContent = 'LAST_ACTION: CREATE_PAGE (SIM)';
      }, 1200);
    } else if (type === 'comment') {
      log('NOTION_CMD: POSTING_ADAPTIVE_COMMENT (SIM_MODE)...', 'info');
      status.textContent = 'STATUS: PUSHING_RICH_TEXT...';
      setTimeout(() => {
        log('NOTION_RES: COMMENT_PUBLISHED_TO_CHAT_ROOM', 'ok');
        status.textContent = 'LAST_ACTION: ADD_COMMENT (SIM)';
      }, 1000);
    }
  }
};


init();

