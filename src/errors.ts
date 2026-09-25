export interface InkletErrorOptions {
  code: string;
  status?: number | undefined;
  requestId?: string | undefined;
  details?: Readonly<Record<string, unknown>> | undefined;
  idempotencyKey?: string | undefined;
  cause?: unknown;
}

/**
 * Base class for every error produced by the SDK.
 *
 * `requestId` can be passed to inklet support without exposing credentials.
 */
export class InkletError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  /**
   * The `Idempotency-Key` the failed call sent, including one the SDK
   * generated because the caller passed none. `undefined` for calls that send
   * no key.
   *
   * A call that fails after sending a key may still have created something:
   * the Content was stored before its upload broke, or the Analysis was
   * accepted and only the response was lost. Retrying with
   * `idempotencyKey: error.idempotencyKey` replays what the first attempt
   * created instead of creating it twice. The backend keeps keys for 24 hours,
   * and a retry has to send the same input, or it is refused with
   * `409 idempotency_conflict`.
   */
  readonly idempotencyKey: string | undefined;

  constructor(message: string, options: InkletErrorOptions) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.details = options.details;
    this.idempotencyKey = options.idempotencyKey;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      requestId: this.requestId,
      details: this.details,
      idempotencyKey: this.idempotencyKey,
    };
  }
}

/**
 * Record the `Idempotency-Key` a failed call sent on the error it threw.
 *
 * Errors are raised deep in the transport, which does not know which key the
 * surrounding operation chose, so the operation stamps it on the way out. An
 * error that already carries a key keeps it: the innermost call that sent one
 * is the one a retry has to repeat. Anything that is not an `InkletError` is
 * returned untouched.
 */
export function withIdempotencyKey<E>(error: E, idempotencyKey: string): E {
  if (error instanceof InkletError && error.idempotencyKey === undefined) {
    // `readonly` is a promise to callers, not a runtime property attribute.
    (error as { idempotencyKey: string | undefined }).idempotencyKey =
      idempotencyKey;
  }
  return error;
}

export class ConfigurationError extends InkletError {
  constructor(message: string, options: Omit<InkletErrorOptions, "code"> = {}) {
    super(message, { ...options, code: "invalid_configuration" });
  }
}

export class BrowserEnvironmentError extends InkletError {
  constructor() {
    super(
      "inklet personal access tokens can only be used in trusted server environments. Move this request to a server, serverless function, or controlled local service.",
      { code: "browser_environment" },
    );
  }
}

export class AuthenticationError extends InkletError {}

export class AuthenticationFailedError extends AuthenticationError {
  constructor(options: Omit<InkletErrorOptions, "code"> = {}) {
    super(
      "inklet authentication failed. Check that the personal access token is valid and active.",
      { ...options, code: "authentication_failed" },
    );
  }
}

export class InvalidSecretKeyError extends AuthenticationError {
  constructor(options: Omit<InkletErrorOptions, "code"> = {}) {
    super(
      "inklet authentication failed. Check that the personal access token is valid and active.",
      { ...options, code: "invalid_secret_key" },
    );
  }
}

export class RevokedSecretKeyError extends AuthenticationError {
  constructor(options: Omit<InkletErrorOptions, "code"> = {}) {
    super(
      "The inklet personal access token has been revoked. Create a new token and update the server configuration.",
      { ...options, code: "revoked_secret_key" },
    );
  }
}

export class PermissionDeniedError extends InkletError {
  constructor(
    message: string,
    options: Omit<InkletErrorOptions, "code"> & { code?: string } = {},
  ) {
    super(message, { ...options, code: options.code ?? "permission_denied" });
  }
}

/**
 * The authenticated user does not have the subscription required by a
 * server-side feature. Subscription changes are managed in the inklet portal;
 * retrying the same request before the plan changes will not help.
 */
export class SubscriptionRequiredError extends PermissionDeniedError {
  constructor(
    message = "This inklet feature requires an active Pro subscription. Manage the subscription in the inklet portal, then retry with the same personal access token.",
    options: Omit<InkletErrorOptions, "code"> = {},
  ) {
    super(message, { ...options, code: "subscription_required" });
  }
}

export class NotFoundError extends InkletError {
  constructor(
    message: string,
    options: Omit<InkletErrorOptions, "code"> & { code?: string } = {},
  ) {
    super(message, { ...options, code: options.code ?? "not_found" });
  }
}

export interface RetryAfterErrorOptions extends Omit<InkletErrorOptions, "code"> {
  code?: string;
  retryAfterMs?: number | null;
}

/**
 * `429`: either `code: "rate_limited"`, which backing off clears, or
 * `code: "quota_exceeded"`, which only time or a plan change clears — see
 * `details.resetAt`.
 */
export class RateLimitError extends InkletError {
  /**
   * How long the server asked for before the next attempt, in milliseconds,
   * read from `Retry-After` — delta-seconds or an HTTP-date, measured from
   * when the response arrived. `null` when the response sent none, or sent one
   * the SDK could not read.
   */
  readonly retryAfterMs: number | null;

  constructor(message: string, options: RetryAfterErrorOptions = {}) {
    const { retryAfterMs = null, ...rest } = options;
    super(message, { ...rest, code: options.code ?? "rate_limited" });
    this.retryAfterMs = retryAfterMs;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfterMs: this.retryAfterMs };
  }
}

export class PayloadTooLargeError extends InkletError {
  constructor(
    message: string,
    options: Omit<InkletErrorOptions, "code"> & { code?: string } = {},
  ) {
    super(message, { ...options, code: options.code ?? "payload_too_large" });
  }
}

export class ConflictError extends InkletError {
  constructor(
    message: string,
    options: Omit<InkletErrorOptions, "code"> & { code?: string } = {},
  ) {
    super(message, { ...options, code: options.code ?? "conflict" });
  }
}

export interface AssetUploadErrorOptions
  extends Omit<InkletErrorOptions, "code"> {
  contentId?: string | undefined;
  failedAssetIndexes: readonly number[];
}

export class AssetUploadError extends InkletError {
  readonly contentId: string | undefined;
  readonly failedAssetIndexes: readonly number[];

  constructor(message: string, options: AssetUploadErrorOptions) {
    super(message, { ...options, code: "asset_upload_failed" });
    this.contentId = options.contentId;
    this.failedAssetIndexes = [...options.failedAssetIndexes];
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      contentId: this.contentId,
      failedAssetIndexes: this.failedAssetIndexes,
    };
  }
}

export class ApiError extends InkletError {
  /**
   * The `Retry-After` the response carried, in milliseconds, as on
   * `RateLimitError`. A `503` is the status that usually sends one. `null`
   * when there was none.
   */
  readonly retryAfterMs: number | null;

  constructor(message: string, options: RetryAfterErrorOptions = {}) {
    const { retryAfterMs = null, ...rest } = options;
    super(message, { ...rest, code: options.code ?? "api_error" });
    this.retryAfterMs = retryAfterMs;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfterMs: this.retryAfterMs };
  }
}

export class InvalidResponseError extends InkletError {
  constructor(options: Omit<InkletErrorOptions, "code"> = {}) {
    super("inklet returned a response that the SDK could not parse.", {
      ...options,
      code: "invalid_response",
    });
  }
}

/**
 * The request did not produce a response: the connection failed, dropped, or
 * timed out. The request may or may not have reached inklet, so a call that
 * creates something is only safe to retry with the same idempotency key.
 */
export class NetworkError extends InkletError {
  constructor(
    message: string,
    options: Omit<InkletErrorOptions, "code"> & { code?: string } = {},
  ) {
    super(message, { ...options, code: options.code ?? "network_error" });
  }
}

/**
 * One HTTP request ran past its timeout — the client's `timeoutMs`, a call's
 * own `timeoutMs`, or `uploadTimeoutMs` for a storage upload — and was
 * cancelled.
 *
 * It is a `NetworkError` because it means the same thing to a caller: no
 * answer arrived, and the request may still have been processed. Waiting
 * helpers and `watch()` retry it like any other dropped connection; this is
 * what escapes once they stop.
 */
export class RequestTimeoutError extends NetworkError {
  readonly timeoutMs: number;

  constructor(
    message: string,
    options: Omit<InkletErrorOptions, "code"> & { timeoutMs: number },
  ) {
    const { timeoutMs, ...rest } = options;
    super(message, {
      ...rest,
      code: "request_timed_out",
      details: { ...rest.details, timeoutMs },
    });
    this.timeoutMs = timeoutMs;
  }
}

export class OperationTimeoutError extends InkletError {
  constructor(
    message: string,
    options: Omit<InkletErrorOptions, "code"> = {},
  ) {
    super(message, { ...options, code: "operation_timed_out" });
  }
}

export class OperationAbortedError extends InkletError {
  constructor(
    message: string,
    options: Omit<InkletErrorOptions, "code"> = {},
  ) {
    super(message, { ...options, code: "operation_aborted" });
  }
}

export class AnalysisFailedError extends InkletError {
  readonly analysisId: string;

  constructor(
    message: string,
    options: Omit<InkletErrorOptions, "code"> & { analysisId: string },
  ) {
    super(message, {
      ...options,
      code: "analysis_failed",
      details: { ...options.details, analysisId: options.analysisId },
    });
    this.analysisId = options.analysisId;
  }
}

/**
 * An Analysis completed but produced no Presentation. Only possible for an
 * Analysis that named no `contentIds`: once Contents are named, the backend
 * either covers them or fails the Analysis with `no_presentable_content`.
 * This is a normal outcome for history-driven analyses; it is an error only
 * for callers that required exactly one Presentation, such as
 * `presentations.waitUntilReady`.
 */
export class NoChangeError extends InkletError {
  readonly analysisId: string;
  readonly reason: string | null;

  constructor(analysisId: string, reason: string | null) {
    super(
      reason
        ? `The Analysis completed without a Presentation: ${reason}`
        : "The Analysis completed without producing a Presentation.",
      { code: "analysis_no_change", details: { analysisId, reason } },
    );
    this.analysisId = analysisId;
    this.reason = reason;
  }
}

/**
 * An Analysis completed with more than one Presentation, and the caller asked
 * for exactly one — `presentations.waitUntilReady()`. The Analysis itself
 * succeeded: one pinned to several Displays, or one the agent split across
 * them, produces a Presentation per Display. Read them from
 * `presentationIds` instead.
 */
export class MultiplePresentationsError extends InkletError {
  readonly analysisId: string;
  readonly presentationIds: readonly string[];

  constructor(analysisId: string, presentationIds: readonly string[]) {
    super(
      `Analysis ${analysisId} produced ${presentationIds.length} Presentations, but waitUntilReady() returns exactly one. Wait with analyses.wait() and read presentationIds instead.`,
      {
        code: "analysis_multiple_presentations",
        details: { analysisId, presentationIds: [...presentationIds] },
      },
    );
    this.analysisId = analysisId;
    this.presentationIds = [...presentationIds];
  }
}
