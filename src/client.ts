import { Deadline, throwIfAborted, validateTimeout } from "./abort.js";
import {
  ApiError,
  AuthenticationFailedError,
  BrowserEnvironmentError,
  ConflictError,
  ConfigurationError,
  InkletError,
  InvalidResponseError,
  InvalidSecretKeyError,
  NetworkError,
  NotFoundError,
  OperationAbortedError,
  PayloadTooLargeError,
  PermissionDeniedError,
  RateLimitError,
  RequestTimeoutError,
  RevokedSecretKeyError,
  SubscriptionRequiredError,
} from "./errors.js";
import {
  AnalysesResource,
  type Analysis,
  type AnalyzeInput,
  type DirectInput,
} from "./analyses.js";
import { AssetsResource } from "./assets.js";
import { ContentsResource } from "./contents.js";
import { DisplaysResource } from "./displays.js";
import { parseRetryAfter } from "./polling.js";
import { PresentationsResource } from "./presentations.js";
import { PushResource } from "./push.js";
import type {
  CallOptions,
  PresignedUpload,
  ResourceTransport,
} from "./resource.js";

export const DEFAULT_INKLET_BASE_URL = "https://dev.iminklet.com";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 5 * 60_000;
const REQUEST_ABORTED = "The Inklet request was aborted.";
const UPLOAD_ABORTED = "The Inklet asset upload was aborted.";
/** How much of a non-JSON error body makes it into `error.message`. */
const MAX_ERROR_EXCERPT_LENGTH = 200;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface InkletClientOptions {
  /**
   * A server-side personal access token created in the Inklet portal.
   */
  pat?: string;

  /**
   * Compatibility alias for `pat` from the first SDK alpha.
   */
  secretKey?: string;

  /**
   * Inklet Cloud is used by default. Override this for a controlled local
   * Compute Hub or a test server.
   */
  baseUrl?: string;

  /**
   * Custom fetch implementation, primarily for controlled runtimes and tests.
   */
  fetch?: FetchImplementation;

  /**
   * How long one API request may take, in milliseconds, before it is
   * cancelled with `RequestTimeoutError`. Defaults to 60,000.
   *
   * The clock runs from sending the request until its response has been read
   * in full. A streamed response — `requestRaw()`, and the event stream behind
   * `analyses.watch()` — is only timed until its headers arrive, because its
   * body is meant to stay open; stop one of those with an `AbortSignal`. Any
   * resource method can override this for one call with its own `timeoutMs`.
   * Storage uploads are timed by `uploadTimeoutMs` instead.
   */
  timeoutMs?: number;

  /**
   * How long one binary Asset upload to storage may take, in milliseconds.
   * Defaults to 300,000 (five minutes).
   *
   * An upload goes straight to storage with up to 10 MiB in it, so it gets a
   * clock of its own rather than the API's: five minutes carries a full-size
   * Asset at about 280 kbit/s. An upload that runs out of time is a failed
   * upload like any other — `contents.upload()` refreshes its ticket and tries
   * once more before giving up with `AssetUploadError` — and a call's
   * `timeoutMs` does not change it.
   */
  uploadTimeoutMs?: number;
}

/**
 * Request headers in any form `new Headers()` accepts.
 *
 * Declared here rather than borrowed from the DOM's `HeadersInit`, which a
 * project compiling against `@types/node` without `lib: ["DOM"]` does not
 * have.
 */
export type InkletRequestHeaders =
  | Headers
  | Record<string, string | readonly string[]>
  | readonly (readonly string[])[];

/**
 * A request body `fetch` can send, declared here for the same reason as
 * `InkletRequestHeaders`: the DOM's `BodyInit` is not available everywhere
 * the SDK is compiled. Use `json` rather than a string for a JSON body.
 */
export type InkletRequestBody =
  | string
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | FormData
  | URLSearchParams;

export interface InkletRequestOptions
  extends Omit<RequestInit, "body" | "headers" | "redirect"> {
  headers?: InkletRequestHeaders;
  body?: InkletRequestBody | null;
  json?: unknown;
  /**
   * Overrides the client's `timeoutMs` for this request. For `requestRaw()` it
   * only covers the wait for the response headers.
   */
  timeoutMs?: number;
}

/** A response whose headers have arrived, and the clock still running on it. */
interface Exchange {
  response: Response;
  deadline: Deadline;
  /**
   * The error for a failed fetch or body read: a timeout, the caller's abort,
   * or `NetworkError` with `message` when it was neither.
   */
  failure(message: string, context?: FailureContext): InkletError;
}

interface FailureContext {
  status?: number | undefined;
  requestId?: string | undefined;
}

interface ErrorPayload {
  code?: string | undefined;
  message?: string | undefined;
  requestId?: string | undefined;
  details?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Server-only client for the Inklet API.
 *
 * Construction is side-effect free: the first network request is only made
 * when `request` (or a resource method built on it) is called.
 */
export class InkletClient {
  readonly baseUrl: string;
  readonly assets: AssetsResource;
  readonly contents: ContentsResource;
  readonly analyses: AnalysesResource;
  readonly displays: DisplaysResource;
  readonly presentations: PresentationsResource;
  readonly push: PushResource;

  readonly #secretKey: string;
  readonly #fetch: FetchImplementation;
  readonly #timeoutMs: number;
  readonly #uploadTimeoutMs: number;

  constructor(options: InkletClientOptions) {
    assertServerEnvironment();

    if (!options || typeof options !== "object") {
      throw new ConfigurationError(
        "InkletClient requires an options object containing a personal access token.",
      );
    }

    this.#secretKey = resolveSecretKey(options);
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#fetch = resolveFetch(options.fetch);
    this.#timeoutMs =
      options.timeoutMs === undefined
        ? DEFAULT_TIMEOUT_MS
        : validateTimeout(options.timeoutMs, "timeoutMs");
    this.#uploadTimeoutMs =
      options.uploadTimeoutMs === undefined
        ? DEFAULT_UPLOAD_TIMEOUT_MS
        : validateTimeout(options.uploadTimeoutMs, "uploadTimeoutMs");

    const transport: ResourceTransport = {
      request: this.request.bind(this),
      requestRaw: this.requestRaw.bind(this),
      upload: this.upload.bind(this),
    };
    this.assets = new AssetsResource();
    this.contents = new ContentsResource(transport);
    this.analyses = new AnalysesResource(transport);
    this.presentations = new PresentationsResource(
      transport,
      this.contents,
      this.analyses,
    );
    this.displays = new DisplaysResource(transport);
    this.push = new PushResource(this.contents, this.analyses);
  }

  /**
   * Run the agent over uploaded Contents and/or the user's history.
   * Shorthand for `analyses.analyze()`.
   */
  analyze(input: AnalyzeInput = {}, options: CallOptions = {}): Promise<Analysis> {
    return this.analyses.analyze(input, options);
  }

  /** Show one uploaded image without AI. Shorthand for `analyses.direct()`. */
  direct(input: DirectInput, options: CallOptions = {}): Promise<Analysis> {
    return this.analyses.direct(input, options);
  }

  /**
   * Send an authenticated request and return the raw `Response` without
   * reading the body.
   *
   * Non-2xx responses still throw the usual typed errors, so a caller only
   * ever receives a successful response. Use this for streaming endpoints such
   * as the Analysis event stream, where the body must be consumed
   * incrementally; `request()` is the right choice for everything else.
   *
   * The timeout stops once the headers are in, so a body that stays open is
   * not cut off by it; `signal` still cancels the body for as long as it is
   * being read.
   */
  async requestRaw(
    path: string,
    options: InkletRequestOptions = {},
  ): Promise<Response> {
    const { response, deadline } = await this.#send(path, options);
    deadline.stopTimer();
    return response;
  }

  async request<T = unknown>(
    path: string,
    options: InkletRequestOptions = {},
  ): Promise<T> {
    const { response, deadline, failure } = await this.#send(path, options);
    try {
      const requestId = getRequestId(response);

      if (
        response.status === 204 ||
        response.status === 205 ||
        options.method?.toUpperCase() === "HEAD"
      ) {
        return undefined as T;
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        throw failure(
          `The connection to ${new URL(this.baseUrl).origin} closed before the Inklet response was complete.`,
          { status: response.status, requestId },
        );
      }
      if (text.length === 0) {
        return undefined as T;
      }

      if (isJsonResponse(response)) {
        try {
          return JSON.parse(text) as T;
        } catch (cause) {
          throw new InvalidResponseError({
            status: response.status,
            requestId,
            cause,
          });
        }
      }

      return text as T;
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Send one request and wait for its headers. The deadline it returns is
   * still running: `request()` keeps it until the body is read, and
   * `requestRaw()` stops it at once.
   */
  async #send(path: string, options: InkletRequestOptions): Promise<Exchange> {
    assertServerEnvironment();
    const url = resolveRequestUrl(this.baseUrl, path);
    const {
      json,
      body,
      headers: suppliedHeaders,
      timeoutMs,
      signal,
      ...requestInit
    } = options;
    const timeout =
      timeoutMs === undefined ? this.#timeoutMs : validateTimeout(timeoutMs, "timeoutMs");

    if (json !== undefined && body !== undefined && body !== null) {
      throw new ConfigurationError(
        "An Inklet request cannot include both `json` and `body`.",
      );
    }

    const headers = new Headers(suppliedHeaders as HeadersInit | undefined);
    if (!headers.has("accept")) {
      headers.set("accept", "application/json");
    }
    headers.set("authorization", `Bearer ${this.#secretKey}`);

    let requestBody = body;
    if (json !== undefined) {
      headers.set("content-type", "application/json");
      try {
        requestBody = JSON.stringify(json);
      } catch (cause) {
        throw new ConfigurationError(
          "The value supplied as `json` is not JSON serializable.",
          { cause },
        );
      }
    }

    const callerSignal = signal ?? undefined;
    throwIfAborted(callerSignal, REQUEST_ABORTED);
    const deadline = new Deadline(callerSignal, timeout);
    const origin = new URL(this.baseUrl).origin;
    // A failed fetch or body read is our timer, the caller's abort, or the
    // network, in that order of precedence; `timedOut` is only set when the
    // timer fired first.
    const failure: Exchange["failure"] = (message, context = {}) => {
      if (deadline.timedOut) {
        return new RequestTimeoutError(
          `The Inklet request to ${origin} did not complete within ${timeout} ms.`,
          { ...context, timeoutMs: timeout },
        );
      }
      if (callerSignal?.aborted) {
        return new OperationAbortedError(REQUEST_ABORTED, {
          ...context,
          cause: callerSignal.reason,
        });
      }
      return new NetworkError(message, context);
    };

    const fetchInit: RequestInit = {
      ...requestInit,
      headers,
      redirect: "error",
      signal: deadline.signal,
    };
    if (requestBody !== undefined) {
      fetchInit.body = requestBody as BodyInit | null;
    }

    let response: Response;
    try {
      response = await this.#fetch(url, fetchInit);
    } catch (cause) {
      deadline.dispose();
      if (cause instanceof InkletError) {
        throw cause;
      }
      // The cause is deliberately dropped: a runtime's connection error can
      // echo request details, credentials included.
      throw failure(
        `Unable to reach the Inklet service at ${origin}. Check the service address and network connection.`,
      );
    }

    if (!response.ok) {
      try {
        throw await createResponseError(
          response,
          getRequestId(response),
          this.#secretKey,
        );
      } finally {
        deadline.dispose();
      }
    }

    return { response, deadline, failure };
  }

  private async upload(
    upload: PresignedUpload,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<void> {
    assertServerEnvironment();
    const url = normalizeUploadUrl(upload.url);
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) {
      form.append(key, value);
    }
    form.append("file", upload.blob, upload.filename);

    const { signal } = options;
    throwIfAborted(signal, UPLOAD_ABORTED);
    const deadline = new Deadline(signal, this.#uploadTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        body: form,
        redirect: "error",
        signal: deadline.signal,
      });
    } catch {
      if (deadline.timedOut) {
        throw new RequestTimeoutError(
          `Uploading an Inklet asset did not finish within ${this.#uploadTimeoutMs} ms.`,
          { timeoutMs: this.#uploadTimeoutMs },
        );
      }
      if (signal?.aborted) {
        throw new OperationAbortedError(UPLOAD_ABORTED, { cause: signal.reason });
      }
      throw new NetworkError(
        "Unable to upload an Inklet asset. Check the network connection and retry the Push.",
      );
    } finally {
      deadline.dispose();
    }

    if (!response.ok) {
      throw new ApiError("Inklet asset storage rejected the upload.", {
        status: response.status,
        code: "asset_upload_failed",
      });
    }
  }
}

export { InkletClient as Inklet };

function resolveSecretKey(options: InkletClientOptions): string {
  const secretKey = normalizeCredential(options.secretKey);
  const pat = normalizeCredential(options.pat);

  if (secretKey && pat) {
    throw new ConfigurationError(
      "Provide either `pat` or its `secretKey` compatibility alias, not both.",
    );
  }

  const credential = secretKey ?? pat;
  if (!credential) {
    throw new ConfigurationError(
      "A non-empty Inklet personal access token is required.",
    );
  }

  return credential;
}

function normalizeCredential(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(
      "The Inklet personal access token must be a non-empty string.",
    );
  }

  return value.trim();
}

function normalizeUploadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new InvalidResponseError({ cause });
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new InvalidResponseError();
  }
  return url;
}

function normalizeBaseUrl(value: string | undefined): string {
  const candidate = value ?? DEFAULT_INKLET_BASE_URL;
  let url: URL;

  try {
    url = new URL(candidate);
  } catch (cause) {
    throw new ConfigurationError(
      "The Inklet `baseUrl` must be an absolute HTTP or HTTPS URL.",
      { cause },
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigurationError(
      "The Inklet `baseUrl` must use HTTP or HTTPS.",
    );
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError(
      "The Inklet `baseUrl` cannot contain credentials, a query, or a fragment.",
    );
  }

  return url.toString().replace(/\/+$/, "");
}

function resolveFetch(
  suppliedFetch: FetchImplementation | undefined,
): FetchImplementation {
  const implementation = suppliedFetch ?? globalThis.fetch;

  if (typeof implementation !== "function") {
    throw new ConfigurationError(
      "This runtime does not provide `fetch`. Use Node.js 20 or newer, or pass a compatible `fetch` implementation.",
    );
  }

  return implementation.bind(globalThis) as FetchImplementation;
}

function resolveRequestUrl(baseUrl: string, path: string): URL {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new ConfigurationError(
      "Inklet request paths must be non-empty strings.",
    );
  }

  const trimmedPath = path.trim();
  if (
    /^[a-z][a-z\d+\-.]*:/i.test(trimmedPath) ||
    trimmedPath.startsWith("//") ||
    trimmedPath.includes("\\")
  ) {
    throw new ConfigurationError(
      "Inklet request paths must be relative to the configured service address.",
    );
  }

  const relativePath = trimmedPath.replace(/^\/+/, "");
  const requestUrl = new URL(relativePath, `${baseUrl}/`);
  if (requestUrl.origin !== new URL(baseUrl).origin) {
    throw new ConfigurationError(
      "Inklet request paths cannot target a different origin.",
    );
  }

  return requestUrl;
}

function assertServerEnvironment(): void {
  if (
    typeof globalThis.window !== "undefined" &&
    typeof globalThis.window.document !== "undefined"
  ) {
    throw new BrowserEnvironmentError();
  }
}

function getRequestId(response: Response): string | undefined {
  return (
    response.headers.get("x-request-id") ??
    response.headers.get("request-id") ??
    response.headers.get("x-correlation-id") ??
    undefined
  );
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/json") || contentType.includes("+json");
}

async function createResponseError(
  response: Response,
  headerRequestId: string | undefined,
  secretKey: string,
): Promise<InkletError> {
  const payload = await readErrorPayload(response, secretKey);
  const requestId = headerRequestId ?? payload.requestId;
  const serverCode = payload.code?.toLowerCase();
  const options = {
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
    ...(payload.details === undefined ? {} : { details: payload.details }),
  };

  if (response.status === 401) {
    if (serverCode === "authentication_failed") {
      return new AuthenticationFailedError(options);
    }
    if (serverCode?.includes("revoked")) {
      return new RevokedSecretKeyError(options);
    }
    return new InvalidSecretKeyError(options);
  }

  const safeMessage = redactCredential(
    payload.message ?? defaultErrorMessage(response.status),
    secretKey,
  );

  if (serverCode === "subscription_required") {
    return new SubscriptionRequiredError(safeMessage || undefined, options);
  }

  if (response.status === 403) {
    return new PermissionDeniedError(
      safeMessage ||
        "The personal access token does not have permission to access this resource.",
      { ...options, code: serverCode ?? "permission_denied" },
    );
  }

  if (response.status === 404) {
    return new NotFoundError(
      safeMessage || "The requested Inklet resource was not found.",
      { ...options, code: serverCode ?? "not_found" },
    );
  }

  if (response.status === 409) {
    return new ConflictError(safeMessage, {
      ...options,
      code: serverCode ?? "conflict",
    });
  }

  if (response.status === 413) {
    return new PayloadTooLargeError(safeMessage, {
      ...options,
      code: serverCode ?? "payload_too_large",
    });
  }

  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

  if (response.status === 429) {
    return new RateLimitError(
      safeMessage || "The Inklet API rate limit was exceeded. Retry later.",
      { ...options, code: serverCode ?? "rate_limited", retryAfterMs },
    );
  }

  return new ApiError(safeMessage, {
    ...options,
    code: serverCode ?? "api_error",
    retryAfterMs,
  });
}

async function readErrorPayload(
  response: Response,
  secretKey: string,
): Promise<ErrorPayload> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return {};
  }

  if (!text) {
    return {};
  }

  if (!isJsonResponse(response)) {
    // Usually a proxy or gateway page rather than Inklet itself. Its text is
    // not written for a log line, so only a short plain-text excerpt is kept.
    const excerpt = excerptBody(redactCredential(text, secretKey));
    return excerpt
      ? { message: `The Inklet API returned HTTP ${response.status}: ${excerpt}` }
      : {};
  }

  try {
    const value = JSON.parse(text) as unknown;
    return normalizeErrorPayload(value);
  } catch {
    return {};
  }
}

function normalizeErrorPayload(value: unknown): ErrorPayload {
  if (!isRecord(value)) {
    return {};
  }

  const nestedError = isRecord(value.error) ? value.error : undefined;
  const stringError = typeof value.error === "string" ? value.error : undefined;

  return {
    code: firstString(nestedError?.code, value.code),
    message: firstString(nestedError?.message, value.message, stringError),
    requestId: firstString(
      value.requestId,
      value.request_id,
      nestedError?.requestId,
      nestedError?.request_id,
    ),
    details: isRecord(nestedError?.details)
      ? nestedError.details
      : isRecord(value.details)
        ? value.details
        : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function redactCredential(message: string, secretKey: string): string {
  return message.split(secretKey).join("[REDACTED]");
}

/**
 * A short, single-line, plain-text excerpt of a response body for an error
 * message. An HTML page is represented by its `<title>` when it has one —
 * a gateway's page is mostly styles and scripts, and its title is what says
 * "502 Bad Gateway" — and otherwise markup and control characters become
 * spaces, whitespace collapses, and anything past `MAX_ERROR_EXCERPT_LENGTH`
 * is cut. Credentials must already be redacted: cutting first could leave
 * half of one behind.
 */
function excerptBody(text: string): string {
  const title = /<title\b[^>]*>([^<]*)<\/title/i.exec(text)?.[1];
  const plain = (title ?? text)
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= MAX_ERROR_EXCERPT_LENGTH) {
    return plain;
  }
  // Do not end on half of a surrogate pair.
  const cut = plain
    .slice(0, MAX_ERROR_EXCERPT_LENGTH)
    .replace(/[\ud800-\udbff]$/, "");
  return `${cut.trimEnd()}…`;
}

function defaultErrorMessage(status: number): string {
  return `The Inklet API returned HTTP ${status}.`;
}
