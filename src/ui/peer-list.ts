import type { PeerRecord } from '../network/peer-types';

const STATUS_ORDER: Record<PeerRecord['status'], number> = {
  connected: 0,
  discovered: 1,
  disconnected: 2,
};

let detailsSequence = 0;

export function renderPeerList(
  list: HTMLOListElement,
  emptyState: HTMLElement,
  peers: readonly PeerRecord[],
  now = Date.now(),
): void {
  const ordered = [...peers].sort(
    (left, right) =>
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
      right.lastSeenAt - left.lastSeenAt ||
      left.peerId.localeCompare(right.peerId),
  );
  const existing = new Map<string, HTMLLIElement>();
  for (const child of list.children) {
    if (child instanceof HTMLLIElement && child.dataset.peerId) {
      existing.set(child.dataset.peerId, child);
    }
  }

  const retainedPeerIds = new Set<string>();
  let insertionPoint = list.firstElementChild;
  for (const peer of ordered) {
    retainedPeerIds.add(peer.peerId);
    const item = existing.get(peer.peerId) ?? createPeerItem(peer);
    updatePeerItem(item, peer, now);

    if (item !== insertionPoint) {
      // Preserve the active element when a live latency/status update moves the
      // focused row. Chromium's moveBefore keeps focus and selection attached
      // to the existing element; insertBefore remains the compatible fallback.
      const movableList = list as HTMLOListElement & {
        moveBefore?: (element: Element, child?: Node | null) => void;
      };
      if (item.isConnected && typeof movableList.moveBefore === 'function') {
        movableList.moveBefore(item, insertionPoint);
      } else {
        list.insertBefore(item, insertionPoint);
      }
    }
    insertionPoint = item.nextElementSibling;
  }

  for (const [peerId, item] of existing) {
    if (retainedPeerIds.has(peerId)) {
      continue;
    }
    const containsFocus = item.contains(document.activeElement);
    item.remove();
    if (containsFocus) {
      list.tabIndex = -1;
      list.focus();
    }
  }

  emptyState.hidden = ordered.length > 0;
}

function createPeerItem(peer: PeerRecord): HTMLLIElement {
  const item = document.createElement('li');
  const button = document.createElement('button');
  const dot = document.createElement('span');
  const identity = document.createElement('span');
  const peerId = document.createElement('code');
  const state = document.createElement('span');
  const latency = document.createElement('span');
  const details = document.createElement('dl');
  const detailsId = `peer-details-${detailsSequence}`;
  detailsSequence += 1;

  item.className = 'peer-item';
  item.dataset.peerId = peer.peerId;
  button.className = 'peer-row';
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', detailsId);

  dot.className = 'peer-row__dot';
  dot.setAttribute('aria-hidden', 'true');
  identity.className = 'peer-row__identity';
  peerId.dataset.field = 'peer-id-short';
  state.dataset.field = 'state';
  identity.append(peerId, state);
  latency.className = 'peer-row__latency';
  latency.dataset.field = 'latency';
  button.append(dot, identity, latency);

  details.className = 'peer-details';
  details.id = detailsId;
  details.hidden = true;
  details.append(
    detail('Full peer ID', 'peer-id', peer.peerId),
    detail('State', 'status', statusLabel(peer.status)),
    detail('Direction', 'direction', peer.direction ?? 'Not observed'),
    detail('Transport', 'transport', peer.transport ?? 'Not observed'),
    detail('Protocols', 'protocols', peer.protocols?.join(', ') || 'Not observed'),
    detail('Agent', 'agent', peer.agentVersion ?? 'Not observed'),
    detail('Protocol version', 'protocol-version', peer.protocolVersion ?? 'Not observed'),
    detail('Addresses', 'addresses', peer.addressCount === undefined ? 'Not observed' : String(peer.addressCount)),
    detail('Source', 'source', peer.source === 'kubo' ? 'Local Kubo' : 'Browser Helia'),
    detail('Latency', 'latency-detail', latencyLabel(peer.latencyMs)),
    observedTimeDetail('Last observed', 'last-seen', peer.lastSeenAt),
  );

  button.addEventListener('click', () => {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    details.hidden = expanded;
    updateButtonLabelFromDataset(button);
  });

  item.append(button, details);
  return item;
}

function updatePeerItem(
  item: HTMLLIElement,
  peer: PeerRecord,
  now: number,
): void {
  item.dataset.peerId = peer.peerId;
  const button = requiredDescendant<HTMLButtonElement>(item, '.peer-row');
  button.dataset.status = peer.status;
  button.dataset.peerId = peer.peerId;
  button.dataset.latency =
    peer.latencyMs === undefined ? '' : String(peer.latencyMs);
  updateButtonLabel(button, peer.peerId, peer.status, peer.latencyMs);

  const shortIdentity = requiredField<HTMLElement>(item, 'peer-id-short');
  shortIdentity.textContent = shortPeerId(peer.peerId);
  shortIdentity.title = peer.peerId;
  requiredField<HTMLElement>(item, 'state').textContent =
    `${statusLabel(peer.status)} · ${relativeTime(peer.lastSeenAt, now)}`;
  requiredField<HTMLElement>(item, 'latency').textContent = latencyLabel(
    peer.latencyMs,
  );
  requiredField<HTMLElement>(item, 'peer-id').textContent = peer.peerId;
  requiredField<HTMLElement>(item, 'status').textContent = statusLabel(
    peer.status,
  );
  requiredField<HTMLElement>(item, 'direction').textContent =
    peer.direction ?? 'Not observed';
  requiredField<HTMLElement>(item, 'transport').textContent =
    peer.transport ?? 'Not observed';
  requiredField<HTMLElement>(item, 'protocols').textContent =
    peer.protocols?.join(', ') || 'Not observed';
  requiredField<HTMLElement>(item, 'agent').textContent =
    peer.agentVersion ?? 'Not observed';
  requiredField<HTMLElement>(item, 'protocol-version').textContent =
    peer.protocolVersion ?? 'Not observed';
  requiredField<HTMLElement>(item, 'addresses').textContent =
    peer.addressCount === undefined ? 'Not observed' : String(peer.addressCount);
  requiredField<HTMLElement>(item, 'source').textContent =
    peer.source === 'kubo' ? 'Local Kubo' : 'Browser Helia';
  requiredField<HTMLElement>(item, 'latency-detail').textContent = latencyLabel(
    peer.latencyMs,
  );
  updateObservedTime(
    requiredField<HTMLTimeElement>(item, 'last-seen'),
    peer.lastSeenAt,
  );
}

function updateButtonLabelFromDataset(button: HTMLButtonElement): void {
  const status = button.dataset.status;
  if (
    status !== 'connected' &&
    status !== 'discovered' &&
    status !== 'disconnected'
  ) {
    throw new Error('Peer row has an invalid status');
  }
  const rawLatency = button.dataset.latency;
  const parsedLatency = rawLatency ? Number(rawLatency) : undefined;
  updateButtonLabel(
    button,
    button.dataset.peerId ?? 'Unknown peer',
    status,
    parsedLatency,
  );
}

function updateButtonLabel(
  button: HTMLButtonElement,
  peerId: string,
  status: PeerRecord['status'],
  latencyMs: number | undefined,
): void {
  const expanded = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute(
    'aria-label',
    `${peerId}, ${statusLabel(status)}, ${latencyLabel(latencyMs)}. ${expanded ? 'Hide' : 'Show'} details`,
  );
}

function detail(
  label: string,
  field: string,
  value: string,
): HTMLDivElement {
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.dataset.field = field;
  description.textContent = value;
  wrapper.append(term, description);
  return wrapper;
}

function observedTimeDetail(
  label: string,
  field: string,
  observedAt: number,
): HTMLDivElement {
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  const time = document.createElement('time');
  term.textContent = label;
  time.dataset.field = field;
  updateObservedTime(time, observedAt);
  description.append(time);
  wrapper.append(term, description);
  return wrapper;
}

function updateObservedTime(time: HTMLTimeElement, observedAt: number): void {
  const date = new Date(observedAt);
  if (Number.isNaN(date.getTime())) {
    time.removeAttribute('datetime');
    time.textContent = 'Date unavailable';
    return;
  }
  time.dateTime = date.toISOString();
  time.textContent = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

function requiredDescendant<T extends HTMLElement>(
  root: HTMLElement,
  selector: string,
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Peer row is missing ${selector}`);
  }
  return element as T;
}

function requiredField<T extends HTMLElement>(
  root: HTMLElement,
  field: string,
): T {
  return requiredDescendant<T>(root, `[data-field="${field}"]`);
}

function shortPeerId(peerId: string): string {
  if (peerId.length <= 24) {
    return peerId;
  }
  return `${peerId.slice(0, 14)}…${peerId.slice(-7)}`;
}

function statusLabel(status: PeerRecord['status']): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'discovered':
      return 'Discovered';
    case 'disconnected':
      return 'Disconnected';
  }
}

function latencyLabel(latencyMs: number | undefined): string {
  return latencyMs === undefined ? 'Not measured' : `${Math.round(latencyMs)} ms`;
}

function relativeTime(observedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - observedAt) / 1_000));
  if (seconds < 5) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  return `${Math.floor(minutes / 60)}h ago`;
}
