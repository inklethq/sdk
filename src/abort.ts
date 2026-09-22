import { ConfigurationError, OperationAbortedError } from "./errors.js";

/**
 * The longest delay a JavaScript timer can hold. A longer one does not wait
 * longer; it fires at once, so a timeout above this would silently become a
 * timeout of zero.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Validate a per-request timeout, which unlike the waiting helpers' own
 * `timeoutMs` is not capped at half an hour: a slow upload or a caller that
 * wants to wait on a single read for a long time is within its rights.
 */
export function validateTimeout(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TIMER_MS
  ) {
    throw new ConfigurationError(
      `${name} must be an integer number of milliseconds between 1 and ${MAX_TIMER_MS}.`,
    );
  }
  return value;
}

export function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) {
    throw new OperationAbortedError(message, { cause: signal.reason });
  }
}

export function delay(
  milliseconds: number,
  signal: AbortSignal | undefined,
  message = "The wait was aborted.",
): Promise<void> {
  throwIfAborted(signal, message);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new OperationAbortedError(message, { cause: signal?.reason }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface LinkedSignal {
  signal: AbortSignal | undefined;
  /** Detach from the source signals once the linked work is over. */
  release(): void;
}

const NOTHING_TO_RELEASE = (): void => undefined;

/**
 * One signal that aborts as soon as any of `signals` does, with that signal's
 * reason.
 *
 * `AbortSignal.any` does this natively and lets the runtime drop the link
 * once nothing references the result; it exists on Node.js 20.3+ and current
 * browsers. Elsewhere a controller is wired to each source by hand, and those
 * listeners stay on the sources until `release()` — which matters when a
 * source is a caller's long-lived signal shared by many requests.
 */
export function linkSignals(
  signals: readonly (AbortSignal | undefined)[],
): LinkedSignal {
  const sources = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (sources.length <= 1) {
    return { signal: sources[0], release: NOTHING_TO_RELEASE };
  }

  const native = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal })
    .any;
  if (typeof native === "function") {
    return { signal: native.call(AbortSignal, sources), release: NOTHING_TO_RELEASE };
  }

  const controller = new AbortController();
  const detach: (() => void)[] = [];
  const release = () => {
    for (const remove of detach.splice(0)) {
      remove();
    }
  };
  for (const source of sources) {
    if (source.aborted) {
      release();
      controller.abort(source.reason);
      return { signal: controller.signal, release: NOTHING_TO_RELEASE };
    }
    const onAbort = () => {
      release();
      controller.abort(source.reason);
    };
    source.addEventListener("abort", onAbort, { once: true });
    detach.push(() => source.removeEventListener("abort", onAbort));
  }
  return { signal: controller.signal, release };
}

/**
 * A caller's signal with a timer of the SDK's own linked in.
 *
 * `signal` aborts when either fires, so it can go straight to `fetch` or to a
 * wait. `timedOut` tells the two apart afterwards: it is only set when the
 * timer is what aborted the signal, so a caller's abort that lands first still
 * reads as an abort.
 */
export class Deadline {
  readonly signal: AbortSignal;
  #timedOut = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #release: () => void;

  constructor(signal: AbortSignal | undefined, timeoutMs: number) {
    const timer = new AbortController();
    const linked = linkSignals([signal, timer.signal]);
    this.signal = linked.signal ?? timer.signal;
    this.#release = linked.release;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.signal.aborted) {
        this.#timedOut = true;
        timer.abort();
      }
    }, timeoutMs);
  }

  get timedOut(): boolean {
    return this.#timedOut;
  }

  /**
   * Stop the clock without letting go of the caller's signal. A streamed
   * response is only timed until its headers arrive; the body it goes on
   * reading still has to stop when the caller aborts.
   */
  stopTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Stop the clock and detach from the caller's signal. */
  dispose(): void {
    this.stopTimer();
    this.#release();
  }
}
