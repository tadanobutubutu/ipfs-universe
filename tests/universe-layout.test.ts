import { describe, expect, it } from 'vitest';

import {
  coreScaleForPeerCount,
  isBrowserLivePeer,
  isKuboObservedPeer,
  pointRadius,
  prioritizeScenePeers,
  radialDistance,
  relayEdgePairs,
  selectFramingPeers,
} from '../src/scene/universe';

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

    expect(far / near).toBeGreaterThan(8);
    expect(far).toBeGreaterThan(240);
  });

  it('keeps Kubo observations in a visually separate outer field', () => {
    const base = {
      status: 'connected' as const,
      statusObservedAt: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
      transport: 'tcp',
    };
    const kuboRadius = radialDistance({
      ...base,
      peerId: '12D3KooWKuboOuterField',
      source: 'kubo',
      latencyMs: 20,
    });
    const browserRadius = radialDistance({
      ...base,
      peerId: '12D3KooWBrowserInnerField',
      source: 'browser',
      latencyMs: 20,
    });

    expect(kuboRadius).toBeGreaterThan(browserRadius);
    expect(browserRadius).toBeLessThan(90);
  });

  it('keeps browser-only discoveries in a distinct middle field', () => {
    const discoveredRadius = radialDistance({
      peerId: '12D3KooWDiscoveredMiddleField',
      status: 'discovered',
      statusObservedAt: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
      source: 'browser',
    });

    expect(discoveredRadius).toBeGreaterThanOrEqual(100);
    expect(discoveredRadius).toBeLessThan(300);
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
    expect(
      relayEdgePairs([
        { ...relay, source: 'kubo' as const },
        { ...target, source: 'kubo' as const },
      ]),
    ).toEqual([[0, 1]]);
  });

  it('does not present local Kubo observations as browser-live peers', () => {
    expect(
      isBrowserLivePeer({
        peerId: '12D3KooWBrowser',
        status: 'connected',
        source: 'browser',
        statusObservedAt: 1,
        firstSeenAt: 1,
        lastSeenAt: 1,
      }),
    ).toBe(true);
    expect(
      isBrowserLivePeer({
        peerId: '12D3KooWKubo',
        status: 'connected',
        source: 'kubo',
        statusObservedAt: 1,
        firstSeenAt: 1,
        lastSeenAt: 1,
      }),
    ).toBe(false);
    expect(
      isKuboObservedPeer({
        peerId: '12D3KooWKubo',
        status: 'connected',
        source: 'kubo',
        statusObservedAt: 1,
        firstSeenAt: 1,
        lastSeenAt: 1,
      }),
    ).toBe(true);
  });

  it('reports the packed XYZ radius without duplicating an axis', () => {
    const points = new Float32Array([3, 4, 0]);

    expect(pointRadius(points, 0)).toBe(5);
  });

  it('keeps browser-live peers visible ahead of a large Kubo import', () => {
    const kuboPeers = Array.from({ length: 1_024 }, (_, index) => ({
      peerId: `12D3KooWKubo${String(index).padStart(4, '0')}`,
      status: 'connected' as const,
      source: 'kubo' as const,
      statusObservedAt: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
    }));
    const browserPeer = {
      peerId: '12D3KooWBrowserLive',
      status: 'connected' as const,
      source: 'browser' as const,
      statusObservedAt: 2,
      firstSeenAt: 2,
      lastSeenAt: 2,
    };

    const visible = prioritizeScenePeers([...kuboPeers, browserPeer], 1_024);

    expect(visible).toHaveLength(1_024);
    expect(visible[0]?.peerId).toBe(browserPeer.peerId);
  });

  it('keeps the observatory core visually dominant as the field grows', () => {
    expect(coreScaleForPeerCount(2, 0)).toBe(2);
    expect(coreScaleForPeerCount(2, 1_024)).toBeCloseTo(2.4, 5);
    expect(coreScaleForPeerCount(2, 5_000)).toBeCloseTo(2.4, 5);
  });

  it('does not let unmeasured Kubo imports pull the camera from the live core', () => {
    const kubo = {
      peerId: '12D3KooWKuboOuter',
      status: 'connected' as const,
      source: 'kubo' as const,
      statusObservedAt: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
    };
    const browser = {
      peerId: '12D3KooWBrowserInner',
      status: 'connected' as const,
      source: 'browser' as const,
      statusObservedAt: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
    };

    expect(selectFramingPeers([kubo, browser])).toEqual([browser]);
    expect(selectFramingPeers([kubo])).toEqual([kubo]);
  });

  it('frames measured Kubo observations without inventing a ping', () => {
    const measuredKubo = {
      peerId: '12D3KooWMeasuredKubo',
      status: 'connected' as const,
      source: 'kubo' as const,
      statusObservedAt: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
      latencyMs: 640,
    };

    expect(selectFramingPeers([measuredKubo])).toEqual([measuredKubo]);
  });
});
