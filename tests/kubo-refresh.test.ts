import { afterEach, describe, expect, it, vi } from 'vitest';

import { KuboRefreshScheduler } from '../src/network/kubo-refresh';

describe('explicit Kubo refresh scheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes only after the caller opts in and stops after a failed refresh', async () => {
    vi.useFakeTimers();
    const refresh = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false);
    const scheduler = new KuboRefreshScheduler(refresh, 15_000);

    expect(refresh).not.toHaveBeenCalled();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not create duplicate timers when start is called twice', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const scheduler = new KuboRefreshScheduler(refresh, 15_000);

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
