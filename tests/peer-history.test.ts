import 'fake-indexeddb/auto';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  clearPeerHistory,
  getAllPeers,
  getPeerCount,
  savePeer,
  savePeers,
} from '../src/db/peer-history';
import { MAX_TRACKED_PEERS } from '../src/network/peer-reducer';
import type { PersistedPeer } from '../src/network/peer-types';

describe('peer history privacy boundary', () => {
  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('ipfs-universe-peers');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });

  it('persists only the explicitly public peer fields', async () => {
    const publicPeer: PersistedPeer & {
      multiaddr: string;
      privateKey: string;
    } = {
      peerId: '12D3KooWStored',
      status: 'connected',
      firstSeenAt: 10,
      lastSeenAt: 20,
      latencyMs: 31,
      multiaddr: '/ip4/192.0.2.1/tcp/4001/p2p/12D3KooWStored',
      privateKey: 'must-never-be-written',
    };

    await savePeer(publicPeer);

    expect(await getAllPeers()).toEqual([
      {
        peerId: '12D3KooWStored',
        status: 'connected',
        firstSeenAt: 10,
        lastSeenAt: 20,
        latencyMs: 31,
      },
    ]);
  });

  it('batches writes and retains only the bounded recent view', async () => {
    await savePeers(
      Array.from({ length: MAX_TRACKED_PEERS + 8 }, (_, index) => ({
        peerId: `12D3KooWPersisted${String(index).padStart(4, '0')}`,
        status: 'discovered' as const,
        firstSeenAt: 100 + index,
        lastSeenAt: 100 + index,
      })),
    );

    const stored = await getAllPeers();
    expect(stored).toHaveLength(MAX_TRACKED_PEERS);
    expect(stored.some(({ peerId }) => peerId === '12D3KooWStored')).toBe(
      false,
    );
    expect(
      stored.some(({ peerId }) => peerId === '12D3KooWPersisted0000'),
    ).toBe(false);
    expect(
      stored.some(
        ({ peerId }) =>
          peerId ===
          `12D3KooWPersisted${String(MAX_TRACKED_PEERS + 7).padStart(4, '0')}`,
      ),
    ).toBe(true);
  });

  it('lets the visitor erase the complete on-device history', async () => {
    expect(await getPeerCount()).toBeGreaterThan(0);
    await clearPeerHistory();
    expect(await getPeerCount()).toBe(0);
  });
});
