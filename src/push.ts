import {
  assetBlob,
  validateAsset,
  type FileAsset,
  type ImageAsset,
  type InkletAsset,
} from "./assets.js";
import {
  type CreateContentAssetInput,
  type Content,
  type ContentMode,
  type ContentsResource,
  type UploadTicket,
} from "./contents.js";
import {
  AssetUploadError,
  ConfigurationError,
  InvalidResponseError,
} from "./errors.js";
import type { ResourceTransport } from "./resource.js";
import type { PresentationOutputRequest } from "./scene.js";

interface BasePushInput {
  idempotencyKey?: string;
  intent?: string;
  title?: string;
}

export interface AutoPushInput extends BasePushInput {
  assets: readonly InkletAsset[];
}

export interface ManualPushInput extends BasePushInput {
  displayId: string;
  assets: readonly InkletAsset[];
}

export interface HardcodePushInput extends BasePushInput {
  displayId: string;
  image: ImageAsset;
}

export interface PushResult {
  contentId: string;
  state: Content["state"];
  presentationIds: readonly string[];
  idempotencyKey: string;
  content: Content;
}

export type AutoPushResult = PushResult;
export type ManualPushResult = PushResult;
export type HardcodePushResult = PushResult;

interface PreparedBinary {
  asset: ImageAsset | FileAsset;
  assetIndex: number;
  blob: Blob;
}

export class PushResource {
  readonly #submission: ContentSubmissionRunner;

  constructor(transport: ResourceTransport, contents: ContentsResource) {
    this.#submission = new ContentSubmissionRunner(transport, contents);
  }

  async auto(input: AutoPushInput): Promise<AutoPushResult> {
    return this.#submission.run("auto", input, null, input?.assets);
  }

  async manual(input: ManualPushInput): Promise<ManualPushResult> {
    return this.#submission.run(
      "manual",
      input,
      input?.displayId,
      input?.assets,
    );
  }

  async hardcode(input: HardcodePushInput): Promise<HardcodePushResult> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Hardcode Push requires an input object.");
    }
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

    // The backend intentionally preserves the existing custom-image behavior:
    // it scales the submitted image to the Display's output geometry. Do not
    // reject a Push because its input dimensions differ from the panel.
    return this.#submission.run("hardcode", input, input.displayId, [input.image]);
  }
}

interface SubmissionOptions {
  output?: PresentationOutputRequest;
  operation?: "Push" | "Presentation generation";
}

/** @internal Shared upload/confirm orchestration for Push and generation. */
export class ContentSubmissionRunner {
  readonly #transport: ResourceTransport;
  readonly #contents: ContentsResource;

  constructor(transport: ResourceTransport, contents: ContentsResource) {
    this.#transport = transport;
    this.#contents = contents;
  }

  async run(
    mode: ContentMode,
    input: BasePushInput,
    displayId: string | null | undefined,
    assets: readonly InkletAsset[] | undefined,
    options: SubmissionOptions = {},
  ): Promise<PushResult> {
    const operation = options.operation ?? "Push";
    if (!input || typeof input !== "object" || !Array.isArray(assets)) {
      throw new ConfigurationError(
        `${capitalized(mode)} ${operation} requires an assets array.`,
      );
    }
    if (assets.length === 0) {
      throw new ConfigurationError(
        `${capitalized(mode)} ${operation} requires at least one Asset.`,
      );
    }
    if (
      options.output === undefined &&
      mode !== "auto" &&
      (typeof displayId !== "string" || displayId.trim().length === 0)
    ) {
      throw new ConfigurationError(
        `${capitalized(mode)} ${operation} requires displayId.`,
      );
    }

    const prepared = prepareAssets(assets);
    const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey();
    const created = await this.#contents.create(
      {
        mode,
        displayId:
          options.output !== undefined || mode === "auto"
            ? null
            : (displayId as string).trim(),
        intent: input.intent ?? null,
        title: input.title ?? null,
        ...(options.output === undefined ? {} : { output: options.output }),
        assets: prepared.request,
      },
      idempotencyKey,
    );

    await this.#uploadWithOneRefresh(
      created.content.id,
      created.uploadTickets,
      prepared.binary,
    );

    let content = await this.#contents.confirm(created.content.id);
    if (content.upload.status === "partial") {
      const failed = content.upload.failedAssetIndexes;
      await this.#refreshAndUpload(created.content.id, failed, prepared.binary);
      content = await this.#contents.confirm(created.content.id);
    }

    if (content.upload.status === "partial") {
      throw new AssetUploadError(
        "One or more Inklet assets could not be confirmed after retrying the upload.",
        {
          contentId: content.id,
          failedAssetIndexes: content.upload.failedAssetIndexes,
        },
      );
    }

    return {
      contentId: content.id,
      state: content.state,
      presentationIds: content.presentationIds,
      idempotencyKey,
      content,
    };
  }

  async #uploadWithOneRefresh(
    contentId: string,
    tickets: readonly UploadTicket[],
    binary: readonly PreparedBinary[],
  ): Promise<void> {
    validateTickets(tickets, binary);
    const failed = await uploadTickets(
      this.#transport,
      contentId,
      tickets,
      binary,
    );
    if (failed.length === 0) return;
    await this.#refreshAndUpload(contentId, failed, binary);
  }

  async #refreshAndUpload(
    contentId: string,
    assetIndexes: readonly number[],
    binary: readonly PreparedBinary[],
  ): Promise<void> {
    const refreshed = await this.#contents.refreshUploadTickets(
      contentId,
      assetIndexes,
    );
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
      case "image": {
        const blob = assetBlob(asset);
        request.push({
          type: "image",
          filename: asset.filename,
          contentType: asset.contentType,
          sizeBytes: blob.size,
        });
        binary.push({ asset, assetIndex, blob });
        break;
      }
      case "file": {
        const blob = assetBlob(asset);
        request.push({
          type: "file",
          filename: asset.filename,
          contentType: asset.contentType,
          sizeBytes: blob.size,
        });
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

function createIdempotencyKey(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") {
    return `sdk-${randomUUID.call(globalThis.crypto)}`;
  }
  return `sdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function capitalized(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
