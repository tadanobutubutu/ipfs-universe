import * as THREE from 'three';

import type { PeerRecord } from '../network/peer-types';
import type { PhysicsWasm } from '../wasm/load-wasm';

const SCENE_NODE_LIMIT = 512;
const CONNECTED_COLOR = new THREE.Color(0xc9ff70);
const DISCOVERED_COLOR = new THREE.Color(0xa897ff);
const EDGE_COLOR = new THREE.Color(0x9fffe3);

export interface UniverseScene {
  readonly rendererName: string;
  attachPhysics(physics: PhysicsWasm): void;
  setPeers(peers: readonly PeerRecord[]): void;
  onNodeInteraction(listener: (interaction: NodeInteraction) => void): () => void;
  setMotionPaused(paused: boolean): void;
  start(): void;
  dispose(): void;
}

export interface NodeInteraction {
  readonly peer?: PeerRecord;
  readonly x?: number;
  readonly y?: number;
  readonly mode: 'hover' | 'select' | 'clear';
  readonly pinned: boolean;
}

export function createUniverseScene(canvas: HTMLCanvasElement): UniverseScene {
  return new ThreeUniverseScene(canvas);
}

class ThreeUniverseScene implements UniverseScene {
  readonly rendererName = 'WebGL 2';
  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(48, 1, 0.1, 420);
  readonly #lookTarget = new THREE.Vector3();
  readonly #core = new THREE.Group();
  readonly #dust: THREE.Points;
  readonly #pulseRing: THREE.Mesh<
    THREE.TorusGeometry,
    THREE.MeshBasicMaterial
  >;
  readonly #peerMesh: THREE.InstancedMesh;
  readonly #edgeGeometry: THREE.BufferGeometry;
  readonly #edgePositions = new Float32Array(SCENE_NODE_LIMIT * 6);
  readonly #edgeColors = new Float32Array(SCENE_NODE_LIMIT * 6);
  readonly #edgeColor = new THREE.Color();
  readonly #matrix = new THREE.Matrix4();
  readonly #resizeObserver: ResizeObserver;
  readonly #basePixelRatio: number;
  #physics?: PhysicsWasm;
  #physicsPositions?: Float32Array<ArrayBufferLike>;
  #fallbackPositions: Float32Array<ArrayBufferLike> = new Float32Array(0);
  #peers: readonly PeerRecord[] = [];
  #peerSignature = '';
  #frameRequest?: number;
  #disposed = false;
  #motionPaused = false;
  #pointerId?: number;
  #pointerX = 0;
  #pointerY = 0;
  #yaw = -0.12;
  #pitch = 0.08;
  #distance = window.innerWidth < 640 ? 84 : 54;
  #targetYaw = this.#yaw;
  #targetPitch = this.#pitch;
  #targetDistance = this.#distance;
  #pulseUntil = 0;
  #connectedPeerIds = new Set<string>();
  #lastPerformanceSample = performance.now();
  #lastFrameTime = performance.now();
  #sampledFrames = 0;
  #animatedFrames = 0;
  #renderedFrames = 0;
  #pixelRatio: number;
  readonly #pickWorld = new THREE.Vector3();
  readonly #pickScreen = new THREE.Vector3();
  readonly #interactionListeners = new Set<(interaction: NodeInteraction) => void>();
  #hoveredIndex?: number;
  #selectedIndex?: number;
  #keyboardIndex?: number;
  #pointerDownX = 0;
  #pointerDownY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#basePixelRatio = Math.min(
      window.devicePixelRatio || 1,
      window.innerWidth < 640 ? 1.25 : 1.5,
    );
    this.#pixelRatio = this.#basePixelRatio;
    const context = canvas.getContext('webgl2', {
      alpha: true,
      antialias: this.#basePixelRatio <= 1.25,
      depth: true,
      failIfMajorPerformanceCaveat: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    if (context === null) {
      throw new Error('WebGL 2 is unavailable in this browser context');
    }
    this.#renderer = new THREE.WebGLRenderer({
      canvas,
      context,
      alpha: true,
      antialias: this.#basePixelRatio <= 1.25,
      depth: true,
      failIfMajorPerformanceCaveat: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.#renderer.setClearColor(0x050508, 0);
    this.#renderer.setPixelRatio(this.#pixelRatio);
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 1.05;

    this.#scene.fog = new THREE.FogExp2(0x050508, 0.008);
    this.#dust = createDecorativeDust();
    this.#scene.add(this.#dust);
    createObserverCore(this.#core);
    this.#scene.add(this.#core);
    this.#pulseRing = createPulseRing();
    this.#scene.add(this.#pulseRing);

    this.#peerMesh = createPeerMesh();
    this.#scene.add(this.#peerMesh);
    this.#edgeGeometry = new THREE.BufferGeometry();
    this.#edgeGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.#edgePositions, 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    this.#edgeGeometry.setAttribute(
      'color',
      new THREE.BufferAttribute(this.#edgeColors, 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    this.#edgeGeometry.setDrawRange(0, 0);
    const edgeMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    edgeMaterial.toneMapped = false;
    edgeMaterial.fog = false;
    const edges = new THREE.LineSegments(
      this.#edgeGeometry,
      edgeMaterial,
    );
    this.#scene.add(edges);

    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas);
    this.#bindControls();
    this.#resize();
    this.#updateCamera(true);
    this.#renderScene();
  }

  attachPhysics(physics: PhysicsWasm): void {
    this.#physics = physics;
    this.#seedPhysics();
    if (this.#motionPaused) {
      this.#renderStaticFrame();
    }
  }

  setPeers(peers: readonly PeerRecord[]): void {
    const visible = peers
      .filter(({ status }) => status !== 'disconnected')
      .sort((left, right) => left.peerId.localeCompare(right.peerId))
      .slice(0, SCENE_NODE_LIMIT);
    const signature = visible
      .map(
        ({ peerId, status, latencyMs, transport }) =>
          `${peerId}:${status}:${transport ?? 'unknown'}:${latencyMs === undefined ? 'unmeasured' : Math.round(latencyMs / 25)}`,
      )
      .join('|');
    const identityChanged = signature !== this.#peerSignature;
    const connectedPeerIds = new Set(
      visible
        .filter(({ status }) => status === 'connected')
        .map(({ peerId }) => peerId),
    );
    const connectionChanged =
      connectedPeerIds.size !== this.#connectedPeerIds.size ||
      [...connectedPeerIds].some((peerId) => !this.#connectedPeerIds.has(peerId));
    if (connectionChanged) {
      this.#pulseUntil = performance.now() + 900;
    }
    this.#connectedPeerIds = connectedPeerIds;

    this.#peers = visible;
    if (this.#selectedIndex !== undefined && this.#selectedIndex >= visible.length) {
      this.#selectedIndex = undefined;
    }
    if (this.#hoveredIndex !== undefined && this.#hoveredIndex >= visible.length) {
      this.#hoveredIndex = undefined;
    }
    if (this.#keyboardIndex !== undefined && this.#keyboardIndex >= visible.length) {
      this.#keyboardIndex = undefined;
    }
    this.#peerSignature = signature;
    this.#peerMesh.count = visible.length;
    visible.forEach((peer, index) => {
      this.#peerMesh.setColorAt(
        index,
        peer.status === 'connected' ? CONNECTED_COLOR : DISCOVERED_COLOR,
      );
    });
    if (this.#peerMesh.instanceColor !== null) {
      this.#peerMesh.instanceColor.needsUpdate = true;
    }

    if (identityChanged) {
      this.#fallbackPositions = fallbackPositions(visible);
      this.#seedPhysics();
    }
    this.#updatePeerGeometry();
    this.#refreshInteractionPosition();
    if (this.#motionPaused) {
      this.#renderScene();
    }
  }

  onNodeInteraction(listener: (interaction: NodeInteraction) => void): () => void {
    this.#interactionListeners.add(listener);
    return () => this.#interactionListeners.delete(listener);
  }

  setMotionPaused(paused: boolean): void {
    this.#motionPaused = paused;
    if (paused) {
      if (this.#frameRequest !== undefined) {
        cancelAnimationFrame(this.#frameRequest);
        this.#frameRequest = undefined;
      }
      this.#renderStaticFrame();
    } else {
      this.start();
    }
  }

  start(): void {
    if (
      this.#frameRequest === undefined &&
      !this.#disposed &&
      !this.#motionPaused
    ) {
      this.#lastFrameTime = performance.now();
      this.#frameRequest = requestAnimationFrame(this.#renderFrame);
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#frameRequest !== undefined) {
      cancelAnimationFrame(this.#frameRequest);
      this.#frameRequest = undefined;
    }
    this.#resizeObserver.disconnect();
    this.#unbindControls();
    document.removeEventListener('visibilitychange', this.#onVisibilityChange);
    this.#scene.traverse((object) => {
      if (
        object instanceof THREE.Mesh ||
        object instanceof THREE.Points ||
        object instanceof THREE.Line
      ) {
        object.geometry.dispose();
        disposeMaterial(object.material);
      }
    });
    this.#edgeGeometry.dispose();
    this.#renderer.dispose();
  }

  #seedPhysics(): void {
    const physics = this.#physics;
    if (physics === undefined) {
      this.#physicsPositions = undefined;
      return;
    }

    const count = Math.min(this.#peers.length, physics.maxNodes);
    physics.initialize(count);
    this.#peers.slice(0, count).forEach((peer, index) => {
      physics.seedNode(
        index,
        hashPeerId(peer.peerId),
        radialDistance(peer),
        transportSector(peer.transport),
      );
    });
    this.#physicsPositions = physics.positions(count);
  }

  readonly #renderFrame = (frameTime: number): void => {
    this.#frameRequest = undefined;
    if (this.#disposed) {
      return;
    }

    const delta = Math.min(
      Math.max(0, frameTime - this.#lastFrameTime) / 1_000,
      0.05,
    );
    this.#lastFrameTime = frameTime;
    if (document.hidden) {
      return;
    }
    if (!this.#motionPaused) {
      const interactionActive = this.#hoveredIndex !== undefined || this.#selectedIndex !== undefined;
      if (!interactionActive) {
        this.#targetYaw += delta * 0.035;
        this.#physics?.step(delta, this.#peers.length, 1);
      }
      this.#core.rotation.y += delta * 0.09;
      this.#core.rotation.x += delta * 0.025;
      this.#dust.rotation.y -= delta * 0.004;
    }
    this.#updatePulse(frameTime);
    this.#updateCamera(this.#motionPaused);
    this.#updatePeerGeometry();
    this.#refreshInteractionPosition();
    this.#animatedFrames += 1;
    this.#renderScene();
    this.#samplePerformance();

    if (!this.#motionPaused) {
      this.#frameRequest = requestAnimationFrame(this.#renderFrame);
    }
  };

  #renderStaticFrame(): void {
    if (this.#disposed) {
      return;
    }
    this.#updateCamera(true);
    this.#updatePeerGeometry();
    this.#refreshInteractionPosition();
    this.#updatePulse(performance.now());
    this.#renderScene();
  }

  #updatePulse(now: number): void {
    const material = this.#pulseRing.material;
    const remaining = this.#pulseUntil - now;
    if (this.#motionPaused || remaining <= 0) {
      this.#pulseRing.visible = false;
      material.opacity = 0;
      return;
    }
    const progress = 1 - remaining / 900;
    this.#pulseRing.visible = true;
    this.#pulseRing.scale.setScalar(1 + progress * 2.8);
    material.opacity = (1 - progress) * 0.86;
  }

  #renderScene(): void {
    this.#renderer.render(this.#scene, this.#camera);
    this.#renderedFrames += 1;
    this.#canvas.dataset.animationFrames = String(this.#animatedFrames);
    this.#canvas.dataset.renderedFrames = String(this.#renderedFrames);
  }

  #updatePeerGeometry(): void {
    const positions = this.#physicsPositions ?? this.#fallbackPositions;
    let connectedEdgeCount = 0;

    this.#peers.forEach((peer, index) => {
      const offset = index * 3;
      const x = positions[offset] ?? 0;
      const y = positions[offset + 1] ?? 0;
      const z = positions[offset + 2] ?? 0;
      const scale =
        peer.status === 'connected'
          ? peer.latencyMs === undefined
            ? 1
            : 1.16
          : 0.76;
      const emphasis = index === this.#selectedIndex ? 1.42 : index === this.#hoveredIndex ? 1.22 : 1;
      this.#matrix.makeScale(scale * emphasis, scale * emphasis, scale * emphasis);
      this.#matrix.setPosition(x, y, z);
      this.#peerMesh.setMatrixAt(index, this.#matrix);

      if (peer.status === 'connected') {
        const edgeOffset = connectedEdgeCount * 6;
        this.#edgePositions[edgeOffset] = 0;
        this.#edgePositions[edgeOffset + 1] = 0;
        this.#edgePositions[edgeOffset + 2] = 0;
        this.#edgePositions[edgeOffset + 3] = x;
        this.#edgePositions[edgeOffset + 4] = y;
        this.#edgePositions[edgeOffset + 5] = z;
        this.#edgeColor
          .copy(EDGE_COLOR)
          .multiplyScalar(edgeBrightness(peer.latencyMs));
        for (let endpoint = 0; endpoint < 2; endpoint += 1) {
          const colorOffset = edgeOffset + endpoint * 3;
          this.#edgeColors[colorOffset] = this.#edgeColor.r;
          this.#edgeColors[colorOffset + 1] = this.#edgeColor.g;
          this.#edgeColors[colorOffset + 2] = this.#edgeColor.b;
        }
        connectedEdgeCount += 1;
      }
    });

    this.#peerMesh.instanceMatrix.needsUpdate = true;
    const edgeAttribute = this.#edgeGeometry.getAttribute('position');
    edgeAttribute.needsUpdate = true;
    const edgeColorAttribute = this.#edgeGeometry.getAttribute('color');
    edgeColorAttribute.needsUpdate = true;
    this.#edgeGeometry.setDrawRange(0, connectedEdgeCount * 2);
  }

  #peerAt(clientX: number, clientY: number): number | undefined {
    const rect = this.#canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const targetX = clientX - rect.left;
    const targetY = clientY - rect.top;
    const positions = this.#physicsPositions ?? this.#fallbackPositions;
    let nearest: number | undefined;
    let nearestDistance = 24;
    for (let index = 0; index < this.#peers.length; index += 1) {
      const offset = index * 3;
      this.#pickWorld.set(positions[offset] ?? 0, positions[offset + 1] ?? 0, positions[offset + 2] ?? 0);
      this.#pickScreen.copy(this.#pickWorld).project(this.#camera);
      if (this.#pickScreen.z < -1 || this.#pickScreen.z > 1) continue;
      const x = (this.#pickScreen.x + 1) * rect.width * 0.5;
      const y = (1 - this.#pickScreen.y) * rect.height * 0.5;
      const distance = Math.hypot(targetX - x, targetY - y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = index;
      }
    }
    return nearest;
  }

  #emitInteraction(mode: NodeInteraction['mode'], index: number | undefined, pinned: boolean): void {
    const peer = index === undefined ? undefined : this.#peers[index];
    if (peer === undefined) {
      delete this.#canvas.dataset.selectedPeer;
      this.#canvas.setAttribute('aria-label', 'Live 3D IPFS peer universe');
      for (const listener of this.#interactionListeners) listener({ mode: 'clear', pinned: false });
      if (this.#motionPaused) this.#updatePeerGeometry();
      return;
    }
    if (index === undefined) return;
    const position = this.#peerPosition(index);
    if (position === undefined) return;
    const projected = position.project(this.#camera);
    const rect = this.#canvas.getBoundingClientRect();
    const x = rect.left + (projected.x + 1) * rect.width * 0.5;
    const y = rect.top + (1 - projected.y) * rect.height * 0.5;
    this.#canvas.dataset.selectedPeer = peer.peerId;
    this.#canvas.setAttribute('aria-label', `${peer.peerId}, ${peer.status} peer. Press Escape to dismiss details.`);
    for (const listener of this.#interactionListeners) listener({ peer, x, y, mode, pinned });
    if (this.#motionPaused) this.#updatePeerGeometry();
    if (this.#motionPaused) this.#renderScene();
  }

  #peerPosition(index: number): THREE.Vector3 | undefined {
    const positions = this.#physicsPositions ?? this.#fallbackPositions;
    const offset = index * 3;
    if (offset + 2 >= positions.length) return undefined;
    return new THREE.Vector3(positions[offset] ?? 0, positions[offset + 1] ?? 0, positions[offset + 2] ?? 0);
  }

  #refreshInteractionPosition(): void {
    const index = this.#selectedIndex ?? this.#hoveredIndex;
    if (index !== undefined) this.#emitInteraction(this.#selectedIndex === undefined ? 'hover' : 'select', index, this.#selectedIndex !== undefined);
  }

  #resize(): void {
    const width = Math.max(1, this.#canvas.clientWidth);
    const height = Math.max(1, this.#canvas.clientHeight);
    this.#renderer.setPixelRatio(this.#pixelRatio);
    this.#renderer.setSize(width, height, false);
    this.#camera.aspect = width / height;
    this.#lookTarget.x = width >= 900 ? -6 : 0;
    this.#camera.updateProjectionMatrix();
    if (this.#motionPaused) {
      this.#renderStaticFrame();
    }
  }

  #updateCamera(immediate: boolean): void {
    const blend = immediate ? 1 : 0.075;
    this.#yaw = THREE.MathUtils.lerp(this.#yaw, this.#targetYaw, blend);
    this.#pitch = THREE.MathUtils.lerp(this.#pitch, this.#targetPitch, blend);
    this.#distance = THREE.MathUtils.lerp(
      this.#distance,
      this.#targetDistance,
      blend,
    );
    const horizontalDistance = Math.cos(this.#pitch) * this.#distance;
    this.#camera.position.set(
      Math.sin(this.#yaw) * horizontalDistance,
      Math.sin(this.#pitch) * this.#distance,
      Math.cos(this.#yaw) * horizontalDistance,
    );
    this.#camera.lookAt(this.#lookTarget);
    this.#canvas.dataset.cameraDistance = this.#distance.toFixed(2);
  }

  #samplePerformance(): void {
    this.#sampledFrames += 1;
    const now = performance.now();
    const elapsed = now - this.#lastPerformanceSample;
    if (elapsed < 2_000) {
      return;
    }

    const framesPerSecond = (this.#sampledFrames * 1_000) / elapsed;
    this.#canvas.dataset.framesPerSecond = framesPerSecond.toFixed(1);
    this.#canvas.dataset.drawCalls = String(this.#renderer.info.render.calls);
    this.#canvas.dataset.sceneObjects = String(this.#scene.children.length);
    this.#canvas.dataset.pixelRatio = this.#pixelRatio.toFixed(2);
    if (framesPerSecond < 44 && this.#pixelRatio > 1) {
      this.#pixelRatio = Math.max(1, this.#pixelRatio - 0.25);
      this.#resize();
    }
    this.#lastPerformanceSample = now;
    this.#sampledFrames = 0;
  }

  #bindControls(): void {
    this.#canvas.addEventListener('pointerdown', this.#onPointerDown);
    this.#canvas.addEventListener('pointermove', this.#onPointerMove);
    this.#canvas.addEventListener('pointerup', this.#onPointerUp);
    this.#canvas.addEventListener('pointercancel', this.#onPointerUp);
    this.#canvas.addEventListener('wheel', this.#onWheel, { passive: false });
    this.#canvas.addEventListener('keydown', this.#onKeyDown);
    document.addEventListener('visibilitychange', this.#onVisibilityChange);
  }

  #unbindControls(): void {
    this.#canvas.removeEventListener('pointerdown', this.#onPointerDown);
    this.#canvas.removeEventListener('pointermove', this.#onPointerMove);
    this.#canvas.removeEventListener('pointerup', this.#onPointerUp);
    this.#canvas.removeEventListener('pointercancel', this.#onPointerUp);
    this.#canvas.removeEventListener('wheel', this.#onWheel);
    this.#canvas.removeEventListener('keydown', this.#onKeyDown);
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    this.#pointerId = event.pointerId;
    this.#pointerX = event.clientX;
    this.#pointerY = event.clientY;
    this.#pointerDownX = event.clientX;
    this.#pointerDownY = event.clientY;
    this.#canvas.setPointerCapture(event.pointerId);
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    if (this.#pointerId === undefined || event.pointerId !== this.#pointerId) {
      const hit = this.#peerAt(event.clientX, event.clientY);
      if (hit !== this.#hoveredIndex) {
        this.#hoveredIndex = hit;
        this.#keyboardIndex = hit;
        if (this.#selectedIndex === undefined) this.#emitInteraction('hover', hit, false);
      } else if (hit !== undefined && this.#selectedIndex === undefined) {
        this.#emitInteraction('hover', hit, false);
      }
      return;
    }
    const deltaX = event.clientX - this.#pointerX;
    const deltaY = event.clientY - this.#pointerY;
    this.#pointerX = event.clientX;
    this.#pointerY = event.clientY;
    this.#targetYaw -= deltaX * 0.006;
    this.#targetPitch = THREE.MathUtils.clamp(
      this.#targetPitch + deltaY * 0.004,
      -0.75,
      0.75,
    );
    if (this.#motionPaused) {
      this.#renderStaticFrame();
    }
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId === this.#pointerId) {
      this.#pointerId = undefined;
      if (this.#canvas.hasPointerCapture(event.pointerId)) {
        this.#canvas.releasePointerCapture(event.pointerId);
      }
      const moved = Math.hypot(event.clientX - this.#pointerDownX, event.clientY - this.#pointerDownY);
      if (event.type !== 'pointercancel' && moved < 10) {
        const hit = this.#peerAt(event.clientX, event.clientY);
        if (hit === undefined) {
          this.#selectedIndex = undefined;
          this.#keyboardIndex = undefined;
          this.#hoveredIndex = undefined;
          this.#emitInteraction('clear', undefined, false);
        } else {
          this.#selectedIndex = hit;
          this.#keyboardIndex = hit;
          this.#hoveredIndex = hit;
          this.#emitInteraction('select', hit, true);
        }
      }
    }
  };

  readonly #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.#targetDistance = THREE.MathUtils.clamp(
      this.#targetDistance + event.deltaY * 0.015,
      28,
      88,
    );
    if (this.#motionPaused) {
      this.#renderStaticFrame();
    }
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    const rotationStep = event.shiftKey ? 0.22 : 0.1;
    switch (event.key) {
      case 'ArrowLeft':
        this.#targetYaw += rotationStep;
        break;
      case 'ArrowRight':
        this.#targetYaw -= rotationStep;
        break;
      case 'ArrowUp':
        this.#targetPitch = Math.max(-0.75, this.#targetPitch - rotationStep);
        break;
      case 'ArrowDown':
        this.#targetPitch = Math.min(0.75, this.#targetPitch + rotationStep);
        break;
      case '+':
      case '=':
      case 'PageUp':
        this.#targetDistance = Math.max(28, this.#targetDistance - 4);
        break;
      case '-':
      case '_':
      case 'PageDown':
        this.#targetDistance = Math.min(88, this.#targetDistance + 4);
        break;
      case '0':
      case 'Home':
        this.#targetYaw = -0.12;
        this.#targetPitch = 0.08;
        this.#targetDistance = 54;
        break;
      case '[':
        this.#selectRelative(-1);
        event.preventDefault();
        return;
      case ']':
        this.#selectRelative(1);
        event.preventDefault();
        return;
      case 'Enter':
      case ' ':
        this.#toggleKeyboardSelection();
        event.preventDefault();
        return;
      case 'Escape':
        this.#selectedIndex = undefined;
        this.#keyboardIndex = undefined;
        this.#hoveredIndex = undefined;
        this.#emitInteraction('clear', undefined, false);
        return;
      default:
        return;
    }
    event.preventDefault();
    if (this.#motionPaused) {
      this.#renderStaticFrame();
    }
  };

  #selectRelative(delta: -1 | 1): void {
    if (this.#peers.length === 0) return;
    const current = this.#selectedIndex ?? this.#keyboardIndex ?? this.#hoveredIndex;
    const start = current ?? (delta > 0 ? -1 : 0);
    const next = (start + delta + this.#peers.length) % this.#peers.length;
    this.#keyboardIndex = next;
    this.#hoveredIndex = next;
    if (this.#selectedIndex === undefined) {
      this.#emitInteraction('hover', next, false);
    } else {
      this.#selectedIndex = next;
      this.#emitInteraction('select', next, true);
    }
  }

  #toggleKeyboardSelection(): void {
    const index = this.#selectedIndex ?? this.#keyboardIndex ?? this.#hoveredIndex;
    if (index === undefined) return;
    if (this.#selectedIndex === index) {
      this.#selectedIndex = undefined;
      this.#emitInteraction('hover', index, false);
      return;
    }
    this.#selectedIndex = index;
    this.#hoveredIndex = index;
    this.#emitInteraction('select', index, true);
  }

  readonly #onVisibilityChange = (): void => {
    if (document.hidden) {
      if (this.#frameRequest !== undefined) {
        cancelAnimationFrame(this.#frameRequest);
        this.#frameRequest = undefined;
      }
      return;
    }
    this.start();
  };
}

function createDecorativeDust(): THREE.Points {
  const count = 2_400;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const neutral = new THREE.Color(0xd9e7df);
  const aurora = new THREE.Color(0x73fbd3);
  const violet = new THREE.Color(0xa897ff);
  let state = 0x51f15e;

  for (let index = 0; index < count; index += 1) {
    state = xorshift(state);
    const radius = 30 + unitFromInteger(state) * 160;
    state = xorshift(state);
    const theta = unitFromInteger(state) * Math.PI * 2;
    state = xorshift(state);
    const cosinePhi = unitFromInteger(state) * 2 - 1;
    const sinePhi = Math.sqrt(Math.max(0, 1 - cosinePhi * cosinePhi));
    const offset = index * 3;
    positions[offset] = radius * sinePhi * Math.cos(theta);
    positions[offset + 1] = radius * cosinePhi;
    positions[offset + 2] = radius * sinePhi * Math.sin(theta);
    const colorSample = unitFromInteger(xorshift(state ^ 0x7f4a7c15));
    const color =
      colorSample > 0.94
        ? aurora
        : colorSample > 0.89
          ? violet
          : neutral;
    const luminance = 0.46 + unitFromInteger(xorshift(state ^ 0x9e3779b9)) * 0.54;
    colors[offset] = color.r * luminance;
    colors[offset + 1] = color.g * luminance;
    colors[offset + 2] = color.b * luminance;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    vertexColors: true,
    size: 0.48,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.7,
    alphaTest: 0.02,
    map: createDustSprite(),
    depthWrite: false,
  });
  material.toneMapped = false;
  material.fog = false;
  return new THREE.Points(
    geometry,
    material,
  );
}

function createDustSprite(): THREE.CanvasTexture | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext('2d');
  if (context === null) {
    return undefined;
  }
  const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.3, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 32, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createPulseRing(): THREE.Mesh<
  THREE.TorusGeometry,
  THREE.MeshBasicMaterial
> {
  const material = new THREE.MeshBasicMaterial({
    blending: THREE.AdditiveBlending,
    color: 0xc9ff70,
    depthWrite: false,
    opacity: 0,
    transparent: true,
  });
  material.toneMapped = false;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(3.9, 0.035, 4, 96),
    material,
  );
  ring.rotation.x = Math.PI * 0.5;
  ring.visible = false;
  return ring;
}

function createObserverCore(group: THREE.Group): void {
  const shellGeometry = new THREE.IcosahedronGeometry(3, 2);
  const shell = new THREE.Mesh(
    shellGeometry,
    new THREE.MeshBasicMaterial({
      color: 0x73fbd3,
      wireframe: true,
      transparent: true,
      opacity: 0.88,
      blending: THREE.AdditiveBlending,
    }),
  );
  shell.material.toneMapped = false;
  const heart = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.45, 3),
    new THREE.MeshBasicMaterial({
      color: 0xf4f2ea,
      transparent: true,
      opacity: 0.86,
    }),
  );
  heart.material.toneMapped = false;
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(4.35, 24, 16),
    new THREE.MeshBasicMaterial({
      color: 0x73fbd3,
      transparent: true,
      opacity: 0.09,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  atmosphere.material.toneMapped = false;
  const ringGeometry = new THREE.TorusGeometry(7.4, 0.045, 4, 112);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xa897ff,
    transparent: true,
    opacity: 0.48,
    blending: THREE.AdditiveBlending,
  });
  ringMaterial.toneMapped = false;
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.rotation.set(Math.PI * 0.52, 0.28, 0.16);
  const polarRing = new THREE.Mesh(ringGeometry, ringMaterial.clone());
  polarRing.rotation.set(0.18, Math.PI * 0.48, -0.32);
  group.add(atmosphere, heart, shell, ring, polarRing);
}

function createPeerMesh(): THREE.InstancedMesh {
  const geometry = new THREE.IcosahedronGeometry(0.42, 1);
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  material.toneMapped = false;
  const mesh = new THREE.InstancedMesh(geometry, material, SCENE_NODE_LIMIT);
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}

function fallbackPositions(peers: readonly PeerRecord[]): Float32Array {
  const positions = new Float32Array(peers.length * 3);
  peers.forEach((peer, index) => {
    const seed = hashPeerId(peer.peerId) >>> 0;
    const radius = radialDistance(peer);
    // Isotropic sphere: transport is shown in the node details, not used to
    // bunch every peer into a single sector. The peer id keeps positions stable
    // between renders while still giving the scene a full 3D spread.
    const theta = unitFromInteger(xorshift(seed ^ 0x68bc21eb)) * Math.PI * 2;
    const cosinePhi = unitFromInteger(xorshift(seed ^ 0x02e5be93)) * 2 - 1;
    const sinePhi = Math.sqrt(Math.max(0, 1 - cosinePhi * cosinePhi));
    const offset = index * 3;
    positions[offset] = radius * sinePhi * Math.cos(theta);
    positions[offset + 1] = radius * cosinePhi;
    positions[offset + 2] = radius * sinePhi * Math.sin(theta);
  });
  return positions;
}

function radialDistance(peer: PeerRecord): number {
  const seed = unitFromInteger(hashPeerId(peer.peerId) ^ 0xa53c9e17);
  if (peer.status === 'discovered') {
    return 22 + seed * 12;
  }
  if (peer.latencyMs === undefined) {
    return 18 + seed * 14;
  }
  const latency = THREE.MathUtils.clamp(peer.latencyMs, 10, 1_000);
  const normalized = (Math.log(latency) - Math.log(10)) / (Math.log(1_000) - Math.log(10));
  const base = 10 + THREE.MathUtils.clamp(normalized, 0, 1) * 34;
  return base * (0.8 + seed * 0.4);
}

function edgeBrightness(latencyMs: number | undefined): number {
  if (latencyMs === undefined) {
    return 0.42;
  }
  const normalized = THREE.MathUtils.clamp(latencyMs, 0, 800) / 800;
  return THREE.MathUtils.lerp(1.15, 0.58, normalized);
}

function transportSector(transport: string | undefined): number {
  switch (transport) {
    case 'websocket':
      return 0;
    case 'webrtc':
    case 'webrtc-direct':
      return 1;
    case 'webtransport':
      return 2;
    case 'circuit-relay':
      return 3;
    default:
      return 4;
  }
}

function hashPeerId(peerId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < peerId.length; index += 1) {
    hash ^= peerId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

function xorshift(input: number): number {
  let value = input | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function unitFromInteger(value: number): number {
  return (value >>> 0) / 0xffffffff;
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach((entry) => {
    const textured = entry as THREE.Material & {
      map?: THREE.Texture | null;
    };
    textured.map?.dispose();
    entry.dispose();
  });
}
