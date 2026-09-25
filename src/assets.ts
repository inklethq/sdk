import { ConfigurationError } from "./errors.js";

export const MAX_ASSET_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_ASSETS_PER_CONTENT = 50;

export const ALLOWED_IMAGE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
] as const;

export const ALLOWED_FILE_CONTENT_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
] as const;

export type AllowedFileContentType =
  (typeof ALLOWED_FILE_CONTENT_TYPES)[number];

export type AllowedImageContentType =
  (typeof ALLOWED_IMAGE_CONTENT_TYPES)[number];

export type BinaryAssetData = Blob | ArrayBuffer | ArrayBufferView;

export interface TextAsset {
  type: "text";
  text: string;
}

export interface LinkAsset {
  type: "link";
  url: string;
}

export interface ImageAsset {
  type: "image";
  data: BinaryAssetData;
  filename: string;
  contentType: AllowedImageContentType;
}

export interface FileAsset {
  type: "file";
  data: BinaryAssetData;
  filename: string;
  contentType: AllowedFileContentType;
}

export type InkletAsset = TextAsset | LinkAsset | ImageAsset | FileAsset;

export class AssetsResource {
  text(text: string): TextAsset {
    validateText(text);
    return { type: "text", text };
  }

  link(url: string): LinkAsset {
    return { type: "link", url: validateLink(url) };
  }

  image(input: Omit<ImageAsset, "type">): ImageAsset {
    validateBinaryAsset({ ...input, type: "image" });
    return { ...input, type: "image" };
  }

  file(input: Omit<FileAsset, "type">): FileAsset {
    validateBinaryAsset({ ...input, type: "file" });
    return { ...input, type: "file" };
  }
}

export function validateAsset(asset: InkletAsset): void {
  if (!asset || typeof asset !== "object") {
    throw new ConfigurationError("Every asset must be an asset object.");
  }

  switch (asset.type) {
    case "text":
      validateText(asset.text);
      break;
    case "link":
      validateLink(asset.url);
      break;
    case "image":
    case "file":
      validateBinaryAsset(asset);
      break;
    default:
      throw new ConfigurationError("Unsupported inklet asset type.");
  }
}

export function assetBlob(asset: ImageAsset | FileAsset): Blob {
  if (asset.data instanceof Blob) {
    if (asset.data.type && asset.data.type !== asset.contentType) {
      throw new ConfigurationError(
        `Asset Blob type ${asset.data.type} does not match declared contentType ${asset.contentType}.`,
      );
    }
    return asset.data.type
      ? asset.data
      : new Blob([asset.data], { type: asset.contentType });
  }

  if (asset.data instanceof ArrayBuffer) {
    return new Blob([new Uint8Array(asset.data)], {
      type: asset.contentType,
    });
  }

  if (ArrayBuffer.isView(asset.data)) {
    const copy = new Uint8Array(asset.data.byteLength);
    copy.set(
      new Uint8Array(
        asset.data.buffer,
        asset.data.byteOffset,
        asset.data.byteLength,
      ),
    );
    return new Blob([copy], { type: asset.contentType });
  }

  throw new ConfigurationError(
    "Binary asset data must be a Blob, ArrayBuffer, Uint8Array, or Buffer.",
  );
}

function validateText(text: string): void {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ConfigurationError(
      "A text asset must contain at least one non-whitespace character.",
    );
  }
}

function validateLink(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError("A link asset must contain a URL.");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (cause) {
    throw new ConfigurationError(
      "A link asset URL must be an absolute HTTP or HTTPS URL.",
      { cause },
    );
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new ConfigurationError(
      "A link asset URL must use HTTP or HTTPS and cannot contain credentials.",
    );
  }

  return url.toString();
}

function validateBinaryAsset(asset: ImageAsset | FileAsset): void {
  if (typeof asset.filename !== "string" || asset.filename.trim().length === 0) {
    throw new ConfigurationError(
      "A binary asset must include a non-empty filename.",
    );
  }

  if (
    asset.type === "image" &&
    !ALLOWED_IMAGE_CONTENT_TYPES.includes(
      asset.contentType as AllowedImageContentType,
    )
  ) {
    throw new ConfigurationError(
      `Unsupported asset contentType: ${String(asset.contentType)}.`,
    );
  }

  if (
    asset.type === "file" &&
    !ALLOWED_FILE_CONTENT_TYPES.includes(
      asset.contentType as AllowedFileContentType,
    )
  ) {
    throw new ConfigurationError(
      `Unsupported asset contentType: ${String(asset.contentType)}.`,
    );
  }

  const blob = assetBlob(asset);
  if (blob.size === 0) {
    throw new ConfigurationError("Binary assets cannot be empty.");
  }
  if (blob.size > MAX_ASSET_SIZE_BYTES) {
    throw new ConfigurationError(
      `Assets cannot exceed ${MAX_ASSET_SIZE_BYTES} bytes.`,
    );
  }
}
