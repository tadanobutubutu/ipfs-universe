import type { PeerRecord, PeerState, PeerStatus } from '../network/peer-types';
import type { PeerAnalytics } from '../wasm/load-wasm';
import { renderPeerList } from './peer-list';

type NetworkTone = 'error' | 'loading' | 'online';
type MotionListener = (paused: boolean) => void;

export class AppShell {
  readonly #canvas = requiredElement<HTMLCanvasElement>('universe-canvas');
  readonly #sceneFallback = requiredElement<HTMLElement>('scene-fallback');
  readonly #motionButton = requiredElement<HTMLButtonElement>('motion-toggle');
  readonly #peerButton = requiredElement<HTMLButtonElement>(
    'peer-explorer-button',
  );
  readonly #peerCount = requiredElement<HTMLElement>('header-peer-count');
  readonly #dialog = requiredElement<HTMLDialogElement>('peer-dialog');
  readonly #dialogClose =
    requiredElement<HTMLButtonElement>('peer-dialog-close');
  readonly #peerList = requiredElement<HTMLOListElement>('peer-list');
  readonly #peerEmpty = requiredElement<HTMLElement>('peer-empty');
  readonly #peerSearch = requiredElement<HTMLInputElement>('peer-search');
  readonly #peerFilter = requiredElement<HTMLSelectElement>('peer-filter');
  readonly #peerResultCount =
    requiredElement<HTMLOutputElement>('peer-result-count');
  readonly #peerSummary = requiredElement<HTMLElement>('peer-summary');
  readonly #networkStatus = requiredElement<HTMLElement>('network-status');
  readonly #networkBeacon = requiredSelector<HTMLElement>(
    '.node-status__beacon',
  );
  readonly #localPeerId = requiredElement<HTMLElement>('local-peer-id');
  readonly #retryButton = requiredElement<HTMLButtonElement>('network-retry');
  readonly #connectedMetric = requiredElement<HTMLElement>('metric-connected');
  readonly #observedMetric = requiredElement<HTMLElement>('metric-observed');
  readonly #latencyMetric = requiredElement<HTMLElement>('metric-latency');
  readonly #latencySamples = requiredElement<HTMLElement>(
    'metric-latency-samples',
  );
  readonly #p95Metric = requiredElement<HTMLElement>('metric-p95');
  readonly #historyCount = requiredElement<HTMLElement>('history-count');
  readonly #historyClear = requiredElement<HTMLButtonElement>('history-clear');
  readonly #kuboProbe = requiredElement<HTMLButtonElement>('kubo-probe');
  readonly #kuboStatus = requiredElement<HTMLElement>('kubo-status');
  readonly #liveRegion = requiredElement<HTMLElement>('aggregate-live');
  readonly #nodeTooltip = requiredElement<HTMLElement>('node-tooltip');
  readonly #nodeTooltipPeer = requiredElement<HTMLElement>('node-tip-peer');
  readonly #nodeTooltipState = requiredElement<HTMLElement>('node-tip-state');
  readonly #nodeTooltipLatency =
    requiredElement<HTMLElement>('node-tip-latency');
  readonly #nodeTooltipDirection =
    requiredElement<HTMLElement>('node-tip-direction');
  readonly #nodeTooltipTransport =
    requiredElement<HTMLElement>('node-tip-transport');
  readonly #nodeTooltipProtocols =
    requiredElement<HTMLElement>('node-tip-protocols');
  readonly #nodeTooltipAgent = requiredElement<HTMLElement>('node-tip-agent');
  readonly #nodeTooltipProtocol = requiredElement<HTMLElement>(
    'node-tip-protocol-version',
  );
  readonly #nodeTooltipAddresses =
    requiredElement<HTMLElement>('node-tip-addresses');
  readonly #nodeTooltipRelay = requiredElement<HTMLElement>('node-tip-relay');
  readonly #nodeTooltipSource = requiredElement<HTMLElement>('node-tip-source');
  readonly #headerNetworkState = requiredElement<HTMLElement>(
    'header-network-state',
  );
  readonly #headerNetworkDot = requiredSelector<HTMLElement>(
    '.connection-chip__dot',
  );
  readonly #motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  readonly #motionListeners = new Set<MotionListener>();
  #paused = this.#motionMedia.matches;
  #manualMotionChoice = false;
  #retryListener?: () => void;
  #clearHistoryListener?: () => void;
  #kuboProbeListener?: () => void;
  #announcementTimer?: number;
  #pendingAnnouncement = '';
  #lastAnnouncement = '';
  #currentPeers: readonly PeerRecord[] = [];
  #tooltipSignature = '';

  constructor() {
    this.#setMotionState(this.#paused);
    this.#motionButton.addEventListener('click', () => {
      this.#manualMotionChoice = true;
      this.#setMotionState(!this.#paused);
    });
    this.#motionMedia.addEventListener('change', ({ matches }) => {
      if (!this.#manualMotionChoice) {
        this.#setMotionState(matches);
      }
    });
    this.#peerButton.addEventListener('click', () => {
      if (!this.#dialog.open) {
        this.#dialog.showModal();
        this.#renderFilteredPeers();
      }
    });
    this.#dialogClose.addEventListener('click', () => this.#dialog.close());
    this.#retryButton.addEventListener('click', () => this.#retryListener?.());
    this.#peerSearch.addEventListener('input', () =>
      this.#renderFilteredPeers(),
    );
    this.#peerFilter.addEventListener('change', () =>
      this.#renderFilteredPeers(),
    );
    this.#historyClear.addEventListener('click', () =>
      this.#clearHistoryListener?.(),
    );
    this.#kuboProbe.addEventListener('click', () =>
      this.#kuboProbeListener?.(),
    );
  }

  get motionPaused(): boolean {
    return this.#paused;
  }

  onMotionChange(listener: MotionListener): () => void {
    this.#motionListeners.add(listener);
    listener(this.#paused);
    return () => this.#motionListeners.delete(listener);
  }

  onRetry(listener: () => void): void {
    this.#retryListener = listener;
  }

  onClearHistory(listener: () => void): void {
    this.#clearHistoryListener = listener;
  }

  onKuboProbe(listener: () => void): void {
    this.#kuboProbeListener = listener;
  }

  setKuboStatus(message: string, busy = false): void {
    this.#kuboStatus.textContent = message;
    this.#kuboStatus.dataset.visible = 'true';
    this.#kuboStatus.removeAttribute('aria-hidden');
    this.#kuboProbe.disabled = busy;
    this.#kuboProbe.dataset.busy = busy ? 'true' : 'false';
    this.#kuboProbe.setAttribute(
      'aria-label',
      busy ? 'Reading local Kubo daemon' : 'Read local Kubo daemon',
    );
  }

  showNodeDetails(
    peer: PeerRecord | undefined,
    x = 0,
    y = 0,
    pinned = false,
  ): void {
    if (peer === undefined) {
      this.#nodeTooltip.hidden = true;
      this.#tooltipSignature = '';
      return;
    }
    const signature = `${peer.peerId}|${peer.status}|${peer.source ?? ''}|${peer.latencyMs ?? ''}|${peer.direction ?? ''}|${peer.transport ?? ''}|${peer.agentVersion ?? ''}|${peer.protocolVersion ?? ''}|${peer.addressCount ?? ''}|${peer.relayPeerId ?? ''}|${peer.protocols?.join(',') ?? ''}`;
    if (signature !== this.#tooltipSignature) {
      this.#tooltipSignature = signature;
      this.#nodeTooltipPeer.textContent = shortPeerId(peer.peerId);
      this.#nodeTooltipPeer.title = peer.peerId;
      this.#nodeTooltipState.textContent = statusLabel(peer.status);
      this.#nodeTooltipLatency.textContent =
        peer.latencyMs === undefined
          ? 'unmeasured'
          : `${Math.round(peer.latencyMs)} ms`;
      this.#nodeTooltipDirection.textContent = peer.direction ?? 'not observed';
      this.#nodeTooltipTransport.textContent = peer.transport ?? 'not observed';
      this.#nodeTooltipProtocols.textContent = peer.protocols?.length
        ? peer.protocols.join(', ')
        : 'not observed';
      this.#nodeTooltipAgent.textContent = peer.agentVersion ?? 'not observed';
      this.#nodeTooltipProtocol.textContent =
        peer.protocolVersion ?? 'not observed';
      this.#nodeTooltipAddresses.textContent =
        peer.addressCount === undefined
          ? 'not observed'
          : `${peer.addressCount}`;
      this.#nodeTooltipRelay.textContent =
        peer.relayPeerId === undefined
          ? 'not observed'
          : shortPeerId(peer.relayPeerId);
      this.#nodeTooltipRelay.title = peer.relayPeerId ?? '';
      this.#nodeTooltipSource.textContent =
        peer.source === 'kubo' ? 'local Kubo' : 'browser Helia';
    }
    this.#nodeTooltip.dataset.pinned = pinned ? 'true' : 'false';
    this.#nodeTooltip.style.left = `${x}px`;
    this.#nodeTooltip.style.top = `${y}px`;
    this.#nodeTooltip.hidden = false;
    this.#placeTooltip(x, y);
  }

  #placeTooltip(anchorX: number, anchorY: number): void {
    // The first call can happen in the same task that removes `hidden`, before
    // layout has produced an offset box. Use the computed width as a safe
    // fallback so a narrow viewport never receives an unclamped card.
    const computed = getComputedStyle(this.#nodeTooltip);
    const width =
      this.#nodeTooltip.offsetWidth ||
      Number.parseFloat(computed.width) ||
      Math.min(320, window.innerWidth - 16);
    const height =
      this.#nodeTooltip.offsetHeight ||
      Number.parseFloat(computed.height) ||
      220;
    const gap = 14;
    const rightCandidate = anchorX + gap;
    const leftCandidate = anchorX - gap - width;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    // Prefer the node's right side, but flip to the left before clamping so
    // the card remains fully readable on narrow screens.
    const left =
      rightCandidate + width <= window.innerWidth - 8
        ? rightCandidate
        : leftCandidate >= 8
          ? leftCandidate
          : Math.min(Math.max(8, rightCandidate), maxLeft);
    const top = Math.min(
      Math.max(height / 2 + 8, anchorY),
      Math.max(height / 2 + 8, window.innerHeight - height / 2 - 8),
    );
    this.#nodeTooltip.style.left = `${left}px`;
    this.#nodeTooltip.style.top = `${top}px`;
    const edgeX = anchorX < left ? left : left + width;
    const edgeY = top;
    const deltaX = anchorX - edgeX;
    const deltaY = anchorY - edgeY;
    this.#nodeTooltip.style.setProperty(
      '--anchor-line-x',
      `${anchorX < left ? 0 : width}px`,
    );
    this.#nodeTooltip.style.setProperty('--anchor-line-y', `${height / 2}px`);
    this.#nodeTooltip.style.setProperty(
      '--anchor-line-length',
      `${Math.hypot(deltaX, deltaY)}px`,
    );
    this.#nodeTooltip.style.setProperty(
      '--anchor-line-angle',
      `${Math.atan2(deltaY, deltaX)}rad`,
    );
    this.#nodeTooltip.style.setProperty(
      '--anchor-line-width',
      `${Math.min(2, 0.85 + Math.hypot(deltaX, deltaY) / 220)}px`,
    );
  }

  setStoredPeerCount(count: number): void {
    this.#historyCount.textContent = `${formatInteger(count)} public peer ${count === 1 ? 'ID' : 'IDs'} retained from previous observations.`;
  }

  setStoredPeerUnavailable(): void {
    this.#historyCount.textContent =
      'Local history is unavailable in this browser context.';
  }

  markSceneReady(): void {
    document.documentElement.dataset.scene = 'ready';
    this.#sceneFallback.hidden = true;
    this.#sceneFallback.setAttribute('aria-hidden', 'true');
    this.#canvas.removeAttribute('aria-hidden');
    this.#canvas.tabIndex = 0;
  }

  markSceneUnavailable(): void {
    document.documentElement.dataset.scene = 'unavailable';
    this.#sceneFallback.hidden = false;
    this.#sceneFallback.removeAttribute('aria-hidden');
    this.#canvas.setAttribute('aria-hidden', 'true');
    this.#canvas.removeAttribute('tabindex');
  }

  setNetworkState(
    tone: NetworkTone,
    message: string,
    localPeerId?: string,
  ): void {
    this.#networkBeacon.dataset.tone = tone;
    this.#headerNetworkDot.dataset.tone = tone;
    this.#networkStatus.textContent = message;
    this.#headerNetworkState.textContent =
      tone === 'online' ? 'Live' : tone === 'error' ? 'Offline' : 'Connecting';
    this.#retryButton.hidden = tone !== 'error';
    if (localPeerId !== undefined) {
      this.#localPeerId.textContent = shortPeerId(localPeerId);
      this.#localPeerId.title = localPeerId;
    }
  }

  updatePeerState(state: PeerState, analytics?: PeerAnalytics): void {
    const peers = [...state.peers.values()];
    this.#currentPeers = peers;
    this.#connectedMetric.textContent = formatInteger(state.connectedCount);
    this.#connectedMetric.parentElement?.setAttribute(
      'data-tone',
      state.connectedCount === 0 ? 'empty' : 'ok',
    );
    this.#observedMetric.textContent = formatInteger(state.totalCount);
    this.#peerCount.textContent = formatInteger(state.connectedCount);
    this.#peerButton.setAttribute(
      'aria-label',
      `Open peer explorer, ${formatInteger(state.connectedCount)} connected peers`,
    );
    this.#latencyMetric.textContent =
      analytics === undefined || analytics.latencySamples === 0
        ? '—'
        : `${formatInteger(analytics.latencyP50Ms)} ms`;
    this.#p95Metric.textContent =
      analytics === undefined || analytics.latencySamples === 0
        ? '—'
        : `${formatInteger(analytics.latencyP95Ms)} ms`;
    const measured = analytics?.latencySamples ?? 0;
    const coverage = analytics?.measurementCoverage ?? 0;
    this.#latencySamples.textContent = `${formatInteger(measured)} / ${formatInteger(state.connectedCount)} live pings${state.connectedCount === 0 ? '' : ` · ${Math.round(coverage)}% coverage`}`;
    this.#peerSummary.textContent = `${formatInteger(state.connectedCount)} connected, ${formatInteger(state.discoveredCount)} discovered, ${formatInteger(state.disconnectedCount)} disconnected in the bounded active view.`;
    this.#renderFilteredPeers();
    const connectedBucket =
      state.connectedCount < 5
        ? state.connectedCount
        : Math.round(state.connectedCount / 5) * 5;
    this.#queueAnnouncement(
      `${connectedBucket >= 5 ? 'About ' : ''}${connectedBucket} peers connected. ${state.totalCount} peers tracked in the active view.`,
    );
  }

  #renderFilteredPeers(): void {
    if (!this.#dialog.open) {
      return;
    }
    const query = this.#peerSearch.value.trim().toLowerCase();
    const filter = parsePeerFilter(this.#peerFilter.value);
    const filtered = this.#currentPeers.filter(
      (peer) =>
        (filter === undefined || peer.status === filter) &&
        (query === '' || peer.peerId.toLowerCase().includes(query)),
    );
    renderPeerList(this.#peerList, this.#peerEmpty, filtered);
    this.#peerResultCount.textContent = `${formatInteger(filtered.length)} shown`;
    this.#peerEmpty.textContent =
      this.#currentPeers.length === 0
        ? 'No browser-reachable peers have been observed yet. Discovery can take a moment and depends on the transports available to this browser.'
        : 'No observed peer matches the current search and state filter.';
  }

  #setMotionState(paused: boolean): void {
    this.#paused = paused;
    document.documentElement.dataset.motion = paused ? 'paused' : 'running';
    this.#motionButton.setAttribute('aria-pressed', String(paused));
    this.#motionButton.setAttribute(
      'aria-label',
      paused ? 'Resume motion' : 'Pause motion',
    );
    for (const listener of this.#motionListeners) {
      listener(paused);
    }
  }

  #queueAnnouncement(message: string): void {
    this.#pendingAnnouncement = message;
    if (this.#announcementTimer !== undefined) {
      return;
    }
    this.#announcementTimer = window.setTimeout(() => {
      if (this.#pendingAnnouncement !== this.#lastAnnouncement) {
        this.#liveRegion.textContent = this.#pendingAnnouncement;
        this.#lastAnnouncement = this.#pendingAnnouncement;
      }
      this.#announcementTimer = undefined;
    }, 10_000);
  }
}

function statusLabel(status: PeerStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function parsePeerFilter(value: string): PeerStatus | undefined {
  switch (value) {
    case 'all':
      return undefined;
    case 'connected':
    case 'discovered':
    case 'disconnected':
      return value;
    default:
      return undefined;
  }
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Required element #${id} is missing`);
  }
  return element as T;
}

function requiredSelector<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector(selector);
  if (element === null) {
    throw new Error(`Required element ${selector} is missing`);
  }
  return element as T;
}

function shortPeerId(peerId: string): string {
  if (peerId.length <= 26) {
    return peerId;
  }
  return `${peerId.slice(0, 15)}…${peerId.slice(-7)}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(
    value,
  );
}
