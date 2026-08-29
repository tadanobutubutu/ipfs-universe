import { MAX_TRACKED_PEERS } from '../network/peer-reducer';
import type { PeerStatus, PersistedPeer } from '../network/peer-types';

const DB_NAME = 'ipfs-universe-peers';
const STORE_NAME = 'peer-history';
const DB_VERSION = 2;
const LAST_SEEN_INDEX = 'lastSeenAt';
const VALID_STATUSES: ReadonlySet<PeerStatus> = new Set([
  'connected',
  'disconnected',
  'discovered',
]);
let databasePromise: Promise<IDBDatabase> | undefined;

export async function savePeer(peer: PersistedPeer): Promise<void> {
  await savePeers([peer]);
}

export async function savePeers(
  peers: readonly PersistedPeer[],
): Promise<void> {
  if (peers.length === 0) {
    return;
  }
  const publicPeers = peers.map(sanitizePeer);
  const db = await peerDatabase();
  await transactionComplete(db, 'readwrite', (store) => {
    for (const peer of publicPeers) {
      store.put(peer);
    }
    trimOldestPeers(store, MAX_TRACKED_PEERS);
  });
}

export async function getPeerCount(): Promise<number> {
  const db = await peerDatabase();
  return new Promise<number>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function getAllPeers(): Promise<readonly PersistedPeer[]> {
  const db = await peerDatabase();
  const stored = await new Promise<unknown[]>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request: IDBRequest<unknown[]> = transaction
      .objectStore(STORE_NAME)
      .getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error);
  });

  return stored.flatMap((value) => {
    try {
      return [sanitizePeer(value)];
    } catch {
      return [];
    }
  });
}

export async function clearPeerHistory(): Promise<void> {
  const db = await peerDatabase();
  await transactionComplete(db, 'readwrite', (store) => store.clear());
}

export function closePeerHistory(): void {
  void databasePromise?.then((database) => database.close());
  databasePromise = undefined;
}

function peerDatabase(): Promise<IDBDatabase> {
  databasePromise ??= openPeerDatabase();
  return databasePromise;
}

async function openPeerDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction?.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: 'peerId' });
      if (store === undefined) {
        throw new Error('Peer history upgrade transaction is unavailable');
      }
      if (!store.indexNames.contains(LAST_SEEN_INDEX)) {
        store.createIndex(LAST_SEEN_INDEX, LAST_SEEN_INDEX);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Peer history database is blocked'));
  });
}

function trimOldestPeers(store: IDBObjectStore, maximum: number): void {
  const countRequest = store.count();
  countRequest.onsuccess = () => {
    let remaining = Math.max(0, countRequest.result - maximum);
    if (remaining === 0) {
      return;
    }

    const cursorRequest = store.index(LAST_SEEN_INDEX).openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor === null || remaining === 0) {
        return;
      }
      cursor.delete();
      remaining -= 1;
      cursor.continue();
    };
  };
}

async function transactionComplete(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);

    try {
      operation(transaction.objectStore(STORE_NAME));
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  });
}

function sanitizePeer(value: unknown): PersistedPeer {
  if (!isRecord(value)) {
    throw new TypeError('Persisted peer must be an object');
  }

  const { peerId, status, firstSeenAt, lastSeenAt, latencyMs } = value;
  if (
    typeof peerId !== 'string' ||
    peerId.trim() === '' ||
    peerId !== peerId.trim()
  ) {
    throw new TypeError('Persisted peerId is invalid');
  }
  if (typeof status !== 'string' || !isPeerStatus(status)) {
    throw new TypeError('Persisted peer status is invalid');
  }
  if (!isNonNegativeFiniteNumber(firstSeenAt)) {
    throw new TypeError('Persisted firstSeenAt is invalid');
  }
  if (!isNonNegativeFiniteNumber(lastSeenAt) || lastSeenAt < firstSeenAt) {
    throw new TypeError('Persisted lastSeenAt is invalid');
  }
  if (latencyMs !== undefined && !isNonNegativeFiniteNumber(latencyMs)) {
    throw new TypeError('Persisted latencyMs is invalid');
  }

  return {
    peerId,
    status,
    firstSeenAt,
    lastSeenAt,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPeerStatus(value: string): value is PeerStatus {
  return VALID_STATUSES.has(value as PeerStatus);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
