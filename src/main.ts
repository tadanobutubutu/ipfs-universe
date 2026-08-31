/// <reference types="vite/client" />

import {
  clearPeerHistory,
  closePeerHistory,
  getPeerCount,
  savePeers,
} from './db/peer-history';
import type { HeliaObserver } from './network/helia-observer';
import { KuboProbeError, probeLocalKubo } from './network/kubo-observer';
import { KuboRefreshScheduler } from './network/kubo-refresh';
import {
  emptyPeerState,
  reducePeerEvent,
  toPersistedPeer,
} from './network/peer-reducer';
import type {
  PeerObservation,
  PeerRecord,
  PeerState,
} from './network/peer-types';
import type { UniverseScene } from './scene/universe';
import { AppShell } from './ui/app-shell';
import {
  type AnalyticsWasm,
  loadAnalyticsWasm,
  loadPhysicsWasm,
} from './wasm/load-wasm';

const UI_BATCH_INTERVAL_MS = 100;
const PERSIST_BATCH_INTERVAL_MS = 5_000;
// Keep the first paint and the interactive 3D shell free from Helia's large
// transport graph. The browser node starts shortly after the observatory is
// usable; mobile gets a little more breathing room for its slower CPU path.
// Keep the first interaction window free from Helia's large transport graph.
// The 12 s hand-off still makes the browser node live during a normal session,
// while preventing a 600 KiB module evaluation from competing with the first
// 3D frame on throttled mobile CPUs.
const NETWORK_BOOT_DELAY_MS = 12_000;
const MOBILE_NETWORK_BOOT_DELAY_MS = 12_000;

if (import.meta.env.DEV) {
  (
    window as Window & { __peerstellationSceneReady?: boolean }
  ).__peerstellationSceneReady = false;
}

const canvas = requiredCanvas('universe-canvas');
const shell = new AppShell();
let universe: UniverseScene | undefined;
let analytics: AnalyticsWasm | undefined;
let observer: HeliaObserver | undefined;
let unsubscribeObserver: (() => void) | undefined;
let peerState = emptyPeerState();
let updateTimer: number | undefined;
let persistTimer: number | undefined;
let networkGeneration = 0;
let appDisposed = false;
let lastPersisted = new Map<string, string>();
const pendingPersistence = new Map<
  string,
  ReturnType<typeof toPersistedPeer>
>();

shell.onMotionChange((paused) => universe?.setMotionPaused(paused));
shell.onRetry(() => {
  void startNetworkObserver();
});
shell.onClearHistory(() => {
  pendingPersistence.clear();
  if (persistTimer !== undefined) {
    window.clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  void clearPeerHistory()
    .then(() => shell.setStoredPeerCount(0))
    .catch(() => shell.setStoredPeerUnavailable());
});
const kuboRefresh = new KuboRefreshScheduler(readLocalKubo);
shell.onKuboProbe(() => {
  kuboRefresh.stop();
  void readLocalKubo().then((succeeded) => {
    if (succeeded && !appDisposed) kuboRefresh.start();
  });
});
shell.updatePeerState(peerState);

// A visitor who immediately explores the scene should not have to wait for
// the quiet-start timer. The first gesture/keyboard focus opts into Helia at
// once; passive visits retain the delayed, first-paint-friendly path below.
const wakeNetworkOnIntent = (): void => {
  if (networkGeneration === 0 && !appDisposed) {
    void startNetworkObserver();
  }
};
window.addEventListener('pointerdown', wakeNetworkOnIntent, {
  once: true,
  passive: true,
});
window.addEventListener('keydown', wakeNetworkOnIntent, { once: true });

requestAnimationFrame(() => {
  void startScene().then(() => {
    if (universe !== undefined) {
      shell.markSceneReady();
      if (import.meta.env.DEV) {
        (
          window as Window & { __peerstellationSceneReady?: boolean }
        ).__peerstellationSceneReady = true;
      }
    }
    void startDeferredSystems();
  });
});

window.addEventListener(
  'pagehide',
  () => {
    appDisposed = true;
    kuboRefresh.stop();
    networkGeneration += 1;
    unsubscribeObserver?.();
    unsubscribeObserver = undefined;
    void observer?.stop();
    observer = undefined;
    universe?.dispose();
    if (persistTimer !== undefined) {
      window.clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    void flushPersistedPeers().finally(closePeerHistory);
  },
  { once: true },
);

async function startScene(): Promise<void> {
  try {
    const { createUniverseScene } = await import('./scene/universe');
    universe = await createUniverseScene(canvas);
    universe.onNodeInteraction(({ peer, x, y, pinned }) => {
      shell.showNodeDetails(peer, x, y, pinned);
    });
    universe.setMotionPaused(shell.motionPaused);
    universe.start();
    // A development-only seam lets the browser E2E suite feed a deterministic
    // relay fixture into the real renderer. It is tree-shaken from production
    // and never exposes network state in the deployed app.
    if (import.meta.env.DEV) {
      const devWindow = window as Window & {
        __peerstellationFreezePeers?: boolean;
        __peerstellationSetPeers?: (peers: readonly PeerRecord[]) => void;
      };
      devWindow.__peerstellationFreezePeers = false;
      devWindow.__peerstellationSetPeers = (peers) => {
        // Feeding a fixture also freezes the app-level reducer updates. This
        // prevents the asynchronous analytics/observer startup from racing
        // the renderer and replacing the deterministic fixture with the
        // still-empty live state midway through a visual test.
        devWindow.__peerstellationFreezePeers = true;
        universe?.setPeers(peers);
      };
    }
  } catch {
    if (import.meta.env.DEV) {
      (
        window as Window & { __peerstellationSceneReady?: boolean }
      ).__peerstellationSceneReady = false;
    }
    shell.markSceneUnavailable();
  }
}

async function startDeferredSystems(): Promise<void> {
  void getPeerCount()
    .then((count) => shell.setStoredPeerCount(count))
    .catch(() => shell.setStoredPeerUnavailable());
  const physicsTask = loadPhysicsWasm('/physics.wasm')
    .then((physics) => {
      if (!appDisposed) universe?.attachPhysics(physics);
    })
    .catch(() => undefined);
  const analyticsTask = loadAnalyticsWasm('/analytics.wasm')
    .then((loaded) => {
      if (appDisposed) return;
      analytics = loaded;
      scheduleUiUpdate();
    })
    .catch(() => undefined);
  const networkTask = startNetworkObserverWhenIdle();

  await Promise.allSettled([physicsTask, analyticsTask, networkTask]);
}

async function readLocalKubo(): Promise<boolean> {
  shell.setKuboStatus(
    'Requesting /id and /swarm/peers from 127.0.0.1:5001…',
    true,
  );
  try {
    const result = await probeLocalKubo();
    for (const observation of result.observations)
      acceptObservation(observation);
    shell.setKuboStatus(
      `${result.peerCount} peers observed by local Kubo${result.truncated ? `; first ${result.observations.filter(({ type }) => type === 'connected').length.toLocaleString()} admitted to the view` : ''}. Browser Helia remains a separate node. Refreshing every 15s while enabled.`,
    );
    scheduleUiUpdate();
    return true;
  } catch (error) {
    const message =
      error instanceof KuboProbeError && error.code === 'cors'
        ? 'Local Kubo blocked this origin. Add only this local origin to API.HTTPHeaders, then restart IPFS Desktop.'
        : error instanceof Error
          ? error.message
          : 'Local Kubo could not be read.';
    shell.setKuboStatus(message);
    return false;
  }
}

async function startNetworkObserverWhenIdle(): Promise<void> {
  await new Promise<void>((resolve) => {
    const delay =
      window.innerWidth < 640
        ? MOBILE_NETWORK_BOOT_DELAY_MS
        : NETWORK_BOOT_DELAY_MS;
    globalThis.setTimeout(resolve, delay);
  });
  if (appDisposed || networkGeneration !== 0) return;
  // Rendering benchmarks use the development fixture switch to isolate the
  // scene from Helia's intentionally deferred node bootstrap. Without this
  // guard, the 12-second dynamic import would contaminate CPU frame metrics
  // with a one-time module-evaluation long task. Production builds never
  // expose this switch and always start the real browser node.
  if (
    import.meta.env.DEV &&
    (window as Window & { __peerstellationFreezePeers?: boolean })
      .__peerstellationFreezePeers === true
  ) {
    return;
  }
  await new Promise<void>((resolve) => {
    const start = (): void => {
      void startNetworkObserver().finally(resolve);
    };
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(start, { timeout: 1_200 });
      return;
    }
    globalThis.setTimeout(start, 250);
  });
}

async function startNetworkObserver(): Promise<void> {
  if (appDisposed) return;
  const generation = ++networkGeneration;
  unsubscribeObserver?.();
  unsubscribeObserver = undefined;
  if (observer !== undefined) {
    await observer.stop();
    observer = undefined;
  }

  shell.setNetworkState('loading', 'Opening a browser node…');

  try {
    let nextObserver: HeliaObserver;
    try {
      // Keep the large libp2p graph, key generation, and transport setup off
      // the compositor thread. A direct main-thread fallback preserves
      // compatibility with browsers that disable module workers.
      const { startHeliaWorkerObserver } = await import(
        './network/helia-worker-client'
      );
      nextObserver = await startHeliaWorkerObserver();
    } catch {
      const { startHeliaObserver } = await import('./network/helia-observer');
      nextObserver = await startHeliaObserver();
    }
    if (generation !== networkGeneration) {
      await nextObserver.stop();
      return;
    }

    observer = nextObserver;
    unsubscribeObserver = nextObserver.subscribe(acceptObservation);
    for (const observation of nextObserver.snapshot()) {
      acceptObservation(observation);
    }
    updateNetworkStatus(nextObserver.localPeerId);
    scheduleUiUpdate();
  } catch {
    if (generation === networkGeneration) {
      shell.setNetworkState('error', 'Browser node could not start');
    }
  }
}

function acceptObservation(observation: PeerObservation): void {
  let nextState: PeerState;
  try {
    nextState = reducePeerEvent(peerState, observation);
  } catch {
    return;
  }
  if (nextState === peerState) {
    return;
  }
  peerState = nextState;
  updateNetworkStatus(observer?.localPeerId);
  scheduleUiUpdate();
}

function updateNetworkStatus(localPeerId: string | undefined): void {
  const message =
    peerState.browserConnectedCount === 0
      ? 'Searching for browser-reachable peers'
      : `Observing ${peerState.browserConnectedCount} live ${peerState.browserConnectedCount === 1 ? 'connection' : 'connections'}`;
  shell.setNetworkState('online', message, localPeerId);
}

function scheduleUiUpdate(): void {
  if (updateTimer !== undefined) {
    return;
  }
  updateTimer = window.setTimeout(() => {
    updateTimer = undefined;
    const peers = [...peerState.peers.values()];
    const devWindow = window as Window & {
      __peerstellationFreezePeers?: boolean;
    };
    if (devWindow.__peerstellationFreezePeers !== true) {
      universe?.setPeers(peers);
    }
    // Kubo imports carry daemon latency, not browser ping samples. Keep them
    // in the scene and explorer while excluding them from Helia live metrics.
    const browserPeers = peers.filter((peer) => peer.source !== 'kubo');
    const metrics = analytics?.analyze(browserPeers);
    shell.updatePeerState(peerState, metrics);
    persistChangedPeers(peerState);
  }, UI_BATCH_INTERVAL_MS);
}

function persistChangedPeers(state: PeerState): void {
  const nextPersisted = new Map<string, string>();
  const changedPeers = [];
  for (const peer of state.peers.values()) {
    const fingerprint = `${peer.status}:${peer.lastSeenAt}:${peer.latencyMs ?? 'unmeasured'}`;
    nextPersisted.set(peer.peerId, fingerprint);
    if (lastPersisted.get(peer.peerId) === fingerprint) {
      continue;
    }
    changedPeers.push(toPersistedPeer(peer));
  }
  lastPersisted = nextPersisted;
  for (const peer of changedPeers) {
    pendingPersistence.set(peer.peerId, peer);
  }
  if (changedPeers.length > 0 && persistTimer === undefined) {
    persistTimer = window.setTimeout(() => {
      persistTimer = undefined;
      void flushPersistedPeers();
    }, PERSIST_BATCH_INTERVAL_MS);
  }
}

async function flushPersistedPeers(): Promise<void> {
  const peers = [...pendingPersistence.values()];
  pendingPersistence.clear();
  if (peers.length > 0) {
    await savePeers(peers);
  }
}

function requiredCanvas(id: string): HTMLCanvasElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error(`Required canvas #${id} is missing`);
  }
  return element;
}
