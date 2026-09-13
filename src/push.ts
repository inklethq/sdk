import { validateAsset, type ImageAsset, type InkletAsset } from "./assets.js";
import {
  type Analysis,
  type AnalysisContext,
  type AnalysisState,
  type AnalysisTargetInput,
  type AnalysesResource,
} from "./analyses.js";
import { type Content, type ContentsResource } from "./contents.js";
import { ConfigurationError } from "./errors.js";

interface BasePushInput {
  /** Reused for both the Content and the Analysis; generated when omitted. */
  idempotencyKey?: string;
  intent?: string;
  title?: string;
  /** Defaults to `submitted`. `history` lets the agent read earlier Contents. */
  context?: AnalysisContext;
}

export interface AutoPushInput extends BasePushInput {
  assets: readonly InkletAsset[];
}

export interface ManualPushInput extends BasePushInput {
  displayId: string;
  assets: readonly InkletAsset[];
}

export interface HardcodePushInput {
  idempotencyKey?: string;
  displayId: string;
  image: ImageAsset;
}

/** The Content that was uploaded and the Analysis that was started for it. */
export interface PushResult {
  contentId: string;
  analysisId: string;
  state: AnalysisState;
  presentationIds: readonly string[];
  idempotencyKey: string;
  content: Content;
  analysis: Analysis;
}

export type AutoPushResult = PushResult;
export type ManualPushResult = PushResult;
export type HardcodePushResult = PushResult;

/**
 * Convenience wrappers: upload one Content and immediately analyze it.
 * Equivalent to `contents.upload()` followed by `analyze()` / `direct()`.
 */
export class PushResource {
  readonly #contents: ContentsResource;
  readonly #analyses: AnalysesResource;

  constructor(contents: ContentsResource, analyses: AnalysesResource) {
    this.#contents = contents;
    this.#analyses = analyses;
  }

  /** Inklet chooses one or more compatible Displays. */
  async auto(input: AutoPushInput): Promise<AutoPushResult> {
    requireAssets("Auto", input);
    return this.#uploadAndAnalyze(input, input.assets, undefined);
  }

  /** Inklet organizes the Assets for exactly one Display. */
  async manual(input: ManualPushInput): Promise<ManualPushResult> {
    requireAssets("Manual", input);
    requireDisplayId("Manual", input.displayId);
    return this.#uploadAndAnalyze(input, input.assets, {
      displayId: input.displayId,
    });
  }

  /** One PNG or JPEG straight to one Display, no AI. */
  async hardcode(input: HardcodePushInput): Promise<HardcodePushResult> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Hardcode Push requires an input object.");
    }
    requireDisplayId("Hardcode", input.displayId);
    validateAsset(input.image);
    if (
      input.image.type !== "image" ||
      (input.image.contentType !== "image/png" &&
        input.image.contentType !== "image/jpeg")
    ) {
      throw new ConfigurationError(
        "Hardcode Push requires one PNG or JPEG image.",
      );
    }

    // The backend scales the image to the Display's output geometry. Do not
    // reject a Push because its input dimensions differ from the panel.
    const uploaded = await this.#contents.upload({
      assets: [input.image],
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
    const analysis = await this.#analyses.direct({
      contentId: uploaded.content.id,
      target: { displayId: input.displayId.trim() },
      idempotencyKey: uploaded.idempotencyKey,
    });
    return toPushResult(uploaded.content, analysis, uploaded.idempotencyKey);
  }

  async #uploadAndAnalyze(
    input: BasePushInput,
    assets: readonly InkletAsset[],
    target: AnalysisTargetInput | undefined,
  ): Promise<PushResult> {
    const uploaded = await this.#contents.upload({
      title: input.title ?? null,
      assets,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
    const analysis = await this.#analyses.analyze({
      contentIds: [uploaded.content.id],
      context: input.context ?? "submitted",
      intent: input.intent ?? null,
      title: input.title ?? null,
      ...(target === undefined ? {} : { target }),
      idempotencyKey: uploaded.idempotencyKey,
    });
    return toPushResult(uploaded.content, analysis, uploaded.idempotencyKey);
  }
}

export function toPushResult(
  content: Content,
  analysis: Analysis,
  idempotencyKey: string,
): PushResult {
  return {
    contentId: content.id,
    analysisId: analysis.id,
    state: analysis.state,
    presentationIds: analysis.presentationIds,
    idempotencyKey,
    content,
    analysis,
  };
}

function requireAssets(
  label: string,
  input: { assets?: readonly InkletAsset[] } | undefined,
): void {
  if (!input || typeof input !== "object" || !Array.isArray(input.assets)) {
    throw new ConfigurationError(`${label} Push requires an assets array.`);
  }
  if (input.assets.length === 0) {
    throw new ConfigurationError(`${label} Push requires at least one Asset.`);
  }
}

function requireDisplayId(label: string, displayId: unknown): void {
  if (typeof displayId !== "string" || displayId.trim().length === 0) {
    throw new ConfigurationError(`${label} Push requires displayId.`);
  }
}
