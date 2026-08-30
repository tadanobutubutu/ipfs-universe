import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { withLibp2pLight } from '@helia/libp2p';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { identify, identifyPush } from '@libp2p/identify';
import type {
  Connection,
  IdentifyResult,
  Libp2p,
  PeerId,
  PeerInfo,
  ServiceMap,
} from '@libp2p/interface';
import { kadDHT } from '@libp2p/kad-dht';
import { mplex } from '@libp2p/mplex';
import { ping } from '@libp2p/ping';
import { webRTC, webRTCDirect } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { webTransport } from '@libp2p/webtransport';
import { createHeliaLight } from 'helia';

import type { PeerConnectionDirection, PeerObservation } from './peer-types';

const DEFAULT_PING_CONCURRENCY = 2;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PING_TIMEOUT_MS = 5_000;
const DHT_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_DHT_DISCOVERIES = 128;
const MAX_OBSERVATIONS = 2_048;

type AdapterEvent = 'connected' | 'disconnected' | 'discovered';
type ObservationListener = (observation: PeerObservation) => void;

export interface ObservablePeer {
  toString(): string;
}

export interface ObservableConnection {
  readonly remotePeer: ObservablePeer;
  readonly remoteAddr: { toString(): string };
  readonly direction: PeerConnectionDirection;
  readonly status: string;
  readonly openedAt: number;
}

export interface HeliaNetworkAdapter {
  readonly localPeerId: string;
  getConnections(remotePeer?: ObservablePeer): readonly ObservableConnection[];
  on(
    event: AdapterEvent,
    listener: (remotePeer: ObservablePeer) => void,
  ): () => void;
  onIdentify?(
    listener: (remotePeer: ObservablePeer, details: PeerDetails) => void,
  ): () => void;
  ping(remotePeer: ObservablePeer, signal: AbortSignal): Promise<number>;
  getPeerDetails?(remotePeer: ObservablePeer): Promise<PeerDetails | undefined>;
  discover?(
    listener: (remotePeer: ObservablePeer) => void,
    signal: AbortSignal,
  ): Promise<void>;
  stop(): Promise<void>;
}

export interface PeerDetails {
  readonly protocols?: readonly string[];
  readonly agentVersion?: string;
  readonly protocolVersion?: string;
  readonly addressCount?: number;
}

export interface HeliaObserver {
  readonly localPeerId: string;
  snapshot(): readonly PeerObservation[];
  subscribe(listener: ObservationListener): () => void;
  retry(): Promise<void>;
  stop(): Promise<void>;
}

export interface HeliaObserverOptions {
  readonly createAdapter?: () => Promise<HeliaNetworkAdapter>;
  readonly now?: () => number;
  readonly pingConcurrency?: number;
  readonly pingIntervalMs?: number;
  readonly pingTimeoutMs?: number;
}

export function normalizeConnections(
  connections: readonly ObservableConnection[],
  observedAt: number,
): readonly PeerObservation[] {
  const newestByPeer = new Map<string, ObservableConnection>();

  for (const connection of connections) {
    if (connection.status !== 'open') {
      continue;
    }

    const peerId = connection.remotePeer.toString();
    if (peerId.trim() === '') {
      continue;
    }

    const existing = newestByPeer.get(peerId);
    if (existing === undefined || connection.openedAt > existing.openedAt) {
      newestByPeer.set(peerId, connection);
    }
  }

  return [...newestByPeer.entries()].map(([peerId, connection]) => {
    const remoteAddr = connection.remoteAddr.toString();
    const relayPeerId = relayPeerIdFromMultiaddr(remoteAddr);
    return {
      type: 'connected' as const,
      peerId,
      observedAt,
      direction: connection.direction,
      transport: transportFromMultiaddr(remoteAddr),
      ...(relayPeerId === undefined ? {} : { relayPeerId }),
    };
  });
}

export async function startHeliaObserver(
  options: HeliaObserverOptions = {},
): Promise<HeliaObserver> {
  const observer = new BrowserHeliaObserver(options);
  await observer.start();
  return observer;
}

class BrowserHeliaObserver implements HeliaObserver {
  readonly #createAdapter: () => Promise<HeliaNetworkAdapter>;
  readonly #now: () => number;
  readonly #pingConcurrency: number;
  readonly #pingIntervalMs: number;
  readonly #pingTimeoutMs: number;
  readonly #listeners = new Set<ObservationListener>();
  readonly #lastPingAt = new Map<string, number>();
  readonly #queuedPeerIds = new Set<string>();
  readonly #activePings = new Map<string, AbortController>();
  #adapter?: HeliaNetworkAdapter;
  #localPeerId = '';
  #observations: PeerObservation[] = [];
  #queuedPeers: ObservablePeer[] = [];
  #unsubscribers: Array<() => void> = [];
  #discoveryController?: AbortController;
  #stopped = false;

  constructor(options: HeliaObserverOptions) {
    this.#createAdapter = options.createAdapter ?? createDefaultHeliaAdapter;
    this.#now = options.now ?? Date.now;
    this.#pingConcurrency = clampInteger(
      options.pingConcurrency ?? DEFAULT_PING_CONCURRENCY,
      1,
      8,
    );
    this.#pingIntervalMs = positiveDuration(
      options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
      'pingIntervalMs',
    );
    this.#pingTimeoutMs = positiveDuration(
      options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS,
      'pingTimeoutMs',
    );
  }

  get localPeerId(): string {
    return this.#localPeerId;
  }

  async start(): Promise<void> {
    const adapter = await this.#createAdapter();
    if (adapter.localPeerId.trim() === '') {
      await adapter.stop();
      throw new Error('Helia returned an empty local peer ID');
    }

    this.#stopped = false;
    this.#adapter = adapter;
    this.#localPeerId = adapter.localPeerId;
    this.#unsubscribers = [
      adapter.on('discovered', (remotePeer) => {
        this.#emit({
          type: 'discovered',
          peerId: remotePeer.toString(),
          observedAt: this.#now(),
        });
      }),
      adapter.on('connected', (remotePeer) => {
        this.#observeConnections(adapter.getConnections(remotePeer));
        void this.#observePeerDetails(adapter, remotePeer);
      }),
      adapter.on('disconnected', (remotePeer) => {
        const remaining = adapter
          .getConnections(remotePeer)
          .filter(({ status }) => status === 'open');

        if (remaining.length > 0) {
          this.#observeConnections(remaining);
          return;
        }

        this.#cancelPing(remotePeer.toString());
        this.#emit({
          type: 'disconnected',
          peerId: remotePeer.toString(),
          observedAt: this.#now(),
        });
      }),
    ];
    if (adapter.onIdentify !== undefined) {
      this.#unsubscribers.push(
        adapter.onIdentify((remotePeer, details) => {
          this.#emit({
            type: 'identified',
            peerId: remotePeer.toString(),
            observedAt: this.#now(),
            ...details,
          });
        }),
      );
    }

    this.#observeConnections(adapter.getConnections());
    if (adapter.discover !== undefined) {
      const controller = new AbortController();
      this.#discoveryController = controller;
      const timeout = globalThis.setTimeout(
        () => controller.abort(),
        DHT_DISCOVERY_TIMEOUT_MS,
      );
      void adapter
        .discover((remotePeer) => {
          const peerId = remotePeer.toString();
          if (peerId.trim() === '' || peerId === this.#localPeerId) return;
          this.#emit({
            type: 'discovered',
            peerId,
            observedAt: this.#now(),
          });
        }, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          globalThis.clearTimeout(timeout);
          if (this.#discoveryController === controller) {
            this.#discoveryController = undefined;
          }
        });
    }
  }

  snapshot(): readonly PeerObservation[] {
    return [...this.#observations];
  }

  subscribe(listener: ObservationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async retry(): Promise<void> {
    await this.#teardown();
    this.#lastPingAt.clear();
    await this.start();
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }

    this.#stopped = true;
    await this.#teardown();
    this.#listeners.clear();
  }

  #observeConnections(connections: readonly ObservableConnection[]): void {
    const observedAt = this.#now();
    for (const observation of normalizeConnections(connections, observedAt)) {
      this.#emit(observation);
    }

    const newestPeers = newestOpenConnections(connections);
    for (const connection of newestPeers) {
      this.#enqueuePing(connection.remotePeer);
      void this.#observePeerDetails(this.#adapter, connection.remotePeer);
    }
  }

  async #observePeerDetails(
    adapter: HeliaNetworkAdapter | undefined,
    remotePeer: ObservablePeer,
  ): Promise<void> {
    if (adapter?.getPeerDetails === undefined || this.#stopped) return;
    try {
      const details = await adapter.getPeerDetails(remotePeer);
      if (details === undefined || this.#stopped) return;
      this.#emit({
        type: 'identified',
        peerId: remotePeer.toString(),
        observedAt: this.#now(),
        ...details,
      });
    } catch {
      // Identify is best-effort; the connection remains useful without metadata.
    }
  }

  #emit(observation: PeerObservation): void {
    if (this.#stopped) {
      return;
    }

    this.#observations.push(observation);
    if (this.#observations.length > MAX_OBSERVATIONS) {
      this.#observations = this.#observations.slice(-MAX_OBSERVATIONS);
    }

    for (const listener of this.#listeners) {
      listener(observation);
    }
  }

  #enqueuePing(remotePeer: ObservablePeer): void {
    const peerId = remotePeer.toString();
    const lastPingAt = this.#lastPingAt.get(peerId);
    if (
      this.#stopped ||
      this.#queuedPeerIds.has(peerId) ||
      this.#activePings.has(peerId) ||
      (lastPingAt !== undefined &&
        this.#now() - lastPingAt < this.#pingIntervalMs)
    ) {
      return;
    }

    this.#queuedPeerIds.add(peerId);
    this.#queuedPeers.push(remotePeer);
    this.#drainPingQueue();
  }

  #drainPingQueue(): void {
    const adapter = this.#adapter;
    if (adapter === undefined || this.#stopped) {
      return;
    }

    while (
      this.#activePings.size < this.#pingConcurrency &&
      this.#queuedPeers.length > 0
    ) {
      const remotePeer = this.#queuedPeers.shift();
      if (remotePeer === undefined) {
        return;
      }

      const peerId = remotePeer.toString();
      this.#queuedPeerIds.delete(peerId);
      const controller = new AbortController();
      this.#activePings.set(peerId, controller);
      this.#lastPingAt.set(peerId, this.#now());

      void this.#measureLatency(adapter, remotePeer, controller).finally(() => {
        this.#activePings.delete(peerId);
        this.#drainPingQueue();
      });
    }
  }

  async #measureLatency(
    adapter: HeliaNetworkAdapter,
    remotePeer: ObservablePeer,
    controller: AbortController,
  ): Promise<void> {
    const peerId = remotePeer.toString();

    try {
      const latencyMs = await promiseWithTimeout(
        adapter.ping(remotePeer, controller.signal),
        this.#pingTimeoutMs,
        controller,
      );

      if (
        !this.#stopped &&
        !controller.signal.aborted &&
        Number.isFinite(latencyMs) &&
        latencyMs >= 0
      ) {
        this.#emit({
          type: 'latency',
          peerId,
          observedAt: this.#now(),
          latencyMs,
        });
      }
    } catch {
      // A failed or timed-out measurement remains explicitly unmeasured.
    }
  }

  #cancelPing(peerId: string): void {
    this.#queuedPeerIds.delete(peerId);
    this.#queuedPeers = this.#queuedPeers.filter(
      (peer) => peer.toString() !== peerId,
    );
    this.#activePings.get(peerId)?.abort();
  }

  async #teardown(): Promise<void> {
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      unsubscribe();
    }
    for (const controller of this.#activePings.values()) {
      controller.abort();
    }
    this.#activePings.clear();
    this.#queuedPeerIds.clear();
    this.#queuedPeers = [];
    this.#discoveryController?.abort();
    this.#discoveryController = undefined;

    const adapter = this.#adapter;
    this.#adapter = undefined;
    if (adapter !== undefined) {
      await adapter.stop();
    }
  }
}

async function createDefaultHeliaAdapter(): Promise<HeliaNetworkAdapter> {
  const node = withLibp2pLight(createHeliaLight(), {
    addresses: {
      listen: ['/p2p-circuit', '/webrtc'],
    },
    transports: [
      circuitRelayTransport(),
      webRTC(),
      webRTCDirect(),
      webSockets(),
      webTransport(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux(), mplex()],
    peerDiscovery: [
      bootstrap({
        list: [
          // Kept in sync with @helia/libp2p's browser defaults for 2.1.3.
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
          '/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8',
          '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
        ],
      }),
    ],
    services: {
      dht: kadDHT({ clientMode: true }),
      identify: identify(),
      identifyPush: identifyPush(),
      ping: ping(),
    },
  });
  await node.start();
  const libp2p = node.libp2p;

  return {
    localPeerId: libp2p.peerId.toString(),
    getConnections: (remotePeer) =>
      libp2p
        .getConnections(remotePeer as PeerId | undefined)
        .map(mapConnection),
    on: (event, listener) => subscribeToLibp2p(libp2p, event, listener),
    onIdentify: (listener) => subscribeToIdentify(libp2p, listener),
    ping: (remotePeer, signal) =>
      libp2p.services.ping.ping(remotePeer as PeerId, { signal }),
    getPeerDetails: async (remotePeer) => {
      const peer = await libp2p.peerStore.get(remotePeer as PeerId);
      const readMetadata = (key: string): string | undefined => {
        const value = peer.metadata.get(key);
        if (
          value === undefined ||
          value.byteLength === 0 ||
          value.byteLength > 256
        )
          return undefined;
        return new TextDecoder().decode(value).slice(0, 256);
      };
      return {
        protocols: peer.protocols
          .slice(0, 32)
          .map((value) => value.slice(0, 128)),
        agentVersion: readMetadata('AgentVersion'),
        protocolVersion: readMetadata('ProtocolVersion'),
        addressCount: Math.min(peer.addresses.length, 128),
      };
    },
    discover: async (listener, signal) => {
      let count = 0;
      try {
        for await (const peer of libp2p.peerRouting.getClosestPeers(
          libp2p.peerId.toMultihash().bytes,
          { signal },
        )) {
          if (peer.id.toString() === libp2p.peerId.toString()) continue;
          listener(peer.id);
          count += 1;
          if (count >= MAX_DHT_DISCOVERIES) break;
        }
      } catch {
        // Browser routing is best-effort. Bootstrap/relay connections remain
        // useful when the current network cannot answer a DHT query.
      }
    },
    stop: async () => {
      await node.stop();
    },
  };
}

function subscribeToLibp2p<M extends ServiceMap>(
  libp2p: Libp2p<M>,
  event: AdapterEvent,
  listener: (remotePeer: ObservablePeer) => void,
): () => void {
  if (event === 'discovered') {
    const handler = ({ detail }: CustomEvent<PeerInfo>): void =>
      listener(detail.id);
    libp2p.addEventListener('peer:discovery', handler);
    return () => libp2p.removeEventListener('peer:discovery', handler);
  }

  if (event === 'connected') {
    const handler = ({ detail }: CustomEvent<PeerId>): void => listener(detail);
    libp2p.addEventListener('peer:connect', handler);
    return () => libp2p.removeEventListener('peer:connect', handler);
  }

  const handler = ({ detail }: CustomEvent<PeerId>): void => listener(detail);
  libp2p.addEventListener('peer:disconnect', handler);
  return () => libp2p.removeEventListener('peer:disconnect', handler);
}

function subscribeToIdentify(
  libp2p: Libp2p<ServiceMap>,
  listener: (remotePeer: ObservablePeer, details: PeerDetails) => void,
): () => void {
  const handler = (event: CustomEvent<IdentifyResult>): void => {
    const result = event.detail;
    listener(result.peerId, {
      protocols: result.protocols
        .filter((value): value is string => typeof value === 'string')
        .slice(0, 32)
        .map((value) => value.slice(0, 128)),
      agentVersion: boundedIdentifyString(result.agentVersion),
      protocolVersion: boundedIdentifyString(result.protocolVersion),
      addressCount: Math.min(result.listenAddrs.length, 128),
    });
  };
  libp2p.addEventListener('peer:identify', handler);
  return () => libp2p.removeEventListener('peer:identify', handler);
}

function boundedIdentifyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.slice(0, 256)
    : undefined;
}

function mapConnection(connection: Connection): ObservableConnection {
  return {
    remotePeer: connection.remotePeer,
    remoteAddr: connection.remoteAddr,
    direction: connection.direction,
    status: connection.status,
    openedAt: connection.timeline.open ?? 0,
  };
}

function newestOpenConnections(
  connections: readonly ObservableConnection[],
): readonly ObservableConnection[] {
  const newestByPeer = new Map<string, ObservableConnection>();

  for (const connection of connections) {
    if (connection.status !== 'open') {
      continue;
    }
    const peerId = connection.remotePeer.toString();
    const existing = newestByPeer.get(peerId);
    if (existing === undefined || connection.openedAt > existing.openedAt) {
      newestByPeer.set(peerId, connection);
    }
  }

  return [...newestByPeer.values()];
}

function transportFromMultiaddr(multiaddr: string): string {
  if (multiaddr.includes('/p2p-circuit')) {
    return 'circuit-relay';
  }
  if (multiaddr.includes('/webtransport')) {
    return 'webtransport';
  }
  if (multiaddr.includes('/webrtc-direct')) {
    return 'webrtc-direct';
  }
  if (multiaddr.includes('/webrtc')) {
    return 'webrtc';
  }
  if (multiaddr.includes('/wss') || multiaddr.includes('/ws')) {
    return 'websocket';
  }
  if (multiaddr.includes('/quic-v1')) {
    return 'quic-v1';
  }
  if (multiaddr.includes('/tcp')) {
    return 'tcp';
  }
  return 'unknown';
}

function relayPeerIdFromMultiaddr(multiaddr: string): string | undefined {
  const match = /(?:^|\/)p2p\/([^/]+)\/p2p-circuit(?:\/|$)/u.exec(multiaddr);
  const relayPeerId = match?.[1];
  return relayPeerId === undefined || relayPeerId.trim() === ''
    ? undefined
    : relayPeerId.slice(0, 128);
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError('pingConcurrency must be finite');
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

async function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Ping timed out'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
