import { ConfigurationError, InvalidResponseError } from "./errors.js";
import {
  ALLOWED_FILE_CONTENT_TYPES,
  ALLOWED_IMAGE_CONTENT_TYPES,
  MAX_ASSETS_PER_CONTENT,
  MAX_ASSET_SIZE_BYTES,
  assetBlob,
  validateAsset,
  type AllowedFileContentType,
  type AllowedImageContentType,
  type FileAsset,
  type ImageAsset,
  type InkletAsset,
} from "./assets.js";
import { AssetUploadError, OperationAbortedError, OperationTimeoutError } from "./errors.js";
import {
  SDK_API_PREFIX,
  appendCursorAndLimit,
  encodePathSegment,
  expectInteger,
  expectRecord,
  expectRecordArray,
  expectString,
  expectStringArray,
  isRecord,
  nullableRecord,
  nullableString,
  parsePage,
  type ResourceTransport,
} from "./resource.js";
import type { PresentationProblem } from "./presentations.js";

/**
 * A Content only tracks whether its Assets have arrived. Processing is a
 * separate Analysis (see `analyses.ts`), so there is no processing state here.
 */
export type ContentState = "pending" | "ready" | "failed";
export type ContentAssetUploadState = "pending" | "uploaded" | "failed";

export interface ContentAsset {
  assetIndex: number;
  type: InkletAsset["type"];
  text: string | null;
  url: string | null;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  uploadState: ContentAssetUploadState;
}

export interface Content {
  id: string;
  title: string | null;
  state: ContentState;
  assets: readonly ContentAsset[];
  failedAssetIndexes: readonly number[];
  /** Every Analysis that referenced this Content, oldest first. */
  analysisIds: readonly string[];
  /** Union of Presentations produced by those Analyses, oldest first. */
  presentationIds: readonly string[];
  failure: PresentationProblem | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentPage {
  items: readonly Content[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListContentsOptions {
  state?: ContentState;
  cursor?: string;
  limit?: number;
}

export interface UploadTicket {
  assetIndex: number;
  url: string;
  fields: Readonly<Record<string, string>>;
  expiresAt: string;
}

export interface CreateContentResponse {
  content: Content;
  uploadTickets: readonly UploadTicket[];
}

export interface ContentTextInput {
  type: "text";
  text: string;
}

export interface ContentLinkInput {
  type: "link";
  url: string;
}

export interface ContentImageInput {
  type: "image";
  filename: string;
  contentType: AllowedImageContentType;
  sizeBytes: number;
}

export interface ContentFileInput {
  type: "file";
  filename: string;
  contentType: AllowedFileContentType;
  sizeBytes: number;
}

export type CreateContentAssetInput =
  | ContentTextInput
  | ContentLinkInput
  | ContentImageInput
  | ContentFileInput;

/** Low-level create request: Asset metadata only, binaries are uploaded after. */
export interface CreateContentRequest {
  title?: string | null;
  assets: readonly CreateContentAssetInput[];
}

/** High-level upload input: Assets with their binary data. */
export interface UploadContentInput {
  title?: string | null;
  assets: readonly InkletAsset[];
  /** Generated when omitted; returned on the result for caller-controlled retries. */
  idempotencyKey?: string;
}

export interface UploadContentResult {
  content: Content;
  idempotencyKey: string;
}

export interface WaitUntilContentReadyOptions {
  /** Defaults to 1,000 ms. */
  pollIntervalMs?: number;
  /** Defaults to 60,000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface PreparedBinary {
  asset: ImageAsset | FileAsset;
  assetIndex: number;
  blob: Blob;
}

export class ContentsResource {
  readonly #transport: ResourceTransport;

  constructor(transport: ResourceTransport) {
    this.#transport = transport;
  }

  /**
   * Create a Content, upload its binary Assets directly to storage, and return
   * the Content. Nothing is analyzed until `inklet.analyze()` references it.
   *
   * A Content with binary Assets is reported as `pending` until the backend
   * has verified the uploads (storage events, or lazily when an Analysis first
   * references it). Text and link Contents are `ready` immediately.
   */
  async upload(input: UploadContentInput): Promise<UploadContentResult> {
    if (!input || typeof input !== "object" || !Array.isArray(input.assets)) {
      throw new ConfigurationError("Content upload requires an assets array.");
    }
    const prepared = prepareAssets(input.assets);
    const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey();
    const created = await this.create(
      { title: input.title ?? null, assets: prepared.request },
      idempotencyKey,
    );

    validateTickets(created.uploadTickets, prepared.binary);
    const failed = await uploadTickets(
      this.#transport,
      created.content.id,
      created.uploadTickets,
      prepared.binary,
    );
    if (failed.length > 0) {
      await this.#refreshAndUpload(created.content.id, failed, prepared.binary);
    }

    return { content: created.content, idempotencyKey };
  }

  async create(
    input: CreateContentRequest,
    idempotencyKey: string,
  ): Promise<CreateContentResponse> {
    validateCreateContentRequest(input);
    validateIdempotencyKey(idempotencyKey);
    const response = await this.#transport.request(`${SDK_API_PREFIX}/contents`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      json: { title: input.title ?? null, assets: input.assets },
    });
    return parseCreateContentResponse(response);
  }

  async retrieve(contentId: string): Promise<Content> {
    const id = encodePathSegment(contentId, "contentId");
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/contents/${id}`,
    );
    return parseContent(expectRecord(response));
  }

  async list(options: ListContentsOptions = {}): Promise<ContentPage> {
    const query = new URLSearchParams();
    appendCursorAndLimit(query, options);
    if (options.state !== undefined) {
      validateEnumOption(options.state, ["pending", "ready", "failed"], "state");
      query.set("state", options.state);
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/contents${suffix}`,
    );
    return parsePage(response, parseContent);
  }

  async refreshUploadTickets(
    contentId: string,
    assetIndexes: readonly number[],
  ): Promise<CreateContentResponse> {
    const id = encodePathSegment(contentId, "contentId");
    if (
      assetIndexes.length === 0 ||
      new Set(assetIndexes).size !== assetIndexes.length ||
      !assetIndexes.every(
        (index) => Number.isInteger(index) && index >= 0,
      )
    ) {
      throw new ConfigurationError(
        "assetIndexes must contain one or more unique non-negative integers.",
      );
    }
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/contents/${id}/upload-tickets`,
      { method: "POST", json: { assetIndexes } },
    );
    return parseCreateContentResponse(response);
  }

  /**
   * Poll until the backend reports the Content `ready` or `failed`. Only
   * needed when a caller wants to observe ingestion without analyzing;
   * `inklet.analyze()` verifies pending uploads on its own.
   */
  async waitUntilReady(
    contentOrId: Content | string,
    options: WaitUntilContentReadyOptions = {},
  ): Promise<Content> {
    const contentId = typeof contentOrId === "string" ? contentOrId : contentOrId.id;
    const pollIntervalMs = validateWaitNumber(options.pollIntervalMs, 1_000, 100, 60_000, "pollIntervalMs");
    const timeoutMs = validateWaitNumber(options.timeoutMs, 60_000, 1, 30 * 60_000, "timeoutMs");
    const startedAt = Date.now();
    let content = typeof contentOrId === "string" ? undefined : contentOrId;

    while (true) {
      throwIfAborted(options.signal, "Waiting for the Content was aborted.");
      content = content ?? (await this.retrieve(contentId));
      if (content.state === "ready" || content.state === "failed") {
        return content;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new OperationTimeoutError(
          `Content ${content.id} did not become ready within ${timeoutMs} ms.`,
          { details: { contentId: content.id, timeoutMs } },
        );
      }
      await delay(Math.min(pollIntervalMs, timeoutMs - elapsed), options.signal);
      content = undefined;
    }
  }

  async #refreshAndUpload(
    contentId: string,
    assetIndexes: readonly number[],
    binary: readonly PreparedBinary[],
  ): Promise<void> {
    const refreshed = await this.refreshUploadTickets(contentId, assetIndexes);
    validateTickets(refreshed.uploadTickets, binary, assetIndexes);
    const failed = await uploadTickets(
      this.#transport,
      contentId,
      refreshed.uploadTickets,
      binary,
    );
    if (failed.length > 0) {
      throw new AssetUploadError(
        "One or more Inklet assets could not be uploaded after refreshing their upload tickets.",
        { contentId, failedAssetIndexes: failed },
      );
    }
  }
}

function validateCreateContentRequest(input: CreateContentRequest): void {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Content creation requires an input object.");
  }
  if (input.title !== undefined && input.title !== null && typeof input.title !== "string") {
    throw new ConfigurationError("title must be a string or null.");
  }
  if (!Array.isArray(input.assets) || input.assets.length === 0) {
    throw new ConfigurationError("Content requires at least one Asset.");
  }
  if (input.assets.length > MAX_ASSETS_PER_CONTENT) {
    throw new ConfigurationError(
      `Content cannot contain more than ${MAX_ASSETS_PER_CONTENT} Assets.`,
    );
  }

  input.assets.forEach((asset, assetIndex) => {
    if (!asset || typeof asset !== "object") {
      throw new ConfigurationError(`Asset ${assetIndex} must be an object.`);
    }
    switch (asset.type) {
      case "text":
        if (typeof asset.text !== "string" || asset.text.trim().length === 0) {
          throw new ConfigurationError(
            `Asset ${assetIndex} must contain non-whitespace text.`,
          );
        }
        return;
      case "link":
        validateContentLink(asset.url, assetIndex);
        return;
      case "image":
        validateBinaryInput(asset, assetIndex, ALLOWED_IMAGE_CONTENT_TYPES);
        return;
      case "file":
        validateBinaryInput(asset, assetIndex, ALLOWED_FILE_CONTENT_TYPES);
        return;
      default:
        throw new ConfigurationError(`Asset ${assetIndex} has an unsupported type.`);
    }
  });
}

function validateContentLink(value: string, assetIndex: number): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`Asset ${assetIndex} must contain a URL.`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (cause) {
    throw new ConfigurationError(
      `Asset ${assetIndex} must contain an absolute HTTP or HTTPS URL.`,
      { cause },
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new ConfigurationError(
      `Asset ${assetIndex} must contain an absolute HTTP or HTTPS URL without credentials.`,
    );
  }
}

function validateBinaryInput(
  asset: ContentImageInput | ContentFileInput,
  assetIndex: number,
  allowed: readonly string[],
): void {
  if (typeof asset.filename !== "string" || asset.filename.trim().length === 0) {
    throw new ConfigurationError(`Asset ${assetIndex} requires filename.`);
  }
  if (!allowed.includes(asset.contentType)) {
    throw new ConfigurationError(
      `Asset ${assetIndex} has unsupported contentType ${String(asset.contentType)}.`,
    );
  }
  if (
    !Number.isInteger(asset.sizeBytes) ||
    asset.sizeBytes <= 0 ||
    asset.sizeBytes > MAX_ASSET_SIZE_BYTES
  ) {
    throw new ConfigurationError(
      `Asset ${assetIndex} sizeBytes must be an integer between 1 and ${MAX_ASSET_SIZE_BYTES}.`,
    );
  }
}

export function validateEnumOption(
  value: unknown,
  allowed: readonly string[],
  name: string,
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ConfigurationError(`${name} must be one of ${allowed.join(", ")}.`);
  }
}

export function parseCreateContentResponse(value: unknown): CreateContentResponse {
  const record = expectRecord(value);
  return {
    content: parseContent(expectRecord(record.content)),
    uploadTickets: expectRecordArray(record.uploadTickets).map(parseUploadTicket),
  };
}

export function parseContent(record: Record<string, unknown>): Content {
  return {
    id: expectString(record, "id"),
    title: nullableString(record.title),
    state: expectEnum(record.state, ["pending", "ready", "failed"] as const),
    assets: expectRecordArray(record.assets).map(parseAsset),
    failedAssetIndexes: parseIntegerArray(record.failedAssetIndexes ?? []),
    analysisIds: expectStringArray(record.analysisIds ?? []),
    presentationIds: expectStringArray(record.presentationIds ?? []),
    failure: parseProblem(nullableRecord(record.failure ?? null)),
    createdAt: expectString(record, "createdAt"),
    updatedAt: expectString(record, "updatedAt"),
  };
}

function parseAsset(record: Record<string, unknown>): ContentAsset {
  const type = expectEnum(
    record.type,
    ["text", "link", "image", "file"] as const,
  );
  const sizeBytes = record.sizeBytes;
  if (
    sizeBytes !== null &&
    (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes))
  ) {
    throw new InvalidResponseError();
  }
  return {
    assetIndex: expectInteger(record, "assetIndex"),
    type,
    text: nullableString(record.text),
    url: nullableString(record.url),
    filename: nullableString(record.filename),
    contentType: nullableString(record.contentType),
    sizeBytes,
    uploadState: expectEnum(
      record.uploadState,
      ["pending", "uploaded", "failed"] as const,
    ),
  };
}

function parseUploadTicket(record: Record<string, unknown>): UploadTicket {
  if (!isRecord(record.fields)) {
    throw new InvalidResponseError();
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(record.fields)) {
    if (typeof value !== "string") {
      throw new InvalidResponseError();
    }
    fields[key] = value;
  }
  return {
    assetIndex: expectInteger(record, "assetIndex"),
    url: expectString(record, "url"),
    fields,
    expiresAt: expectString(record, "expiresAt"),
  };
}

export function parseProblem(
  record: Record<string, unknown> | null,
): PresentationProblem | null {
  if (record === null) {
    return null;
  }
  const stage = record.stage ?? null;
  const assetIndex = record.assetIndex ?? null;
  if (
    (stage !== null && typeof stage !== "string") ||
    typeof record.retryable !== "boolean" ||
    (assetIndex !== null &&
      (typeof assetIndex !== "number" || !Number.isInteger(assetIndex)))
  ) {
    throw new InvalidResponseError();
  }
  return {
    code: expectString(record, "code"),
    message: expectString(record, "message"),
    stage,
    retryable: record.retryable,
    assetIndex,
  };
}

function parseIntegerArray(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => Number.isInteger(entry) && entry >= 0)
  ) {
    throw new InvalidResponseError();
  }
  return [...value] as number[];
}

export function expectEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new InvalidResponseError();
  }
  return value as T[number];
}

export function validateIdempotencyKey(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 128 ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new ConfigurationError(
      "idempotencyKey must contain 8-128 printable ASCII characters without spaces.",
    );
  }
}

export function createIdempotencyKey(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") {
    return `sdk-${randomUUID.call(globalThis.crypto)}`;
  }
  return `sdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function prepareAssets(assets: readonly InkletAsset[]): {
  request: CreateContentAssetInput[];
  binary: PreparedBinary[];
} {
  const request: CreateContentAssetInput[] = [];
  const binary: PreparedBinary[] = [];

  assets.forEach((asset, assetIndex) => {
    validateAsset(asset);
    switch (asset.type) {
      case "text":
        request.push({ type: "text", text: asset.text });
        break;
      case "link":
        request.push({ type: "link", url: asset.url });
        break;
      case "image":
      case "file": {
        const blob = assetBlob(asset);
        request.push({
          type: asset.type,
          filename: asset.filename,
          contentType: asset.contentType,
          sizeBytes: blob.size,
        } as ContentImageInput | ContentFileInput);
        binary.push({ asset, assetIndex, blob });
        break;
      }
    }
  });

  return { request, binary };
}

async function uploadTickets(
  transport: ResourceTransport,
  contentId: string,
  tickets: readonly UploadTicket[],
  binary: readonly PreparedBinary[],
): Promise<number[]> {
  const byIndex = new Map(binary.map((entry) => [entry.assetIndex, entry]));
  const results = await Promise.allSettled(
    tickets.map(async (ticket) => {
      const entry = byIndex.get(ticket.assetIndex);
      if (entry === undefined) {
        throw new InvalidResponseError();
      }
      await transport.upload({
        url: ticket.url,
        fields: ticket.fields,
        blob: entry.blob,
        filename: entry.asset.filename,
        contentType: entry.asset.contentType,
        assetIndex: entry.assetIndex,
        contentId,
      });
      return ticket.assetIndex;
    }),
  );

  const failed: number[] = [];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failed.push(tickets[index]?.assetIndex ?? index);
    }
  });
  return [...new Set(failed)].sort((a, b) => a - b);
}

function validateTickets(
  tickets: readonly UploadTicket[],
  binary: readonly PreparedBinary[],
  expectedIndexes: readonly number[] = binary.map((entry) => entry.assetIndex),
): void {
  const actual = tickets.map((ticket) => ticket.assetIndex);
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== expectedIndexes.length ||
    !expectedIndexes.every((index) => actual.includes(index))
  ) {
    throw new InvalidResponseError();
  }
}

export function validateWaitNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new ConfigurationError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return resolved;
}

export function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) {
    throw new OperationAbortedError(message);
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
      reject(new OperationAbortedError(message));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
