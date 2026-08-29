import { describe, expect, it } from 'vitest';

import { radialDistance, relayEdgePairs } from '../src/scene/universe';

describe('3D peer layout', () => {
  it('keeps latency legible in the radial scale', () => {
    const peer = {
      status: 'connected' as const,
      statusObservedAt: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
      transport: 'websocket' as const,
    };
    const near = radialDistance({
      ...peer,
      peerId: '12D3KooWNearLatencyPeer',
      latencyMs: 10,
    });
    const far = radialDistance({
      ...peer,
      peerId: '12D3KooWFarLatencyPeer',
      latencyMs: 800,
    });

    expect(far / near).toBeGreaterThan(4);
  });

  it('draws relay edges only when both endpoint peers are observed', () => {
    const relay = {
      peerId: '12D3KooWRelay',
      status: 'connected' as const,
      statusObservedAt: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
    };
    const target = {
      peerId: '12D3KooWTarget',
      status: 'connected' as const,
      statusObservedAt: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
      relayPeerId: relay.peerId,
    };

    expect(relayEdgePairs([relay, target])).toEqual([[0, 1]]);
    expect(relayEdgePairs([target])).toEqual([]);
  });
});
