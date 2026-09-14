export interface InkletErrorOptions {
  code: string;
  status?: number | undefined;
  requestId?: string | undefined;
  details?: Readonly<Record<string, unknown>> | undefined;
  cause?: unknown;
}

/**
 * Base class for every error produced by the SDK.
 *
 * `requestId` can be passed to Inklet support without exposing credentials.
 */
export class InkletError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(message: string, options: InkletErrorOptions) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      requestId: this.requestId,
      details: this.details,
    };
  }
}

export class ConfigurationError extends InkletError {
  constructor(message: string, options: Omit<InkletErrorOptions, "code"> = {}) {
    super(message, { ...options, code: "invalid_configuration" });
  }
}

export class BrowserEnvironmentError extends InkletError {
  constructor() {
    super(
      "Inklet personal access tokens can only be used in trusted server environments. Move this request to a server, serverless function, or controlled local service.",
      { code: "browser_environment" },
    );
  }
}

export class AuthenticationError extends InkletError {}

export class AuthenticationFailedError extends AuthenticationError {
  constructor(options: Omit<InkletErrorOptions, "code"> = {}) {
    super(
      "Inklet authentication failed. Check that the personal access token is valid and active.",
      { ...options, code: "authentication_failed" },
    );
  }
}

export class InvalidSecretKeyError extends AuthenticationError {
  constructor(options: Omit<InkletErrorOptions, "code"> = {}) {
    super(
      "Inklet authentication failed. Check that the personal access token is valid and active.",
      { ...options, code: "invalid_secret_key" },
    );
  }
}

export class RevokedSecretKeyError extends AuthenticationError {
  constructor(options: Omit<InkletErrorOptions, "code"> = {}) {
    super(
      "The Inklet personal access token has been revoked. Create a new token and update the server configuration.",
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
 * server-side feature. Subscription changes are managed in the Inklet portal;
 * retrying the same request before the plan changes will not help.
 */
export class SubscriptionRequiredError extends PermissionDeniedError {
  constructor(
    message = "This Inklet feature requires an active Pro subscription. Manage the subscription in the Inklet portal, then retry with the same personal access token.",
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

export class RateLimitError extends InkletError {
  constructor(
    message: string,
    options: Omit<InkletErrorOptions, "code"> & { code?: string } = {},
  ) {
    super(message, { ...options, code: options.code ?? "rate_limited" });
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

export class UnsupportedOperationError extends InkletError {
  constructor(message: string) {
    super(message, { code: "unsupported_operation" });
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
  constructor(
    message: string,
    options: Omit<InkletErrorOptions, "code"> & { code?: string } = {},
  ) {
    super(message, { ...options, code: options.code ?? "api_error" });
  }
}

export class InvalidResponseError extends InkletError {
  constructor(options: Omit<InkletErrorOptions, "code"> = {}) {
    super("Inklet returned a response that the SDK could not parse.", {
      ...options,
      code: "invalid_response",
    });
  }
}

export class NetworkError extends InkletError {
  constructor(message: string, options: Omit<InkletErrorOptions, "code"> = {}) {
    super(message, { ...options, code: "network_error" });
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
