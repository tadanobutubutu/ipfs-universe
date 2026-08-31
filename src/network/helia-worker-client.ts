import type { HeliaObserver } from './helia-observer';
import type { PeerObservation } from './peer-types';

type WorkerCommand =
  | { readonly type: 'start' }
  | { readonly type: 'retry' }
  | { readonly type: 'stop' };

type WorkerEvent =
  | { readonly type: 'ready'; readonly localPeerId: string }
  | { readonly type: 'observation'; readonly observation: PeerObservation }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'stopped' };

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 1_000;

/** Start the real Helia observer off the UI thread. */
export async function startHeliaWorkerObserver(): Promise<HeliaObserver> {
  const worker = new Worker(new URL('./helia-worker.ts', import.meta.url), {
    name: 'peerstellation-helia',
    type: 'module',
  });
  const observer = new WorkerHeliaObserver(worker);
  try {
    await observer.start();
    return observer;
  } catch (error) {
    await observer.stop();
    throw error;
  }
}

class WorkerHeliaObserver implements HeliaObserver {
  readonly #worker: Worker;
  readonly #listeners = new Set<(observation: PeerObservation) => void>();
  readonly #observations: PeerObservation[] = [];
  #localPeerId = '';
  #started = false;
  #stopped = false;
  #startResolve?: () => void;
  #startReject?: (error: Error) => void;
  #stopResolve?: () => void;

  constructor(worker: Worker) {
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerEvent>): void => {
      this.#handleEvent(event.data);
    };
    worker.onerror = (event): void => {
      const error = new Error(event.message || 'Helia worker failed');
      this.#startReject?.(error);
    };
  }

  get localPeerId(): string {
    return this.#localPeerId;
  }

  async start(): Promise<void> {
    if (this.#started || this.#stopped) return;
    await new Promise<void>((resolve, reject) => {
      this.#startResolve = resolve;
      this.#startReject = reject;
      globalThis.setTimeout(() => {
        if (this.#started) return;
        this.#startResolve = undefined;
        this.#startReject = undefined;
        reject(new Error('Helia worker startup timed out'));
      }, START_TIMEOUT_MS);
      this.#post({ type: 'start' });
    });
  }

  snapshot(): readonly PeerObservation[] {
    return [...this.#observations];
  }

  subscribe(listener: (observation: PeerObservation) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async retry(): Promise<void> {
    if (!this.#stopped) this.#post({ type: 'retry' });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await new Promise<void>((resolve) => {
      this.#stopResolve = resolve;
      globalThis.setTimeout(() => {
        this.#worker.terminate();
        this.#stopResolve = undefined;
        resolve();
      }, STOP_TIMEOUT_MS);
      this.#post({ type: 'stop' });
    });
    this.#listeners.clear();
  }

  #post(command: WorkerCommand): void {
    if (!this.#stopped || command.type === 'stop') {
      this.#worker.postMessage(command);
    }
  }

  #handleEvent(event: WorkerEvent): void {
    if (event.type === 'ready') {
      this.#localPeerId = event.localPeerId;
      this.#started = true;
      this.#startResolve?.();
      this.#startResolve = undefined;
      this.#startReject = undefined;
      return;
    }
    if (event.type === 'observation') {
      this.#observations.push(event.observation);
      if (this.#observations.length > 2_048) this.#observations.shift();
      for (const listener of this.#listeners) listener(event.observation);
      return;
    }
    if (event.type === 'error') {
      this.#startReject?.(new Error(event.message));
      return;
    }
    this.#stopResolve?.();
    this.#stopResolve = undefined;
  }
}
