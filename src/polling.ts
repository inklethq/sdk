import { Deadline, delay, throwIfAborted } from "./abort.js";
import {
  ApiError,
  NetworkError,
  OperationAbortedError,
  RateLimitError,
} from "./errors.js";

/**
 * Statuses that say "not right now" rather than "no": the request timed out
 * on the way in, the caller is being throttled, or something between the SDK
 * and inklet failed for a moment.
 */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

/**
 * Transient failures of one idempotent read that a polling loop absorbs
 * before giving up, counted in a row: a read that succeeds starts the count
 * again. The fourth consecutive failure is thrown.
 */
export const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/** First retry delay for reads that have no poll interval of their own. */
export const DEFAULT_RETRY_DELAY_MS = 500;

/** Longest the SDK backs off on its own between two attempts. */
export const MAX_RETRY_DELAY_MS = 30_000;

/**
 * The longest `Retry-After` the SDK sleeps through. A server asking for more
 * than this is asking the caller to come back later rather than to retry, so
 * its error is thrown with `retryAfterMs` set instead of being waited out
 * inside a call the caller thinks is live.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Whether trying the same idempotent request again could succeed.
 *
 * A connection failure or a timeout qualifies, and so do the transient HTTP
 * statuses — except `429 quota_exceeded`, which shares its status with rate
 * limiting but is a spent plan allowance that no amount of retrying clears.
 * Aborts never qualify: they are the caller's decision.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof OperationAbortedError) {
    return false;
  }
  if (error instanceof NetworkError) {
    return true;
  }
  if (error instanceof RateLimitError) {
    return error.code !== "quota_exceeded";
  }
  return (
    error instanceof ApiError &&
    error.status !== undefined &&
    TRANSIENT_STATUSES.has(error.status)
  );
}

/**
 * Read `Retry-After` (RFC 9110 §10.2.3) as milliseconds from `now`: either
 * delta-seconds or an HTTP-date. A date in the past means "now" rather than
 * something negative. `null` when the header is absent or unreadable.
 */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
  }
  // Every HTTP-date format names a day or a month. Requiring a letter keeps
  // Date.parse, which reads "1" as 2001 and "-5" as 5 BC, away from junk.
  if (!/[a-z]/i.test(trimmed)) {
    return null;
  }
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * How long to wait before retry number `attempt` (0 for the first): doubling
 * from `baseMs` up to `capMs`, and never sooner than a `Retry-After` the error
 * carries. `null` when that `Retry-After` is longer than the SDK will wait,
 * which the caller treats as "stop retrying".
 */
export function retryDelay(
  error: unknown,
  baseMs: number,
  attempt: number,
  capMs: number = MAX_RETRY_DELAY_MS,
): number | null {
  const backoff = Math.min(baseMs * 2 ** attempt, capMs);
  const retryAfter =
    error instanceof RateLimitError || error instanceof ApiError
      ? error.retryAfterMs
      : null;
  if (retryAfter === null) {
    return backoff;
  }
  return retryAfter > MAX_RETRY_AFTER_MS ? null : Math.max(backoff, retryAfter);
}

export interface RetryReadOptions {
  signal: AbortSignal | undefined;
  abortMessage: string;
  /** First retry delay; doubled for each further one. */
  baseDelayMs: number;
  /** Told about each failure that is about to be retried. */
  onRetry?: (error: unknown) => void;
}

/**
 * Run one idempotent read, retrying it through transient failures.
 *
 * Only reads go through here — `GET`s whose repetition changes nothing. Up to
 * `MAX_CONSECUTIVE_POLL_FAILURES` failures in a row are retried with backoff;
 * the next one, any failure that is not transient, and a `Retry-After` longer
 * than `MAX_RETRY_AFTER_MS` are thrown as they are.
 */
export async function readWithRetry<T>(
  read: () => Promise<T>,
  options: RetryReadOptions,
): Promise<T> {
  for (let failures = 0; ; failures += 1) {
    try {
      return await read();
    } catch (error) {
      if (failures >= MAX_CONSECUTIVE_POLL_FAILURES || !isTransient(error)) {
        throw error;
      }
      throwIfAborted(options.signal, options.abortMessage);
      const wait = retryDelay(error, options.baseDelayMs, failures);
      if (wait === null) {
        throw error;
      }
      options.onRetry?.(error);
      await delay(wait, options.signal, options.abortMessage);
    }
  }
}

export interface PollOptions<T, R> {
  /** The caller's own signal. */
  signal: AbortSignal | undefined;
  /** How long the whole wait may take. */
  timeoutMs: number;
  pollIntervalMs: number;
  abortMessage: string;
  /** A value the caller already holds, checked before the first read. */
  initial?: T | undefined;
  /** One read. The signal it is given aborts at the caller's abort or at the deadline. */
  read: (signal: AbortSignal) => Promise<T>;
  /** The result once `value` is final; `undefined` to keep waiting. May throw. */
  settle: (value: T) => R | undefined;
  /**
   * The error for running out of time. `last` is the latest value read, if
   * any; `cause` is the failure the deadline interrupted, if any.
   */
  timeout: (last: T | undefined, cause: unknown) => Error;
}

/**
 * The loop behind every `waitUntil*`: read, settle or sleep, read again.
 *
 * `timeoutMs` is a deadline for the whole wait, not only for the gaps between
 * reads. A read still in flight when it passes is cancelled rather than left
 * to run out its own request timeout, and so is a backoff after a transient
 * failure; either way the wait ends with `timeout()`, which is handed the
 * failure being retried, if any, as `cause`. A caller's abort cancels the
 * same way and is reported as `OperationAbortedError` with `abortMessage`,
 * whatever it interrupted.
 *
 * A value `settle` does not recognise — a state added to the backend after
 * this SDK shipped — is not final, so the loop keeps reading until the value
 * settles, the deadline passes, or the caller aborts.
 */
export async function pollUntil<T, R>(options: PollOptions<T, R>): Promise<R> {
  const { signal, timeoutMs, pollIntervalMs, abortMessage } = options;
  const startedAt = Date.now();
  const deadline = new Deadline(signal, timeoutMs);
  let last = options.initial;
  let current = options.initial;
  // The transient failure being retried, if the loop is in the middle of one.
  let retrying: unknown;

  try {
    while (true) {
      throwIfAborted(signal, abortMessage);
      if (current === undefined) {
        current = await readWithRetry(() => options.read(deadline.signal), {
          signal: deadline.signal,
          abortMessage,
          baseDelayMs: pollIntervalMs,
          onRetry: (error) => {
            retrying = error;
          },
        });
        last = current;
        retrying = undefined;
      }
      const settled = options.settle(current);
      if (settled !== undefined) {
        return settled;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw options.timeout(last, undefined);
      }
      await delay(
        Math.min(pollIntervalMs, timeoutMs - elapsed),
        deadline.signal,
        abortMessage,
      );
      current = undefined;
    }
  } catch (error) {
    // Both the caller's signal and the deadline surface from a read or a
    // sleep as an abort; which of the two it was decides what the caller sees.
    if (error instanceof OperationAbortedError) {
      if (signal?.aborted) {
        throw new OperationAbortedError(abortMessage, { cause: signal.reason });
      }
      if (deadline.timedOut) {
        throw options.timeout(last, retrying);
      }
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}
