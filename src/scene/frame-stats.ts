/** Return a monotonic frame interval in milliseconds for telemetry. */
export function frameElapsedMs(
  frameTime: number,
  previousTime: number,
): number {
  const elapsed = frameTime - previousTime;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

/** Keep physics integration bounded while preserving raw telemetry separately. */
export function simulationDeltaSeconds(frameMs: number, maxMs = 50): number {
  const safeMs = Number.isFinite(frameMs) ? Math.max(0, frameMs) : 0;
  const safeMaxMs = Number.isFinite(maxMs) ? Math.max(0, maxMs) : 50;
  return Math.min(safeMs, safeMaxMs) / 1_000;
}
