import type { PeerRecord, PeerStatus } from '../network/peer-types';

type WasmNumberFunction = (...arguments_: number[]) => number;

export type WasmFetcher = (url: string) => Promise<Response>;

export interface PhysicsWasm {
  readonly maxNodes: number;
  initialize(count: number): void;
  seedNode(index: number, seed: number, radius: number, sector: number): void;
  step(deltaSeconds: number, count: number, motionScale: number): void;
  positions(count: number): Float32Array;
}

export interface PeerAnalytics {
  readonly total: number;
  readonly connected: number;
  readonly discovered: number;
  readonly disconnected: number;
  readonly latencySamples: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly latencyJitterMs: number;
  readonly measurementCoverage: number;
}

export interface AnalyticsWasm {
  readonly maxNodes: number;
  analyze(peers: readonly PeerRecord[]): PeerAnalytics;
}

export async function loadPhysicsWasm(
  url: string,
  fetcher: WasmFetcher = defaultWasmFetcher,
): Promise<PhysicsWasm> {
  const instance = await instantiateWasm(url, fetcher);
  const memory = exportedMemory(instance);
  const maximum = integerResult(instance, 'max_nodes');
  const initialize = exportedFunction(instance, 'init_system');
  const seedNode = exportedFunction(instance, 'seed_node');
  const step = exportedFunction(instance, 'step');
  const positionsPointer = integerResult(instance, 'positions_ptr');

  if (maximum <= 0 || maximum > 100_000) {
    throw new Error('Zig WASMが不正なmax_nodesを返しました。');
  }
  createFloat32View(memory, positionsPointer, maximum * 3);

  return {
    maxNodes: maximum,
    initialize: (count) => {
      initialize(clampCount(count, maximum));
    },
    seedNode: (index, seed, radius, sector) => {
      seedNode(
        Math.trunc(index),
        Math.trunc(seed),
        Math.min(44, Math.max(8, finiteOr(radius, 40))),
        Math.min(4, Math.max(0, Math.trunc(finiteOr(sector, 4)))),
      );
    },
    step: (deltaSeconds, count, motionScale) => {
      step(
        finiteOr(deltaSeconds, 0),
        clampCount(count, maximum),
        Math.min(1, Math.max(0, finiteOr(motionScale, 0))),
      );
    },
    positions: (count) =>
      createFloat32View(
        memory,
        positionsPointer,
        clampCount(count, maximum) * 3,
      ),
  };
}

export async function loadAnalyticsWasm(
  url: string,
  fetcher: WasmFetcher = defaultWasmFetcher,
): Promise<AnalyticsWasm> {
  const instance = await instantiateWasm(url, fetcher);
  const memory = exportedMemory(instance);
  const maximum = integerResult(instance, 'max_nodes');
  const inputStride = integerResult(instance, 'input_stride');
  const resultLength = integerResult(instance, 'result_len');
  const inputPointer = integerResult(instance, 'input_ptr');
  const resultPointer = integerResult(instance, 'result_ptr');
  const analyzeRaw = exportedFunction(instance, 'analyze');

  if (maximum <= 0 || maximum > 100_000 || inputStride !== 2) {
    throw new Error('Rust WASMの入力ABIが期待値と一致しません。');
  }
  if (resultLength !== 9) {
    throw new Error('Rust WASMの結果ABIが期待値と一致しません。');
  }

  createFloat32View(memory, inputPointer, maximum * inputStride);
  createFloat32View(memory, resultPointer, resultLength);

  return {
    maxNodes: maximum,
    analyze: (peers) => {
      const count = Math.min(peers.length, maximum);
      const input = createFloat32View(
        memory,
        inputPointer,
        maximum * inputStride,
      );
      input.fill(-1, 0, count * inputStride);

      for (let index = 0; index < count; index += 1) {
        const peer = peers[index];
        if (peer === undefined) {
          continue;
        }
        input[index * inputStride] = statusCode(peer.status);
        input[index * inputStride + 1] = peer.latencyMs ?? -1;
      }

      analyzeRaw(count);
      const result = createFloat32View(memory, resultPointer, resultLength);
      return {
        total: result[0] ?? 0,
        connected: result[1] ?? 0,
        discovered: result[2] ?? 0,
        disconnected: result[3] ?? 0,
        latencySamples: result[4] ?? 0,
        latencyP50Ms: rounded(result[5] ?? 0),
        latencyP95Ms: rounded(result[6] ?? 0),
        latencyJitterMs: rounded(result[7] ?? 0),
        measurementCoverage: rounded(result[8] ?? 0),
      };
    },
  };
}

async function defaultWasmFetcher(url: string): Promise<Response> {
  return fetch(url, {
    cache: 'force-cache',
    credentials: 'same-origin',
  });
}

async function instantiateWasm(
  url: string,
  fetcher: WasmFetcher,
): Promise<WebAssembly.Instance> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`WASM取得失敗: ${response.status} ${url}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('application/wasm')) {
    try {
      const source = await WebAssembly.instantiateStreaming(
        Promise.resolve(response.clone()),
        {},
      );
      return source.instance;
    } catch {
      // Some static hosts send a misleading MIME type; validate bytes below.
    }
  }

  const bytes = await response.arrayBuffer();
  if (!WebAssembly.validate(bytes)) {
    throw new Error(`${url} は有効なWebAssembly moduleではありません。`);
  }
  const source = await WebAssembly.instantiate(bytes, {});
  return source.instance;
}

function exportedMemory(instance: WebAssembly.Instance): WebAssembly.Memory {
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error('WASM memory exportが見つかりません。');
  }
  return memory;
}

function exportedFunction(
  instance: WebAssembly.Instance,
  name: string,
): WasmNumberFunction {
  const value = instance.exports[name];
  if (typeof value !== 'function') {
    throw new Error(`WASM function exportが見つかりません: ${name}`);
  }
  return value as WasmNumberFunction;
}

function integerResult(instance: WebAssembly.Instance, name: string): number {
  const result = Number(exportedFunction(instance, name)());
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`WASM export ${name} が不正な整数を返しました。`);
  }
  return result;
}

function createFloat32View(
  memory: WebAssembly.Memory,
  pointer: number,
  length: number,
): Float32Array {
  const byteLength = length * Float32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isSafeInteger(pointer) ||
    pointer < 0 ||
    pointer % Float32Array.BYTES_PER_ELEMENT !== 0 ||
    pointer + byteLength > memory.buffer.byteLength
  ) {
    throw new RangeError('WASM memory範囲が不正です。');
  }
  return new Float32Array(memory.buffer, pointer, length);
}

function statusCode(status: PeerStatus): number {
  switch (status) {
    case 'discovered':
      return 0;
    case 'connected':
      return 1;
    case 'disconnected':
      return 2;
  }
}

function clampCount(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, Math.trunc(finiteOr(value, 0))));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
