import { describe, expect, it } from 'vitest';

import {
  emptyPeerState,
  MAX_TRACKED_PEERS,
  reducePeerEvent,
  selectConnectedPeers,
} from '../src/network/peer-reducer';
import type { PeerObservation } from '../src/network/peer-types';

function reduce(events: readonly PeerObservation[]) {
  return events.reduce(reducePeerEvent, emptyPeerState());
}

describe('peer observation reducer', () => {
  it('keeps discovered peers separate from connected peers', () => {
    const state = reduce([
      {
        type: 'discovered',
        peerId: '12D3KooWObserved',
        observedAt: 10,
      },
    ]);

    expect(state.connectedCount).toBe(0);
    expect(state.discoveredCount).toBe(1);
    const peer = state.peers.get('12D3KooWObserved');
    expect(peer).toMatchObject({ status: 'discovered' });
    expect(peer?.latencyMs).toBeUndefined();
    expect(selectConnectedPeers(state)).toEqual([]);
  });

  it('records only measured latency and preserves connection evidence', () => {
    const state = reduce([
      {
        type: 'connected',
        peerId: '12D3KooWConnected',
        observedAt: 20,
        direction: 'outbound',
        transport: 'webrtc',
      },
      {
        type: 'latency',
        peerId: '12D3KooWConnected',
        observedAt: 25,
        latencyMs: 42.5,
      },
    ]);

    expect(state.connectedCount).toBe(1);
    expect(state.peers.get('12D3KooWConnected')).toMatchObject({
      direction: 'outbound',
      latencyMs: 42.5,
      latencyObservedAt: 25,
      status: 'connected',
      transport: 'webrtc',
    });
  });

  it('ignores an out-of-order disconnect for current status', () => {
    const state = reduce([
      {
        type: 'connected',
        peerId: '12D3KooWOrdered',
        observedAt: 100,
        direction: 'inbound',
        transport: 'webtransport',
      },
      {
        type: 'disconnected',
        peerId: '12D3KooWOrdered',
        observedAt: 90,
      },
    ]);

    expect(state.connectedCount).toBe(1);
    expect(state.peers.get('12D3KooWOrdered')).toMatchObject({
      firstSeenAt: 90,
      lastSeenAt: 100,
      status: 'connected',
      statusObservedAt: 100,
    });
  });

  it('does not let discovery downgrade a connected or disconnected peer', () => {
    const connected = reduce([
      {
        type: 'connected',
        peerId: '12D3KooWStable',
        observedAt: 10,
        direction: 'outbound',
        transport: 'websocket',
      },
      {
        type: 'discovered',
        peerId: '12D3KooWStable',
        observedAt: 20,
      },
    ]);
    const disconnected = reducePeerEvent(connected, {
      type: 'disconnected',
      peerId: '12D3KooWStable',
      observedAt: 30,
    });
    const rediscovered = reducePeerEvent(disconnected, {
      type: 'discovered',
      peerId: '12D3KooWStable',
      observedAt: 40,
    });

    expect(connected.peers.get('12D3KooWStable')?.status).toBe('connected');
    expect(rediscovered.peers.get('12D3KooWStable')).toMatchObject({
      lastSeenAt: 40,
      status: 'disconnected',
      statusObservedAt: 30,
    });
  });

  it('is idempotent for duplicate observations', () => {
    const event: PeerObservation = {
      type: 'connected',
      peerId: '12D3KooWDuplicate',
      observedAt: 50,
      direction: 'outbound',
      transport: 'webrtc',
    };
    const once = reducePeerEvent(emptyPeerState(), event);
    const twice = reducePeerEvent(once, event);

    expect(twice).toBe(once);
  });

  it('keeps the newest latency sample when events arrive out of order', () => {
    const state = reduce([
      {
        type: 'connected',
        peerId: '12D3KooWLatency',
        observedAt: 70,
        direction: 'outbound',
        transport: 'websocket',
      },
      {
        type: 'latency',
        peerId: '12D3KooWLatency',
        observedAt: 90,
        latencyMs: 18,
      },
      {
        type: 'latency',
        peerId: '12D3KooWLatency',
        observedAt: 80,
        latencyMs: 999,
      },
    ]);

    expect(state.peers.get('12D3KooWLatency')).toMatchObject({
      latencyMs: 18,
      latencyObservedAt: 90,
      status: 'connected',
    });
  });

  it('clears stale latency evidence when a peer disconnects', () => {
    const state = reduce([
      {
        type: 'connected',
        peerId: '12D3KooWStaleLatency',
        observedAt: 10,
        direction: 'outbound',
        transport: 'websocket',
      },
      {
        type: 'latency',
        peerId: '12D3KooWStaleLatency',
        observedAt: 11,
        latencyMs: 25,
      },
      {
        type: 'disconnected',
        peerId: '12D3KooWStaleLatency',
        observedAt: 12,
      },
    ]);

    expect(state.peers.get('12D3KooWStaleLatency')).toMatchObject({
      status: 'disconnected',
    });
    expect(state.peers.get('12D3KooWStaleLatency')?.latencyMs).toBeUndefined();
    expect(
      state.peers.get('12D3KooWStaleLatency')?.latencyObservedAt,
    ).toBeUndefined();
  });

  it('bounds the active view and evicts the oldest non-connected peer first', () => {
    let state = emptyPeerState();
    for (let index = 0; index < MAX_TRACKED_PEERS + 1; index += 1) {
      state = reducePeerEvent(state, {
        type: 'discovered',
        peerId: `12D3KooWBounded${String(index).padStart(4, '0')}`,
        observedAt: index,
      });
    }
    state = reducePeerEvent(state, {
      type: 'connected',
      peerId: '12D3KooWBounded0001',
      observedAt: MAX_TRACKED_PEERS + 2,
      direction: 'inbound',
      transport: 'webtransport',
    });

    expect(state.peers.size).toBe(MAX_TRACKED_PEERS);
    expect(state.totalCount).toBe(MAX_TRACKED_PEERS);
    expect(state.peers.has('12D3KooWBounded0000')).toBe(false);
    expect(state.peers.get('12D3KooWBounded0001')?.status).toBe('connected');
    expect(
      state.connectedCount + state.discoveredCount + state.disconnectedCount,
    ).toBe(state.totalCount);
  });

  it('rejects observations that would corrupt state', () => {
    expect(() =>
      reducePeerEvent(emptyPeerState(), {
        type: 'discovered',
        peerId: '   ',
        observedAt: 1,
      }),
    ).toThrow(/peerId/u);

    expect(() =>
      reducePeerEvent(emptyPeerState(), {
        type: 'latency',
        peerId: '12D3KooWInvalid',
        observedAt: 1,
        latencyMs: Number.NaN,
      }),
    ).toThrow(/latencyMs/u);
  });
});
