import type { AnalysisMode } from "./analyses.js";
import { expectEnum } from "./contents.js";
import { ConfigurationError, InvalidResponseError } from "./errors.js";
import {
  formatQuery,
  parseContentRefs,
  parsePresentation,
  type Presentation,
  type PresentationContentRef,
  type PresentationImageFormat,
  type PresentationState,
} from "./presentations.js";
import {
  SDK_API_PREFIX,
  appendCursorAndLimit,
  encodePathSegment,
  expectBoolean,
  expectInteger,
  expectRecord,
  expectString,
  expectStringArray,
  nullableNumber,
  nullableString,
  parsePage,
  type ResourceTransport,
} from "./resource.js";

export interface DisplayCapabilities {
  pixelWidth: number;
  pixelHeight: number;
  orientation: string;
  colorMode: string;
  supportedImageContentTypes: readonly string[];
  supportedOutputFormats: readonly PresentationImageFormat[];
}

export interface Display {
  id: string;
  hardwareId: string;
  thingName: string;
  name: string;
  nickname: string | null;
  firmware: string | null;
  batteryPercent: number | null;
  online: boolean;
  lastSeenAt: string | null;
  stateUpdatedAt: string | null;
  boundAt: string | null;
  tags: readonly string[];
  syncIntervalMinutes: number | null;
  nextSyncAt: string | null;
  currentPresentationId: string | null;
  currentPresentationUpdatedAt: string | null;
  pendingPresentationId: string | null;
  capabilities: DisplayCapabilities;
}

export interface DisplayPage {
  items: readonly Display[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListDisplaysOptions {
  cursor?: string;
  limit?: number;
}

export interface DisplayQueueItem {
  id: string;
  displayId: string;
  /** Same shape and ordering as `Presentation.contentIds`. */
  contentIds: readonly PresentationContentRef[];
  /** Same values as `Presentation.mode` and `Analysis.mode`. */
  mode: AnalysisMode;
  state: PresentationState;
  createdAt: string;
  updatedAt: string;
}

export interface DisplayQueuePage {
  items: readonly DisplayQueueItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListDisplayQueueOptions extends ListDisplaysOptions {
  from?: string | Date;
  to?: string | Date;
}

export interface CurrentPresentationOptions {
  format?: PresentationImageFormat;
}

export class DisplaysResource {
  readonly #transport: ResourceTransport;

  constructor(transport: ResourceTransport) {
    this.#transport = transport;
  }

  async list(options: ListDisplaysOptions = {}): Promise<DisplayPage> {
    const query = new URLSearchParams();
    appendCursorAndLimit(query, options);
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/displays${suffix}`,
    );
    return parsePage(response, parseDisplay);
  }

  async retrieve(displayId: string): Promise<Display> {
    const id = encodePathSegment(displayId, "displayId");
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/displays/${id}`,
    );
    return parseDisplay(expectRecord(response));
  }

  async listQueue(
    displayId: string,
    options: ListDisplayQueueOptions = {},
  ): Promise<DisplayQueuePage> {
    const id = encodePathSegment(displayId, "displayId");
    const query = new URLSearchParams();
    appendCursorAndLimit(query, options);
    const from = normalizeTimestamp(options.from, "from");
    const to = normalizeTimestamp(options.to, "to");
    if (from !== undefined) query.set("from", from);
    if (to !== undefined) query.set("to", to);
    if (from !== undefined && to !== undefined && to < from) {
      throw new ConfigurationError("to must not be earlier than from.");
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/displays/${id}/queue${suffix}`,
    );
    return parsePage(response, parseQueueItem);
  }

  async current(
    displayId: string,
    options: CurrentPresentationOptions = {},
  ): Promise<Presentation | null> {
    const id = encodePathSegment(displayId, "displayId");
    const response = expectRecord(
      await this.#transport.request(
        `${SDK_API_PREFIX}/displays/${id}/current-presentation${formatQuery(options.format)}`,
      ),
    );
    if (response.presentation === null) {
      return null;
    }
    return parsePresentation(expectRecord(response.presentation));
  }
}

export function parseDisplay(record: Record<string, unknown>): Display {
  const capabilities = expectRecord(record.capabilities);
  const formats = expectStringArray(capabilities.supportedOutputFormats);
  if (!formats.every(isImageFormat)) {
    throw new InvalidResponseError();
  }
  return {
    id: expectString(record, "id"),
    hardwareId: expectString(record, "hardwareId"),
    thingName: expectString(record, "thingName"),
    name: expectString(record, "name"),
    nickname: nullableString(record.nickname),
    firmware: nullableString(record.firmware),
    batteryPercent: nullableNumber(record.batteryPercent),
    online: expectBoolean(record, "online"),
    lastSeenAt: nullableString(record.lastSeenAt),
    stateUpdatedAt: nullableString(record.stateUpdatedAt),
    boundAt: nullableString(record.boundAt),
    tags: expectStringArray(record.tags),
    syncIntervalMinutes: nullableNumber(record.syncIntervalMinutes),
    nextSyncAt: nullableString(record.nextSyncAt),
    currentPresentationId: nullableString(record.currentPresentationId),
    currentPresentationUpdatedAt: nullableString(
      record.currentPresentationUpdatedAt,
    ),
    pendingPresentationId: nullableString(record.pendingPresentationId),
    capabilities: {
      pixelWidth: expectInteger(capabilities, "pixelWidth"),
      pixelHeight: expectInteger(capabilities, "pixelHeight"),
      orientation: expectString(capabilities, "orientation"),
      colorMode: expectString(capabilities, "colorMode"),
      supportedImageContentTypes: expectStringArray(
        capabilities.supportedImageContentTypes,
      ),
      supportedOutputFormats: formats,
    },
  };
}

function parseQueueItem(record: Record<string, unknown>): DisplayQueueItem {
  const state = record.state;
  if (
    typeof state !== "string" ||
    ![
      "preparing",
      "queued",
      "published",
      "confirmed",
      "expired",
      "failed",
    ].includes(state)
  ) {
    throw new InvalidResponseError();
  }
  return {
    id: expectString(record, "id"),
    displayId: expectString(record, "displayId"),
    contentIds: parseContentRefs(record.contentIds),
    mode: expectEnum(record.mode, ["ai", "direct"] as const),
    state: state as PresentationState,
    createdAt: expectString(record, "createdAt"),
    updatedAt: expectString(record, "updatedAt"),
  };
}

function normalizeTimestamp(
  value: string | Date | undefined,
  name: "from" | "to",
): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ConfigurationError(`${name} must be a valid date or timestamp.`);
  }
  return date.toISOString();
}

function isImageFormat(value: string): value is PresentationImageFormat {
  return value === "png" || value === "raw2" || value === "raw4";
}
