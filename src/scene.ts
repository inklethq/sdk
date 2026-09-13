import { ConfigurationError, InvalidResponseError } from "./errors.js";
import {
  expectInteger,
  expectRecord,
  expectRecordArray,
  expectString,
  isRecord,
  nullableString,
} from "./resource.js";

export const INKLET_SCENE_MEDIA_TYPE =
  "application/vnd.inklet.scene+json;version=1";

export type PresentationOutputFormat = "scene" | "png";
export type PresentationColorMode = "color" | "grayscale" | "monochrome";

export interface PresentationViewport {
  width: number;
  height: number;
}

/**
 * Requested output for a targetless Presentation.
 *
 * When neither `preset` nor `viewport` is supplied, Inklet uses its default
 * preview profile. `preset` and `viewport` are mutually exclusive.
 */
export interface PresentationOutputRequest {
  formats?: readonly PresentationOutputFormat[];
  preset?: string;
  viewport?: PresentationViewport;
  colorMode?: PresentationColorMode;
}

/** The normalized output profile persisted by Inklet. */
export interface PresentationOutput {
  formats: readonly PresentationOutputFormat[];
  preset: string | null;
  viewport: PresentationViewport;
  colorMode: PresentationColorMode;
}

export interface InkletSceneFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One forward-compatible scene element.
 *
 * v1 renderers must support `text`, `image`, and `shape`. Element-specific
 * properties remain available through `properties`, so adding an optional
 * style does not require a new SDK release.
 */
export interface InkletSceneElement {
  id: string;
  type: "text" | "image" | "shape";
  frame: InkletSceneFrame;
  properties: Readonly<Record<string, unknown>>;
}

export interface InkletScene {
  version: 1;
  viewport: PresentationViewport;
  background: string;
  elements: readonly InkletSceneElement[];
}

export interface PresentationScene {
  mediaType: typeof INKLET_SCENE_MEDIA_TYPE;
  version: 1;
  data: InkletScene;
}

export function validatePresentationOutputRequest(
  output: PresentationOutputRequest,
): void {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new ConfigurationError("output must be an object.");
  }

  const formats = output.formats ?? ["scene", "png"];
  if (
    !Array.isArray(formats) ||
    formats.length === 0 ||
    new Set(formats).size !== formats.length ||
    !formats.every((format) => format === "scene" || format === "png")
  ) {
    throw new ConfigurationError(
      "output.formats must contain one or more unique scene or png values.",
    );
  }

  if (output.preset !== undefined) {
    if (
      typeof output.preset !== "string" ||
      output.preset.trim().length === 0
    ) {
      throw new ConfigurationError("output.preset must be a non-empty string.");
    }
    if (output.viewport !== undefined) {
      throw new ConfigurationError(
        "output must use either preset or viewport, not both.",
      );
    }
  }

  if (output.viewport !== undefined) {
    validateViewport(output.viewport, "output.viewport");
  }

  if (
    output.colorMode !== undefined &&
    output.colorMode !== "color" &&
    output.colorMode !== "grayscale" &&
    output.colorMode !== "monochrome"
  ) {
    throw new ConfigurationError(
      "output.colorMode must be color, grayscale, or monochrome.",
    );
  }
}

export function parsePresentationOutput(value: unknown): PresentationOutput | null {
  if (value === undefined || value === null) {
    return null;
  }
  const record = expectRecord(value);
  const formats = record.formats;
  if (
    !Array.isArray(formats) ||
    formats.length === 0 ||
    !formats.every((format) => format === "scene" || format === "png")
  ) {
    throw new InvalidResponseError();
  }
  const colorMode = record.colorMode;
  if (
    colorMode !== "color" &&
    colorMode !== "grayscale" &&
    colorMode !== "monochrome"
  ) {
    throw new InvalidResponseError();
  }
  return {
    formats: [...formats] as PresentationOutputFormat[],
    preset: nullableString(record.preset),
    viewport: parseViewport(expectRecord(record.viewport)),
    colorMode,
  };
}

export function parsePresentationScene(value: unknown): PresentationScene | null {
  if (value === undefined || value === null) {
    return null;
  }
  const record = expectRecord(value);
  if (
    record.mediaType !== INKLET_SCENE_MEDIA_TYPE ||
    record.version !== 1
  ) {
    throw new InvalidResponseError();
  }
  return {
    mediaType: INKLET_SCENE_MEDIA_TYPE,
    version: 1,
    data: parseInkletScene(expectRecord(record.data)),
  };
}

export function parseInkletScene(record: Record<string, unknown>): InkletScene {
  if (record.version !== 1) {
    throw new InvalidResponseError();
  }
  return {
    version: 1,
    viewport: parseViewport(expectRecord(record.viewport)),
    background: expectString(record, "background"),
    elements: expectRecordArray(record.elements).map(parseSceneElement),
  };
}

function parseSceneElement(record: Record<string, unknown>): InkletSceneElement {
  const type = record.type;
  if (type !== "text" && type !== "image" && type !== "shape") {
    throw new InvalidResponseError();
  }
  const properties = record.properties;
  if (!isRecord(properties)) {
    throw new InvalidResponseError();
  }
  return {
    id: expectString(record, "id"),
    type,
    frame: parseFrame(expectRecord(record.frame)),
    properties: { ...properties },
  };
}

function parseFrame(record: Record<string, unknown>): InkletSceneFrame {
  const frame = {
    x: expectInteger(record, "x"),
    y: expectInteger(record, "y"),
    width: expectInteger(record, "width"),
    height: expectInteger(record, "height"),
  };
  if (frame.width <= 0 || frame.height <= 0) {
    throw new InvalidResponseError();
  }
  return frame;
}

function parseViewport(record: Record<string, unknown>): PresentationViewport {
  const viewport = {
    width: expectInteger(record, "width"),
    height: expectInteger(record, "height"),
  };
  if (
    viewport.width < 1 ||
    viewport.width > 8192 ||
    viewport.height < 1 ||
    viewport.height > 8192
  ) {
    throw new InvalidResponseError();
  }
  return viewport;
}

function validateViewport(value: PresentationViewport, name: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${name} must be an object.`);
  }
  for (const dimension of ["width", "height"] as const) {
    const number = value[dimension];
    if (!Number.isInteger(number) || number < 1 || number > 8192) {
      throw new ConfigurationError(
        `${name}.${dimension} must be an integer between 1 and 8192.`,
      );
    }
  }
}
