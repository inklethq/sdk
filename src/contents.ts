import { ConfigurationError, InvalidResponseError } from "./errors.js";
import {
  ALLOWED_FILE_CONTENT_TYPES,
  ALLOWED_IMAGE_CONTENT_TYPES,
  MAX_ASSETS_PER_CONTENT,
  MAX_ASSET_SIZE_BYTES,
  type AllowedFileContentType,
  type AllowedImageContentType,
  type InkletAsset,
} from "./assets.js";
import type { PresentationProblem } from "./presentations.js";
import {
  parsePresentationOutput,
  validatePresentationOutputRequest,
  type PresentationOutput,
  type PresentationOutputRequest,
} from "./scene.js";
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
  nullableString,
  parsePage,
  type ResourceTransport,
} from "./resource.js";

export type ContentMode = "auto" | "manual" | "hardcode";
export type ContentState = "pending" | "processing" | "ready" | "failed";
export type ContentUploadStatus = "awaiting_upload" | "partial" | "complete";
export type ContentAssetUploadState = "pending" | "uploaded" | "failed";
export type ContentProcessingStage =
  | "awaiting_upload"
  | "fetching_links"
  | "summarizing"
  | "routing"
  | "creating_presentations"
  | "complete"
  | "failed";

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

export interface ContentUpload {
  status: ContentUploadStatus;
  failedAssetIndexes: readonly number[];
}

export interface ContentProcessing {
  stage: ContentProcessingStage | null;
  warnings: readonly PresentationProblem[];
  error: PresentationProblem | null;
}

export interface Content {
  id: string;
  mode: ContentMode;
  requestedDisplayId: string | null;
  intent: string | null;
  title: string | null;
  /** Non-null when this Content generates one targetless Presentation. */
  output: PresentationOutput | null;
  state: ContentState;
  assets: readonly ContentAsset[];
  upload: ContentUpload;
  processing: ContentProcessing;
  presentationIds: readonly string[];
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
  mode?: ContentMode;
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

export interface CreateContentRequest {
  mode: ContentMode;
  displayId?: string | null;
  intent?: string | null;
  title?: string | null;
  /**
   * Generate a Presentation without delivering it to a Display.
   *
   * Omit this field to preserve the v0.1 Display Push behavior.
   */
  output?: PresentationOutputRequest;
  assets: readonly CreateContentAssetInput[];
}

export class ContentsResource {
  readonly #transport: ResourceTransport;

  constructor(transport: ResourceTransport) {
    this.#transport = transport;
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
      json: input,
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
      validateEnumOption(
        options.state,
        ["pending", "processing", "ready", "failed"],
        "state",
      );
      query.set("state", options.state);
    }
    if (options.mode !== undefined) {
      validateEnumOption(options.mode, ["auto", "manual", "hardcode"], "mode");
      query.set("mode", options.mode);
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/contents${suffix}`,
    );
    return parsePage(response, parseContent);
  }

  async confirm(contentId: string): Promise<Content> {
    const id = encodePathSegment(contentId, "contentId");
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/contents/${id}/confirm`,
      { method: "POST" },
    );
    return parseContent(expectRecord(response));
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
}

function validateCreateContentRequest(input: CreateContentRequest): void {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Content creation requires an input object.");
  }
  validateEnumOption(input.mode, ["auto", "manual", "hardcode"], "mode");

  if (input.output !== undefined) {
    validatePresentationOutputRequest(input.output);
    if (input.mode === "manual") {
      throw new ConfigurationError(
        "Targetless Presentation generation supports auto or hardcode mode, not manual.",
      );
    }
    if (input.displayId !== undefined && input.displayId !== null) {
      throw new ConfigurationError(
        "Targetless Presentation Content must omit displayId.",
      );
    }
  } else if (input.mode === "auto") {
    if (input.displayId !== undefined && input.displayId !== null) {
      throw new ConfigurationError("Auto Content must omit displayId.");
    }
  } else if (
    typeof input.displayId !== "string" ||
    input.displayId.trim().length === 0
  ) {
    throw new ConfigurationError(
      `${input.mode === "manual" ? "Manual" : "Hardcode"} Content requires displayId.`,
    );
  }

  validateOptionalString(input.intent, "intent");
  validateOptionalString(input.title, "title");

  if (!Array.isArray(input.assets) || input.assets.length === 0) {
    throw new ConfigurationError("Content requires at least one Asset.");
  }
  if (input.assets.length > MAX_ASSETS_PER_CONTENT) {
    throw new ConfigurationError(
      `Content cannot contain more than ${MAX_ASSETS_PER_CONTENT} Assets.`,
    );
  }
  if (input.mode === "hardcode" && input.assets.length !== 1) {
    throw new ConfigurationError(
      "Hardcode Content requires exactly one PNG or JPEG image.",
    );
  }

  input.assets.forEach((asset, assetIndex) => {
    if (!asset || typeof asset !== "object") {
      throw new ConfigurationError(`Asset ${assetIndex} must be an object.`);
    }
    switch (asset.type) {
      case "text":
        if (
          input.mode === "hardcode" ||
          typeof asset.text !== "string" ||
          asset.text.trim().length === 0
        ) {
          throw new ConfigurationError(
            `Asset ${assetIndex} must contain non-whitespace text.`,
          );
        }
        return;
      case "link":
        if (input.mode === "hardcode") {
          throw new ConfigurationError(
            "Hardcode Content requires exactly one PNG or JPEG image.",
          );
        }
        validateContentLink(asset.url, assetIndex);
        return;
      case "image":
        validateBinaryInput(asset, assetIndex, ALLOWED_IMAGE_CONTENT_TYPES);
        if (
          input.mode === "hardcode" &&
          asset.contentType !== "image/png" &&
          asset.contentType !== "image/jpeg"
        ) {
          throw new ConfigurationError(
            "Hardcode Content requires exactly one PNG or JPEG image.",
          );
        }
        return;
      case "file":
        if (input.mode === "hardcode") {
          throw new ConfigurationError(
            "Hardcode Content requires exactly one PNG or JPEG image.",
          );
        }
        validateBinaryInput(asset, assetIndex, ALLOWED_FILE_CONTENT_TYPES);
        return;
      default:
        throw new ConfigurationError(`Asset ${assetIndex} has an unsupported type.`);
    }
  });
}

function validateOptionalString(
  value: string | null | undefined,
  name: "intent" | "title",
): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new ConfigurationError(`${name} must be a string or null.`);
  }
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

function validateEnumOption(
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
  const mode = expectEnum(record.mode, ["auto", "manual", "hardcode"] as const);
  const state = expectEnum(
    record.state,
    ["pending", "processing", "ready", "failed"] as const,
  );
  const upload = expectRecord(record.upload);
  const processing = expectRecord(record.processing);
  const stage = processing.stage;
  if (stage !== null && !isProcessingStage(stage)) {
    throw new InvalidResponseError();
  }

  return {
    id: expectString(record, "id"),
    mode,
    requestedDisplayId: nullableString(record.requestedDisplayId),
    intent: nullableString(record.intent),
    title: nullableString(record.title),
    output: parsePresentationOutput(record.output),
    state,
    assets: expectRecordArray(record.assets).map(parseAsset),
    upload: {
      status: expectEnum(
        upload.status,
        ["awaiting_upload", "partial", "complete"] as const,
      ),
      failedAssetIndexes: parseIntegerArray(upload.failedAssetIndexes),
    },
    processing: {
      stage,
      warnings: expectRecordArray(processing.warnings).map(parseProblem),
      error:
        processing.error === null
          ? null
          : parseProblem(expectRecord(processing.error)),
    },
    presentationIds: expectStringArray(record.presentationIds),
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

function parseProblem(record: Record<string, unknown>): PresentationProblem {
  const stage = record.stage;
  const assetIndex = record.assetIndex;
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

function expectEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new InvalidResponseError();
  }
  return value as T[number];
}

function isProcessingStage(value: unknown): value is ContentProcessingStage {
  return (
    typeof value === "string" &&
    [
      "awaiting_upload",
      "fetching_links",
      "summarizing",
      "routing",
      "creating_presentations",
      "complete",
      "failed",
    ].includes(value)
  );
}

function validateIdempotencyKey(value: string): void {
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
