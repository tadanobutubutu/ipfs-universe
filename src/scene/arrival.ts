export const ARRIVAL_PHASES = [
  'discovery',
  'ping',
  'link',
  'settle',
  'reframe',
  'settled',
] as const;

export type ArrivalPhase = (typeof ARRIVAL_PHASES)[number];

export interface ArrivalState {
  readonly peerId: string;
  readonly phase: ArrivalPhase;
  readonly elapsedMs: number;
  readonly progress: number;
}

const ARRIVAL_DURATION_MS = 1_100;

export function createArrival(peerId: string): ArrivalState {
  return { peerId, phase: 'discovery', elapsedMs: 0, progress: 0 };
}

export function advanceArrival(
  state: ArrivalState,
  deltaMs: number,
  reducedMotion: boolean,
): ArrivalState {
  if (reducedMotion || state.phase === 'settled') {
    return {
      ...state,
      phase: 'settled',
      elapsedMs: ARRIVAL_DURATION_MS,
      progress: 1,
    };
  }

  const elapsedMs = Math.min(
    ARRIVAL_DURATION_MS,
    Math.max(0, state.elapsedMs + (Number.isFinite(deltaMs) ? deltaMs : 0)),
  );
  return {
    ...state,
    phase: phaseAt(elapsedMs),
    elapsedMs,
    progress: elapsedMs / ARRIVAL_DURATION_MS,
  };
}

export function arrivalScale(state: ArrivalState): number {
  if (state.phase === 'settled') return 1;
  const eased = state.progress * state.progress * (3 - 2 * state.progress);
  switch (state.phase) {
    case 'discovery':
      return 0.4 + eased * 0.18;
    case 'ping':
      return 0.58 + eased * 0.2;
    case 'link':
      return 0.78 + eased * 0.22;
    case 'settle':
      return 1.08 - eased * 0.08;
    case 'reframe':
      return 1.04 - eased * 0.04;
  }
}

/** Progress of an evidence-backed line reveal for this arriving peer. */
export function arrivalLinkProgress(state: ArrivalState): number {
  if (state.phase === 'discovery' || state.phase === 'ping') return 0;
  if (state.phase === 'settled') return 1;
  const linkStart = 420 / ARRIVAL_DURATION_MS;
  const linkEnd = 760 / ARRIVAL_DURATION_MS;
  const progress = (state.progress - linkStart) / (linkEnd - linkStart);
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped * clamped * (3 - 2 * clamped);
}

function phaseAt(elapsedMs: number): ArrivalPhase {
  if (elapsedMs < 180) return 'discovery';
  if (elapsedMs < 420) return 'ping';
  if (elapsedMs < 760) return 'link';
  if (elapsedMs < 1_000) return 'settle';
  if (elapsedMs < ARRIVAL_DURATION_MS) return 'reframe';
  return 'settled';
}
