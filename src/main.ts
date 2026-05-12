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
let coreAura: THREE.Mesh;
let coreAdditionalGlow: THREE.Points;
let coreRotationSpeed = 0.3;
let coreInnerGlow: THREE.Mesh;

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
const reticle = document.getElementById('targeting-reticle') as HTMLDivElement;
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
  const ttGraph = document.getElementById('tt-graph') as HTMLDivElement;
  
  gsap.to(ttEl, { 
    opacity: 1, 
    duration: 0.4, 
    scale: persistent ? 1.05 : 1,
    ease: "expo.out",
    onStart: () => {
      const overlay = ttEl.querySelector('.glitch-overlay') as HTMLElement;
      if (overlay) {
        gsap.fromTo(overlay, { opacity: 0.9 }, { opacity: 0.05, duration: 0.2, repeat: 3, yoyo: true });
      }
      // Sound effect simulation (visual pulse)
      gsap.to(ttEl, { x: "+=2", duration: 0.05, repeat: 5, yoyo: true });
    }
  });
  
  // Adjust tooltip position to stay within screen
  const rect = ttEl.getBoundingClientRect();
  let finalX = x;
  let finalY = y - 20;
  
  if (x + 320 > window.innerWidth) finalX = window.innerWidth - 340;
  if (x < 20) finalX = 20;
  if (y - 300 < 0) finalY = y + 20;

  ttEl.style.left = finalX + 'px';
  ttEl.style.top = finalY + 'px';
  
  ttId.textContent = data.peerId; 
  ttLat.textContent = data.latency + 'ms';
  if (ttPath) ttPath.textContent = data.gatewayUsed || 'libp2p-direct';
  if (ttLoc) {
    const locs = ['GENEVA_RELAY', 'TOKYO_CLUSTER', 'US_EAST_GATEWAY', 'BERLIN_NODE', 'SINGAPORE_HOP'];
    ttLoc.textContent = data.location || locs[Math.floor(Math.random() * locs.length)];
  }
  
  // Traffic Simulation
  const trafficEl = document.getElementById('tt-traffic');
  if (trafficEl) {
    const traffic = (Math.random() * 50 + 10).toFixed(2);
    trafficEl.textContent = traffic + ' KB/s';
  }

  // Mini-graph population
  if (ttGraph) {
    ttGraph.innerHTML = '';
    for (let i = 0; i < 24; i++) {
      const bar = document.createElement('div');
      bar.className = 'graph-bar';
      const height = 20 + Math.random() * 80;
      bar.style.height = height + '%';
      bar.style.opacity = (0.3 + (i / 24) * 0.7).toString();
      ttGraph.appendChild(bar);
      gsap.from(bar, { scaleY: 0, duration: 0.3, delay: i * 0.01, ease: "power1.out" });
    }
  }

  const rxBar = document.getElementById('tt-rx-bar');
  const rxVal = document.getElementById('tt-rx-val');
  const txBar = document.getElementById('tt-tx-bar');
  const txVal = document.getElementById('tt-tx-val');
  
  if (rxBar && rxVal) {
    const rx = Math.floor(Math.random() * 100);
    gsap.to(rxBar, { width: rx + '%', duration: 0.8, ease: "power2.inOut" });
    rxVal.textContent = rx + '%';
  }
  if (txBar && txVal) {
    const tx = Math.floor(Math.random() * 100);
    gsap.to(txBar, { width: tx + '%', duration: 0.8, ease: "power2.inOut" });
    txVal.textContent = tx + '%';
  }
  
  // High-fidelity HUD additions
  const ttProtocol = document.getElementById('tt-protocol');
  const ttStability = document.getElementById('tt-stability');
  if (ttProtocol) {
    const protocols = ['QUIC_V1', 'TCP/TLS', 'WS/NOISE', 'WTRC/SIGNAL'];
    ttProtocol.textContent = protocols[Math.floor(Math.random() * protocols.length)];
  }
  if (ttStability) {
    const stability = (Math.random() * 15 + 85).toFixed(2);
    ttStability.textContent = stability + '%';
  }
  
  if (ttStatus) {
    ttStatus.textContent = persistent ? 'LOCKED_ON' : 'ACTIVE_STREAM';
    ttStatus.style.color = persistent ? 'var(--color-accent)' : 'var(--color-primary)';
  }

  // Generate simulated route path
  const ttRoute = document.getElementById('tt-route');
  if (ttRoute) {
    const hops = ['LOCAL_CORE', 'REGION_RELAY', 'GATEWAY_EXIT', 'PEER_ENTRY'];
    const randomHops = [hops[0], ...Array.from({length: Math.floor(Math.random()*3)}, () => 'HOP_' + Math.random().toString(36).slice(2,5).toUpperCase()), hops[3]];
    ttRoute.innerHTML = randomHops.map((h, i) => `<span style="opacity: ${0.4 + (i/randomHops.length)*0.6}">${h}</span>`).join(' <span style="opacity:0.2">→</span> ');
  }

  // Randomize HUD bars for "real-time data" look
  hudBars.forEach((bar, idx) => {
    gsap.to(bar, { width: (Math.random() * 70 + 30) + '%', duration: 0.5, delay: idx * 0.05, ease: "back.out(1.7)" });
  });

  if (ttProgress) {
    gsap.fromTo(ttProgress, { x: '-100%' }, { x: '200%', duration: 1.5, ease: "none", repeat: -1 });
  }
  
  if (persistent) {
    ttEl.style.borderColor = 'var(--color-accent)';
    ttEl.style.boxShadow = '0 0 50px rgba(63, 185, 80, 0.4), inset 0 0 25px rgba(63, 185, 80, 0.1)';
  } else {
    ttEl.style.borderColor = 'var(--color-primary)';
    ttEl.style.boxShadow = '0 0 40px rgba(88, 166, 255, 0.3), inset 0 0 20px rgba(88, 166, 255, 0.05)';
  }

  // Show reticle
  if (reticle) {
    reticle.style.opacity = '1';
    reticle.style.left = x + 'px';
    reticle.style.top = y + 'px';
    gsap.fromTo(reticle, { scale: 3, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: "back.out(2)" });
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
      if (reticle) reticle.style.opacity = '0';
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
      gsap.to(coreAura.scale, { x: 1.8, y: 1.8, z: 1.8, duration: 0.3, yoyo: true, repeat: 1, ease: "expo.out" });
      
      // Flash effect on core
      const flash = new THREE.Mesh(
        new THREE.SphereGeometry(12, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending })
      );
      scene.add(flash);
      gsap.to(flash.scale, { x: 4, y: 4, z: 4, duration: 0.5, ease: "expo.out" });
      gsap.to(flash.material, { opacity: 0, duration: 0.5, ease: "expo.out", onComplete: () => {
        scene.remove(flash);
        flash.geometry.dispose();
        (flash.material as THREE.Material).dispose();
      }});

      createDiscoveryWave(peer.peerId);
      pulseNode(peer.peerId);
      createDataPulse(peer.peerId);
      
      // Boost core rotation on discovery
      coreRotationSpeed = 2.0;
      gsap.to({ val: 2.0 }, { val: 0.3, duration: 2, onUpdate: function() { coreRotationSpeed = this.targets()[0].val; } });
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
  controls.autoRotateSpeed = coreRotationSpeed;
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
  
  coreInnerGlow = new THREE.Mesh(
    new THREE.IcosahedronGeometry(4, 2),
    new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending })
  );
  coreMesh.add(coreInnerGlow);
  gsap.to(coreInnerGlow.scale, { x: 1.5, y: 1.5, z: 1.5, duration: 1.5, repeat: -1, yoyo: true, ease: "power2.inOut" });

  // Wallet-specific aura points placeholder
  const auraPointsGeo = new THREE.BufferGeometry();
  const auraPointsMat = new THREE.PointsMaterial({ 
    size: 2, 
    color: 0x58a6ff, 
    transparent: true, 
    opacity: 0, 
    blending: THREE.AdditiveBlending 
  });
  coreAdditionalGlow = new THREE.Points(auraPointsGeo, auraPointsMat);
  scene.add(coreAdditionalGlow);
}

function setupRings() {
  const ringGeo = new THREE.TorusGeometry(120, 0.15, 16, 120);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending });
  const ring1 = new THREE.Mesh(ringGeo, ringMat);
  ring1.rotation.x = Math.PI / 2;
  scene.add(ring1);
  
  const ring2 = ring1.clone();
  ring2.rotation.y = Math.PI / 4;
  ring2.scale.set(1.1, 1.1, 1.1);
  scene.add(ring2);
  
  gsap.to(ring1.rotation, { z: Math.PI * 2, duration: 60, repeat: -1, ease: "none" });
  gsap.to(ring2.rotation, { z: -Math.PI * 2, duration: 90, repeat: -1, ease: "none" });
}

function notionAction(type: string) {
  const query = (document.getElementById('notion-search-input') as HTMLInputElement).value;
  const statusEl = document.getElementById('notion-status');
  
  log(`NOTION_REQUEST: ACTION_${type.toUpperCase()}`, 'info');
  if (statusEl) statusEl.textContent = `EXECUTING_${type.toUpperCase()}...`;
  
  const params = new URLSearchParams({ type, query, title: 'Network Discovery Log', content: `Discovered new network entities. Current peer count: ${peerNodes.size}` });
  
  fetch(`/api/notion?${params.toString()}`)
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        log(`NOTION_SUCCESS: SYNC_COMPLETE`, 'ok');
        if (statusEl) statusEl.textContent = 'SYNC_STATUS: IDLE_OK';
        console.log('Notion Response:', data.output);
      } else {
        log(`NOTION_ERROR: ${data.error}`, 'error');
        if (statusEl) statusEl.textContent = 'SYNC_STATUS: ERROR_DETECTED';
      }
    })
    .catch(err => {
      log(`NOTION_BRIDGE_ERROR: ${err.message}`, 'error');
      if (statusEl) statusEl.textContent = 'SYNC_STATUS: CONNECTION_FAILED';
    });
}

(window as any).notionAction = notionAction;

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
  createShockwave(new THREE.Vector3(0,0,0), userColor, 40);

  for (let i = 0; i < pulseCount; i++) {
    // 1. Streak pulse (Comet effect)
    const streakGeo = new THREE.CylinderGeometry(0.1, 0.4, 8, 8);
    const streakMat = new THREE.MeshBasicMaterial({ 
      color: userColor, 
      transparent: true, 
      opacity: 0.8,
      blending: THREE.AdditiveBlending 
    });
    const streak = new THREE.Mesh(streakGeo, streakMat);
    scene.add(streak);

    const start = new THREE.Vector3(0, 0, 0);
    const end = node.targetPos;
    
    streak.lookAt(end);
    streak.rotateX(Math.PI / 2);

    gsap.to(streak.position, {
      x: end.x,
      y: end.y,
      z: end.z,
      duration: 0.6 + (i * 0.15),
      delay: i * 0.08,
      ease: "power2.in",
      onUpdate: () => {
        const dist = streak.position.distanceTo(start);
        const totalDist = end.length();
        const progress = dist / totalDist;
        streak.scale.set(1 + progress * 2, 1 + progress * 3, 1);
        streakMat.opacity = Math.sin(progress * Math.PI) * 0.8;
      },
      onComplete: () => {
        scene.remove(streak);
        streakGeo.dispose();
        streakMat.dispose();
      }
    });
    
    // 2. Wave pulse (Expanding shockwave at target)
    if (i === 0) {
      setTimeout(() => {
        createShockwave(end, userColor, 15);
        pulseNode(peerId);

        // Inter-node pulse (Pulse to another random node)
        if (peerNodes.size > 1) {
          const others = Array.from(peerNodes.keys()).filter(id => id !== peerId);
          const nextPeerId = others[Math.floor(Math.random() * others.length)];
          createInterNodePulse(peerId, nextPeerId);
        }
      }, 700);
    }
  }
}

function createShockwave(pos: THREE.Vector3, color: THREE.Color, size: number) {
  const shockGeo = new THREE.RingGeometry(0.5, 1.0, 32);
  const shockMat = new THREE.MeshBasicMaterial({ 
    color: color, 
    transparent: true, 
    opacity: 0.8, 
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide
  });
  const shock = new THREE.Mesh(shockGeo, shockMat);
  shock.position.copy(pos);
  shock.lookAt(camera.position); // Always face camera for UI feel
  scene.add(shock);
  
  gsap.to(shock.scale, { x: size, y: size, z: size, duration: 1.2, ease: "expo.out" });
  gsap.to(shockMat, { opacity: 0, duration: 1.2, ease: "expo.out", onComplete: () => {
    scene.remove(shock);
    shockGeo.dispose();
    shockMat.dispose();
  }});
}

function createPulseWave(peerId: string) {
  const node = peerNodes.get(peerId);
  if (!node) return;

  const userColor = coreAura ? (coreAura.material as THREE.MeshBasicMaterial).color : new THREE.Color(0x58a6ff);
  
  // Create a moving wave along the line
  const waveGeo = new THREE.SphereGeometry(1.2, 12, 12);
  const waveMat = new THREE.MeshBasicMaterial({ 
    color: userColor, 
    transparent: true, 
    opacity: 0.8,
    blending: THREE.AdditiveBlending 
  });
  const wave = new THREE.Mesh(waveGeo, waveMat);
  scene.add(wave);

  const start = new THREE.Vector3(0,0,0);
  const end = node.targetPos;

  gsap.to(wave.position, {
    x: end.x, y: end.y, z: end.z,
    duration: 0.8,
    ease: "power1.in",
    onUpdate: function() {
      const p = this.progress();
      const s = Math.sin(p * Math.PI) * 5 + 0.5;
      wave.scale.set(s, s, s);
      waveMat.opacity = 0.8 * (1 - p);
    },
    onComplete: () => {
      scene.remove(wave);
      waveGeo.dispose();
      waveMat.dispose();
      
      // Node reaction on impact
      gsap.to(node.mesh.scale, { x: 3, y: 3, z: 3, duration: 0.1, yoyo: true, repeat: 1 });
    }
  });
}

function createDiscoveryWave(peerId: string) {
  const node = peerNodes.get(peerId);
  if (!node) return;

  const waveGeo = new THREE.SphereGeometry(1, 32, 32);
  const waveMat = new THREE.MeshBasicMaterial({
    color: 0x3fb950,
    transparent: true,
    opacity: 0.5,
    wireframe: true,
    blending: THREE.AdditiveBlending
  });
  const wave = new THREE.Mesh(waveGeo, waveMat);
  scene.add(wave);

  gsap.to(wave.scale, {
    x: 300, y: 300, z: 300,
    duration: 3,
    ease: "power2.out",
    onUpdate: function() {
      waveMat.opacity = 0.5 * (1 - this.progress());
    },
    onComplete: () => {
      scene.remove(wave);
      waveGeo.dispose();
      waveMat.dispose();
    }
  });
}

function createInterNodePulse(fromId: string, toId: string) {
  const from = peerNodes.get(fromId);
  const to = peerNodes.get(toId);
  if (!from || !to) return;

  const pulseGeo = new THREE.CylinderGeometry(0.05, 0.2, 4, 8);
  const pulseMat = new THREE.MeshBasicMaterial({ 
    color: 0x3fb950, 
    transparent: true, 
    opacity: 1.0,
    blending: THREE.AdditiveBlending 
  });
  const pulse = new THREE.Mesh(pulseGeo, pulseMat);
  scene.add(pulse);

  pulse.position.copy(from.targetPos);
  pulse.lookAt(to.targetPos);
  pulse.rotateX(Math.PI / 2);

  gsap.to(pulse.position, {
    x: to.targetPos.x,
    y: to.targetPos.y,
    z: to.targetPos.z,
    duration: 1.2,
    ease: "power1.inOut",
    onUpdate: () => {
      pulseMat.opacity = 0.8;
    },
    onComplete: () => {
      scene.remove(pulse);
      pulseGeo.dispose();
      pulseMat.dispose();
      pulseNode(toId);
      createShockwave(to.targetPos, new THREE.Color(0x3fb950), 10);
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

  controls.autoRotateSpeed = coreRotationSpeed;
  controls.update();

  // Core Pulse Animation
  if (coreMesh) {
    coreMesh.rotation.y += 0.01 * (coreRotationSpeed * 2);
    coreMesh.rotation.z += 0.005 * coreRotationSpeed;
  }
  if (coreAdditionalGlow) {
    coreAdditionalGlow.rotation.y -= 0.005;
  }
  
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

  // Follow selected node with UI
  if (selectedPeerId && ttEl.style.opacity !== '0') {
    const node = peerNodes.get(selectedPeerId);
    if (node) {
      const vector = node.mesh.position.clone();
      vector.project(camera);
      const x = (vector.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-(vector.y * 0.5 - 0.5)) * window.innerHeight;
      
      ttEl.style.left = x + 'px';
      ttEl.style.top = (y - 20) + 'px';
      if (reticle) {
        reticle.style.left = x + 'px';
        reticle.style.top = y + 'px';
      }
    }
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
    
    if (coreAura) {
      gsap.to((coreAura.material as THREE.MeshBasicMaterial).color, {
        duration: 1.5,
        r: userColor.r, g: userColor.g, b: userColor.b,
      });
      gsap.to(coreAura.material, { opacity: 0.3, duration: 1 });
      gsap.to(coreAura.scale, { x: 2.2, y: 2.2, z: 2.2, duration: 2, repeat: -1, yoyo: true });
      gsap.to(coreAura.rotation, { x: Math.PI * 2, y: Math.PI * 2, duration: 20, repeat: -1, ease: 'none' });
    }

    // Generate custom aura based on address
    if (coreAdditionalGlow) {
      const pointsCount = 300;
      const positions = new Float32Array(pointsCount * 3);
      for (let i = 0; i < pointsCount; i++) {
        const phi = Math.acos(-1 + (2 * i) / pointsCount);
        const theta = Math.sqrt(pointsCount * Math.PI) * phi;
        const r = 12 + Math.random() * 8;
        positions[i*3] = r * Math.cos(theta) * Math.sin(phi);
        positions[i*3+1] = r * Math.sin(theta) * Math.sin(phi);
        positions[i*3+2] = r * Math.cos(phi);
      }
      coreAdditionalGlow.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      gsap.to(coreAdditionalGlow.material, { opacity: 0.8, duration: 2 });
      (coreAdditionalGlow.material as THREE.PointsMaterial).color.copy(userColor);
    }

    // Dynamic Core Geometry Evolution
    const newGeo = new THREE.TorusKnotGeometry(6, 1.5, 100, 16);
    coreMesh.geometry.dispose();
    coreMesh.geometry = newGeo;
    gsap.from(coreMesh.scale, { x: 0, y: 0, z: 0, duration: 1.5, ease: "elastic.out(1, 0.3)" });

    // Shield effect (Multiple Rotating Rings)
    const shields: THREE.Mesh[] = [];
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
      shields.push(shield);
      
      gsap.to(shield.rotation, { 
        z: Math.PI * 2, 
        y: Math.PI * 2,
        duration: 6 + i * 3, 
        repeat: -1, 
        ease: 'none' 
      });

      // Synchronized shield pulsing
      gsap.to(shield.scale, {
        x: 1.05, y: 1.05, z: 1.05,
        duration: 1 + i * 0.5,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut"
      });
    }

    // Add Orbiting Satellites (Quantum Bits)
    for (let i = 0; i < 12; i++) {
      const satGeo = new THREE.IcosahedronGeometry(0.4, 0);
      const satMat = new THREE.MeshBasicMaterial({ color: userColor, transparent: true, opacity: 0.8 });
      const sat = new THREE.Mesh(satGeo, satMat);
      const orbitGroup = new THREE.Group();
      orbitGroup.add(sat);
      scene.add(orbitGroup);
      
      sat.position.x = 25 + Math.random() * 10;
      orbitGroup.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      
      gsap.to(orbitGroup.rotation, {
        y: Math.PI * 2,
        duration: 3 + Math.random() * 5,
        repeat: -1,
        ease: "none"
      });
      
      // Floating motion
      gsap.to(sat.position, {
        x: "+=5",
        duration: 1 + Math.random(),
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut"
      });
    }

    const statNode = document.getElementById('stat-nodeid');
    if (statNode) {
      statNode.textContent = accounts[0];
      statNode.style.color = '#' + userColor.getHexString();
      statNode.style.textShadow = `0 0 10px #${userColor.getHexString()}`;
    }
  } catch (e: any) {
    log(`WALLET_ERR: ${e.message}`, 'error');
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
  
  let url = `/api/notion?type=${type}`;
  if (type === 'search') url += `&query=${encodeURIComponent(input.value || 'IPFS')}`;
  if (type === 'create') url += `&title=${encodeURIComponent(input.value || 'New Project Update')}`;
  if (type === 'comment') url += `&content=${encodeURIComponent(input.value || 'Automated node status update.')}`;

  log(`NOTION_LOCAL_CMD: EXECUTING_${type.toUpperCase()}...`, 'info');
  status.textContent = 'STATUS: COMMUNICATING...';

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.success) {
      log(`NOTION_RES: ${type.toUpperCase()}_SUCCESS`, 'ok');
      status.textContent = `LAST_${type.toUpperCase()}: OK`;
    } else {
      log(`NOTION_ERR: ${data.error}`, 'error');
      status.textContent = 'STATUS: FAILED';
    }
  } catch (e: any) {
    log(`NOTION_BRIDGE_ERR: ${e.message}`, 'error');
    status.textContent = 'STATUS: ERROR';
  }
};


init();

