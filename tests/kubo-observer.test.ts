import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeLocalKubo } from '../src/network/kubo-observer';

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

  it('turns browser fetch failures into an actionable CORS error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    await expect(probeLocalKubo()).rejects.toMatchObject({ code: 'cors' });
  });
});
