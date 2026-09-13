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
  PayloadTooLargeError,
  PermissionDeniedError,
  RateLimitError,
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
import { PresentationsResource } from "./presentations.js";
import { PushResource } from "./push.js";
import type { PresignedUpload, ResourceTransport } from "./resource.js";

export const DEFAULT_INKLET_BASE_URL = "https://dev.iminklet.com";

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
}

export interface InkletRequestOptions
  extends Omit<RequestInit, "body" | "headers" | "redirect"> {
  headers?: HeadersInit;
  body?: BodyInit | null;
  json?: unknown;
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

    const transport: ResourceTransport = {
      request: this.request.bind(this),
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
  analyze(input: AnalyzeInput = {}): Promise<Analysis> {
    return this.analyses.analyze(input);
  }

  /** Show one uploaded image without AI. Shorthand for `analyses.direct()`. */
  direct(input: DirectInput): Promise<Analysis> {
    return this.analyses.direct(input);
  }

  async request<T = unknown>(
    path: string,
    options: InkletRequestOptions = {},
  ): Promise<T> {
    assertServerEnvironment();
    const url = resolveRequestUrl(this.baseUrl, path);
    const { json, body, headers: suppliedHeaders, ...requestInit } = options;

    if (json !== undefined && body !== undefined && body !== null) {
      throw new ConfigurationError(
        "An Inklet request cannot include both `json` and `body`.",
      );
    }

    const headers = new Headers(suppliedHeaders);
    headers.set("accept", "application/json");
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

    const fetchInit: RequestInit = {
      ...requestInit,
      headers,
      redirect: "error",
    };
    if (requestBody !== undefined) {
      fetchInit.body = requestBody;
    }

    let response: Response;
    try {
      response = await this.#fetch(url, fetchInit);
    } catch (cause) {
      if (cause instanceof InkletError) {
        throw cause;
      }

      throw new NetworkError(
        `Unable to reach the Inklet service at ${new URL(this.baseUrl).origin}. Check the service address and network connection.`,
      );
    }

    const requestId = getRequestId(response);
    if (!response.ok) {
      throw await createResponseError(response, requestId, this.#secretKey);
    }

    if (
      response.status === 204 ||
      response.status === 205 ||
      requestInit.method?.toUpperCase() === "HEAD"
    ) {
      return undefined as T;
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new NetworkError(
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
  }

  private async upload(upload: PresignedUpload): Promise<void> {
    assertServerEnvironment();
    const url = normalizeUploadUrl(upload.url);
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) {
      form.append(key, value);
    }
    form.append("file", upload.blob, upload.filename);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        body: form,
        redirect: "error",
      });
    } catch {
      throw new NetworkError(
        "Unable to upload an Inklet asset. Check the network connection and retry the Push.",
      );
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
  const payload = await readErrorPayload(response);
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

  if (response.status === 429) {
    return new RateLimitError(
      safeMessage || "The Inklet API rate limit was exceeded. Retry later.",
      { ...options, code: serverCode ?? "rate_limited" },
    );
  }

  return new ApiError(safeMessage, {
    ...options,
    code: serverCode ?? "api_error",
  });
}

async function readErrorPayload(response: Response): Promise<ErrorPayload> {
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
    return { message: text };
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

function defaultErrorMessage(status: number): string {
  return `The Inklet API returned HTTP ${status}.`;
}
