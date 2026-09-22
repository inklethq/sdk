import type { AnalysisMode } from "./analyses.js";
import { validateWaitNumber } from "./contents.js";
import { ConfigurationError, OperationTimeoutError } from "./errors.js";
import { pollUntil } from "./polling.js";
import {
  formatQuery,
  parseContentRefs,
  parsePresentation,
  parsePresentationMode,
  type Presentation,
  type PresentationContentRef,
  type PresentationImageFormat,
  type PresentationState,
} from "./presentations.js";
import {
  SDK_API_PREFIX,
  appendCursorAndLimit,
  callOptions,
  encodePathSegment,
  expectBoolean,
  expectEnum,
  expectEnumArray,
  expectInteger,
  expectRecord,
  expectString,
  expectStringArray,
  normalizeTimestamp,
  nullableNumber,
  nullableString,
  parsePage,
  requireId,
  type CallOptions,
  type ResourceTransport,
} from "./resource.js";

export interface DisplayCapabilities {
  pixelWidth: number;
  pixelHeight: number;
  orientation: string;
  colorMode: string;
  supportedImageContentTypes: readonly string[];
  /** Formats added after this SDK shipped arrive as their own strings. */
  supportedOutputFormats: readonly (PresentationImageFormat | (string & {}))[];
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

export interface ListDisplaysOptions extends CallOptions {
  cursor?: string;
  limit?: number;
}

export interface DisplayQueueItem {
  id: string;
  displayId: string;
  /** Same shape and ordering as `Presentation.contentIds`. */
  contentIds: readonly PresentationContentRef[];
  /** Same values as `Presentation.mode` and `Analysis.mode`. */
  mode: AnalysisMode | (string & {});
  state: PresentationState | (string & {});
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

export interface CurrentPresentationOptions extends CallOptions {
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
  /**
   * The whole wait, reads included: a read still in flight when it runs out
   * is cancelled. Defaults to 120,000 ms.
   */
  timeoutMs?: number;
  /** Cancels the wait, and a read in flight with it. */
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
      callOptions(options),
    );
    return parsePage(response, parseDisplay);
  }

  async retrieve(displayId: string, options: CallOptions = {}): Promise<Display> {
    const id = encodePathSegment(displayId, "displayId");
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/displays/${id}`,
      callOptions(options),
    );
    return parseDisplay(expectRecord(response));
  }

  /**
   * Read what is waiting to go on the panel, oldest first within a priority.
   *
   * The queue only ever holds `queued` Presentations: once one is delivered it
   * leaves the queue, and the image it replaces expires rather than going back
   * in. For the Display's history, including the `published`, `confirmed`, and
   * `expired` ones, use `presentations.list({ displayId })`, which scopes
   * itself to that Display.
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
      callOptions(options),
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
        callOptions(options),
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
   * for that. Consumes no AI or push quota. Not retried automatically.
   */
  async setCurrent(
    displayId: string,
    presentationId: string,
    options: CallOptions = {},
  ): Promise<Display> {
    const id = encodePathSegment(displayId, "displayId");
    const response = expectRecord(
      await this.#transport.request(`${SDK_API_PREFIX}/displays/${id}/current`, {
        ...callOptions(options),
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
   *
   * Never retried automatically: a retry after a lost response would skip a
   * second Presentation.
   */
  async advance(
    displayId: string,
    options: CallOptions = {},
  ): Promise<DisplayAdvanceResult> {
    const id = encodePathSegment(displayId, "displayId");
    const response = expectRecord(
      await this.#transport.request(`${SDK_API_PREFIX}/displays/${id}/advance`, {
        ...callOptions(options),
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
   * switch: the panel still shows the Presentation once it syncs. Up to three
   * failed reads in a row — a dropped connection, a timeout, `408`, `429`, or
   * `5xx` — are retried with backoff before the error is thrown.
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
    return pollUntil<Display, Display>({
      signal: options.signal,
      timeoutMs,
      pollIntervalMs,
      abortMessage: "Waiting for the Display to switch was aborted.",
      read: (signal) => this.retrieve(displayId, { signal }),
      settle: (display) =>
        display.currentPresentationId === wanted ? display : undefined,
      timeout: (display, cause) =>
        new OperationTimeoutError(
          `Display ${display?.id ?? displayId.trim()} did not confirm Presentation ${wanted} within ${timeoutMs} ms. The switch is still pending.`,
          {
            details: {
              displayId: display?.id ?? displayId.trim(),
              presentationId: wanted,
              pendingPresentationId: display?.pendingPresentationId ?? null,
              timeoutMs,
            },
            cause,
          },
        ),
    });
  }
}

export function parseDisplay(record: Record<string, unknown>): Display {
  const capabilities = expectRecord(record.capabilities);
  const formats = expectEnumArray<PresentationImageFormat>(
    capabilities.supportedOutputFormats,
  );
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
  return {
    id: expectString(record, "id"),
    displayId: expectString(record, "displayId"),
    contentIds: parseContentRefs(record.contentIds),
    mode: parsePresentationMode(record.mode),
    state: expectEnum<PresentationState>(record.state),
    createdAt: expectString(record, "createdAt"),
    updatedAt: expectString(record, "updatedAt"),
  };
}
