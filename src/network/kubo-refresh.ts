/**
 * A refresh loop that is inert until explicitly started by the user. Keeping
 * this separate from the RPC client makes the local-daemon trust boundary
 * obvious and lets the browser tests exercise the timing contract directly.
 */
export class KuboRefreshScheduler {
  readonly #refresh: () => Promise<boolean>;
  readonly #intervalMs: number;
  #timer?: ReturnType<typeof globalThis.setTimeout>;
  #active = false;

  constructor(refresh: () => Promise<boolean>, intervalMs = 15_000) {
    if (typeof refresh !== 'function') {
      throw new TypeError('refresh must be a function');
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new TypeError('intervalMs must be a positive finite number');
    }
    this.#refresh = refresh;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#schedule();
  }

  stop(): void {
    this.#active = false;
    if (this.#timer !== undefined) {
      globalThis.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #schedule(): void {
    if (!this.#active || this.#timer !== undefined) return;
    this.#timer = globalThis.setTimeout(() => {
      this.#timer = undefined;
      void this.#run();
    }, this.#intervalMs);
  }

  async #run(): Promise<void> {
    if (!this.#active) return;
    let shouldContinue = false;
    try {
      shouldContinue = await this.#refresh();
    } catch {
      shouldContinue = false;
    }
    if (!this.#active) return;
    if (!shouldContinue) {
      this.stop();
      return;
    }
    this.#schedule();
  }
}
