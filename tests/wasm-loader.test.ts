import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import type { PeerRecord } from '../src/network/peer-types';
import {
  loadAnalyticsWasm,
  loadPhysicsWasm,
  type WasmFetcher,
} from '../src/wasm/load-wasm';

function bytesFetcher(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
): WasmFetcher {
  return async () =>
    new Response(bytes, {
      headers: { 'content-type': contentType },
      status: 200,
    });
}

describe('typed WASM loaders', () => {
  it('exposes the Zig position buffer without a per-frame copy', async () => {
    const bytes = await readFile('public/physics.wasm');
    const physics = await loadPhysicsWasm(
      '/physics.wasm',
      bytesFetcher(Uint8Array.from(bytes), 'application/wasm'),
    );

    physics.initialize(2);
    physics.seedNode(0, 11, 12, 0);
    physics.seedNode(1, 22, 36, 3);
    const positions = physics.positions(2);
    const initialBuffer = positions.buffer;
    physics.step(1 / 60, 2, 1);

    expect(physics.maxNodes).toBe(512);
    expect(positions).toHaveLength(6);
    expect(positions.buffer).toBe(initialBuffer);
    expect([...positions].every(Number.isFinite)).toBe(true);
  });

  it('exposes the Zig edge-layout buffer without a per-frame copy', async () => {
    const bytes = await readFile('public/physics.wasm');
    const physics = await loadPhysicsWasm(
      '/physics.wasm',
      bytesFetcher(Uint8Array.from(bytes), 'application/wasm'),
    );

    physics.initialize(2);
    physics.seedNode(0, 11, 12, 0);
    physics.seedNode(1, 22, 36, 3);
    physics.setPeerMetadata(0, 'connected', 20, -1);
    physics.setPeerMetadata(1, 'connected', 400, 0);

    const edgeCount = physics.layoutEdges(2);
    expect(edgeCount).toBe(3);
    const edgePositions = physics.edgePositions(edgeCount);
    const edgeColors = physics.edgeColors(edgeCount);
    expect(edgePositions.length).toBe(edgeCount * 2 * 3);
    expect(edgeColors.length).toBe(edgePositions.length);
    expect(edgePositions.buffer).toBe(edgeColors.buffer);
    expect([...edgePositions].every(Number.isFinite)).toBe(true);
    expect([...edgeColors].every(Number.isFinite)).toBe(true);
  });

  it('maps typed peer records into Rust analytics', async () => {
    const bytes = await readFile('public/analytics.wasm');
    const analytics = await loadAnalyticsWasm(
      '/analytics.wasm',
      bytesFetcher(Uint8Array.from(bytes), 'text/plain'),
    );
    const peers: PeerRecord[] = [
      {
        peerId: '12D3KooWConnected',
        status: 'connected',
        statusObservedAt: 10,
        firstSeenAt: 10,
        lastSeenAt: 20,
        latencyMs: 40,
        latencyObservedAt: 20,
      },
      {
        peerId: '12D3KooWDiscovered',
        status: 'discovered',
        statusObservedAt: 15,
        firstSeenAt: 15,
        lastSeenAt: 15,
      },
    ];

    expect(analytics.analyze(peers)).toEqual({
      total: 2,
      connected: 1,
      discovered: 1,
      disconnected: 0,
      latencySamples: 1,
      latencyP50Ms: 40,
      latencyP95Ms: 40,
      latencyJitterMs: 0,
      measurementCoverage: 100,
    });
  });

  it('rejects invalid binaries instead of silently using fake data', async () => {
    await expect(
      loadPhysicsWasm(
        '/broken.wasm',
        bytesFetcher(new Uint8Array([0, 1, 2, 3]), 'application/wasm'),
      ),
    ).rejects.toThrow();
  });
});
