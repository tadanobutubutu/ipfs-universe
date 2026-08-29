import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  FogExp2,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineSegments,
  type Material,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';

import type { PeerRecord } from '../network/peer-types';
import type { PhysicsWasm } from '../wasm/load-wasm';

const SCENE_NODE_LIMIT = 512;
const CONNECTED_COLOR = new Color(0xc9ff70);
const DISCOVERED_COLOR = new Color(0xa897ff);
const EDGE_COLOR = new Color(0x9fffe3);

export interface UniverseScene {
  readonly rendererName: string;
  attachPhysics(physics: PhysicsWasm): void;
  setPeers(peers: readonly PeerRecord[]): void;
  onNodeInteraction(
    listener: (interaction: NodeInteraction) => void,
  ): () => void;
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
  readonly #renderer: WebGLRenderer;
  readonly #scene = new Scene();
  readonly #camera = new PerspectiveCamera(48, 1, 0.1, 420);
  readonly #lookTarget = new Vector3();
  readonly #core = new Group();
  readonly #dust: Points;
  readonly #pulseRing: Mesh<TorusGeometry, MeshBasicMaterial>;
  readonly #peerMesh: InstancedMesh;
  readonly #edgeGeometry: BufferGeometry;
  // Reserve one center edge and one evidence-backed relay edge per visible
  // peer. Unknown remote topology is intentionally never inferred.
  #edgePositions: Float32Array<ArrayBufferLike> = new Float32Array(
    SCENE_NODE_LIMIT * 12,
  );
  #edgeColors: Float32Array<ArrayBufferLike> = new Float32Array(
    SCENE_NODE_LIMIT * 12,
  );
  readonly #edgeColor = new Color();
  readonly #matrix = new Matrix4();
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
  #shaderWarmupStarted = false;
  #shaderWarmupDone = false;
  readonly #pickWorld = new Vector3();
  readonly #pickScreen = new Vector3();
  readonly #interactionListeners = new Set<
    (interaction: NodeInteraction) => void
  >();
  #hoveredIndex?: number;
  #selectedIndex?: number;
  #keyboardIndex?: number;
  #pointerDownX = 0;
  #pointerDownY = 0;
  #pointerDownIndex?: number;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#basePixelRatio = Math.min(
      window.devicePixelRatio || 1,
      window.innerWidth < 640 ? 1.25 : 1.5,
    );
    this.#pixelRatio = this.#basePixelRatio;
    const mobileQuality = window.innerWidth < 640;
    const antialias = !mobileQuality && this.#basePixelRatio <= 1.25;
    const context = canvas.getContext('webgl2', {
      alpha: true,
      antialias,
      depth: true,
      failIfMajorPerformanceCaveat: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    if (context === null) {
      throw new Error('WebGL 2 is unavailable in this browser context');
    }
    this.#renderer = new WebGLRenderer({
      canvas,
      context,
      alpha: true,
      antialias,
      depth: true,
      failIfMajorPerformanceCaveat: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.#renderer.setClearColor(0x050508, 0);
    this.#renderer.setPixelRatio(this.#pixelRatio);
    this.#renderer.outputColorSpace = SRGBColorSpace;
    this.#renderer.toneMapping = ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 1.05;

    this.#scene.fog = new FogExp2(0x050508, 0.008);
    this.#dust = createDecorativeDust(mobileQuality ? 480 : 2_400);
    // Mobile keeps the CSS sky and low-poly core as the first composition;
    // revealing the 2,400-point dust field later would spend the first input
    // window on a texture-heavy shader that contributes little at phone size.
    this.#dust.visible = !mobileQuality;
    this.#scene.add(this.#dust);
    createObserverCore(this.#core, mobileQuality);
    this.#scene.add(this.#core);
    this.#pulseRing = createPulseRing(mobileQuality);
    this.#scene.add(this.#pulseRing);

    this.#peerMesh = createPeerMesh(mobileQuality);
    this.#scene.add(this.#peerMesh);
    this.#edgeGeometry = new BufferGeometry();
    this.#edgeGeometry.setAttribute(
      'position',
      new BufferAttribute(this.#edgePositions, 3).setUsage(DynamicDrawUsage),
    );
    this.#edgeGeometry.setAttribute(
      'color',
      new BufferAttribute(this.#edgeColors, 3).setUsage(DynamicDrawUsage),
    );
    this.#edgeGeometry.setDrawRange(0, 0);
    const edgeMaterial = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.78,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    edgeMaterial.toneMapped = false;
    edgeMaterial.fog = false;
    const edges = new LineSegments(this.#edgeGeometry, edgeMaterial);
    this.#scene.add(edges);

    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas);
    this.#bindControls();
    this.#resize();
    this.#updateCamera(true);
    // Leave the first draw to the scheduled animation frame. Keeping WebGL
    // shader compilation out of the module-construction task prevents one
    // monolithic long task on throttled mobile CPUs while the CSS sky remains
    // visible underneath the transparent canvas.
    this.#canvas.dataset.drawCalls = '0';
    this.#canvas.dataset.sceneObjects = String(this.#scene.children.length);
    this.#canvas.dataset.pixelRatio = this.#pixelRatio.toFixed(2);
    this.#canvas.dataset.edgeSegments = '0';
  }

  attachPhysics(physics: PhysicsWasm): void {
    this.#physics = physics;
    // Bind Three.js attributes directly to the Zig WASM linear memory. The
    // renderer still owns WebGL resources, while all per-frame line geometry
    // is produced by the numeric kernel without a JS-side copy.
    this.#edgePositions = physics.edgePositions(physics.maxEdges);
    this.#edgeColors = physics.edgeColors(physics.maxEdges);
    this.#edgeGeometry.setAttribute(
      'position',
      new BufferAttribute(this.#edgePositions, 3).setUsage(DynamicDrawUsage),
    );
    this.#edgeGeometry.setAttribute(
      'color',
      new BufferAttribute(this.#edgeColors, 3).setUsage(DynamicDrawUsage),
    );
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
        ({ peerId, status, latencyMs, transport, relayPeerId }) =>
          `${peerId}:${status}:${transport ?? 'unknown'}:${latencyMs === undefined ? 'unmeasured' : Math.round(latencyMs / 25)}:${relayPeerId ?? ''}`,
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
      [...connectedPeerIds].some(
        (peerId) => !this.#connectedPeerIds.has(peerId),
      );
    if (connectionChanged) {
      this.#pulseUntil = performance.now() + 900;
    }
    this.#connectedPeerIds = connectedPeerIds;

    this.#peers = visible;
    if (
      this.#selectedIndex !== undefined &&
      this.#selectedIndex >= visible.length
    ) {
      this.#selectedIndex = undefined;
    }
    if (
      this.#hoveredIndex !== undefined &&
      this.#hoveredIndex >= visible.length
    ) {
      this.#hoveredIndex = undefined;
    }
    if (
      this.#keyboardIndex !== undefined &&
      this.#keyboardIndex >= visible.length
    ) {
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
    } else {
      this.#syncPhysicsMetadata();
    }
    this.#updatePeerGeometry();
    this.#refreshInteractionPosition();
    if (this.#motionPaused) {
      this.#renderScene();
    }
  }

  onNodeInteraction(
    listener: (interaction: NodeInteraction) => void,
  ): () => void {
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
        object instanceof Mesh ||
        object instanceof Points ||
        object instanceof Line
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
    this.#syncPhysicsMetadata();
    this.#physicsPositions = physics.positions(count);
  }

  #syncPhysicsMetadata(): void {
    const physics = this.#physics;
    if (physics === undefined) return;
    const peerIndices = new Map(
      this.#peers.map((peer, index) => [peer.peerId, index] as const),
    );
    this.#peers.slice(0, physics.maxNodes).forEach((peer, index) => {
      physics.setPeerMetadata(
        index,
        peer.status,
        peer.latencyMs,
        peer.relayPeerId === undefined
          ? -1
          : (peerIndices.get(peer.relayPeerId) ?? -1),
      );
    });
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
    // Ask browsers that expose KHR_parallel_shader_compile to warm the
    // material programs asynchronously. A synchronous first render otherwise
    // turns shader compilation into a single >200 ms long task on mobile
    // emulation. The transparent canvas still shows the CSS sky while the
    // GPU compiles, then the first real frame is drawn when the promise settles.
    if (!this.#shaderWarmupDone) {
      if (!this.#shaderWarmupStarted) {
        this.#shaderWarmupStarted = true;
        void this.#renderer
          .compileAsync(this.#scene, this.#camera)
          .catch(() => undefined)
          .finally(() => {
            if (this.#disposed) return;
            this.#shaderWarmupDone = true;
            // Yield once more after the asynchronous compiler settles. This
            // keeps GPU completion and the first visible draw in separate
            // tasks, preserving input responsiveness on mobile.
            this.start();
          });
      }
      return;
    }
    if (!this.#motionPaused) {
      const interactionActive =
        this.#hoveredIndex !== undefined || this.#selectedIndex !== undefined;
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
    if (this.#motionPaused) {
      // Reduced-motion users still get a non-animated discovery affordance.
      // Keep the ring static and quiet rather than removing the only visual
      // indication that the browser is searching for peers.
      this.#canvas.dataset.pulse = 'static';
      this.#pulseRing.visible = true;
      this.#pulseRing.scale.setScalar(1.35);
      material.opacity = this.#connectedPeerIds.size < 8 ? 0.28 : 0.12;
      return;
    }
    // A quiet search state still needs a visual heartbeat. This ring is
    // explicitly decorative (it is never added to peer data or hit testing),
    // so it communicates discovery without inventing a node.
    if (this.#connectedPeerIds.size < 8) {
      this.#canvas.dataset.pulse = 'search';
      const cycle = (now % 3_600) / 3_600;
      this.#pulseRing.visible = true;
      this.#pulseRing.scale.setScalar(1 + cycle * 4.8);
      material.opacity = (1 - cycle) * 0.68;
      return;
    }
    if (remaining <= 0) {
      this.#canvas.dataset.pulse = 'hidden';
      this.#pulseRing.visible = false;
      material.opacity = 0;
      return;
    }
    const progress = 1 - remaining / 900;
    this.#canvas.dataset.pulse = 'event';
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
    let edgeCount = 0;

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
      const emphasis =
        index === this.#selectedIndex
          ? 1.42
          : index === this.#hoveredIndex
            ? 1.22
            : 1;
      this.#matrix.makeScale(
        scale * emphasis,
        scale * emphasis,
        scale * emphasis,
      );
      this.#matrix.setPosition(x, y, z);
      this.#peerMesh.setMatrixAt(index, this.#matrix);

      if (this.#physics === undefined && peer.status === 'connected') {
        const edgeOffset = edgeCount * 6;
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
        edgeCount += 1;
      }
    });

    if (this.#physics !== undefined && this.#physicsPositions === positions) {
      // Zig owns center/relay edge construction and writes directly into the
      // attributes bound to its linear memory.
      edgeCount = this.#physics.layoutEdges(this.#peers.length);
    } else {
      // A circuit-relay multiaddr carries the relay peer ID. If that relay is
      // also present in the observed peer set, draw a second segment between
      // the two real nodes. This is the compatibility path for browsers that
      // cannot load WebAssembly.
      for (const [relayIndex, index] of relayEdgePairs(this.#peers)) {
        const peer = this.#peers[index];
        if (peer === undefined) continue;

        const targetOffset = index * 3;
        const relayOffset = relayIndex * 3;
        const edgeOffset = edgeCount * 6;
        this.#edgePositions[edgeOffset] = positions[relayOffset] ?? 0;
        this.#edgePositions[edgeOffset + 1] = positions[relayOffset + 1] ?? 0;
        this.#edgePositions[edgeOffset + 2] = positions[relayOffset + 2] ?? 0;
        this.#edgePositions[edgeOffset + 3] = positions[targetOffset] ?? 0;
        this.#edgePositions[edgeOffset + 4] = positions[targetOffset + 1] ?? 0;
        this.#edgePositions[edgeOffset + 5] = positions[targetOffset + 2] ?? 0;
        this.#edgeColor
          .copy(EDGE_COLOR)
          .multiplyScalar(Math.min(0.72, edgeBrightness(peer.latencyMs)));
        for (let endpoint = 0; endpoint < 2; endpoint += 1) {
          const colorOffset = edgeOffset + endpoint * 3;
          this.#edgeColors[colorOffset] = this.#edgeColor.r;
          this.#edgeColors[colorOffset + 1] = this.#edgeColor.g;
          this.#edgeColors[colorOffset + 2] = this.#edgeColor.b;
        }
        edgeCount += 1;
      }
    }

    this.#peerMesh.instanceMatrix.needsUpdate = true;
    const edgeAttribute = this.#edgeGeometry.getAttribute('position');
    edgeAttribute.needsUpdate = true;
    const edgeColorAttribute = this.#edgeGeometry.getAttribute('color');
    edgeColorAttribute.needsUpdate = true;
    this.#edgeGeometry.setDrawRange(0, edgeCount * 2);
    this.#canvas.dataset.edgeSegments = String(edgeCount);
    // Keep the measured radial signal inspectable for browser QA without
    // putting diagnostics into the visible HUD. This is also useful when a
    // live network happens to report a narrow latency band.
    this.#canvas.dataset.peerRadii = this.#peers
      .map((_, index) =>
        Math.hypot(
          positions[index * 3] ?? 0,
          positions[index * 3 + 1] ?? 0,
          positions[index * 3 + 2] ?? 0,
        ).toFixed(2),
      )
      .join(',');
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
      this.#pickWorld.set(
        positions[offset] ?? 0,
        positions[offset + 1] ?? 0,
        positions[offset + 2] ?? 0,
      );
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

  #emitInteraction(
    mode: NodeInteraction['mode'],
    index: number | undefined,
    pinned: boolean,
  ): void {
    const peer = index === undefined ? undefined : this.#peers[index];
    if (peer === undefined) {
      delete this.#canvas.dataset.selectedPeer;
      this.#canvas.setAttribute('aria-label', 'Live 3D IPFS peer universe');
      for (const listener of this.#interactionListeners)
        listener({ mode: 'clear', pinned: false });
      if (this.#motionPaused) this.#updatePeerGeometry();
      return;
    }
    if (index === undefined) return;
    const position = this.#peerPosition(index);
    if (position === undefined) return;
    const projected = position.project(this.#camera);
    const rect = this.#canvas.getBoundingClientRect();
    const rawX = rect.left + (projected.x + 1) * rect.width * 0.5;
    const rawY = rect.top + (1 - projected.y) * rect.height * 0.5;
    // Keep keyboard-selected nodes usable when perspective places their
    // projected point just beyond a narrow viewport. The card remains attached
    // to the nearest visible edge instead of rendering off-screen.
    const x = Math.min(Math.max(8, rawX), Math.max(8, window.innerWidth - 8));
    const y = Math.min(Math.max(8, rawY), Math.max(8, window.innerHeight - 8));
    this.#canvas.dataset.selectedPeer = peer.peerId;
    this.#canvas.setAttribute(
      'aria-label',
      `${peer.peerId}, ${peer.status} peer. Press Escape to dismiss details.`,
    );
    for (const listener of this.#interactionListeners)
      listener({ peer, x, y, mode, pinned });
    if (this.#motionPaused) this.#updatePeerGeometry();
    if (this.#motionPaused) this.#renderScene();
  }

  #peerPosition(index: number): Vector3 | undefined {
    const positions = this.#physicsPositions ?? this.#fallbackPositions;
    const offset = index * 3;
    if (offset + 2 >= positions.length) return undefined;
    return new Vector3(
      positions[offset] ?? 0,
      positions[offset + 1] ?? 0,
      positions[offset + 2] ?? 0,
    );
  }

  #refreshInteractionPosition(): void {
    const index = this.#selectedIndex ?? this.#hoveredIndex;
    if (index !== undefined)
      this.#emitInteraction(
        this.#selectedIndex === undefined ? 'hover' : 'select',
        index,
        this.#selectedIndex !== undefined,
      );
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
    this.#yaw = MathUtils.lerp(this.#yaw, this.#targetYaw, blend);
    this.#pitch = MathUtils.lerp(this.#pitch, this.#targetPitch, blend);
    this.#distance = MathUtils.lerp(
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
    document.addEventListener('keydown', this.#onDocumentKeyDown);
    document.addEventListener('visibilitychange', this.#onVisibilityChange);
  }

  #unbindControls(): void {
    this.#canvas.removeEventListener('pointerdown', this.#onPointerDown);
    this.#canvas.removeEventListener('pointermove', this.#onPointerMove);
    this.#canvas.removeEventListener('pointerup', this.#onPointerUp);
    this.#canvas.removeEventListener('pointercancel', this.#onPointerUp);
    this.#canvas.removeEventListener('wheel', this.#onWheel);
    this.#canvas.removeEventListener('keydown', this.#onKeyDown);
    document.removeEventListener('keydown', this.#onDocumentKeyDown);
    document.removeEventListener('visibilitychange', this.#onVisibilityChange);
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    this.#pointerId = event.pointerId;
    this.#pointerX = event.clientX;
    this.#pointerY = event.clientY;
    this.#pointerDownX = event.clientX;
    this.#pointerDownY = event.clientY;
    this.#pointerDownIndex = this.#peerAt(event.clientX, event.clientY);
    this.#canvas.setPointerCapture(event.pointerId);
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    if (this.#pointerId === undefined || event.pointerId !== this.#pointerId) {
      const hit = this.#peerAt(event.clientX, event.clientY);
      if (hit !== this.#hoveredIndex) {
        this.#hoveredIndex = hit;
        this.#keyboardIndex = hit;
        if (this.#selectedIndex === undefined)
          this.#emitInteraction('hover', hit, false);
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
    this.#targetPitch = MathUtils.clamp(
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
      const moved = Math.hypot(
        event.clientX - this.#pointerDownX,
        event.clientY - this.#pointerDownY,
      );
      if (event.type !== 'pointercancel' && moved < 10) {
        // Prefer the up position, but retain the down hit for a click that
        // lands a few pixels away after a high-DPI pointer event. The camera
        // is frozen while a node is hovered/selected, so this never invents a
        // peer; it only makes the click target tolerant of device jitter.
        const hit =
          this.#peerAt(event.clientX, event.clientY) ?? this.#pointerDownIndex;
        if (hit === undefined) {
          this.#clearInteraction();
        } else {
          this.#selectedIndex = hit;
          this.#keyboardIndex = hit;
          this.#hoveredIndex = hit;
          this.#emitInteraction('select', hit, true);
        }
      }
      this.#pointerDownIndex = undefined;
    }
  };

  readonly #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.#targetDistance = MathUtils.clamp(
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
        this.#clearInteraction();
        event.preventDefault();
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
    const current =
      this.#selectedIndex ?? this.#keyboardIndex ?? this.#hoveredIndex;
    const start = current ?? (delta > 0 ? -1 : 0);
    const next = (start + delta + this.#peers.length) % this.#peers.length;
    this.#keyboardIndex = next;
    this.#hoveredIndex = next;
    // Keyboard focus is an explicit selection, not a transient hover. Keep
    // the card copyable and announced even when the pointer is elsewhere.
    this.#selectedIndex = next;
    this.#focusCameraOn(next);
    this.#emitInteraction('select', next, true);
  }

  #focusCameraOn(index: number): void {
    const position = this.#peerPosition(index);
    if (position === undefined) return;
    const radius = Math.max(0.001, position.length());
    // The camera looks back toward the origin. Point its forward vector at
    // the selected node so keyboard selection never leaves the card pointing
    // at an off-screen particle on a narrow viewport.
    this.#targetYaw = Math.atan2(-position.x, -position.z);
    this.#targetPitch = MathUtils.clamp(
      Math.asin(-position.y / radius),
      -0.75,
      0.75,
    );
  }

  readonly #onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      this.#clearInteraction();
    }
  };

  #clearInteraction(): void {
    this.#selectedIndex = undefined;
    this.#keyboardIndex = undefined;
    this.#hoveredIndex = undefined;
    this.#emitInteraction('clear', undefined, false);
  }

  #toggleKeyboardSelection(): void {
    const index =
      this.#selectedIndex ?? this.#keyboardIndex ?? this.#hoveredIndex;
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

function createDecorativeDust(count: number): Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const neutral = new Color(0xd9e7df);
  const aurora = new Color(0x73fbd3);
  const violet = new Color(0xa897ff);
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
      colorSample > 0.94 ? aurora : colorSample > 0.89 ? violet : neutral;
    const luminance =
      0.46 + unitFromInteger(xorshift(state ^ 0x9e3779b9)) * 0.54;
    colors[offset] = color.r * luminance;
    colors[offset + 1] = color.g * luminance;
    colors[offset + 2] = color.b * luminance;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const material = new PointsMaterial({
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
  return new Points(geometry, material);
}

function createDustSprite(): CanvasTexture | undefined {
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
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function createPulseRing(
  mobileQuality = false,
): Mesh<TorusGeometry, MeshBasicMaterial> {
  const material = new MeshBasicMaterial({
    blending: AdditiveBlending,
    color: 0xc9ff70,
    depthWrite: false,
    opacity: 0,
    transparent: true,
  });
  material.toneMapped = false;
  const ring = new Mesh(
    new TorusGeometry(3.9, 0.035, 4, mobileQuality ? 56 : 96),
    material,
  );
  ring.rotation.x = Math.PI * 0.5;
  ring.visible = false;
  return ring;
}

function createObserverCore(group: Group, mobileQuality = false): void {
  const shellGeometry = new IcosahedronGeometry(3, mobileQuality ? 1 : 2);
  const shell = new Mesh(
    shellGeometry,
    new MeshBasicMaterial({
      color: 0x73fbd3,
      wireframe: true,
      transparent: true,
      opacity: 0.88,
      blending: AdditiveBlending,
    }),
  );
  shell.material.toneMapped = false;
  const heart = new Mesh(
    new IcosahedronGeometry(1.45, mobileQuality ? 1 : 3),
    new MeshBasicMaterial({
      color: 0xf4f2ea,
      transparent: true,
      opacity: 0.86,
    }),
  );
  heart.material.toneMapped = false;
  if (mobileQuality) {
    const ringGeometry = new TorusGeometry(7.4, 0.045, 4, 64);
    const ringMaterial = new MeshBasicMaterial({
      color: 0xa897ff,
      transparent: true,
      opacity: 0.48,
      blending: AdditiveBlending,
    });
    ringMaterial.toneMapped = false;
    const ring = new Mesh(ringGeometry, ringMaterial);
    ring.rotation.set(Math.PI * 0.52, 0.28, 0.16);
    group.add(heart, shell, ring);
    return;
  }
  const atmosphere = new Mesh(
    new SphereGeometry(4.35, mobileQuality ? 12 : 24, mobileQuality ? 8 : 16),
    new MeshBasicMaterial({
      color: 0x73fbd3,
      transparent: true,
      opacity: 0.09,
      side: BackSide,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  atmosphere.material.toneMapped = false;
  const ringGeometry = new TorusGeometry(
    7.4,
    0.045,
    4,
    mobileQuality ? 64 : 112,
  );
  const ringMaterial = new MeshBasicMaterial({
    color: 0xa897ff,
    transparent: true,
    opacity: 0.48,
    blending: AdditiveBlending,
  });
  ringMaterial.toneMapped = false;
  const ring = new Mesh(ringGeometry, ringMaterial);
  ring.rotation.set(Math.PI * 0.52, 0.28, 0.16);
  const polarRing = new Mesh(ringGeometry, ringMaterial.clone());
  polarRing.rotation.set(0.18, Math.PI * 0.48, -0.32);
  group.add(atmosphere, heart, shell, ring, polarRing);
}

function createPeerMesh(mobileQuality = false): InstancedMesh {
  const geometry = new IcosahedronGeometry(0.42, mobileQuality ? 0 : 1);
  const material = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  material.toneMapped = false;
  const mesh = new InstancedMesh(geometry, material, SCENE_NODE_LIMIT);
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
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

export function radialDistance(peer: PeerRecord): number {
  const seed = unitFromInteger(hashPeerId(peer.peerId) ^ 0xa53c9e17);
  if (peer.status === 'discovered') {
    return 22 + seed * 12;
  }
  if (peer.latencyMs === undefined) {
    return 18 + seed * 14;
  }
  const latency = MathUtils.clamp(peer.latencyMs, 10, 1_000);
  const normalized =
    (Math.log(latency) - Math.log(10)) / (Math.log(1_000) - Math.log(10));
  // Keep the measured signal dominant over the stable per-peer jitter. The
  // wider 8–50 world-unit span makes a 10ms peer visibly closer than an 800ms
  // peer while preserving a small, deterministic spread at each latency.
  const base = 8 + MathUtils.clamp(normalized, 0, 1) * 42;
  return base * (0.9 + seed * 0.2);
}

/**
 * Return only relay edges backed by both endpoint records. A relay ID in a
 * target's multiaddr is not enough to invent a missing relay node.
 */
export function relayEdgePairs(
  peers: readonly PeerRecord[],
): readonly (readonly [relayIndex: number, peerIndex: number])[] {
  const peerIndices = new Map(
    peers.map((peer, index) => [peer.peerId, index] as const),
  );
  const pairs: Array<readonly [number, number]> = [];
  const seenEdges = new Set<string>();
  peers.forEach((peer, index) => {
    if (peer.status !== 'connected' || peer.relayPeerId === undefined) return;
    const relayIndex = peerIndices.get(peer.relayPeerId);
    if (relayIndex === undefined || relayIndex === index) return;
    const edgeKey =
      relayIndex < index ? `${relayIndex}:${index}` : `${index}:${relayIndex}`;
    if (seenEdges.has(edgeKey)) return;
    seenEdges.add(edgeKey);
    pairs.push([relayIndex, index]);
  });
  return pairs;
}

function edgeBrightness(latencyMs: number | undefined): number {
  if (latencyMs === undefined) {
    return 0.42;
  }
  const normalized = MathUtils.clamp(latencyMs, 0, 800) / 800;
  return MathUtils.lerp(1.15, 0.58, normalized);
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

function disposeMaterial(material: Material | Material[]): void {
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach((entry) => {
    const textured = entry as Material & {
      map?: Texture | null;
    };
    textured.map?.dispose();
    entry.dispose();
  });
}
