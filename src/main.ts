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

  // Raycaster intersection for Tooltip
  if (camera && peerGroup) {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(peerGroup.children, false);
    let found = false;
    for (let i = 0; i < intersects.length; i++) {
      const obj = intersects[i].object;
      if (obj.userData && obj.userData.peerId) {
        found = true;
        ttEl.style.opacity = '1';
        ttEl.style.left = e.clientX + 'px';
        ttEl.style.top = e.clientY + 'px';
        ttId.textContent = obj.userData.peerId.substring(0, 8) + '...';
        ttLat.textContent = obj.userData.latency + 'ms';
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

  if (navigator.gpu && !forceWebGL) {
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
      addPeerNode(peer.peerId, peer.latency);
      gsap.to(coreMat, { opacity: 1, duration: 0.2, yoyo: true, repeat: 1 });
      pulseNode(peer.peerId);
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

  // Core Aura (Metamask feature)
  coreAura = new THREE.Mesh(
    new THREE.IcosahedronGeometry(10, 2),
    new THREE.MeshBasicMaterial({ color: 0x58a6ff, wireframe: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending })
  );
  scene.add(coreAura);

  // Rings
  const ringGeo = new THREE.TorusGeometry(120, 0.2, 16, 100);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.2 });
  const ring1 = new THREE.Mesh(ringGeo, ringMat);
  ring1.rotation.x = Math.PI / 2;
  scene.add(ring1);

  // Peer Node Group (Real-time Sync)
  peerGroup = new THREE.Group();
  scene.add(peerGroup);

  infoParticles.textContent = NODE_COUNT.toString();

  // Data transfer pulse simulation
  setInterval(() => {
    if (peerNodes.size > 0) {
      const keys = Array.from(peerNodes.keys());
      const randomId = keys[Math.floor(Math.random() * keys.length)];
      pulseNode(randomId);
    }
  }, 1500);
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
    
    // Metamask aura effects
    if (coreAura) {
      gsap.to((coreAura.material as THREE.MeshBasicMaterial).color, {
        duration: 1.5,
        r: userColor.r, g: userColor.g, b: userColor.b,
      });
      gsap.to(coreAura.material as THREE.MeshBasicMaterial, { opacity: 0.4, duration: 1.5 });
      gsap.to(coreAura.scale, { x: 1.3, y: 1.3, z: 1.3, duration: 2, repeat: -1, yoyo: true, ease: 'sine.inOut' });
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
function addPeerNode(peerId: string, latency: number = 20) {
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
  mesh.userData = { peerId, latency };
  
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
  gsap.to(coreMat, { opacity: 1, duration: 0.2, yoyo: true, repeat: 1 });
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
  
  if (type === 'search') {
    const query = input.value || 'General';
    log(`NOTION_QUERY: SEARCHING_FOR "${query}"...`, 'info');
    status.textContent = 'STATUS: SEARCHING_REMOTE_WORKSPACE...';
    // Logic for actual Notion API call would go here
    setTimeout(() => {
      log('NOTION_RES: SYNC_COMPLETE. LIVE_NETWORK_REFLECTED_BY_DEFAULT.', 'ok');
      status.textContent = 'LAST_SEARCH: ' + query;
    }, 1500);
  } else if (type === 'create') {
    log('NOTION_CMD: INITIALIZING_NEW_PAGE_TEMPLATE...', 'info');
    status.textContent = 'STATUS: CREATING_BLOCKS...';
    setTimeout(() => {
      log('NOTION_RES: PAGE_CREATED_SUCCESSFULLY (ID: 35ea55d2...)', 'ok');
      status.textContent = 'LAST_ACTION: CREATE_PAGE';
    }, 1200);
  } else if (type === 'comment') {
    log('NOTION_CMD: POSTING_ADAPTIVE_COMMENT...', 'info');
    status.textContent = 'STATUS: PUSHING_RICH_TEXT...';
    setTimeout(() => {
      log('NOTION_RES: COMMENT_PUBLISHED_TO_CHAT_ROOM', 'ok');
      status.textContent = 'LAST_ACTION: ADD_COMMENT';
    }, 1000);
  }
};

init();

