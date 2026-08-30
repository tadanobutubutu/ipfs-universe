import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_KUBO_PEERS,
  MAX_KUBO_RESPONSE_BYTES,
  probeLocalKubo,
} from '../src/network/kubo-observer';

describe('probeLocalKubo', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps verbose Kubo peers into typed observations without exposing addresses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ID: 'local' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Peers: [
              {
                Peer: '12D3KooWpeer',
                Addr: '/ip4/127.0.0.1/udp/4001/quic-v1',
                Latency: '12.5ms',
                Direction: 2,
                Identify: {
                  AgentVersion: 'kubo/0.41.0/',
                  Protocols: ['/ipfs/ping/1.0.0'],
                  Addresses: ['/ip4/198.51.100.4/tcp/4001'],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeLocalKubo('http://127.0.0.1:5001');
    expect(result.localPeerId).toBe('local');
    expect(result.peerCount).toBe(1);
    expect(result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'connected',
          source: 'kubo',
          direction: 'outbound',
          transport: 'quic-v1',
          agentVersion: 'kubo/0.41.0/',
          addressCount: 1,
        }),
        expect.objectContaining({ type: 'latency', latencyMs: 12.5 }),
      ]),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain('swarm/peers?verbose=true');
  });

  it('retains the relay peer from a Kubo circuit address', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ID: 'local' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Peers: [
              {
                Peer: '12D3KooWTarget',
                Addr: '/ip4/198.51.100.9/tcp/4001/p2p/12D3KooWRelay/p2p-circuit',
                Direction: 1,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeLocalKubo();
    expect(result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'connected',
          peerId: '12D3KooWTarget',
          relayPeerId: '12D3KooWRelay',
        }),
      ]),
    );
  });

  it('turns browser fetch failures into an actionable CORS error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    await expect(probeLocalKubo()).rejects.toMatchObject({ code: 'cors' });
  });

  it('bounds the imported view while preserving the daemon total', async () => {
    const peerCount = MAX_KUBO_PEERS + 37;
    const peers = Array.from({ length: peerCount }, (_, index) => ({
      Peer: `12D3KooWKubo${String(index).padStart(5, '0')}`,
      Addr: '/ip4/198.51.100.4/tcp/4001',
      Direction: 2,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ID: 'local' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ Peers: peers }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeLocalKubo('http://127.0.0.1:5001');
    expect(result.peerCount).toBe(peerCount);
    expect(result.observations).toHaveLength(MAX_KUBO_PEERS);
    expect(result.truncated).toBe(true);
  });

  it('rejects an unexpectedly large RPC response before parsing it', async () => {
    const oversized = JSON.stringify({
      ID: 'local',
      padding: 'x'.repeat(MAX_KUBO_RESPONSE_BYTES),
    });
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(oversized, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeLocalKubo()).rejects.toMatchObject({ code: 'invalid' });
  });
});
