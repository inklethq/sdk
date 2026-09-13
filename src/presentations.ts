import {
  validateAsset,
  type ImageAsset,
  type InkletAsset,
} from "./assets.js";
import { ContentsResource, type Content } from "./contents.js";
import {
  ConfigurationError,
  InvalidResponseError,
  OperationAbortedError,
  OperationTimeoutError,
  PresentationGenerationError,
} from "./errors.js";
import { ContentSubmissionRunner, type PushResult } from "./push.js";
import {
  SDK_API_PREFIX,
  appendCursorAndLimit,
  encodePathSegment,
  expectInteger,
  expectRecord,
  expectRecordArray,
  expectString,
  expectStringArray,
  nullableRecord,
  nullableString,
  parsePage,
  type ResourceTransport,
} from "./resource.js";
import {
  parsePresentationOutput,
  parsePresentationScene,
  validatePresentationOutputRequest,
  type PresentationColorMode,
  type PresentationOutput,
  type PresentationOutputRequest,
  type PresentationScene,
  type PresentationViewport,
} from "./scene.js";

export type PresentationState =
  | "preparing"
  | "ready"
  | "queued"
  | "published"
  | "confirmed"
  | "expired"
  | "failed";

export type PresentationImageFormat = "png" | "raw2" | "raw4";

export interface PresentationProblem {
  code: string;
  message: string;
  stage: string | null;
  retryable: boolean;
  assetIndex: number | null;
}

/** Legacy single-image view retained for Display Presentations. */
export interface PresentationImage {
  url: string;
  format: PresentationImageFormat;
  width: number;
  height: number;
  expiresAt: string;
  updatedAt: string;
}

export interface PresentationRendition {
  id: string;
  mediaType: "image/png";
  format: "png";
  width: number;
  height: number;
  url: string;
  expiresAt: string;
  updatedAt: string;
}

export interface Presentation {
  id: string;
  /** Derived from whether `displayId` is present. */
  kind: "generated" | "display";
  displayId: string | null;
  contentIds: readonly string[];
  mode: "auto" | "manual" | "hardcode" | "";
  state: PresentationState;
  output: PresentationOutput | null;
  scene: PresentationScene | null;
  renditions: readonly PresentationRendition[];
  /** @deprecated Prefer `renditions`; this remains for v0.1 Display reads. */
  image: PresentationImage | null;
  failure: PresentationProblem | null;
  createdAt: string;
  updatedAt: string;
}

export interface PresentationPage {
  items: readonly Presentation[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface RetrievePresentationOptions {
  /** Legacy Display image selection. Generated Presentations return all renditions. */
  format?: PresentationImageFormat;
}

export interface ListPresentationsOptions {
  scope?: "generated" | "display" | "all";
  state?: PresentationState;
  cursor?: string;
  limit?: number;
}

interface GenerateBaseInput {
  idempotencyKey?: string;
  intent?: string;
  title?: string;
  output?: PresentationOutputRequest;
}

export interface GenerateAutoPresentationInput extends GenerateBaseInput {
  mode?: "auto";
  assets: readonly InkletAsset[];
}

export interface GenerateHardcodePresentationInput extends GenerateBaseInput {
  mode: "hardcode";
  image: ImageAsset;
}

export type GeneratePresentationInput =
  | GenerateAutoPresentationInput
  | GenerateHardcodePresentationInput;

export interface PresentationGeneration extends PushResult {
  /** The targetless path creates exactly one Presentation once ready. */
  presentationIds: readonly string[];
}

export interface WaitUntilReadyOptions {
  /** Defaults to 1,000 ms. */
  pollIntervalMs?: number;
  /** Defaults to 120,000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CreatePresentationRenditionInput {
  preset?: string;
  viewport?: PresentationViewport;
  colorMode?: PresentationColorMode;
}

export class PresentationsResource {
  readonly #transport: ResourceTransport;
  readonly #contents: ContentsResource;
  readonly #submission: ContentSubmissionRunner;

  constructor(
    transport: ResourceTransport,
    contents: ContentsResource = new ContentsResource(transport),
  ) {
    this.#transport = transport;
    this.#contents = contents;
    this.#submission = new ContentSubmissionRunner(transport, contents);
  }

  /**
   * Submit Content that generates one Presentation without requiring a Display.
   * Upload and confirmation behavior matches the high-level Push helpers.
   */
  async generate(input: GeneratePresentationInput): Promise<PresentationGeneration> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError(
        "Presentation generation requires an input object.",
      );
    }
    const output = input.output ?? {};
    validatePresentationOutputRequest(output);

    if (input.mode === "hardcode") {
      validateAsset(input.image);
      if (
        input.image.type !== "image" ||
        (input.image.contentType !== "image/png" &&
          input.image.contentType !== "image/jpeg")
      ) {
        throw new ConfigurationError(
          "Hardcode Presentation generation requires one PNG or JPEG image.",
        );
      }
      return this.#submission.run(
        "hardcode",
        input,
        null,
        [input.image],
        { output, operation: "Presentation generation" },
      );
    }

    if (input.mode !== undefined && input.mode !== "auto") {
      throw new ConfigurationError(
        "Presentation generation mode must be auto or hardcode.",
      );
    }
    return this.#submission.run("auto", input, null, input.assets, {
      output,
      operation: "Presentation generation",
    });
  }

  async retrieve(
    presentationId: string,
    options: RetrievePresentationOptions = {},
  ): Promise<Presentation> {
    const id = encodePathSegment(presentationId, "presentationId");
    const query = formatQuery(options.format);
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/presentations/${id}${query}`,
    );
    return parsePresentation(expectRecord(response));
  }

  async list(options: ListPresentationsOptions = {}): Promise<PresentationPage> {
    const query = new URLSearchParams();
    appendCursorAndLimit(query, options);
    if (options.scope !== undefined) {
      if (!["generated", "display", "all"].includes(options.scope)) {
        throw new ConfigurationError(
          "scope must be generated, display, or all.",
        );
      }
      query.set("scope", options.scope);
    }
    if (options.state !== undefined) {
      if (!isPresentationState(options.state)) {
        throw new ConfigurationError("state is not a valid Presentation state.");
      }
      query.set("state", options.state);
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/presentations${suffix}`,
    );
    return parsePage(response, parsePresentation);
  }

  /**
   * Poll the Content returned by `generate` and resolve its one Presentation.
   */
  async waitUntilReady(
    generationOrContentId: PresentationGeneration | string,
    options: WaitUntilReadyOptions = {},
  ): Promise<Presentation> {
    const contentId =
      typeof generationOrContentId === "string"
        ? encodePathSegment(generationOrContentId, "contentId")
        : encodePathSegment(generationOrContentId.contentId, "contentId");
    const pollIntervalMs = validateWaitNumber(
      options.pollIntervalMs,
      1_000,
      100,
      60_000,
      "pollIntervalMs",
    );
    const timeoutMs = validateWaitNumber(
      options.timeoutMs,
      120_000,
      1,
      30 * 60_000,
      "timeoutMs",
    );
    const startedAt = Date.now();
    let content: Content | undefined =
      typeof generationOrContentId === "string"
        ? undefined
        : generationOrContentId.content;

    while (true) {
      throwIfAborted(options.signal);
      content =
        content === undefined
          ? await this.#contents.retrieve(contentId)
          : content;

      if (content.state === "failed") {
        throw new PresentationGenerationError(
          content.processing.error?.message ??
            "Inklet could not generate the Presentation.",
          {
            contentId: content.id,
            details: content.processing.error
              ? {
                  stage: content.processing.error.stage,
                  retryable: content.processing.error.retryable,
                  backendCode: content.processing.error.code,
                }
              : undefined,
          },
        );
      }
      if (content.state === "ready") {
        if (content.presentationIds.length !== 1) {
          throw new InvalidResponseError();
        }
        return this.retrieve(content.presentationIds[0] as string);
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new OperationTimeoutError(
          `Presentation generation did not finish within ${timeoutMs} ms.`,
          { details: { contentId: content.id, timeoutMs } },
        );
      }
      await delay(Math.min(pollIntervalMs, timeoutMs - elapsed), options.signal);
      content = undefined;
    }
  }

  /** Create another PNG rendition from the persisted Scene without rerunning AI. */
  async render(
    presentationId: string,
    input: CreatePresentationRenditionInput,
  ): Promise<PresentationRendition> {
    const id = encodePathSegment(presentationId, "presentationId");
    const output: PresentationOutputRequest = { ...input, formats: ["png"] };
    validatePresentationOutputRequest(output);
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/presentations/${id}/renditions`,
      { method: "POST", json: output },
    );
    return parseRendition(expectRecord(response));
  }
}

export function parsePresentation(
  record: Record<string, unknown>,
): Presentation {
  const mode = record.mode;
  if (
    typeof mode !== "string" ||
    (mode !== "" && mode !== "auto" && mode !== "manual" && mode !== "hardcode")
  ) {
    throw new InvalidResponseError();
  }

  const state = expectString(record, "state");
  if (!isPresentationState(state)) {
    throw new InvalidResponseError();
  }
  const displayId = nullableString(record.displayId);
  const renditions =
    record.renditions === undefined
      ? []
      : expectRecordArray(record.renditions).map(parseRendition);

  return {
    id: expectString(record, "id"),
    kind: displayId === null ? "generated" : "display",
    displayId,
    contentIds: expectStringArray(record.contentIds),
    mode,
    state,
    output: parsePresentationOutput(record.output),
    scene: parsePresentationScene(record.scene),
    renditions,
    image: parseImage(nullableRecord(record.image ?? null)),
    failure: parseProblem(nullableRecord(record.failure ?? null)),
    createdAt: expectString(record, "createdAt"),
    updatedAt: expectString(record, "updatedAt"),
  };
}

export function parsePresentationProblem(
  record: Record<string, unknown> | null,
): PresentationProblem | null {
  return parseProblem(record);
}

function parseRendition(record: Record<string, unknown>): PresentationRendition {
  if (record.mediaType !== "image/png" || record.format !== "png") {
    throw new InvalidResponseError();
  }
  const width = expectInteger(record, "width");
  const height = expectInteger(record, "height");
  if (width <= 0 || height <= 0) {
    throw new InvalidResponseError();
  }
  return {
    id: expectString(record, "id"),
    mediaType: "image/png",
    format: "png",
    width,
    height,
    url: expectString(record, "url"),
    expiresAt: expectString(record, "expiresAt"),
    updatedAt: expectString(record, "updatedAt"),
  };
}

function parseImage(
  record: Record<string, unknown> | null,
): PresentationImage | null {
  if (record === null) {
    return null;
  }
  const format = expectString(record, "format");
  if (format !== "png" && format !== "raw2" && format !== "raw4") {
    throw new InvalidResponseError();
  }
  return {
    url: expectString(record, "url"),
    format,
    width: expectInteger(record, "width"),
    height: expectInteger(record, "height"),
    expiresAt: expectString(record, "expiresAt"),
    updatedAt: expectString(record, "updatedAt"),
  };
}

function parseProblem(
  record: Record<string, unknown> | null,
): PresentationProblem | null {
  if (record === null) {
    return null;
  }
  if (typeof record.retryable !== "boolean") {
    throw new InvalidResponseError();
  }
  const assetIndex = record.assetIndex;
  if (
    assetIndex !== null &&
    (typeof assetIndex !== "number" || !Number.isInteger(assetIndex))
  ) {
    throw new InvalidResponseError();
  }
  return {
    code: expectString(record, "code"),
    message: expectString(record, "message"),
    stage: nullableString(record.stage),
    retryable: record.retryable,
    assetIndex,
  };
}

function isPresentationState(value: unknown): value is PresentationState {
  return (
    typeof value === "string" &&
    [
      "preparing",
      "ready",
      "queued",
      "published",
      "confirmed",
      "expired",
      "failed",
    ].includes(value)
  );
}

export function formatQuery(format: PresentationImageFormat | undefined): string {
  if (format === undefined) {
    return "";
  }
  if (format !== "png" && format !== "raw2" && format !== "raw4") {
    throw new ConfigurationError("format must be png, raw2, or raw4.");
  }
  return `?format=${format}`;
}

function validateWaitNumber(
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new OperationAbortedError("Presentation generation was aborted.");
  }
}

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new OperationAbortedError("Presentation generation was aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
