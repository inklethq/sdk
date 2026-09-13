import { validateAsset, type ImageAsset, type InkletAsset } from "./assets.js";
import {
  type Analysis,
  type AnalysisContext,
  type AnalysesResource,
  type WaitForAnalysisOptions,
} from "./analyses.js";
import { ContentsResource, parseProblem } from "./contents.js";
import {
  ConfigurationError,
  InvalidResponseError,
  NoChangeError,
} from "./errors.js";
import { toPushResult, type PushResult } from "./push.js";
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
  /** The Analysis that produced this Presentation, when the backend reports it. */
  analysisId: string | null;
  contentIds: readonly string[];
  mode: "auto" | "manual" | "hardcode" | "";
  state: PresentationState;
  output: PresentationOutput | null;
  scene: PresentationScene | null;
  renditions: readonly PresentationRendition[];
  /** @deprecated Prefer `renditions`; this remains for Display reads. */
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
  context?: AnalysisContext;
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

/** The uploaded Content plus the targetless Analysis started for it. */
export type PresentationGeneration = PushResult;

export type WaitUntilReadyOptions = WaitForAnalysisOptions;

export interface CreatePresentationRenditionInput {
  preset?: string;
  viewport?: PresentationViewport;
  colorMode?: PresentationColorMode;
}

export class PresentationsResource {
  readonly #transport: ResourceTransport;
  readonly #contents: ContentsResource;
  readonly #analyses: AnalysesResource;

  constructor(
    transport: ResourceTransport,
    contents: ContentsResource,
    analyses: AnalysesResource,
  ) {
    this.#transport = transport;
    this.#contents = contents;
    this.#analyses = analyses;
  }

  /**
   * Upload Content and start a targetless Analysis for it. Equivalent to
   * `contents.upload()` followed by `analyze({ target: { output } })`.
   */
  async generate(input: GeneratePresentationInput): Promise<PresentationGeneration> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError(
        "Presentation generation requires an input object.",
      );
    }
    const output = input.output ?? {};
    validatePresentationOutputRequest(output);
    const keyOption =
      input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey };

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
      const uploaded = await this.#contents.upload({
        title: input.title ?? null,
        assets: [input.image],
        ...keyOption,
      });
      const analysis = await this.#analyses.direct({
        contentId: uploaded.content.id,
        target: { output },
        idempotencyKey: uploaded.idempotencyKey,
      });
      return toPushResult(uploaded.content, analysis, uploaded.idempotencyKey);
    }

    if (input.mode !== undefined && input.mode !== "auto") {
      throw new ConfigurationError(
        "Presentation generation mode must be auto or hardcode.",
      );
    }
    if (!Array.isArray(input.assets) || input.assets.length === 0) {
      throw new ConfigurationError(
        "Presentation generation requires at least one Asset.",
      );
    }
    const uploaded = await this.#contents.upload({
      title: input.title ?? null,
      assets: input.assets,
      ...keyOption,
    });
    const analysis = await this.#analyses.analyze({
      contentIds: [uploaded.content.id],
      context: input.context ?? "submitted",
      intent: input.intent ?? null,
      title: input.title ?? null,
      target: { output },
      idempotencyKey: uploaded.idempotencyKey,
    });
    return toPushResult(uploaded.content, analysis, uploaded.idempotencyKey);
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
   * Wait for the Analysis started by `generate` and return its one
   * Presentation. Throws `NoChangeError` if the Analysis completed without
   * producing one.
   */
  async waitUntilReady(
    generationOrAnalysis: PresentationGeneration | Analysis | string,
    options: WaitUntilReadyOptions = {},
  ): Promise<Presentation> {
    const analysisId =
      typeof generationOrAnalysis === "string"
        ? generationOrAnalysis
        : "analysisId" in generationOrAnalysis
          ? generationOrAnalysis.analysisId
          : generationOrAnalysis.id;
    const analysis = await this.#analyses.wait(analysisId, options);
    if (analysis.outcome === "no_change" || analysis.presentationIds.length === 0) {
      throw new NoChangeError(analysis.id, analysis.noChangeReason);
    }
    if (analysis.presentationIds.length !== 1) {
      throw new InvalidResponseError();
    }
    return this.retrieve(analysis.presentationIds[0] as string);
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
  const mode = record.mode ?? "";
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
    analysisId: nullableString(record.analysisId),
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
