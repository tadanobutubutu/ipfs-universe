import { describe, expect, it, vi } from 'vitest';

import {
  type HeliaNetworkAdapter,
  normalizeConnections,
  type ObservableConnection,
  type ObservablePeer,
  startHeliaObserver,
} from '../src/network/helia-observer';

const peer = (value: string): ObservablePeer => ({
  toString: () => value,
});

const connection = (
  peerId: string,
  overrides: Partial<ObservableConnection> = {},
): ObservableConnection => ({
  remotePeer: peer(peerId),
  remoteAddr: { toString: () => '/ip4/127.0.0.1/udp/4001/webrtc' },
  direction: 'outbound',
  status: 'open',
  openedAt: 1,
  ...overrides,
});

class FakeAdapter implements HeliaNetworkAdapter {
  readonly localPeerId = '12D3KooWLocal';
  readonly #listeners = {
    discovered: new Set<(remotePeer: ObservablePeer) => void>(),
    connected: new Set<(remotePeer: ObservablePeer) => void>(),
    disconnected: new Set<(remotePeer: ObservablePeer) => void>(),
  };

  connections: ObservableConnection[] = [];
  ping = vi.fn(async () => 12);
  stop = vi.fn(async () => undefined);

  getConnections(remotePeer?: ObservablePeer): readonly ObservableConnection[] {
    if (remotePeer === undefined) {
      return this.connections;
    }

    const peerId = remotePeer.toString();
    return this.connections.filter(
      (candidate) => candidate.remotePeer.toString() === peerId,
    );
  }

  on(
    event: 'connected' | 'disconnected' | 'discovered',
    listener: (remotePeer: ObservablePeer) => void,
  ): () => void {
    this.#listeners[event].add(listener);
    return () => this.#listeners[event].delete(listener);
  }

  emit(
    event: 'connected' | 'disconnected' | 'discovered',
    remotePeer: ObservablePeer,
  ): void {
    for (const listener of this.#listeners[event]) {
      listener(remotePeer);
    }
  }
}

describe('Helia observer', () => {
  it('normalizes only actual open connections', () => {
    const observations = normalizeConnections(
      [
        connection('12D3KooWOpen', {
          direction: 'inbound',
          remoteAddr: {
            toString: () => '/dns4/relay.example/tcp/443/wss/p2p-circuit',
          },
        }),
        connection('12D3KooWClosed', { status: 'closed' }),
      ],
      1_000,
    );

    expect(observations).toEqual([
      {
        type: 'connected',
        peerId: '12D3KooWOpen',
        observedAt: 1_000,
        direction: 'inbound',
        transport: 'circuit-relay',
      },
    ]);
  });

  it('uses the newest open connection when a peer has several', () => {
    const observations = normalizeConnections(
      [
        connection('12D3KooWMulti', {
          openedAt: 10,
          remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/4001/ws' },
        }),
        connection('12D3KooWMulti', {
          openedAt: 20,
          remoteAddr: {
            toString: () => '/ip4/127.0.0.1/udp/4001/quic-v1/webtransport',
          },
        }),
      ],
      30,
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ transport: 'webtransport' });
  });

  it('retains an observed relay peer for evidence-backed relay edges', () => {
    const observations = normalizeConnections(
      [
        connection('12D3KooWTarget', {
          remoteAddr: {
            toString: () =>
              '/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWTarget',
          },
        }),
      ],
      1_500,
    );

    expect(observations[0]).toMatchObject({
      transport: 'circuit-relay',
      relayPeerId: '12D3KooWRelay',
    });
  });

  it('snapshots initial connections and keeps discovery distinct', async () => {
    const adapter = new FakeAdapter();
    adapter.connections = [connection('12D3KooWInitial')];

    const observer = await startHeliaObserver({
      createAdapter: async () => adapter,
      now: () => 100,
      pingIntervalMs: 30_000,
    });
    adapter.emit('discovered', peer('12D3KooWDiscovered'));

    expect(observer.localPeerId).toBe('12D3KooWLocal');
    expect(observer.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'connected',
          peerId: '12D3KooWInitial',
        }),
        {
          type: 'discovered',
          peerId: '12D3KooWDiscovered',
          observedAt: 100,
        },
      ]),
    );

    await observer.stop();
  });

  it('emits disconnect only after the last real connection closes', async () => {
    const adapter = new FakeAdapter();
    const remotePeer = peer('12D3KooWRemote');
    adapter.connections = [connection('12D3KooWRemote')];
    const observer = await startHeliaObserver({
      createAdapter: async () => adapter,
      now: () => 200,
    });

    adapter.emit('disconnected', remotePeer);
    expect(observer.snapshot().at(-1)?.type).toBe('connected');

    adapter.connections = [];
    adapter.emit('disconnected', remotePeer);
    expect(observer.snapshot().at(-1)).toEqual({
      type: 'disconnected',
      peerId: '12D3KooWRemote',
      observedAt: 200,
    });

    await observer.stop();
  });

  it('never fabricates latency when ping fails', async () => {
    const adapter = new FakeAdapter();
    adapter.connections = [connection('12D3KooWNoPing')];
    adapter.ping.mockRejectedValueOnce(new Error('timeout'));
    const observer = await startHeliaObserver({
      createAdapter: async () => adapter,
      now: () => 300,
    });

    await vi.waitFor(() => expect(adapter.ping).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(observer.snapshot().some(({ type }) => type === 'latency')).toBe(
      false,
    );
    await observer.stop();
  });

  it('limits concurrent pings to two peers', async () => {
    const adapter = new FakeAdapter();
    adapter.connections = [
      connection('12D3KooWOne'),
      connection('12D3KooWTwo'),
      connection('12D3KooWThree'),
    ];
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    adapter.ping.mockImplementation(
      async () =>
        new Promise<number>((resolve) => {
          active += 1;
          maximum = Math.max(maximum, active);
          releases.push(() => {
            active -= 1;
            resolve(10);
          });
        }),
    );

    const observer = await startHeliaObserver({
      createAdapter: async () => adapter,
      now: () => 400,
      pingConcurrency: 2,
    });
    await vi.waitFor(() => expect(adapter.ping).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(adapter.ping).toHaveBeenCalledTimes(3));
    for (const release of releases.splice(0)) {
      release();
    }

    expect(maximum).toBe(2);
    await observer.stop();
  });

  it('unsubscribes and stops Helia without accepting later events', async () => {
    const adapter = new FakeAdapter();
    const observer = await startHeliaObserver({
      createAdapter: async () => adapter,
      now: () => 500,
    });
    await observer.stop();
    const before = observer.snapshot();

    adapter.emit('discovered', peer('12D3KooWTooLate'));

    expect(observer.snapshot()).toEqual(before);
    expect(adapter.stop).toHaveBeenCalledOnce();
  });
});
