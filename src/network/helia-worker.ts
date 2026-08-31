import { type HeliaObserver, startHeliaObserver } from './helia-observer';
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

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerCommand>) => void) | null;
  postMessage(message: WorkerEvent): void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;
let observer: HeliaObserver | undefined;
let unsubscribe: (() => void) | undefined;
let stopping = false;

scope.onmessage = (event): void => {
  void handleCommand(event.data);
};

async function handleCommand(command: WorkerCommand): Promise<void> {
  if (command.type === 'stop') {
    stopping = true;
    unsubscribe?.();
    unsubscribe = undefined;
    await observer?.stop();
    observer = undefined;
    scope.postMessage({ type: 'stopped' });
    scope.close();
    return;
  }

  try {
    if (command.type === 'retry' && observer !== undefined) {
      await observer.retry();
    } else if (observer === undefined) {
      observer = await startHeliaObserver();
      unsubscribe = observer.subscribe((observation) => {
        if (!stopping) scope.postMessage({ type: 'observation', observation });
      });
    }

    if (observer === undefined || stopping) return;
    scope.postMessage({ type: 'ready', localPeerId: observer.localPeerId });
    for (const observation of observer.snapshot()) {
      scope.postMessage({ type: 'observation', observation });
    }
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Helia worker failed',
    });
  }
}
