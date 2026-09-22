import type { InkletRequestOptions } from "./client.js";
import { ConfigurationError, InvalidResponseError } from "./errors.js";

/**
 * Cancellation and a timeout for one SDK call. Every method that talks to
 * Inklet accepts these, as the last argument or as part of its options
 * object.
 */
export interface CallOptions {
  /**
   * Cancels the call, including a request already in flight; the call then
   * rejects with `OperationAbortedError`. An abort does not undo anything the
   * backend already accepted.
   */
  signal?: AbortSignal;
  /**
   * How long each HTTP request the call sends may take, in milliseconds,
   * before it is cancelled with `RequestTimeoutError`. Overrides the client's
   * `timeoutMs` for this call. A method that sends several requests applies it
   * to each of them rather than to the call as a whole — pass an
   * `AbortSignal.timeout()` as `signal` for an overall limit — and a storage
   * upload keeps the client's `uploadTimeoutMs`.
   */
  timeoutMs?: number;
}

export type InkletRequest = <T = unknown>(
  path: string,
  options?: InkletRequestOptions,
) => Promise<T>;

export interface PresignedUpload {
  url: string;
  fields: Readonly<Record<string, string>>;
  blob: Blob;
  filename: string;
  contentType: string;
  assetIndex: number;
  contentId: string | null;
}

export type InkletUpload = (
  upload: PresignedUpload,
  options?: { signal?: AbortSignal | undefined },
) => Promise<void>;

/**
 * Authenticated request that resolves with the raw `Response`, for endpoints
 * whose body has to be consumed incrementally (server-sent events).
 */
export type InkletRequestRaw = (
  path: string,
  options?: InkletRequestOptions,
) => Promise<Response>;

export interface ResourceTransport {
  request: InkletRequest;
  requestRaw: InkletRequestRaw;
  upload: InkletUpload;
}

export const SDK_API_PREFIX = "/api/sdk/v1";

/**
 * The request options a resource method forwards for its `CallOptions`, with
 * absent fields left out rather than set to `undefined`.
 */
export function callOptions(options: CallOptions | undefined): InkletRequestOptions {
  const forwarded: InkletRequestOptions = {};
  if (options?.signal !== undefined) {
    forwarded.signal = options.signal;
  }
  if (options?.timeoutMs !== undefined) {
    forwarded.timeoutMs = options.timeoutMs;
  }
  return forwarded;
}

/** A caller-supplied id, trimmed. Use `encodePathSegment` to put it in a path. */
export function requireId(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * A caller-supplied id, ready to be one segment of a request path.
 *
 * `encodeURIComponent` escapes `/` and `%` but leaves `.` alone, and a URL
 * resolves a `.` or `..` segment rather than sending it: `retrieve("..")`
 * would request the collection above the resource instead. Neither is a
 * valid id, so both are refused before anything is sent.
 */
export function encodePathSegment(value: string, name: string): string {
  const id = requireId(value, name);
  if (id === "." || id === "..") {
    throw new ConfigurationError(`${name} cannot be "." or "..".`);
  }
  return encodeURIComponent(id);
}

export function expectRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InvalidResponseError();
  }
  return value;
}

export function expectRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new InvalidResponseError();
  }
  return value;
}

export function expectString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidResponseError();
  }
  return value;
}

export function expectBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new InvalidResponseError();
  }
  return value;
}

export function expectNumber(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidResponseError();
  }
  return value;
}

export function expectInteger(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = expectNumber(record, key);
  if (!Number.isInteger(value)) {
    throw new InvalidResponseError();
  }
  return value;
}

/**
 * Read a value from a set the backend owns and may grow: a state, a mode, a
 * reason. `T` names the values this SDK knows, for autocompletion and for
 * narrowing; any other non-empty string is passed through as it is, so a
 * backend that adds a value does not break an SDK that is already installed.
 * Only a value that is not a string at all, or is empty, is malformed.
 *
 * Request-side options are the opposite: what the SDK sends is validated
 * against the values it knows (`validateEnumOption`), since sending one the
 * backend does not accept can only fail.
 */
export function expectEnum<T extends string>(value: unknown): T | (string & {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidResponseError();
  }
  return value;
}

/** `expectEnum` for every entry of an array. */
export function expectEnumArray<T extends string>(
  value: unknown,
): (T | (string & {}))[] {
  if (!Array.isArray(value)) {
    throw new InvalidResponseError();
  }
  return value.map((entry) => expectEnum<T>(entry));
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function nullableRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  return expectRecord(value);
}

export function nullableStringArray(value: unknown): readonly string[] | null {
  if (value === null) {
    return null;
  }
  return expectStringArray(value);
}

export function expectStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new InvalidResponseError();
  }
  return [...value];
}

export function positiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : null;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function parsePage<T>(
  value: unknown,
  mapItem: (item: Record<string, unknown>) => T,
): { items: readonly T[]; nextCursor: string | null; hasMore: boolean } {
  const record = expectRecord(value);
  return {
    items: expectRecordArray(record.items).map(mapItem),
    nextCursor: nullableString(record.nextCursor),
    hasMore: expectBoolean(record, "hasMore"),
  };
}

export function appendCursorAndLimit(
  query: URLSearchParams,
  options: { cursor?: string; limit?: number },
): void {
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== "string" || options.cursor.length === 0) {
      throw new ConfigurationError("cursor must be a non-empty string.");
    }
    query.set("cursor", options.cursor);
  }
  const limit = validateLimit(options.limit);
  if (limit !== undefined) {
    query.set("limit", String(limit));
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateLimit(
  value: number | undefined,
  maximum = 50,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ConfigurationError(
      `limit must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

export function validatePage(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigurationError("page must be a positive integer.");
  }
  return value;
}

export function normalizeTimestamp(
  value: string | Date | undefined,
  name: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ConfigurationError(`${name} must be a valid date or timestamp.`);
  }
  return date.toISOString();
}
