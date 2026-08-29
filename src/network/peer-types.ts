export type PeerConnectionDirection = 'inbound' | 'outbound' | 'unknown';

export type PeerStatus = 'connected' | 'disconnected' | 'discovered';
export type PeerSource = 'browser' | 'kubo';

export type PeerObservation =
  | {
      readonly type: 'discovered';
      readonly peerId: string;
      readonly observedAt: number;
    }
  | {
      readonly type: 'connected';
      readonly peerId: string;
      readonly observedAt: number;
      readonly direction: PeerConnectionDirection;
      readonly transport: string;
      /** Relay peer carried by a /p2p-circuit address, when observed. */
      readonly relayPeerId?: string;
      readonly source?: PeerSource;
      readonly protocols?: readonly string[];
      readonly agentVersion?: string;
      readonly protocolVersion?: string;
      readonly addressCount?: number;
    }
  | {
      readonly type: 'latency';
      readonly peerId: string;
      readonly observedAt: number;
      readonly latencyMs: number;
    }
  | {
      readonly type: 'identified';
      readonly peerId: string;
      readonly observedAt: number;
      readonly source?: PeerSource;
      readonly protocols?: readonly string[];
      readonly agentVersion?: string;
      readonly protocolVersion?: string;
      readonly addressCount?: number;
    }
  | {
      readonly type: 'disconnected';
      readonly peerId: string;
      readonly observedAt: number;
    };

export interface PeerRecord {
  readonly peerId: string;
  readonly status: PeerStatus;
  readonly statusObservedAt: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly direction?: PeerConnectionDirection;
  readonly transport?: string;
  readonly relayPeerId?: string;
  readonly source?: PeerSource;
  readonly protocols?: readonly string[];
  readonly agentVersion?: string;
  readonly protocolVersion?: string;
  readonly addressCount?: number;
  readonly latencyMs?: number;
  readonly latencyObservedAt?: number;
}

export interface PeerState {
  readonly peers: ReadonlyMap<string, PeerRecord>;
  readonly totalCount: number;
  readonly connectedCount: number;
  readonly discoveredCount: number;
  readonly disconnectedCount: number;
  readonly revision: number;
}

export type PersistedPeer = Pick<
  PeerRecord,
  'peerId' | 'status' | 'firstSeenAt' | 'lastSeenAt' | 'latencyMs'
>;
