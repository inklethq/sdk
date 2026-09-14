import {
  ContentsResource,
  createIdempotencyKey,
  delay,
  expectEnum,
  parseProblem,
  throwIfAborted,
  validateEnumOption,
  validateIdempotencyKey,
  validateWaitNumber,
} from "./contents.js";
import {
  AnalysisFailedError,
  ConfigurationError,
  InvalidResponseError,
  OperationTimeoutError,
} from "./errors.js";
import {
  analysisEventTimeline,
  listAnalysisEvents,
  retrieveAnalysisArchive,
  watchAnalysisEvents,
  type AnalysisArchive,
  type AnalysisEvent,
  type AnalysisEventPage,
  type ListAnalysisEventsOptions,
  type TimelineOptions,
  type WatchAnalysisOptions,
} from "./events.js";
import type { PresentationProblem } from "./presentations.js";
import {
  SDK_API_PREFIX,
  appendCursorAndLimit,
  encodePathSegment,
  expectRecord,
  expectString,
  expectStringArray,
  nullableRecord,
  nullableString,
  parsePage,
  type ResourceTransport,
} from "./resource.js";
import {
  parsePresentationOutput,
  validatePresentationOutputRequest,
  type PresentationOutput,
  type PresentationOutputRequest,
} from "./scene.js";

export type AnalysisMode = "ai" | "direct";
export type AnalysisTrigger = "api" | "scheduled";
export type AnalysisState = "queued" | "running" | "completed" | "failed";
export type AnalysisOutcome = "presentations" | "no_change";

/**
 * `submitted`: the agent only sees the listed Contents.
 * `history`: the agent may also retrieve the user's earlier Contents.
 */
export type AnalysisContext = "submitted" | "history";

/** Requested look-back window: a relative duration, e.g. `"24h"`, `"7d"`, `"90m"`. */
export interface AnalysisScopeInput {
  since: string;
}

/** The window the backend resolved at creation time. */
export interface AnalysisScope extends AnalysisScopeInput {
  /**
   * Absolute start of the window, resolved from `since` when the Analysis was
   * created, so a queued Analysis reads the same history it would have read
   * immediately. The window is `[sinceAt, createdAt]`. `null` when the backend
   * did not report it.
   */
  sinceAt: string | null;
}

export type AnalysisTargetInput =
  | { displayId: string }
  | { displayIds: readonly string[] }
  | { output: PresentationOutputRequest };

export type AnalysisTarget =
  | { displayId: string }
  | { displayIds: readonly string[] }
  | { output: PresentationOutput };

export interface Analysis {
  id: string;
  mode: AnalysisMode;
  trigger: AnalysisTrigger;
  state: AnalysisState;
  outcome: AnalysisOutcome | null;
  noChangeReason: string | null;
  contentIds: readonly string[];
  context: AnalysisContext;
  scope: AnalysisScope | null;
  intent: string | null;
  title: string | null;
  /** `null` means the agent chose (or will choose) the Displays. */
  target: AnalysisTarget | null;
  presentationIds: readonly string[];
  failure: PresentationProblem | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisPage {
  items: readonly Analysis[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AnalyzeInput {
  /** Omit or leave empty to analyze recent history without new Content. */
  contentIds?: readonly string[];
  /** Defaults to `submitted` when `contentIds` is given, else `history`. */
  context?: AnalysisContext;
  /** Only meaningful with `context: "history"`. */
  scope?: AnalysisScopeInput;
  intent?: string | null;
  title?: string | null;
  /** Omit to let the agent choose Displays. */
  target?: AnalysisTargetInput;
  idempotencyKey?: string;
}

export interface DirectInput {
  /** A Content holding exactly one PNG or JPEG image. */
  contentId: string;
  target: AnalysisTargetInput;
  idempotencyKey?: string;
}

/** Low-level request with `mode` explicit; `analyze()` and `direct()` wrap it. */
export interface CreateAnalysisRequest extends Omit<AnalyzeInput, "idempotencyKey"> {
  mode: AnalysisMode;
}

export interface ListAnalysesOptions {
  /** Only Analyses that listed this Content in contentIds (role "input"). */
  contentId?: string;
  state?: AnalysisState;
  trigger?: AnalysisTrigger;
  cursor?: string;
  limit?: number;
}

export interface WaitForAnalysisOptions {
  /** Defaults to 1,000 ms. */
  pollIntervalMs?: number;
  /** Defaults to 120,000 ms. Raise it for queued history Analyses. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const SCOPE_PATTERN = /^\d+[mhd]$/;

export class AnalysesResource {
  readonly #transport: ResourceTransport;

  constructor(transport: ResourceTransport, _contents?: ContentsResource) {
    this.#transport = transport;
  }

  /**
   * Run the agent over the given Contents and/or the user's history.
   *
   * Naming `contentIds` rules out `no_change`: every Content named appears in
   * at least one Presentation, or the Analysis fails with
   * `no_presentable_content`. `no_change` is only reachable when no
   * `contentIds` are given.
   *
   * `context: "history"` Analyses run one at a time per user, so this one may
   * sit in `queued` for a while rather than being rejected. Only a user over
   * the backend's queue limit gets `409 analysis_in_progress`.
   */
  async analyze(input: AnalyzeInput = {}): Promise<Analysis> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("analyze requires an input object.");
    }
    const { idempotencyKey, ...rest } = input;
    return this.create({ mode: "ai", ...rest }, idempotencyKey ?? createIdempotencyKey());
  }

  /** Show one uploaded image without AI. Server-side scaling matches Hardcode. */
  async direct(input: DirectInput): Promise<Analysis> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("direct requires an input object.");
    }
    if (typeof input.contentId !== "string" || input.contentId.trim().length === 0) {
      throw new ConfigurationError("direct requires contentId.");
    }
    if (input.target === undefined) {
      throw new ConfigurationError("direct requires a target.");
    }
    return this.create(
      {
        mode: "direct",
        contentIds: [input.contentId.trim()],
        context: "submitted",
        target: input.target,
      },
      input.idempotencyKey ?? createIdempotencyKey(),
    );
  }

  async create(
    input: CreateAnalysisRequest,
    idempotencyKey: string,
  ): Promise<Analysis> {
    const body = normalizeCreateRequest(input);
    validateIdempotencyKey(idempotencyKey);
    const response = await this.#transport.request(`${SDK_API_PREFIX}/analyses`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      json: body,
    });
    return parseAnalysis(expectRecord(response));
  }

  async retrieve(analysisId: string): Promise<Analysis> {
    const id = encodePathSegment(analysisId, "analysisId");
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/analyses/${id}`,
    );
    return parseAnalysis(expectRecord(response));
  }

  async list(options: ListAnalysesOptions = {}): Promise<AnalysisPage> {
    const query = new URLSearchParams();
    appendCursorAndLimit(query, options);
    if (options.contentId !== undefined) {
      query.set("contentId", encodePathSegment(options.contentId, "contentId"));
    }
    if (options.state !== undefined) {
      validateEnumOption(
        options.state,
        ["queued", "running", "completed", "failed"],
        "state",
      );
      query.set("state", options.state);
    }
    if (options.trigger !== undefined) {
      validateEnumOption(options.trigger, ["api", "scheduled"], "trigger");
      query.set("trigger", options.trigger);
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/analyses${suffix}`,
    );
    return parsePage(response, parseAnalysis);
  }

  /**
   * Poll until the Analysis is `completed` and return it. A `failed` Analysis
   * throws `AnalysisFailedError`; `failure.code` is on
   * `error.details.backendCode`, for example `no_presentable_content` when the
   * agent could not use the Contents that were named. `no_change` is a normal
   * completion and only possible when no `contentIds` were given; check
   * `outcome` on the result.
   *
   * `timeoutMs` defaults to 120,000 ms, which suits a `submitted` Analysis.
   * `context: "history"` and `trigger: "scheduled"` Analyses queue behind the
   * user's other history Analyses and can stay `queued` far longer, so raise
   * it for those, e.g. `wait(analysis, { timeoutMs: 15 * 60_000 })`. A timeout
   * does not cancel the Analysis: `analyses.retrieve()` still returns it later.
   */
  async wait(
    analysisOrId: Analysis | string,
    options: WaitForAnalysisOptions = {},
  ): Promise<Analysis> {
    const analysisId =
      typeof analysisOrId === "string" ? analysisOrId : analysisOrId.id;
    const pollIntervalMs = validateWaitNumber(
      options.pollIntervalMs, 1_000, 100, 60_000, "pollIntervalMs",
    );
    const timeoutMs = validateWaitNumber(
      options.timeoutMs, 120_000, 1, 30 * 60_000, "timeoutMs",
    );
    const startedAt = Date.now();
    let analysis = typeof analysisOrId === "string" ? undefined : analysisOrId;

    while (true) {
      throwIfAborted(options.signal, "Waiting for the Analysis was aborted.");
      analysis = analysis ?? (await this.retrieve(analysisId));

      if (analysis.state === "failed") {
        throw new AnalysisFailedError(
          analysis.failure?.message ?? "Inklet could not complete the Analysis.",
          {
            analysisId: analysis.id,
            details: analysis.failure
              ? {
                  stage: analysis.failure.stage,
                  retryable: analysis.failure.retryable,
                  backendCode: analysis.failure.code,
                }
              : undefined,
          },
        );
      }
      if (analysis.state === "completed") {
        return analysis;
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new OperationTimeoutError(
          `Analysis ${analysis.id} did not finish within ${timeoutMs} ms.`,
          { details: { analysisId: analysis.id, timeoutMs } },
        );
      }
      await delay(
        Math.min(pollIntervalMs, timeoutMs - elapsed),
        options.signal,
        "Waiting for the Analysis was aborted.",
      );
      analysis = undefined;
    }
  }

  /**
   * Read one page of the Analysis event stream, oldest first.
   *
   * Pass the previous page's `nextAfter` as `after` to continue. Use
   * `timeline()` when you want every event rather than one page.
   */
  async listEvents(
    analysisId: string,
    options: ListAnalysisEventsOptions = {},
  ): Promise<AnalysisEventPage> {
    return listAnalysisEvents(this.#transport, analysisId, options);
  }

  /**
   * Follow an Analysis live and yield events as the agent produces them.
   *
   * The SDK reads the server-sent event stream and falls back to polling
   * `listEvents()` when the response is not `text/event-stream`, which is what
   * a proxy that cannot carry streaming responses returns. A dropped
   * connection is resumed from the last `seq` (up to five attempts with
   * exponential back-off), so events are not lost across a reconnect, and
   * iteration ends once the Analysis reaches `completed` or `failed`.
   *
   * Events carry `summary` only. For tool inputs and outputs, read
   * `timeline({ detail: "full" })` after the Analysis has finished.
   *
   * ```ts
   * for await (const event of inklet.analyses.watch(analysis.id)) {
   *   console.log(event.summary);
   * }
   * ```
   */
  watch(
    analysisId: string,
    options: WatchAnalysisOptions = {},
  ): AsyncIterable<AnalysisEvent> {
    return watchAnalysisEvents(this.#transport, analysisId, options);
  }

  /**
   * Iterate every event of an Analysis, paging automatically.
   *
   * `detail: "full"` adds the verbatim agent payloads and requires a terminal
   * Analysis: this checks the state first and throws `ConflictError` with
   * `code: "analysis_in_progress"` rather than starting a walk the backend
   * would reject part way through.
   */
  timeline(
    analysisId: string,
    options: TimelineOptions = {},
  ): AsyncIterable<AnalysisEvent> {
    return analysisEventTimeline(
      this.#transport,
      analysisId,
      options,
      async () => (await this.retrieve(analysisId)).state,
    );
  }

  /**
   * Get a short-lived download URL for the Analysis run archive.
   *
   * Throws `NotFoundError` with `code: "archive_not_found"` when the Analysis
   * has no archive, for example while it is still running or after retention
   * has expired.
   */
  async archive(analysisId: string): Promise<AnalysisArchive> {
    return retrieveAnalysisArchive(this.#transport, analysisId);
  }
}

interface WireCreateAnalysis {
  mode: AnalysisMode;
  contentIds: string[];
  context: AnalysisContext;
  scope: AnalysisScopeInput | null;
  intent: string | null;
  title: string | null;
  target: AnalysisTargetInput | null;
}

function normalizeCreateRequest(input: CreateAnalysisRequest): WireCreateAnalysis {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Analysis creation requires an input object.");
  }
  validateEnumOption(input.mode, ["ai", "direct"], "mode");

  const contentIds = normalizeContentIds(input.contentIds);
  const context: AnalysisContext =
    input.context ?? (contentIds.length === 0 ? "history" : "submitted");
  validateEnumOption(context, ["submitted", "history"], "context");
  if (context === "submitted" && contentIds.length === 0) {
    throw new ConfigurationError(
      "An Analysis with context \"submitted\" requires at least one contentId. Use context \"history\" to analyze without new Content.",
    );
  }

  let scope: AnalysisScopeInput | null = null;
  if (input.scope !== undefined) {
    if (context !== "history") {
      throw new ConfigurationError("scope is only valid with context \"history\".");
    }
    scope = validateScope(input.scope);
  }

  for (const [name, value] of [["intent", input.intent], ["title", input.title]] as const) {
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new ConfigurationError(`${name} must be a string or null.`);
    }
  }

  const target = input.target === undefined ? null : normalizeTarget(input.target);

  if (input.mode === "direct") {
    if (contentIds.length !== 1) {
      throw new ConfigurationError("A direct Analysis requires exactly one contentId.");
    }
    if (context !== "submitted") {
      throw new ConfigurationError("A direct Analysis cannot use history context.");
    }
    if (target === null) {
      throw new ConfigurationError("A direct Analysis requires a target.");
    }
  }

  return {
    mode: input.mode,
    contentIds,
    context,
    scope,
    intent: input.intent ?? null,
    title: input.title ?? null,
    target,
  };
}

function normalizeContentIds(value: readonly string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ConfigurationError("contentIds must be an array of Content IDs.");
  }
  const ids = value.map((id, index) => {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new ConfigurationError(`contentIds[${index}] must be a non-empty string.`);
    }
    return id.trim();
  });
  if (new Set(ids).size !== ids.length) {
    throw new ConfigurationError("contentIds must not contain duplicates.");
  }
  return ids;
}

/** Returns only `since`: `sinceAt` is resolved by the backend, never sent. */
function validateScope(scope: AnalysisScopeInput): AnalysisScopeInput {
  if (
    !scope ||
    typeof scope !== "object" ||
    typeof scope.since !== "string" ||
    !SCOPE_PATTERN.test(scope.since)
  ) {
    throw new ConfigurationError(
      "scope.since must be a relative duration such as \"90m\", \"24h\", or \"7d\".",
    );
  }
  return { since: scope.since };
}

function normalizeTarget(target: AnalysisTargetInput): AnalysisTargetInput {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new ConfigurationError("target must be an object.");
  }
  const keys = Object.keys(target).filter((key) =>
    ["displayId", "displayIds", "output"].includes(key),
  );
  if (keys.length !== 1) {
    throw new ConfigurationError(
      "target must contain exactly one of displayId, displayIds, or output.",
    );
  }
  if ("displayId" in target) {
    if (typeof target.displayId !== "string" || target.displayId.trim().length === 0) {
      throw new ConfigurationError("target.displayId must be a non-empty string.");
    }
    return { displayId: target.displayId.trim() };
  }
  if ("displayIds" in target) {
    if (
      !Array.isArray(target.displayIds) ||
      target.displayIds.length === 0 ||
      !target.displayIds.every((id) => typeof id === "string" && id.trim().length > 0)
    ) {
      throw new ConfigurationError(
        "target.displayIds must contain one or more non-empty strings.",
      );
    }
    const ids = target.displayIds.map((id) => id.trim());
    if (new Set(ids).size !== ids.length) {
      throw new ConfigurationError("target.displayIds must not contain duplicates.");
    }
    return { displayIds: ids };
  }
  validatePresentationOutputRequest(target.output);
  return { output: target.output };
}

export function parseAnalysis(record: Record<string, unknown>): Analysis {
  const outcome = record.outcome ?? null;
  if (outcome !== null && outcome !== "presentations" && outcome !== "no_change") {
    throw new InvalidResponseError();
  }
  return {
    id: expectString(record, "id"),
    mode: expectEnum(record.mode, ["ai", "direct"] as const),
    trigger: expectEnum(record.trigger ?? "api", ["api", "scheduled"] as const),
    state: expectEnum(
      record.state,
      ["queued", "running", "completed", "failed"] as const,
    ),
    outcome,
    noChangeReason: nullableString(record.noChangeReason),
    contentIds: expectStringArray(record.contentIds ?? []),
    context: expectEnum(record.context, ["submitted", "history"] as const),
    scope: parseScope(record.scope ?? null),
    intent: nullableString(record.intent),
    title: nullableString(record.title),
    target: parseTarget(record.target ?? null),
    presentationIds: expectStringArray(record.presentationIds ?? []),
    failure: parseProblem(nullableRecord(record.failure ?? null)),
    createdAt: expectString(record, "createdAt"),
    updatedAt: expectString(record, "updatedAt"),
  };
}

function parseScope(value: unknown): AnalysisScope | null {
  if (value === null) {
    return null;
  }
  const record = expectRecord(value);
  const since = expectString(record, "since");
  if (!SCOPE_PATTERN.test(since)) {
    throw new InvalidResponseError();
  }
  return { since, sinceAt: nullableString(record.sinceAt) };
}

function parseTarget(value: unknown): AnalysisTarget | null {
  if (value === null) {
    return null;
  }
  const record = expectRecord(value);
  if (typeof record.displayId === "string") {
    return { displayId: expectString(record, "displayId") };
  }
  if (Array.isArray(record.displayIds)) {
    return { displayIds: expectStringArray(record.displayIds) };
  }
  if (record.output !== undefined && record.output !== null) {
    const output = parsePresentationOutput(record.output);
    if (output === null) {
      throw new InvalidResponseError();
    }
    return { output };
  }
  throw new InvalidResponseError();
}
