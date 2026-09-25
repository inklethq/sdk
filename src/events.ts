import { delay, throwIfAborted, validateTimeout } from "./abort.js";
import type { InkletRequestOptions } from "./client.js";
import { validateWaitNumber } from "./contents.js";
import {
  ConfigurationError,
  InvalidResponseError,
  NetworkError,
  OperationAbortedError,
} from "./errors.js";
import {
  DEFAULT_RETRY_DELAY_MS,
  isTransient,
  readWithRetry,
  retryDelay,
} from "./polling.js";
import {
  SDK_API_PREFIX,
  callOptions,
  encodePathSegment,
  expectBoolean,
  expectEnum,
  expectRecord,
  expectRecordArray,
  expectString,
  expectStringArray,
  validateLimit,
  type CallOptions,
  type ResourceTransport,
} from "./resource.js";
import type { AnalysisOutcome, AnalysisState } from "./analyses.js";

export type AnalysisEventLevel = "info" | "warn" | "error";

/** `agent` events come from the model loop; `backend` events from inklet. */
export type AnalysisEventSource = "agent" | "backend";

/**
 * Every event type a public reader can return.
 *
 * The stream an Analysis publishes to you is a projection, not the run's
 * internal log: it answers "where is this now" rather than "how is it doing
 * it". The agent's turns, its individual tool calls, the kernel it chose, and
 * the sentences a rejected plan was faulted for stay inside inklet and never
 * appear here, so nothing in your UI is pinned to our directory layout or to
 * which tool happens to read what.
 */
export type AnalysisEventType =
  | "analysis.created"
  | "analysis.dispatched"
  | "analysis.leased"
  | "analysis.lease_expired"
  | "analysis.completed"
  | "analysis.failed"
  | "context.materialized"
  | "agent.activity"
  | "plan.submitted"
  | "plan.rejected"
  | "plan.accepted"
  | "render.finished"
  | "render.failed"
  | "delivery.published"
  | "delivery.confirmed"
  | "delivery.failed"
  | "assistant.delta"
  | "assistant.citation"
  | "action.card_created"
  | "action.display_switched";

/** What the agent is doing right now, as one `agent.activity` reports it. */
export type AgentActivityKind =
  | "reading_brief"
  | "reading_notes"
  | "checking_display"
  | "choosing_layout"
  | "submitting_plan"
  | "retrying"
  | "searching_notes"
  | "reading_note"
  | "creating_card"
  | "switching_display"
  | "other";

/** `done` and `failed` are final; `active` repeats as the activity runs. */
export type AgentActivityState = "active" | "done" | "failed";

/**
 * Counters for one activity. Every field is absent rather than `0` when it
 * does not apply: "read no notes" and "this kind of activity does not count
 * notes" are two different statements.
 */
export interface AgentActivityStats {
  /** Distinct notes read. */
  notesRead?: number;
  /** Distinct layouts looked at. */
  layoutsSeen?: number;
  /** `searching_notes`: how many notes the search found. */
  matches?: number;
  /** The layout the agent settled on. */
  chosen?: string | null;
  failedSteps?: number;
  /** Steps the workspace guard refused. */
  deniedSteps?: number;
}

/**
 * A run of related agent steps, collapsed into one activity.
 *
 * The same `activityId` arrives several times as the activity progresses:
 * throttled `active` updates, then a final `done` or `failed`. Upsert by
 * `attempt` and `activityId` together rather than appending, or use
 * {@link mergeActivities}.
 */
export interface AgentActivityData {
  /** Stable for the life of one activity, unique within an `attempt`. */
  activityId: string;
  /** A kind added after this SDK shipped arrives as its own string. */
  kind: AgentActivityKind | (string & {});
  /** A state added after this SDK shipped arrives as its own string. */
  state: AgentActivityState | (string & {});
  /** Steps folded into this activity so far. */
  steps: number;
  stats: AgentActivityStats;
}

/** Why a plan was sent back. The problem sentences themselves are internal. */
export type PlanRejectedReason =
  | "layout_mismatch"
  | "target"
  | "content_refs"
  | "schema"
  | "other";

export interface PlanRejectedData {
  /** How many problems were found, not what they were. */
  problems: number;
  /** A reason added after this SDK shipped arrives as its own string. */
  reason: PlanRejectedReason | (string & {});
  attempt: number;
}

export interface PlanSubmittedData {
  /** 1 for the first submission, higher after a correction round. */
  round: number;
  /** Absent when the agent gave up instead of submitting a usable plan. */
  outcome?: AnalysisOutcome | (string & {});
  /** How many actions the plan asks for. */
  actions?: number;
}

export interface PlanAcceptedData {
  presentationIds: readonly string[];
  /** How many actions the plan asked for. */
  actions: number;
}

export interface AnalysisCompletedData {
  outcome: AnalysisOutcome | (string & {});
  /** How many Presentations the run produced. */
  presentations: number;
  /** On a `chat` round (`outcome: "reply"`): the assistant Message that is now final. */
  messageId?: string;
}

/** A piece of the reply; concatenate in `seq` order for the full text. */
export interface AssistantDeltaData {
  text: string;
}

/** A Content the reply drew on. */
export interface AssistantCitationData {
  contentId: string;
  title: string;
}

/** The agent started a card Analysis for the user during a chat round. */
export interface ActionCardCreatedData {
  analysisId: string;
  contentIds?: readonly string[];
  displayId?: string;
}

/** The agent put a Presentation back on a Display during a chat round. */
export interface ActionDisplaySwitchedData {
  displayId: string;
  presentationId: string;
}

export interface AnalysisFailedData {
  /** The backend failure code, the same one `Analysis.failure.code` carries. */
  code: string;
}

/**
 * A worker's lease ran out before it returned a result.
 *
 * This reads like the end and is not: the attempt is abandoned, the run is
 * handed back out, and the agent starts again from the top. The event is
 * `warn`, the Analysis stays `running`, and two of these followed by another
 * `analysis.leased` means "retried twice, still going" — not a run to tell
 * anyone to retry.
 */
export interface AnalysisLeaseExpiredData {
  /** The attempt that timed out; the next one carries `attempt + 1`. */
  attempt: number;
}

/** Counts of what the agent was given to work with. */
export interface ContextReadyData {
  /** Contents named by the Analysis. */
  contents: number;
  /** Earlier Contents retrieved from history. */
  history: number;
  displays: number;
  /** Layouts available to choose from. */
  templates: number;
  /** Size of the materialized workspace. */
  bytes?: number;
  /** `true` when at least one image was included. */
  vision?: boolean;
  /** Present, and the event is `warn`, when something was degraded. */
  warnings?: number;
}

export interface RenderEventData {
  presentationId: string;
  displayId?: string;
}

export interface DeliveryEventData {
  /** Absent on a delivery that names no Presentation. */
  presentationId?: string;
  displayId?: string;
}

/** Fields every event carries, whatever its type. */
interface AnalysisEventFields {
  /**
   * Monotonic per Analysis, and the value to pass back as `after` to resume.
   *
   * It is not contiguous: the sequence is shared with the run's internal
   * events, which a public reader never returns, so a public stream skips
   * numbers. Treat it as an ordering and a resume token, never as a count or
   * an index.
   */
  seq: number;
  at: string;
  /** Which execution attempt produced the event; retries restart the agent. */
  attempt: number;
  source: AnalysisEventSource | (string & {});
  level: AnalysisEventLevel | (string & {});
  /** A displayable one-line English summary generated by the backend. */
  summary: string;
}

/** One event type paired with the `data` that type carries. */
export interface AnalysisEventOf<T extends string, D> extends AnalysisEventFields {
  type: T;
  /** Structured, type-specific fields. Empty when the event carries none. */
  data: D;
}

/**
 * One entry in an Analysis event stream.
 *
 * `data` is discriminated on `type` for every type this SDK knows, and the
 * last member of the union is the escape hatch: a type this SDK has never seen
 * parses as `Record<string, unknown>` rather than failing the stream, so a
 * backend that starts publishing a new type never breaks an older SDK. The
 * same goes for every other value the backend owns — `source`, `level`, an
 * activity's `kind` and `state`, a rejected plan's `reason`, an `outcome`:
 * one this SDK has not seen arrives as its own string.
 *
 * TypeScript cannot use `type` as a discriminant while that open member is in
 * the union, so `event.type === "agent.activity"` narrows `type` but not
 * `data`. Use {@link isAnalysisEvent} where you want the payload typed, and
 * fall back to `summary` — or {@link describeEvent} — for everything else.
 */
export type AnalysisEvent =
  | AnalysisEventOf<"analysis.created", Record<string, unknown>>
  | AnalysisEventOf<"analysis.dispatched", Record<string, unknown>>
  | AnalysisEventOf<"analysis.leased", Record<string, unknown>>
  | AnalysisEventOf<"analysis.lease_expired", AnalysisLeaseExpiredData>
  | AnalysisEventOf<"analysis.completed", AnalysisCompletedData>
  | AnalysisEventOf<"analysis.failed", AnalysisFailedData>
  | AnalysisEventOf<"context.materialized", ContextReadyData>
  | AnalysisEventOf<"agent.activity", AgentActivityData>
  | AnalysisEventOf<"plan.submitted", PlanSubmittedData>
  | AnalysisEventOf<"plan.rejected", PlanRejectedData>
  | AnalysisEventOf<"plan.accepted", PlanAcceptedData>
  | AnalysisEventOf<"render.finished", RenderEventData>
  | AnalysisEventOf<"render.failed", RenderEventData>
  | AnalysisEventOf<"delivery.published", DeliveryEventData>
  | AnalysisEventOf<"delivery.confirmed", DeliveryEventData>
  | AnalysisEventOf<"delivery.failed", DeliveryEventData>
  | AnalysisEventOf<"assistant.delta", AssistantDeltaData>
  | AnalysisEventOf<"assistant.citation", AssistantCitationData>
  | AnalysisEventOf<"action.card_created", ActionCardCreatedData>
  | AnalysisEventOf<"action.display_switched", ActionDisplaySwitchedData>
  | AnalysisEventOf<string & {}, Record<string, unknown>>;

/** The event of one known type, with its `data` typed. */
export type AnalysisEventWithType<T extends AnalysisEventType> = Extract<
  AnalysisEvent,
  { type: T }
>;

/**
 * Narrow an event to one known type, and its `data` with it.
 *
 * ```ts
 * if (isAnalysisEvent(event, "agent.activity")) {
 *   upsert(`${event.attempt}:${event.data.activityId}`, event.data.state);
 * }
 * ```
 */
export function isAnalysisEvent<T extends AnalysisEventType>(
  event: AnalysisEvent,
  type: T,
): event is AnalysisEventWithType<T> {
  return event.type === type;
}

export interface AnalysisEventPage {
  items: readonly AnalysisEvent[];
  /** Pass back as `after` to read the next page; `null` at the end. */
  nextAfter: number | null;
  hasMore: boolean;
  /**
   * The Analysis state when the page was produced. A state this SDK does not
   * know is passed through, and is not treated as final.
   */
  state: AnalysisState | (string & {});
}

export interface ListAnalysisEventsOptions extends CallOptions {
  /** Exclusive lower bound: only events with a greater `seq` are returned. */
  after?: number;
  /** 1-200. The backend picks a default when omitted. */
  limit?: number;
}

export interface WatchAnalysisOptions {
  /** Resume after this `seq` instead of replaying from the beginning. */
  after?: number;
  /**
   * Stops the iteration with `OperationAbortedError`, including mid-read of an
   * open stream.
   */
  signal?: AbortSignal;
  /**
   * How long each connection attempt, and each page read by the polling
   * fallback, may take before it counts as failed and is retried. Overrides
   * the client's `timeoutMs`. It never cuts off a stream that has started:
   * events can be minutes apart.
   */
  timeoutMs?: number;
  /**
   * Poll interval for the `listEvents` fallback used when the response is not
   * `text/event-stream`. Defaults to 1,000 ms.
   */
  pollIntervalMs?: number;
  /**
   * Delay before the first reconnect attempt, doubled for each further
   * attempt and capped at five attempts in a row. A `Retry-After` on a `429`
   * or `503` is honoured when it is longer. Defaults to 500 ms.
   */
  reconnectDelayMs?: number;
}

export interface TimelineOptions {
  /** Events per request, 1-200. Defaults to 100. */
  pageSize?: number;
  /** Start after this `seq` instead of at the first event. */
  after?: number;
  signal?: AbortSignal;
  /** Per page request; overrides the client's `timeoutMs`. */
  timeoutMs?: number;
}

export interface AnalysisArchive {
  /** Short-lived download URL for the full run archive. */
  url: string;
  expiresAt: string;
}

const ACTIVITY_STAT_COUNTS = [
  "notesRead",
  "layoutsSeen",
  "matches",
  "failedSteps",
  "deniedSteps",
] as const;
const MAX_EVENT_LIMIT = 200;
const DEFAULT_TIMELINE_PAGE_SIZE = 100;
const WATCH_PAGE_LIMIT = MAX_EVENT_LIMIT;
const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_RECONNECT_DELAY_MS = 30_000;
const WATCH_ABORTED = "Watching the Analysis event stream was aborted.";
const TIMELINE_ABORTED = "Reading the Analysis timeline was aborted.";

interface ResolvedWatchOptions {
  after: number | undefined;
  signal: AbortSignal | undefined;
  timeoutMs: number | undefined;
  pollIntervalMs: number;
  reconnectDelayMs: number;
}

interface ResolvedTimelineOptions {
  after: number | undefined;
  signal: AbortSignal | undefined;
  timeoutMs: number | undefined;
  pageSize: number;
}

export async function listAnalysisEvents(
  transport: ResourceTransport,
  analysisId: string,
  options: ListAnalysisEventsOptions = {},
): Promise<AnalysisEventPage> {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("listEvents options must be an object.");
  }
  return fetchEventPage(
    transport,
    encodePathSegment(analysisId, "analysisId"),
    options,
  );
}

export function watchAnalysisEvents(
  transport: ResourceTransport,
  analysisId: string,
  options: WatchAnalysisOptions = {},
): AsyncIterable<AnalysisEvent> {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("watch options must be an object.");
  }
  const encodedId = encodePathSegment(analysisId, "analysisId");
  const resolved: ResolvedWatchOptions = {
    after: validateAfter(options.after),
    signal: options.signal,
    timeoutMs: optionalTimeout(options.timeoutMs),
    pollIntervalMs: validateWaitNumber(
      options.pollIntervalMs, 1_000, 100, 60_000, "pollIntervalMs",
    ),
    reconnectDelayMs: validateWaitNumber(
      options.reconnectDelayMs, 500, 10, 60_000, "reconnectDelayMs",
    ),
  };
  return streamAnalysisEvents(transport, encodedId, resolved);
}

export function analysisEventTimeline(
  transport: ResourceTransport,
  analysisId: string,
  options: TimelineOptions,
): AsyncIterable<AnalysisEvent> {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("timeline options must be an object.");
  }
  const encodedId = encodePathSegment(analysisId, "analysisId");
  const resolved: ResolvedTimelineOptions = {
    after: validateAfter(options.after),
    signal: options.signal,
    timeoutMs: optionalTimeout(options.timeoutMs),
    pageSize:
      validateLimit(options.pageSize, MAX_EVENT_LIMIT) ??
      DEFAULT_TIMELINE_PAGE_SIZE,
  };
  return iterateTimeline(transport, encodedId, resolved);
}

export async function retrieveAnalysisArchive(
  transport: ResourceTransport,
  analysisId: string,
  options: CallOptions = {},
): Promise<AnalysisArchive> {
  const encodedId = encodePathSegment(analysisId, "analysisId");
  const response = await transport.request(
    `${SDK_API_PREFIX}/analyses/${encodedId}/archive`,
    callOptions(options),
  );
  const record = expectRecord(response);
  return {
    url: expectString(record, "url"),
    expiresAt: expectString(record, "expiresAt"),
  };
}

/**
 * Collapse every `agent.activity` to its latest state, keyed by `attempt` and
 * `activityId` together.
 *
 * One activity reports itself several times — throttled `active` updates and
 * then `done` or `failed` — so a raw list renders the same row over and over.
 * Each activity keeps the position of its first appearance, so the order still
 * reads as the order things started, and every other event is passed through
 * untouched.
 *
 * **`activityId` is only unique within an attempt.** It restarts at `a1` every
 * time the agent loop restarts, so a retried run has one `a1` per attempt and
 * keying on the id alone would fold attempt two's first activity into attempt
 * one's row. The attempt is part of the key, which leaves a retry reading as
 * the second pass it was.
 *
 * ```ts
 * const events = mergeActivities(await collect(inklet.analyses.timeline(id)));
 * ```
 */
export function mergeActivities(
  events: Iterable<AnalysisEvent>,
): AnalysisEvent[] {
  const merged: AnalysisEvent[] = [];
  const positions = new Map<string, number>();

  for (const event of events) {
    if (!isAnalysisEvent(event, "agent.activity")) {
      merged.push(event);
      continue;
    }
    const key = `${event.attempt}:${event.data.activityId}`;
    const at = positions.get(key);
    if (at === undefined) {
      positions.set(key, merged.length);
      merged.push(event);
      continue;
    }
    merged[at] = event;
  }

  return merged;
}

/**
 * One English line for an event, read from `type` and `data`.
 *
 * `agent.activity` is the reason this exists: it is the only public type the
 * backend has no sentence for, because what it means depends on counters that
 * change as the activity runs. Every other type falls back to the `summary`
 * the backend already wrote whenever there is nothing better to say.
 *
 * Values added after this SDK shipped still get a line: an activity `kind` it
 * does not know is described from its step count, as `other` is; a `state`
 * it does not know reads as still running, since only `done` and `failed`
 * are known to be final; and an unknown rejection `reason` gets the generic
 * "sent back" sentence.
 *
 * Pure, and English only — there is no locale option.
 */
export function describeEvent(event: AnalysisEvent): string {
  if (isAnalysisEvent(event, "agent.activity")) {
    return describeActivity(event.data);
  }
  if (isAnalysisEvent(event, "context.materialized")) {
    return describeContext(event.data);
  }
  if (isAnalysisEvent(event, "plan.submitted")) {
    return describePlanSubmitted(event.data);
  }
  if (isAnalysisEvent(event, "plan.rejected")) {
    return describePlanRejected(event.data);
  }
  if (isAnalysisEvent(event, "plan.accepted")) {
    return `Plan accepted · ${count(event.data.presentationIds.length, "Presentation")}`;
  }
  if (isAnalysisEvent(event, "analysis.completed")) {
    if (event.data.outcome === "reply") {
      return "Replied";
    }
    return event.data.outcome === "no_change"
      ? "Finished · nothing worth showing"
      : `Finished · ${count(event.data.presentations, "Presentation")}`;
  }
  if (isAnalysisEvent(event, "assistant.citation")) {
    return event.data.title === "" ? "Cited a note" : `Cited ${event.data.title}`;
  }
  if (isAnalysisEvent(event, "action.card_created")) {
    const from = event.data.contentIds?.length
      ? ` from ${count(event.data.contentIds.length, "note")}`
      : "";
    return `Started a card${from}`;
  }
  if (isAnalysisEvent(event, "action.display_switched")) {
    return `Put ${event.data.presentationId} back on the display`;
  }
  if (isAnalysisEvent(event, "analysis.failed")) {
    return `Failed · ${event.data.code}`;
  }
  if (isAnalysisEvent(event, "analysis.lease_expired")) {
    // What happens next, not that it stopped: the run is handed back out.
    return `Attempt ${event.data.attempt} timed out — retrying`;
  }
  if (isAnalysisEvent(event, "render.finished")) {
    return `Rendered ${event.data.presentationId}`;
  }
  if (isAnalysisEvent(event, "render.failed")) {
    return `Could not render ${event.data.presentationId}`;
  }
  if (
    isAnalysisEvent(event, "delivery.published") ||
    isAnalysisEvent(event, "delivery.confirmed") ||
    isAnalysisEvent(event, "delivery.failed")
  ) {
    return describeDelivery(event.type, event.data) ?? event.summary;
  }
  return event.summary;
}

/**
 * Why the plan came back, in the reader's terms.
 *
 * Every one of these ends in "trying again" because that is the fact that
 * matters: a rejected plan is not a failed run. The worker corrects it and
 * submits again, and the Analysis never leaves `running`.
 */
const PLAN_REJECTED_PHRASES: Record<PlanRejectedReason, string> = {
  target: "The plan aimed at the wrong display — trying again",
  layout_mismatch: "The first layout didn't fit — trying another",
  content_refs: "The plan missed some of your notes — trying again",
  schema: "The layout details didn't validate — trying again",
  other: "The plan was sent back — trying again",
};

function describePlanRejected(data: PlanRejectedData): string {
  // An own-property check, not `??`: a reason such as "constructor" would
  // otherwise find something on the object's prototype.
  const phrase = Object.hasOwn(PLAN_REJECTED_PHRASES, data.reason)
    ? PLAN_REJECTED_PHRASES[data.reason as PlanRejectedReason]
    : PLAN_REJECTED_PHRASES.other;
  return data.problems > 0
    ? `${phrase} (${count(data.problems, "problem")})`
    : phrase;
}

/**
 * The whole line for one activity: what it is doing, what its counters say,
 * and whether it got there.
 */
function describeActivity(data: AgentActivityData): string {
  return `${activityLine(data)}${stepSuffix(data.stats)}${
    data.state === "failed" ? " — failed" : ""
  }`;
}

/**
 * What the activity is doing, or did.
 *
 * A `failed` activity is described by what it was *attempting* rather than by
 * a finished sentence: "Read 3 notes — failed" contradicts itself, where
 * "Reading your notes · 3 read — failed" is what happened. A counter that does
 * not apply is absent rather than zero, so the line says one thing when a
 * count is there and a different thing when it is not, instead of printing a
 * `0` that reads as a result.
 *
 * A `kind` this SDK does not know takes the `default` branch with `other`,
 * and a `state` it does not know is neither `done` nor `failed`, so it reads
 * in the running form.
 */
function activityLine(data: AgentActivityData): string {
  const { kind, state, steps, stats } = data;
  const done = state === "done";

  switch (kind) {
    case "reading_brief":
      return done ? "Read the brief" : "Reading the brief";
    case "reading_notes":
      if (done) {
        return stats.notesRead === undefined
          ? "Read your notes"
          : `Read ${count(stats.notesRead, "note")}`;
      }
      return stats.notesRead
        ? `Reading your notes · ${stats.notesRead} read`
        : "Reading your notes";
    case "checking_display":
      return done ? "Checked the display" : "Checking the display";
    case "choosing_layout":
      return choosingLayoutLine(done, stats);
    case "submitting_plan":
      // "Checking" while it runs, because the backend is still validating it
      // and it may yet come back; "Submitted" only once it has gone through.
      return done ? "Submitted the plan" : "Checking the plan";
    case "retrying":
      return done ? "Tried another layout" : "Trying another layout";
    case "searching_notes":
      if (done) {
        return stats.matches === undefined
          ? "Searched your notes"
          : `Found ${count(stats.matches, "note")}`;
      }
      return "Searching your notes";
    case "reading_note":
      return done ? "Read a note" : "Reading a note";
    case "creating_card":
      return done ? "Started a card" : "Starting a card";
    case "switching_display":
      return done ? "Switched the display" : "Switching the display";
    default:
      if (steps <= 0) {
        return done ? "Worked through it" : "Working";
      }
      return done
        ? `Worked through ${count(steps, "step")}`
        : `Working · ${count(steps, "step")}`;
  }
}

function choosingLayoutLine(done: boolean, stats: AgentActivityStats): string {
  // An explicit `null` is "looked, has not settled yet", which is not a choice.
  const chosen = typeof stats.chosen === "string" ? stats.chosen : null;
  const seen = stats.layoutsSeen;

  if (seen === undefined) {
    if (chosen !== null) {
      return `Chose ${chosen}`;
    }
    return done ? "Looked at the layouts" : "Looking at layouts";
  }
  if (done) {
    const looked = `Looked at ${count(seen, "layout")}`;
    return chosen === null ? looked : `${looked} · chose ${chosen}`;
  }
  // A layout it has already settled on outranks the running count: it is the
  // answer the activity exists to produce.
  return chosen === null ? `Looking at layouts · ${seen} so far` : `Chose ${chosen}`;
}

/**
 * `· 1 step failed`, `· 2 steps blocked`.
 *
 * Blocked is not failed: it is the agent reaching for something the workspace
 * guard will not give it, which says something different about the run and is
 * worth its own word. Both sit before the failure marker, so a failed activity
 * still reads as one sentence.
 */
function stepSuffix(stats: AgentActivityStats): string {
  const parts: string[] = [];
  if (stats.failedSteps) {
    parts.push(`${count(stats.failedSteps, "step")} failed`);
  }
  if (stats.deniedSteps) {
    parts.push(`${count(stats.deniedSteps, "step")} blocked`);
  }
  return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}

function describeContext(data: ContextReadyData): string {
  const parts = [count(data.contents, "Content")];
  if (data.history > 0) {
    parts.push(`${data.history} from history`);
  }
  parts.push(count(data.displays, "Display"), count(data.templates, "layout"));
  if (data.vision === true) {
    parts.push("images");
  }
  const line = `Ready · ${parts.join(", ")}`;
  return data.warnings === undefined || data.warnings === 0
    ? line
    : `${line} · ${count(data.warnings, "gap")}`;
}

function describePlanSubmitted(data: PlanSubmittedData): string {
  const round = data.round > 1 ? ` (round ${data.round})` : "";
  if (data.outcome === "no_change") {
    return `Submitted the plan${round} · nothing worth showing`;
  }
  if (data.actions === undefined) {
    return `Submitted the plan${round}`;
  }
  return `Submitted the plan${round} · ${count(data.actions, "action")}`;
}

function describeDelivery(
  type: string,
  data: DeliveryEventData,
): string | null {
  const { presentationId, displayId } = data;
  if (presentationId === undefined) {
    return null;
  }
  const where = displayId === undefined ? "" : ` to Display ${displayId}`;
  switch (type) {
    case "delivery.published":
      return `Sent ${presentationId}${where}`;
    case "delivery.confirmed":
      return displayId === undefined
        ? `${presentationId} is showing`
        : `Display ${displayId} is showing ${presentationId}`;
    default:
      return `Could not deliver ${presentationId}${where}`;
  }
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

async function* streamAnalysisEvents(
  transport: ResourceTransport,
  encodedId: string,
  options: ResolvedWatchOptions,
): AsyncGenerator<AnalysisEvent, void, undefined> {
  let after = options.after;
  let attempt = 0;

  while (true) {
    throwIfAborted(options.signal, WATCH_ABORTED);

    let response: Response;
    try {
      response = await transport.requestRaw(
        streamPath(encodedId, after),
        streamRequestOptions(after, options),
      );
    } catch (error) {
      throwIfAborted(options.signal, WATCH_ABORTED);
      // A dropped connection, a timeout, and a 408, 429, or 5xx are all worth
      // reconnecting for; a 404 or 403 will not change on the next attempt.
      if (!isTransient(error)) {
        throw error;
      }
      attempt = await backOff(attempt, options, error);
      continue;
    }

    if (!isEventStream(response)) {
      // A proxy that cannot carry `text/event-stream` answered instead.
      await response.body?.cancel().catch(() => undefined);
      yield* pollAnalysisEvents(transport, encodedId, { ...options, after });
      return;
    }

    const body = response.body;
    if (body === null) {
      attempt = await backOff(attempt, options);
      continue;
    }

    const reader = body.getReader();
    const decoder = new SseDecoder();
    const text = new TextDecoder();
    let ended = false;

    try {
      while (!ended) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throwIfAborted(options.signal, WATCH_ABORTED);
          if (error instanceof OperationAbortedError) {
            throw error;
          }
          break;
        }
        if (chunk.done) {
          break;
        }

        for (const message of decoder.push(text.decode(chunk.value, { stream: true }))) {
          attempt = 0;
          if (message.event === "end") {
            ended = true;
            break;
          }
          if (message.data === null) {
            // A named frame with nothing to parse, such as a keep-alive.
            continue;
          }
          const event = parseAnalysisEvent(expectRecord(parseJson(message.data)));
          after = event.seq;
          yield event;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    if (ended) {
      return;
    }
    // The connection dropped before the Analysis reached a terminal state.
    attempt = await backOff(attempt, options);
  }
}

/**
 * The fallback when the stream cannot be read as a stream: page through
 * `listEvents()` until the page reports a final state.
 *
 * Only `completed` and `failed` end it. A state this SDK does not know is not
 * assumed to be final, so the loop keeps polling through it — until the
 * Analysis settles or the caller aborts.
 */
async function* pollAnalysisEvents(
  transport: ResourceTransport,
  encodedId: string,
  options: ResolvedWatchOptions,
): AsyncGenerator<AnalysisEvent, void, undefined> {
  let after = options.after;

  while (true) {
    throwIfAborted(options.signal, WATCH_ABORTED);
    const page = await readWithRetry(
      () =>
        fetchEventPage(transport, encodedId, {
          ...pageRequestOptions(options),
          limit: WATCH_PAGE_LIMIT,
          ...(after === undefined ? {} : { after }),
        }),
      {
        signal: options.signal,
        abortMessage: WATCH_ABORTED,
        baseDelayMs: options.reconnectDelayMs,
      },
    );
    for (const event of page.items) {
      after = event.seq;
      yield event;
    }
    if (page.nextAfter !== null) {
      after = page.nextAfter;
    }
    if (page.hasMore) {
      if (page.items.length === 0 && page.nextAfter === null) {
        // `hasMore` without a way to advance would spin forever.
        throw new InvalidResponseError();
      }
      continue;
    }
    if (isTerminalState(page.state)) {
      return;
    }
    await delay(options.pollIntervalMs, options.signal, WATCH_ABORTED);
  }
}

async function* iterateTimeline(
  transport: ResourceTransport,
  encodedId: string,
  options: ResolvedTimelineOptions,
): AsyncGenerator<AnalysisEvent, void, undefined> {
  let after = options.after;
  while (true) {
    throwIfAborted(options.signal, TIMELINE_ABORTED);
    const page = await readWithRetry(
      () =>
        fetchEventPage(transport, encodedId, {
          ...pageRequestOptions(options),
          limit: options.pageSize,
          ...(after === undefined ? {} : { after }),
        }),
      {
        signal: options.signal,
        abortMessage: TIMELINE_ABORTED,
        baseDelayMs: DEFAULT_RETRY_DELAY_MS,
      },
    );
    for (const event of page.items) {
      after = event.seq;
      yield event;
    }
    if (page.nextAfter !== null) {
      after = page.nextAfter;
    }
    if (!page.hasMore) {
      return;
    }
    if (page.items.length === 0 && page.nextAfter === null) {
      // `hasMore` without a way to advance would spin forever.
      throw new InvalidResponseError();
    }
  }
}

async function fetchEventPage(
  transport: ResourceTransport,
  encodedId: string,
  options: ListAnalysisEventsOptions,
): Promise<AnalysisEventPage> {
  const response = await transport.request(
    `${SDK_API_PREFIX}/analyses/${encodedId}/events${eventQuery(options)}`,
    callOptions(options),
  );
  return parseAnalysisEventPage(response);
}

/** The `CallOptions` a page read inherits from `watch()` or `timeline()`. */
function pageRequestOptions(options: {
  signal: AbortSignal | undefined;
  timeoutMs: number | undefined;
}): CallOptions {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

function eventQuery(options: ListAnalysisEventsOptions): string {
  const query = new URLSearchParams();
  const after = validateAfter(options.after);
  if (after !== undefined) {
    query.set("after", String(after));
  }
  const limit = validateLimit(options.limit, MAX_EVENT_LIMIT);
  if (limit !== undefined) {
    query.set("limit", String(limit));
  }
  return query.size === 0 ? "" : `?${query.toString()}`;
}

function streamPath(encodedId: string, after: number | undefined): string {
  const suffix = after === undefined ? "" : `?after=${after}`;
  return `${SDK_API_PREFIX}/analyses/${encodedId}/events/stream${suffix}`;
}

function streamRequestOptions(
  after: number | undefined,
  options: ResolvedWatchOptions,
): InkletRequestOptions {
  const headers = new Headers({ accept: "text/event-stream" });
  if (after !== undefined) {
    // Honoured by the backend on reconnect, and by any conforming SSE proxy.
    headers.set("last-event-id", String(after));
  }
  // The client times a raw request only until its headers arrive, so the
  // timeout bounds connecting and never an open stream.
  return { ...callOptions(pageRequestOptions(options)), method: "GET", headers };
}

/**
 * Wait before reconnect number `attempt + 1`, or throw once the budget of
 * `MAX_RECONNECT_ATTEMPTS` in a row is spent. The delay doubles from
 * `reconnectDelayMs`, but a `Retry-After` on the failure wins when it is
 * longer; one longer than the SDK is willing to sleep ends the watch with
 * that error, whose `retryAfterMs` says when to come back.
 */
async function backOff(
  attempt: number,
  options: ResolvedWatchOptions,
  cause?: unknown,
): Promise<number> {
  const next = attempt + 1;
  if (next > MAX_RECONNECT_ATTEMPTS) {
    throw (
      cause ??
      new NetworkError(
        `The Analysis event stream disconnected and could not be resumed after ${MAX_RECONNECT_ATTEMPTS} attempts.`,
      )
    );
  }
  const wait = retryDelay(
    cause,
    options.reconnectDelayMs,
    attempt,
    MAX_RECONNECT_DELAY_MS,
  );
  if (wait === null) {
    throw cause;
  }
  await delay(wait, options.signal, WATCH_ABORTED);
  return next;
}

function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");
}

/** Only the two states known to be final; anything else may still move. */
function isTerminalState(state: string): boolean {
  return state === "completed" || state === "failed";
}

/**
 * Validated up front, like the other options, so a bad value fails the call to
 * `watch()` or `timeline()` rather than the first request it makes.
 */
function optionalTimeout(value: number | undefined): number | undefined {
  return value === undefined ? undefined : validateTimeout(value, "timeoutMs");
}

function validateAfter(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigurationError(
      "after must be a non-negative integer event sequence number.",
    );
  }
  return value;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new InvalidResponseError({ cause });
  }
}

export function parseAnalysisEventPage(value: unknown): AnalysisEventPage {
  const record = expectRecord(value);
  return {
    items: expectRecordArray(record.items).map(parseAnalysisEvent),
    nextAfter: nullableSequence(record.nextAfter ?? null),
    hasMore: expectBoolean(record, "hasMore"),
    state: expectEnum<AnalysisState>(record.state),
  };
}

export function parseAnalysisEvent(
  record: Record<string, unknown>,
): AnalysisEvent {
  const summary = record.summary;
  if (typeof summary !== "string") {
    throw new InvalidResponseError();
  }
  // Deliberately any non-empty string: new event types must not break reads.
  const type = expectString(record, "type");
  return {
    seq: expectSequence(record, "seq"),
    at: expectString(record, "at"),
    attempt: expectSequence(record, "attempt"),
    source: expectEnum<AnalysisEventSource>(record.source),
    type,
    level: expectEnum<AnalysisEventLevel>(record.level),
    summary,
    data: parseEventData(type, record.data),
  } as AnalysisEvent;
}

/**
 * Validate the fields a known type is defined to carry, and pass the rest
 * through untouched.
 *
 * A type this SDK does not know keeps its `data` verbatim, and so does any
 * field a known type gained after this SDK was published: the overlay is
 * applied on top of the record rather than replacing it. Only a known type
 * whose own fields are missing or malformed is rejected — and an enum field
 * holding a value this SDK has not seen is neither.
 */
function parseEventData(type: string, value: unknown): Record<string, unknown> {
  const data =
    value === undefined || value === null ? {} : { ...expectRecord(value) };
  switch (type) {
    case "agent.activity":
      return { ...data, ...parseAgentActivity(data) };
    case "context.materialized":
      return { ...data, ...parseContextReady(data) };
    case "plan.submitted":
      return { ...data, ...parsePlanSubmitted(data) };
    case "plan.rejected":
      return { ...data, ...parsePlanRejected(data) };
    case "plan.accepted":
      return {
        ...data,
        presentationIds: expectStringArray(data.presentationIds ?? []),
        actions: expectSequence(data, "actions"),
      };
    case "analysis.completed":
      return {
        ...data,
        outcome: expectEnum<AnalysisOutcome>(data.outcome),
        presentations: expectSequence(data, "presentations"),
        ...optionalField("messageId", optionalString(data.messageId)),
      };
    case "assistant.delta":
      return { ...data, text: expectString(data, "text") };
    case "assistant.citation":
      return {
        ...data,
        contentId: expectString(data, "contentId"),
        title: typeof data.title === "string" ? data.title : "",
      };
    case "action.card_created":
      return {
        ...data,
        analysisId: expectString(data, "analysisId"),
        ...(Array.isArray(data.contentIds)
          ? { contentIds: expectStringArray(data.contentIds) }
          : {}),
        ...optionalField("displayId", optionalString(data.displayId)),
      };
    case "action.display_switched":
      return {
        ...data,
        displayId: expectString(data, "displayId"),
        presentationId: expectString(data, "presentationId"),
      };
    case "analysis.lease_expired":
      return { ...data, attempt: expectSequence(data, "attempt") };
    case "analysis.failed":
      return { ...data, code: expectString(data, "code") };
    case "render.finished":
    case "render.failed":
      return {
        ...data,
        presentationId: expectString(data, "presentationId"),
        ...optionalField("displayId", optionalString(data.displayId)),
      };
    case "delivery.published":
    case "delivery.confirmed":
    case "delivery.failed":
      return {
        ...data,
        ...optionalField("presentationId", optionalString(data.presentationId)),
        ...optionalField("displayId", optionalString(data.displayId)),
      };
    default:
      return data;
  }
}

function parseAgentActivity(data: Record<string, unknown>): AgentActivityData {
  return {
    activityId: expectString(data, "activityId"),
    kind: expectEnum<AgentActivityKind>(data.kind),
    state: expectEnum<AgentActivityState>(data.state),
    steps: expectSequence(data, "steps"),
    stats: parseActivityStats(data.stats),
  };
}

function parseActivityStats(value: unknown): AgentActivityStats {
  if (value === undefined || value === null) {
    return {};
  }
  const record = expectRecord(value);
  const stats: AgentActivityStats = {};
  for (const key of ACTIVITY_STAT_COUNTS) {
    const count = optionalSequence(record[key]);
    if (count !== undefined) {
      stats[key] = count;
    }
  }
  // `chosen` is the one stat that is a name rather than a count, and the one
  // that is meaningfully `null`: the agent looked but has not settled yet.
  if (record.chosen !== undefined) {
    stats.chosen = record.chosen === null ? null : expectString(record, "chosen");
  }
  return stats;
}

function parseContextReady(data: Record<string, unknown>): ContextReadyData {
  return {
    contents: expectSequence(data, "contents"),
    history: expectSequence(data, "history"),
    displays: expectSequence(data, "displays"),
    templates: expectSequence(data, "templates"),
    ...optionalField("bytes", optionalSequence(data.bytes)),
    ...optionalField("vision", optionalBoolean(data.vision)),
    ...optionalField("warnings", optionalSequence(data.warnings)),
  };
}

function parsePlanSubmitted(data: Record<string, unknown>): PlanSubmittedData {
  return {
    round: expectSequence(data, "round"),
    ...optionalField(
      "outcome",
      data.outcome === undefined || data.outcome === null
        ? undefined
        : expectEnum<AnalysisOutcome>(data.outcome),
    ),
    ...optionalField("actions", optionalSequence(data.actions)),
  };
}

function parsePlanRejected(data: Record<string, unknown>): PlanRejectedData {
  return {
    // A count, never the sentences. An older backend that still sends the list
    // is read for its length rather than refused.
    problems: Array.isArray(data.problems)
      ? data.problems.length
      : expectSequence(data, "problems"),
    reason: expectEnum<PlanRejectedReason>(data.reason),
    attempt: expectSequence(data, "attempt"),
  };
}

function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidResponseError();
  }
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new InvalidResponseError();
  }
  return value;
}

function optionalSequence(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidResponseError();
  }
  return value;
}

function expectSequence(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidResponseError();
  }
  return value;
}

function nullableSequence(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidResponseError();
  }
  return value;
}

interface SseMessage {
  id: string | null;
  event: string | null;
  /** `null` when the frame had no `data:` line at all. */
  data: string | null;
}

/**
 * Incremental `text/event-stream` decoder.
 *
 * Chunks arrive at arbitrary boundaries, so lines are buffered until a
 * terminator is seen; a trailing lone `\r` is held back because it may still
 * turn out to be the first half of a `\r\n`. Comment lines (`: ping`) are
 * dropped, `data:` lines accumulate and are joined with newlines, and an event
 * is only dispatched on a blank line, per the HTML spec.
 *
 * One deliberate departure: the spec drops a frame that has no `data:` line,
 * but the backend closes a finished stream with a bare `event: end`, and
 * dropping that turns a clean end into a disconnect and a reconnect. A frame
 * with an `event:` name is dispatched with `data: null` instead.
 */
class SseDecoder {
  #buffer = "";
  #data: string[] = [];
  #event: string | null = null;
  #lastId: string | null = null;

  push(chunk: string): SseMessage[] {
    if (chunk.length === 0) {
      return [];
    }
    this.#buffer += chunk;
    const messages: SseMessage[] = [];

    while (true) {
      const boundary = nextLineBoundary(this.#buffer);
      if (boundary === null) {
        break;
      }
      const line = this.#buffer.slice(0, boundary.end);
      this.#buffer = this.#buffer.slice(boundary.next);
      const message = this.#consume(line);
      if (message !== null) {
        messages.push(message);
      }
    }

    return messages;
  }

  #consume(line: string): SseMessage | null {
    if (line.length === 0) {
      return this.#dispatch();
    }
    if (line.startsWith(":")) {
      return null;
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "event":
        this.#event = value;
        break;
      case "data":
        this.#data.push(value);
        break;
      case "id":
        if (!value.includes("\u0000")) {
          this.#lastId = value;
        }
        break;
      default:
        break;
    }
    return null;
  }

  #dispatch(): SseMessage | null {
    const data = this.#data;
    const event = this.#event;
    this.#data = [];
    this.#event = null;
    if (data.length === 0) {
      return event === null ? null : { id: this.#lastId, event, data: null };
    }
    return { id: this.#lastId, event, data: data.join("\n") };
  }
}

function nextLineBoundary(
  buffer: string,
): { end: number; next: number } | null {
  const lf = buffer.indexOf("\n");
  const cr = buffer.indexOf("\r");

  if (cr !== -1 && (lf === -1 || cr < lf)) {
    if (cr === buffer.length - 1) {
      // Could still become "\r\n" once the next chunk arrives.
      return null;
    }
    return buffer[cr + 1] === "\n"
      ? { end: cr, next: cr + 2 }
      : { end: cr, next: cr + 1 };
  }
  if (lf !== -1) {
    return { end: lf, next: lf + 1 };
  }
  return null;
}
