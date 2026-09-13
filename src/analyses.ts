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

/** Relative look-back window, e.g. `"24h"`, `"7d"`, `"90m"`. */
export interface AnalysisScope {
  since: string;
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
  scope?: AnalysisScope;
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
  contentId?: string;
  state?: AnalysisState;
  trigger?: AnalysisTrigger;
  cursor?: string;
  limit?: number;
}

export interface WaitForAnalysisOptions {
  /** Defaults to 1,000 ms. */
  pollIntervalMs?: number;
  /** Defaults to 120,000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const SCOPE_PATTERN = /^\d+[mhd]$/;

export class AnalysesResource {
  readonly #transport: ResourceTransport;

  constructor(transport: ResourceTransport, _contents?: ContentsResource) {
    this.#transport = transport;
  }

  /** Run the agent over the given Contents and/or the user's history. */
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
   * throws `AnalysisFailedError`. `no_change` is a normal completion; check
   * `outcome` on the result.
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
}

interface WireCreateAnalysis {
  mode: AnalysisMode;
  contentIds: string[];
  context: AnalysisContext;
  scope: AnalysisScope | null;
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

  if (input.scope !== undefined) {
    if (context !== "history") {
      throw new ConfigurationError("scope is only valid with context \"history\".");
    }
    validateScope(input.scope);
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
    scope: input.scope ?? null,
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

function validateScope(scope: AnalysisScope): void {
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
  return { since };
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
