import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

type WasmFunction = (...arguments_: number[]) => number | undefined;

interface LoadedWasm {
  readonly instance: WebAssembly.Instance;
  readonly memory: WebAssembly.Memory;
}

async function loadWasm(path: string): Promise<LoadedWasm> {
  const bytes = await readFile(path);
  expect(WebAssembly.validate(bytes)).toBe(true);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const memory = instance.exports.memory;
  expect(memory).toBeInstanceOf(WebAssembly.Memory);

  return { instance, memory: memory as WebAssembly.Memory };
}

function exportedFunction(
  instance: WebAssembly.Instance,
  name: string,
): WasmFunction {
  const value = instance.exports[name];
  expect(value, `${name} export`).toBeTypeOf('function');
  return value as WasmFunction;
}

describe('native WebAssembly modules', () => {
  let physics: LoadedWasm;
  let analytics: LoadedWasm;

  beforeAll(async () => {
    [physics, analytics] = await Promise.all([
      loadWasm('public/physics.wasm'),
      loadWasm('public/analytics.wasm'),
    ]);
  });

  it('builds executable Zig and Rust modules with stable raw ABIs', () => {
    for (const name of [
      'init_system',
      'seed_node',
      'step',
      'positions_ptr',
      'max_nodes',
      'set_peer_metadata',
      'layout_edges',
      'edge_count',
      'edge_positions_ptr',
      'edge_colors_ptr',
    ]) {
      exportedFunction(physics.instance, name);
    }
    for (const name of [
      'input_ptr',
      'analyze',
      'result_ptr',
      'max_nodes',
      'input_stride',
      'result_len',
    ]) {
      exportedFunction(analytics.instance, name);
    }
  });

  it('seeds deterministic finite Zig positions and honors motion pause', () => {
    const initialize = exportedFunction(physics.instance, 'init_system');
    const seed = exportedFunction(physics.instance, 'seed_node');
    const step = exportedFunction(physics.instance, 'step');
    const positionsPointer = exportedFunction(
      physics.instance,
      'positions_ptr',
    );

    initialize(3);
    seed(0, 101, 12, 0);
    seed(1, 202, 24, 2);
    seed(2, 303, 40, 4);
    const pointer = Number(positionsPointer());
    const first = [...new Float32Array(physics.memory.buffer, pointer, 9)];

    initialize(3);
    seed(0, 101, 12, 0);
    seed(1, 202, 24, 2);
    seed(2, 303, 40, 4);
    const second = [...new Float32Array(physics.memory.buffer, pointer, 9)];
    expect(second).toEqual(first);
    expect(second.every(Number.isFinite)).toBe(true);
    expect(second.some((value) => value !== 0)).toBe(true);

    step(1 / 60, 3, 0);
    expect([...new Float32Array(physics.memory.buffer, pointer, 9)]).toEqual(
      second,
    );

    step(1 / 60, 3, 1);
    const moved = [...new Float32Array(physics.memory.buffer, pointer, 9)];
    expect(moved).not.toEqual(second);
    expect(moved.every(Number.isFinite)).toBe(true);
  });

  it('maps Zig radial and transport-sector hints into spatial positions', () => {
    const initialize = exportedFunction(physics.instance, 'init_system');
    const seed = exportedFunction(physics.instance, 'seed_node');
    const positionsPointer = exportedFunction(
      physics.instance,
      'positions_ptr',
    );
    initialize(2);
    seed(0, 1234, 12, 0);
    seed(1, 1234, 40, 3);

    const positions = new Float32Array(
      physics.memory.buffer,
      Number(positionsPointer()),
      6,
    );
    const radius = (offset: number): number =>
      Math.hypot(
        positions[offset] ?? 0,
        positions[offset + 1] ?? 0,
        positions[offset + 2] ?? 0,
      );
    const angle = (offset: number): number =>
      Math.atan2(positions[offset + 2] ?? 0, positions[offset] ?? 0);

    expect(radius(0)).toBeCloseTo(12, 3);
    expect(radius(3)).toBeCloseTo(40, 3);
    expect(Math.abs(angle(0) - angle(3))).toBeGreaterThan(1.5);
  });

  it('clamps Zig work to its fixed capacity', () => {
    const maximum = Number(exportedFunction(physics.instance, 'max_nodes')());
    const initialize = exportedFunction(physics.instance, 'init_system');
    const step = exportedFunction(physics.instance, 'step');

    expect(maximum).toBe(1_024);
    expect(() => {
      initialize(50_000);
      step(10, 50_000, 1);
    }).not.toThrow();
  });

  it('computes center and relay edges in the Zig module', () => {
    const initialize = exportedFunction(physics.instance, 'init_system');
    const seedNode = exportedFunction(physics.instance, 'seed_node');
    const setPeerMetadata = exportedFunction(
      physics.instance,
      'set_peer_metadata',
    );
    const layoutEdges = exportedFunction(physics.instance, 'layout_edges');
    const edgeCount = exportedFunction(physics.instance, 'edge_count');
    const edgePositionsPointer = exportedFunction(
      physics.instance,
      'edge_positions_ptr',
    );
    const edgeColorsPointer = exportedFunction(
      physics.instance,
      'edge_colors_ptr',
    );

    initialize(2);
    seedNode(0, 11, 12, 0);
    seedNode(1, 22, 36, 3);
    setPeerMetadata(0, 1, 20, -1);
    setPeerMetadata(1, 1, 400, 0);
    layoutEdges(2);

    expect(edgeCount()).toBe(3);
    const positions = new Float32Array(
      physics.memory.buffer,
      Number(edgePositionsPointer()),
      3 * 2 * 3,
    );
    const colors = new Float32Array(
      physics.memory.buffer,
      Number(edgeColorsPointer()),
      3 * 2 * 3,
    );
    expect([...positions].every(Number.isFinite)).toBe(true);
    expect([...colors].every(Number.isFinite)).toBe(true);
  });

  it('keeps Kubo relay evidence without drawing a browser center edge', () => {
    const initialize = exportedFunction(physics.instance, 'init_system');
    const seedNode = exportedFunction(physics.instance, 'seed_node');
    const setPeerMetadata = exportedFunction(
      physics.instance,
      'set_peer_metadata',
    );
    const setPeerSource = exportedFunction(physics.instance, 'set_peer_source');
    const layoutEdges = exportedFunction(physics.instance, 'layout_edges');
    const edgeCount = exportedFunction(physics.instance, 'edge_count');

    initialize(2);
    seedNode(0, 11, 60, 0);
    seedNode(1, 22, 68, 3);
    setPeerMetadata(0, 1, -1, -1);
    setPeerMetadata(1, 1, -1, 0);
    setPeerSource(0, 1);
    setPeerSource(1, 1);
    layoutEdges(2);

    expect(edgeCount()).toBe(1);
  });

  it('uses only live peer pings for Rust latency and coverage analytics', () => {
    const inputPointer = exportedFunction(analytics.instance, 'input_ptr');
    const analyze = exportedFunction(analytics.instance, 'analyze');
    const resultPointer = exportedFunction(analytics.instance, 'result_ptr');
    const stride = Number(
      exportedFunction(analytics.instance, 'input_stride')(),
    );
    const resultLength = Number(
      exportedFunction(analytics.instance, 'result_len')(),
    );
    const input = new Float32Array(
      analytics.memory.buffer,
      Number(inputPointer()),
      5 * stride,
    );
    input.set([1, 10, 1, 20, 1, 30, 0, 40, 2, 50]);

    analyze(5);
    const result = [
      ...new Float32Array(
        analytics.memory.buffer,
        Number(resultPointer()),
        resultLength,
      ),
    ];

    expect(result).toEqual([5, 3, 1, 1, 3, 20, 30, 10, 100]);
  });

  it('handles empty, unmeasured, and oversized Rust input safely', () => {
    const inputPointer = exportedFunction(analytics.instance, 'input_ptr');
    const analyze = exportedFunction(analytics.instance, 'analyze');
    const resultPointer = exportedFunction(analytics.instance, 'result_ptr');
    const resultLength = Number(
      exportedFunction(analytics.instance, 'result_len')(),
    );
    const maximum = Number(exportedFunction(analytics.instance, 'max_nodes')());

    analyze(0);
    expect([
      ...new Float32Array(
        analytics.memory.buffer,
        Number(resultPointer()),
        resultLength,
      ),
    ]).toEqual(new Array<number>(resultLength).fill(0));

    const input = new Float32Array(
      analytics.memory.buffer,
      Number(inputPointer()),
      maximum * 2,
    );
    input.fill(-1);
    expect(() => analyze(50_000)).not.toThrow();
    const result = new Float32Array(
      analytics.memory.buffer,
      Number(resultPointer()),
      resultLength,
    );
    expect(result[0]).toBe(maximum);
    expect([...result].every(Number.isFinite)).toBe(true);
  });
});
