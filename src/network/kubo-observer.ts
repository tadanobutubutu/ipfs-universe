import type { PeerObservation } from './peer-types';

export interface KuboProbeResult {
  readonly localPeerId?: string;
  readonly observations: readonly PeerObservation[];
  readonly peerCount: number;
  readonly truncated: boolean;
}

/** Maximum number of Kubo records admitted to the active browser view. */
export const MAX_KUBO_PEERS = 1_024;
/** Maximum JSON payload accepted from the local admin RPC. */
export const MAX_KUBO_RESPONSE_BYTES = 8 * 1024 * 1024;

export class KuboProbeError extends Error {
  readonly code: 'cors' | 'http' | 'invalid' | 'unavailable';

  constructor(code: KuboProbeError['code'], message: string) {
    super(message);
    this.name = 'KuboProbeError';
    this.code = code;
  }
}

/**
 * Explicitly opt-in probe for a user's local Kubo RPC. It is never called on
 * page load: a public page must not silently inspect a local daemon.
 */
export async function probeLocalKubo(
  baseUrl = 'http://127.0.0.1:5001',
  signal?: AbortSignal,
): Promise<KuboProbeResult> {
  const origin = baseUrl.replace(/\/$/, '');
  const [idPayload, peersPayload] = await Promise.all([
    kuboJson<{ ID?: string }>(origin, 'id', signal),
    kuboJson<{ Peers?: readonly KuboPeer[] }>(
      origin,
      'swarm/peers?verbose=true&latency=true&direction=true&streams=true&identify=true',
      signal,
    ),
  ]);
  const peers = Array.isArray(peersPayload.Peers) ? peersPayload.Peers : [];
  const observedAt = Date.now();
  const importedPeers = peers.slice(0, MAX_KUBO_PEERS);
  const observations = importedPeers.flatMap((peer): PeerObservation[] => {
    if (typeof peer.Peer !== 'string' || peer.Peer.trim() === '') return [];
    const peerId = peer.Peer.trim();
    const relayPeerId = relayPeerIdFromMultiaddr(peer.Addr);
    const measuredLatency = latencyMs(peer.Latency);
    return [
      {
        type: 'connected',
        peerId,
        observedAt,
        source: 'kubo',
        ...(relayPeerId === undefined ? {} : { relayPeerId }),
        direction: directionLabel(peer.Direction),
        transport: transportLabel(peer.Addr),
        protocols: protocolsFrom(peer),
        agentVersion: identifyString(peer.Identify?.AgentVersion),
        protocolVersion: identifyString(peer.Identify?.ProtocolVersion),
        addressCount: Array.isArray(peer.Identify?.Addresses)
          ? Math.min(peer.Identify.Addresses.length, 128)
          : 1,
      },
      ...(measuredLatency === undefined
        ? []
        : [
            {
              type: 'latency' as const,
              peerId,
              observedAt,
              latencyMs: measuredLatency,
            },
          ]),
    ];
  });
  return {
    localPeerId: typeof idPayload.ID === 'string' ? idPayload.ID : undefined,
    observations,
    peerCount: peers.length,
    truncated: peers.length > importedPeers.length,
  };
}

interface KuboPeer {
  readonly Peer?: unknown;
  readonly Addr?: unknown;
  readonly Latency?: unknown;
  readonly Direction?: unknown;
  readonly Streams?: readonly unknown[];
  readonly Identify?: {
    readonly AgentVersion?: unknown;
    readonly ProtocolVersion?: unknown;
    readonly Protocols?: readonly unknown[];
    readonly Addresses?: readonly unknown[];
  };
}

function relayPeerIdFromMultiaddr(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /\/p2p\/([^/]+)\/p2p-circuit(?:\/|$)/u.exec(value);
  return match?.[1];
}

function protocolsFrom(peer: KuboPeer): readonly string[] | undefined {
  const identify = peer.Identify?.Protocols;
  if (Array.isArray(identify))
    return identify
      .filter((value: unknown): value is string => typeof value === 'string')
      .slice(0, 32);
  if (Array.isArray(peer.Streams)) {
    return peer.Streams.flatMap((stream: unknown) => {
      if (typeof stream === 'string') return [stream];
      if (
        stream !== null &&
        typeof stream === 'object' &&
        'Protocol' in stream &&
        typeof stream.Protocol === 'string'
      )
        return [stream.Protocol];
      return [];
    }).slice(0, 32);
  }
  return undefined;
}

function identifyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.slice(0, 256)
    : undefined;
}

async function kuboJson<T>(
  baseUrl: string,
  endpoint: string,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v0/${endpoint}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(4_000),
    });
  } catch {
    throw new KuboProbeError(
      'cors',
      'Local Kubo is unreachable or has not allowed this origin (CORS).',
    );
  }
  if (!response.ok) {
    throw new KuboProbeError(
      'http',
      `Local Kubo returned HTTP ${response.status}.`,
    );
  }
  try {
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_KUBO_RESPONSE_BYTES
    ) {
      throw new KuboProbeError(
        'invalid',
        'Local Kubo response exceeded the safe size limit.',
      );
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_KUBO_RESPONSE_BYTES) {
      throw new KuboProbeError(
        'invalid',
        'Local Kubo response exceeded the safe size limit.',
      );
    }
    return JSON.parse(body) as T;
  } catch (error) {
    if (errorIsKuboProbeError(error)) throw error;
    throw new KuboProbeError('invalid', 'Local Kubo returned invalid JSON.');
  }
}

function errorIsKuboProbeError(value: unknown): value is KuboProbeError {
  return value instanceof KuboProbeError;
}

function directionLabel(value: unknown): 'inbound' | 'outbound' | 'unknown' {
  if (value === 1 || value === '1' || value === 'inbound') return 'inbound';
  if (value === 2 || value === '2' || value === 'outbound') return 'outbound';
  return 'unknown';
}

function transportLabel(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  if (value.includes('/p2p-circuit')) return 'circuit-relay';
  if (value.includes('/webtransport')) return 'webtransport';
  if (value.includes('/quic')) return 'quic-v1';
  if (value.includes('/wss') || value.includes('/ws')) return 'websocket';
  if (value.includes('/webrtc')) return 'webrtc';
  if (value.includes('/tcp')) return 'tcp';
  return 'unknown';
}

function latencyMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    return value;
  if (typeof value !== 'string') return undefined;
  const match = /([0-9]+(?:\.[0-9]+)?)\s*(ms|s)?/i.exec(value);
  if (match === null) return undefined;
  const number = Number(match[1]);
  return Number.isFinite(number)
    ? match[2]?.toLowerCase() === 's'
      ? number * 1_000
      : number
    : undefined;
}
