import type { AnalysisMode } from "./analyses.js";
import {
  delay,
  expectEnum,
  throwIfAborted,
  validateWaitNumber,
} from "./contents.js";
import {
  ConfigurationError,
  InvalidResponseError,
  OperationTimeoutError,
} from "./errors.js";
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

export interface DisplayAdvanceResult {
  display: Display;
  /** `false` when the queue was empty and nothing changed. */
  changed: boolean;
}

export interface WaitUntilCurrentOptions {
  /** Defaults to 1,000 ms. */
  pollIntervalMs?: number;
  /** Defaults to 120,000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
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

  /**
   * Read what is waiting to go on the panel, oldest first within a priority.
   *
   * The queue only ever holds `queued` Presentations: once one is delivered it
   * leaves the queue, and the image it replaces expires rather than going back
   * in. For the Display's history, including the `published`, `confirmed`, and
   * `expired` ones, use `presentations.list({ displayId })`.
   */
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

  /**
   * Put a specific Presentation on the panel. It must be a Display
   * Presentation of this user's, already delivered to this Display and
   * rendered; an `expired` one can be reactivated, which is how "go back to
   * the previous image" works. Anything else is
   * `409 presentation_not_deliverable`.
   *
   * The Presentation that was on the panel becomes `expired`; it does not go
   * back into the queue. The switch lands on `pendingPresentationId`;
   * `currentPresentationId` follows once the panel confirms, which for an
   * offline panel happens at its next sync. Use `waitUntilCurrent()` to wait
   * for that. Consumes no AI or push quota.
   */
  async setCurrent(displayId: string, presentationId: string): Promise<Display> {
    const id = encodePathSegment(displayId, "displayId");
    const response = expectRecord(
      await this.#transport.request(`${SDK_API_PREFIX}/displays/${id}/current`, {
        method: "POST",
        json: { presentationId: requireId(presentationId, "presentationId") },
      }),
    );
    return parseDisplay(expectRecord(response.display));
  }

  /**
   * Rotate to the next queued Presentation, highest priority first and oldest
   * first within a priority. `changed` is `false` when the queue was empty,
   * which is a normal `200` and changes nothing. Otherwise the effect matches
   * `setCurrent()`: the old image expires, the new one lands on
   * `pendingPresentationId`, and no quota is consumed.
   */
  async advance(displayId: string): Promise<DisplayAdvanceResult> {
    const id = encodePathSegment(displayId, "displayId");
    const response = expectRecord(
      await this.#transport.request(`${SDK_API_PREFIX}/displays/${id}/advance`, {
        method: "POST",
      }),
    );
    return {
      display: parseDisplay(expectRecord(response.display)),
      changed: expectBoolean(response, "changed"),
    };
  }

  /**
   * Poll until the Display reports `presentationId` as its confirmed current
   * Presentation. `setCurrent()` / `advance()` only move
   * `pendingPresentationId`; the panel confirms later, and an offline panel
   * confirms when it next syncs.
   *
   * Throws `OperationTimeoutError` on timeout. That does not cancel the
   * switch: the panel still shows the Presentation once it syncs.
   */
  async waitUntilCurrent(
    displayId: string,
    presentationId: string,
    options: WaitUntilCurrentOptions = {},
  ): Promise<Display> {
    encodePathSegment(displayId, "displayId");
    const wanted = requireId(presentationId, "presentationId");
    const pollIntervalMs = validateWaitNumber(
      options.pollIntervalMs, 1_000, 100, 60_000, "pollIntervalMs",
    );
    const timeoutMs = validateWaitNumber(
      options.timeoutMs, 120_000, 1, 30 * 60_000, "timeoutMs",
    );
    const abortMessage = "Waiting for the Display to switch was aborted.";
    const startedAt = Date.now();

    while (true) {
      throwIfAborted(options.signal, abortMessage);
      const display = await this.retrieve(displayId);
      if (display.currentPresentationId === wanted) {
        return display;
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new OperationTimeoutError(
          `Display ${display.id} did not confirm Presentation ${wanted} within ${timeoutMs} ms. The switch is still pending.`,
          {
            details: {
              displayId: display.id,
              presentationId: wanted,
              pendingPresentationId: display.pendingPresentationId,
              timeoutMs,
            },
          },
        );
      }
      await delay(
        Math.min(pollIntervalMs, timeoutMs - elapsed),
        options.signal,
        abortMessage,
      );
    }
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

function requireId(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${name} must be a non-empty string.`);
  }
  return value.trim();
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
