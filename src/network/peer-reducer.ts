import type {
  PeerObservation,
  PeerRecord,
  PeerState,
  PeerStatus,
  PersistedPeer,
} from './peer-types';

const EMPTY_PEERS: ReadonlyMap<string, PeerRecord> = new Map();
export const MAX_TRACKED_PEERS = 512;

export function emptyPeerState(): PeerState {
  return {
    peers: EMPTY_PEERS,
    totalCount: 0,
    connectedCount: 0,
    discoveredCount: 0,
    disconnectedCount: 0,
    revision: 0,
  };
}

export function reducePeerEvent(
  state: PeerState,
  observation: PeerObservation,
): PeerState {
  validateObservation(observation);

  const current = state.peers.get(observation.peerId);
  const next = reduceRecord(current, observation);

  if (current !== undefined && recordsEqual(current, next)) {
    return state;
  }

  const peers = new Map(state.peers);
  peers.set(observation.peerId, next);
  prunePeers(peers);
  const counts = countStatuses(peers);

  return {
    peers,
    totalCount: peers.size,
    connectedCount: counts.connected,
    discoveredCount: counts.discovered,
    disconnectedCount: counts.disconnected,
    revision: state.revision + 1,
  };
}

export function selectConnectedPeers(state: PeerState): readonly PeerRecord[] {
  return [...state.peers.values()]
    .filter((peer) => peer.status === 'connected')
    .sort(
      (left, right) =>
        right.lastSeenAt - left.lastSeenAt ||
        left.peerId.localeCompare(right.peerId),
    );
}

export function toPersistedPeer(peer: PeerRecord): PersistedPeer {
  return {
    peerId: peer.peerId,
    status: peer.status,
    firstSeenAt: peer.firstSeenAt,
    lastSeenAt: peer.lastSeenAt,
    ...(peer.latencyMs === undefined ? {} : { latencyMs: peer.latencyMs }),
  };
}

function reduceRecord(
  current: PeerRecord | undefined,
  observation: PeerObservation,
): PeerRecord {
  const base = current ?? {
    peerId: observation.peerId,
    status: 'discovered' as const,
    statusObservedAt: observation.observedAt,
    firstSeenAt: observation.observedAt,
    lastSeenAt: observation.observedAt,
  };

  const seen = {
    ...base,
    firstSeenAt: Math.min(base.firstSeenAt, observation.observedAt),
    lastSeenAt: Math.max(base.lastSeenAt, observation.observedAt),
  };

  switch (observation.type) {
    case 'discovered':
      return seen;
    case 'identified':
      return {
        ...seen,
        source: observation.source ?? current?.source ?? 'browser',
        ...(observation.protocols === undefined ? {} : { protocols: observation.protocols }),
        ...(observation.agentVersion === undefined ? {} : { agentVersion: observation.agentVersion }),
        ...(observation.protocolVersion === undefined ? {} : { protocolVersion: observation.protocolVersion }),
        ...(observation.addressCount === undefined ? {} : { addressCount: observation.addressCount }),
      };
    case 'connected':
      if (
        current !== undefined &&
        observation.observedAt < current.statusObservedAt
      ) {
        return seen;
      }

      return {
        ...seen,
        status: 'connected',
        statusObservedAt: observation.observedAt,
        direction: observation.direction,
        transport: observation.transport,
        ...(observation.relayPeerId === undefined ? {} : { relayPeerId: observation.relayPeerId }),
        source: observation.source ?? current?.source ?? 'browser',
        ...(observation.protocols === undefined ? {} : { protocols: observation.protocols }),
        ...(observation.agentVersion === undefined ? {} : { agentVersion: observation.agentVersion }),
        ...(observation.protocolVersion === undefined ? {} : { protocolVersion: observation.protocolVersion }),
        ...(observation.addressCount === undefined ? {} : { addressCount: observation.addressCount }),
        ...(current?.status === 'connected'
          ? {}
          : { latencyMs: undefined, latencyObservedAt: undefined }),
      };
    case 'disconnected':
      if (
        current !== undefined &&
        observation.observedAt < current.statusObservedAt
      ) {
        return seen;
      }

      return {
        ...seen,
        status: 'disconnected',
        statusObservedAt: observation.observedAt,
        latencyMs: undefined,
        latencyObservedAt: undefined,
      };
    case 'latency':
      if (current?.status !== 'connected') {
        return seen;
      }
      if (
        current?.latencyObservedAt !== undefined &&
        observation.observedAt < current.latencyObservedAt
      ) {
        return seen;
      }

      return {
        ...seen,
        latencyMs: observation.latencyMs,
        latencyObservedAt: observation.observedAt,
      };
  }
}

function validateObservation(observation: PeerObservation): void {
  if (
    observation.peerId.trim().length === 0 ||
    observation.peerId !== observation.peerId.trim()
  ) {
    throw new TypeError('peerId must be a non-empty, trimmed string');
  }

  if (!Number.isFinite(observation.observedAt) || observation.observedAt < 0) {
    throw new TypeError('observedAt must be a finite, non-negative number');
  }

  if (observation.type === 'connected' && observation.transport.trim() === '') {
    throw new TypeError('transport must be a non-empty string');
  }

  if (
    observation.type === 'latency' &&
    (!Number.isFinite(observation.latencyMs) || observation.latencyMs < 0)
  ) {
    throw new TypeError('latencyMs must be a finite, non-negative number');
  }
}

function prunePeers(peers: Map<string, PeerRecord>): void {
  if (peers.size <= MAX_TRACKED_PEERS) {
    return;
  }

  const evictionOrder: Readonly<Record<PeerStatus, number>> = {
    disconnected: 0,
    discovered: 1,
    connected: 2,
  };
  const candidates = [...peers.values()].sort(
    (left, right) =>
      evictionOrder[left.status] - evictionOrder[right.status] ||
      left.lastSeenAt - right.lastSeenAt ||
      left.peerId.localeCompare(right.peerId),
  );

  for (
    let index = 0;
    peers.size > MAX_TRACKED_PEERS && index < candidates.length;
    index += 1
  ) {
    const candidate = candidates[index];
    if (candidate !== undefined) {
      peers.delete(candidate.peerId);
    }
  }
}

function countStatuses(peers: ReadonlyMap<string, PeerRecord>): {
  connected: number;
  discovered: number;
  disconnected: number;
} {
  let connected = 0;
  let discovered = 0;
  let disconnected = 0;
  for (const peer of peers.values()) {
    switch (peer.status) {
      case 'connected':
        connected += 1;
        break;
      case 'discovered':
        discovered += 1;
        break;
      case 'disconnected':
        disconnected += 1;
        break;
    }
  }
  return { connected, discovered, disconnected };
}

function recordsEqual(left: PeerRecord, right: PeerRecord): boolean {
  return (
    left.peerId === right.peerId &&
    left.status === right.status &&
    left.statusObservedAt === right.statusObservedAt &&
    left.firstSeenAt === right.firstSeenAt &&
    left.lastSeenAt === right.lastSeenAt &&
    left.direction === right.direction &&
    left.transport === right.transport &&
    left.relayPeerId === right.relayPeerId &&
    left.source === right.source &&
    sameStrings(left.protocols, right.protocols) &&
    left.agentVersion === right.agentVersion &&
    left.protocolVersion === right.protocolVersion &&
    left.addressCount === right.addressCount &&
    left.latencyMs === right.latencyMs &&
    left.latencyObservedAt === right.latencyObservedAt
  );
}

function sameStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
