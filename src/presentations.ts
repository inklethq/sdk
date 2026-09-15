import { validateAsset, type ImageAsset, type InkletAsset } from "./assets.js";
import {
  type Analysis,
  type AnalysisContext,
  type AnalysisMode,
  type AnalysesResource,
  type WaitForAnalysisOptions,
} from "./analyses.js";
import { ContentsResource, expectEnum, parseProblem } from "./contents.js";
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

/**
 * How a Content ended up in a Presentation.
 *
 * `input`: the caller named it in the Analysis `contentIds`.
 * `context`: the agent retrieved it from the user's history and used it.
 */
export type PresentationContentRole = "input" | "context";

/** One Content used by a Presentation, with the role it played. */
export interface PresentationContentRef {
  id: string;
  role: PresentationContentRole;
}

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

/**
 * Where one rendition is in its own lifecycle, independent of the
 * Presentation's `state`.
 *
 * `preparing`: the render has not landed yet. A state, not an error — read the
 * Presentation again until it settles.
 * `ready`: the pixels exist.
 * `failed`: this geometry could not be produced. The rendition stays readable
 * and neither the Scene nor any sibling rendition is affected; asking for the
 * same geometry again returns the same rendition.
 */
export type PresentationRenditionState = "preparing" | "ready" | "failed";

export interface PresentationRendition {
  id: string;
  mediaType: "image/png";
  format: "png";
  width: number;
  height: number;
  /**
   * Part of this rendition's identity, not just of the request that asked for
   * it: the backend deduplicates on format, geometry, and colour mode
   * together, so two renditions of one Presentation can differ by nothing
   * else.
   */
  colorMode: PresentationColorMode;
  state: PresentationRenditionState;
  /**
   * A short-lived signed link to the PNG, minted per response.
   *
   * `null` while `state` is `preparing` or `failed` — there is no object to
   * link to — and also on the rare `ready` rendition the backend could not
   * sign, which it reports as a link-less rendition rather than failing the
   * whole read. Always branch on `url`, never on `state` alone. Reading the
   * Presentation again issues a fresh URL for the same stored PNG; it never
   * re-renders.
   */
  url: string | null;
  /**
   * When `url` stops working, not when the render does. `null` exactly when
   * `url` is.
   */
  expiresAt: string | null;
  updatedAt: string;
  /**
   * Why this rendition could not be produced. Set only when `state` is
   * `failed`, and the only place that reason appears — the Presentation's own
   * `failure` covers Scene generation, not rasterisation.
   */
  failure: PresentationProblem | null;
}

export interface Presentation {
  id: string;
  /** Derived from whether `displayId` is present. */
  kind: "generated" | "display";
  displayId: string | null;
  /**
   * The Analysis that produced this Presentation. Always set by current
   * backends; `null` only for Presentations stored before Analyses existed.
   */
  analysisId: string | null;
  /**
   * The Contents behind this Presentation, ordered by the backend: `input`
   * refs first, in the order the Analysis named them, then `context` refs the
   * agent retrieved itself. A Content appears at most once.
   */
  contentIds: readonly PresentationContentRef[];
  /**
   * Whether the model produced this Presentation. Same values as
   * `Analysis.mode`; target, context, and trigger live on the Analysis.
   */
  mode: AnalysisMode;
  state: PresentationState;
  /**
   * What this Presentation is called in a Display's history: the plan's own
   * title, else the template's title parameter, else the first input
   * Content's title or an excerpt of its text, else the Analysis title or the
   * template name. `null` only for Presentations stored before titles were
   * resolved at acceptance.
   */
  title: string | null;
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
  /**
   * How far back this list is allowed to see, as an RFC3339 UTC timestamp.
   *
   * The plan caps the Display history a list may reach: the Free plan sees the
   * last 7 days, Pro sees all of it. The backend clamps instead of refusing, so
   * Display Presentations created before this instant are simply left out of
   * `items` and paging past it ends the list. Read it as the floor of what you
   * are showing, not as an error; nothing is deleted, and after an upgrade the
   * same call returns the older rows untouched.
   *
   * Reported whenever a floor is in force, whether or not any row fell outside
   * it; `null` when no floor applies — an unlimited plan, or a scope with no
   * Display half (`scope: "generated"`). Only the Display half is capped, so
   * `scope: "display"` and `scope: "all"` can report a floor.
   * `displays.listQueue()`, `displays.current()`, and
   * `presentations.retrieve()` are not affected: a Presentation you already
   * hold the id for stays readable.
   */
  historyWindowStart: string | null;
}

export interface RetrievePresentationOptions {
  /** Legacy Display image selection. Generated Presentations return all renditions. */
  format?: PresentationImageFormat;
}

export interface ListPresentationsOptions {
  scope?: "generated" | "display" | "all";
  state?: PresentationState;
  /**
   * Keep only Presentations targeted at this Display, which is how you read
   * one panel's history: `displays.listQueue()` covers what has not been shown
   * yet, while this also returns the `published`, `confirmed`, and `expired`
   * ones. Combines with `state`, `cursor`, and `limit`.
   *
   * `scope` is optional here and defaults to `display`, since that is the only
   * scope a Display filter can mean. `scope: "all"` narrows to the Display half
   * just the same, and `scope: "generated"` contradicts the filter and is
   * rejected with `code: "invalid_request"`.
   *
   * A Display id that is not a well-formed id is rejected the same way; one
   * that does not exist or belongs to someone else simply returns an empty
   * page.
   */
  displayId?: string;
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
    if (options.displayId !== undefined) {
      query.set("displayId", encodePathSegment(options.displayId, "displayId"));
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/presentations${suffix}`,
    );
    const record = expectRecord(response);
    return {
      ...parsePage(record, parsePresentation),
      historyWindowStart: nullableString(record.historyWindowStart),
    };
  }

  /**
   * Wait for the Analysis started by `generate` and return its one
   * Presentation. An `{ output }` target always produces exactly one
   * Presentation, so `NoChangeError` is unreachable on the `generate()` path;
   * it remains possible when this is called with an Analysis that named no
   * `contentIds`.
   *
   * Analyses with `context: "history"` or `trigger: "scheduled"` queue behind
   * the user's other history Analyses. Raise `timeoutMs` for those; a timeout
   * does not cancel the Analysis.
   *
   * This waits for the Analysis, which settles once the Scene is durable — the
   * pixels can still be rendering. Check `state` on the Presentation, or on the
   * rendition you want, before reaching for a `url`.
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

  /**
   * Create another PNG rendition from the persisted Scene without rerunning
   * AI.
   *
   * The rasterisation is asynchronous, so a geometry the Presentation does not
   * already have comes back `state: "preparing"` with `url: null`: read the
   * Presentation again until that rendition is `ready`. A geometry it already
   * has is returned as it stands — `ready` with a fresh link, or `preparing`
   * if an earlier call is still rendering it — and starts no second render.
   */
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
    contentIds: parseContentRefs(record.contentIds),
    mode: expectEnum(record.mode, ["ai", "direct"] as const),
    state,
    title: nullableString(record.title),
    output: parsePresentationOutput(record.output),
    scene: parsePresentationScene(record.scene),
    renditions,
    image: parseImage(nullableRecord(record.image ?? null)),
    failure: parseProblem(nullableRecord(record.failure ?? null)),
    createdAt: expectString(record, "createdAt"),
    updatedAt: expectString(record, "updatedAt"),
  };
}

/** Parses the `[{ id, role }]` shape shared by Presentations and queue items. */
export function parseContentRefs(value: unknown): PresentationContentRef[] {
  return expectRecordArray(value).map((entry) => ({
    id: expectString(entry, "id"),
    role: expectEnum(entry.role, ["input", "context"] as const),
  }));
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
  // `url` and `expiresAt` are read as nullable rather than cross-checked
  // against `state`. The backend documents the pairing, but it also drops the
  // link from a `ready` rendition it could not sign rather than failing the
  // read — so insisting on it here would turn a degraded response into a
  // thrown one, which is the whole bug this parser used to have.
  return {
    id: expectString(record, "id"),
    mediaType: "image/png",
    format: "png",
    width,
    height,
    colorMode: expectEnum(
      record.colorMode,
      ["color", "grayscale", "monochrome"] as const,
    ),
    state: expectEnum(
      record.state,
      ["preparing", "ready", "failed"] as const,
    ),
    url: nullableString(record.url),
    expiresAt: nullableString(record.expiresAt),
    updatedAt: expectString(record, "updatedAt"),
    failure: parseProblem(nullableRecord(record.failure ?? null)),
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
