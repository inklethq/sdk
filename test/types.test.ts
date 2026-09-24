import {
  ApiError,
  AuthenticationFailedError,
  Inklet,
  InkletError,
  MultiplePresentationsError,
  NetworkError,
  NoChangeError,
  RateLimitError,
  RequestTimeoutError,
  SubscriptionRequiredError,
  describeEvent,
  isAnalysisEvent,
  mergeActivities,
  type AgentActivityData,
  type AgentActivityKind,
  type AgentActivityState,
  type AgentActivityStats,
  type Analysis,
  type AnalysisArchive,
  type AnalysisCompletedData,
  type AnalysisEvent,
  type AnalysisEventLevel,
  type AnalysisEventPage,
  type AnalysisEventSource,
  type AnalysisEventType,
  type AnalysisFailedData,
  type AnalysisLeaseExpiredData,
  type AnalysisScope,
  type AnalysisScopeInput,
  type AnalyzeInput,
  type ContextReadyData,
  type DeliveryEventData,
  type ListAnalysisEventsOptions,
  type PlanAcceptedData,
  type PlanRejectedData,
  type PlanRejectedReason,
  type PlanSubmittedData,
  type RenderEventData,
  type TimelineOptions,
  type WatchAnalysisOptions,
  type AutoPushInput,
  type CallOptions,
  type Content,
  type ContentState,
  type Display,
  type DisplayAdvanceResult,
  type GeneratePresentationInput,
  type HardcodePushInput,
  type InkletClientOptions,
  type InkletRequestBody,
  type InkletRequestHeaders,
  type InkletRequestOptions,
  type ListPresentationsOptions,
  type Presentation,
  type PresentationContentRef,
  type PresentationContentRole,
  type PresentationColorMode,
  type PresentationPage,
  type PresentationProblem,
  type PresentationRenditionState,
  type PresentationState,
  type WaitUntilCurrentOptions,
} from "@inklethq/sdk";

const options = {
  pat: "inklet_pat_typecheck",
  baseUrl: "http://127.0.0.1:8787/v1",
  fetch: async () => Response.json({ ok: true }),
  timeoutMs: 30_000,
  uploadTimeoutMs: 10 * 60_000,
} satisfies InkletClientOptions;

const client = new Inklet(options);
const requestOptions = {
  method: "POST",
  json: { text: "Hello, Inklet" },
  timeoutMs: 5_000,
  signal: AbortSignal.timeout(10_000),
} satisfies InkletRequestOptions;

void client.request<{ ok: boolean }>("/typecheck", requestOptions);

// Headers and bodies are the SDK's own structural types, so none of this
// needs the DOM lib; the usual shapes still fit.
const headerShapes: InkletRequestHeaders[] = [
  { "x-trace": "1" },
  [["x-trace", "1"]],
  new Headers({ "x-trace": "1" }),
];
const bodyShapes: InkletRequestBody[] = [
  "text",
  new Uint8Array([1]),
  new ArrayBuffer(1),
  new Blob(["x"]),
  new URLSearchParams({ a: "1" }),
  new FormData(),
];
void headerShapes;
void bodyShapes;

// Every resource method takes a signal and a per-call timeout.
const call = {
  signal: new AbortController().signal,
  timeoutMs: 5_000,
} satisfies CallOptions;
void client.contents.retrieve("content_123", call);
void client.contents.list({ state: "ready", ...call });
void client.contents.create({ assets: [{ type: "text", text: "Hi" }] }, "key-12345678", call);
void client.contents.refreshUploadTickets("content_123", [0], call);
void client.analyses.retrieve("analysis_123", call);
void client.analyses.list({ state: "running", ...call });
void client.analyses.list({ mode: "chat", trigger: "chat", ...call });
void client.conversations.create({ title: "牙医" }, call);
void client.conversations.list({ limit: 10, ...call });
void client.conversations.retrieve("conversation_123", call);
void client.conversations.listMessages("conversation_123", { before: "message_123", ...call });
void client.conversations.delete("conversation_123", call);
void client.conversations.send("conversation_123", { text: "你好" }, call);
void client.conversations.send("conversation_123", "你好", call);
void client.conversations.reply("conversation_123", "你好", {
  onDelta: (text: string) => void text,
  onEvent: (ev: AnalysisEvent) => void ev.seq,
  ...call,
});
void client.conversations.message("conversation_123", "message_123", call);
void client.analyses.archive("analysis_123", call);
void client.analyses.listEvents("analysis_123", { after: 1, ...call });
void client.displays.list(call);
void client.displays.retrieve("display_123", call);
void client.displays.listQueue("display_123", call);
void client.displays.current("display_123", { format: "png", ...call });
void client.displays.setCurrent("display_123", "presentation_123", call);
void client.displays.advance("display_123", call);
void client.presentations.retrieve("presentation_123", call);
void client.presentations.list({ scope: "all", ...call });
void client.presentations.render("presentation_123", { preset: "p" }, call);
void client.analyze({ contentIds: ["content_123"] }, call);
void client.direct({ contentId: "content_123", target: { displayId: "d" } }, call);

// Request-side values stay closed: sending one the backend does not know can
// only fail.
// @ts-expect-error not a Content state this SDK can ask for
void client.contents.list({ state: "archived" });
// @ts-expect-error chat rounds are started through conversations, not analyses.create
void client.analyses.create({ mode: "chat", contentIds: [] }, "key-12345678");
// @ts-expect-error not a Presentation state this SDK can ask for
void client.presentations.list({ state: "archived" });

void (async () => {
  try {
    await client.push.auto({ assets: [client.assets.text("Hi")] });
  } catch (error) {
    if (error instanceof InkletError) {
      const key: string | undefined = error.idempotencyKey;
      void key;
    }
    if (error instanceof RequestTimeoutError) {
      const network: NetworkError = error;
      const timeoutMs: number = error.timeoutMs;
      void network;
      void timeoutMs;
    }
    if (error instanceof RateLimitError || error instanceof ApiError) {
      const retryAfterMs: number | null = error.retryAfterMs;
      void retryAfterMs;
    }
    if (error instanceof MultiplePresentationsError) {
      const ids: readonly string[] = error.presentationIds;
      const analysisId: string = error.analysisId;
      void ids;
      void analysisId;
    }
  }
})();

const autoInput = {
  idempotencyKey: "typecheck-auto-1",
  assets: [client.assets.text("Hello, Inklet")],
} satisfies AutoPushInput;

const hardcodeInput = {
  displayId: "display_123",
  image: client.assets.image({
    data: new Uint8Array([1, 2, 3]),
    filename: "poster.png",
    contentType: "image/png",
  }),
} satisfies HardcodePushInput;

const generationInput = {
  assets: [client.assets.text("Hello from a software-only Presentation")],
  output: {
    viewport: { width: 360, height: 170 },
    formats: ["scene", "png"],
  },
} satisfies GeneratePresentationInput;

const scopeInput = { since: "72h" } satisfies AnalysisScopeInput;

const analyzeInput = {
  contentIds: ["content_123"],
  context: "history",
  scope: scopeInput,
  target: { output: { preset: "macos-widget-medium" } },
} satisfies AnalyzeInput;

void client.analyses.retrieve("analysis_123").then((analysis) => {
  const scope: AnalysisScope | null = analysis.scope;
  const sinceAt: string | null | undefined = scope?.sinceAt;
  void sinceAt;
});

const analysisPromise: Promise<Analysis> = client.analyze(analyzeInput);
const historyOnly: Promise<Analysis> = client.analyze({});
const directPromise: Promise<Analysis> = client.direct({
  contentId: "content_123",
  target: { displayIds: ["display_123"] },
});
const uploadPromise = client.contents.upload({
  title: "Note",
  assets: [client.assets.text("Only stored, not analyzed")],
});
void uploadPromise.then((r) => client.contents.waitUntilReady(r.content));
void analysisPromise.then((a) => client.analyses.wait(a));

const displayPromise: Promise<Display> = client.displays.retrieve("display_123");
const currentPromise: Promise<Presentation | null> =
  client.displays.current("display_123");
const contentPromise: Promise<Content> = client.contents.retrieve("content_123");

void client.push.auto(autoInput);
void client.push.hardcode(hardcodeInput);
void client.presentations.retrieve("presentation_123", { format: "raw2" });
const generation = client.presentations.generate(generationInput);
void generation.then(async (value) => {
  const presentation = await client.presentations.waitUntilReady(value);
  const refs: readonly PresentationContentRef[] = presentation.contentIds;
  // Values read from a response are open: known literals for completion and
  // narrowing, plus any string a newer backend sends.
  const role: PresentationContentRole | (string & {}) | undefined = refs[0]?.role;
  const mode: "ai" | "direct" | (string & {}) = presentation.mode;
  const state: PresentationState | (string & {}) = presentation.state;
  // @ts-expect-error a response state may be one this SDK does not know
  const closed: PresentationState = presentation.state;
  void role;
  void mode;
  void state;
  void closed;
});

void client.contents.retrieve("content_123").then((content) => {
  const state: ContentState | (string & {}) = content.state;
  switch (content.state) {
    case "pending":
    case "ready":
    case "failed":
      break;
    default:
      // Reachable: a state added after this SDK shipped.
      void content.state.length;
  }
  void state;
});

const waitUntilCurrentOptions = {
  pollIntervalMs: 2_000,
  timeoutMs: 10 * 60_000,
  signal: new AbortController().signal,
} satisfies WaitUntilCurrentOptions;

const setCurrentPromise: Promise<Display> = client.displays.setCurrent(
  "display_123",
  "presentation_123",
);
const advancePromise: Promise<DisplayAdvanceResult> =
  client.displays.advance("display_123");
void advancePromise.then(({ display, changed }) => {
  const id: string = display.id;
  const didChange: boolean = changed;
  void id;
  void didChange;
});
void setCurrentPromise.then(() =>
  client.displays.waitUntilCurrent(
    "display_123",
    "presentation_123",
    waitUntilCurrentOptions,
  ),
);

void client.displays.listQueue("display_123").then((page) => {
  const item = page.items[0];
  const refs: readonly PresentationContentRef[] | undefined = item?.contentIds;
  const mode: "ai" | "direct" | (string & {}) | undefined = item?.mode;
  void refs;
  void mode;
});
void client.presentations
  .render("presentation_123", { preset: "macos-widget-medium" })
  .then((rendition) => {
    const state: PresentationRenditionState | (string & {}) = rendition.state;
    const colorMode: PresentationColorMode | (string & {}) = rendition.colorMode;
    const url: string | null = rendition.url;
    const expiresAt: string | null = rendition.expiresAt;
    const failure: PresentationProblem | null = rendition.failure;
    void state;
    void colorMode;
    void url;
    void expiresAt;
    void failure;
  });

const displayHistoryOptions = {
  displayId: "display_123",
  state: "expired",
  limit: 20,
} satisfies ListPresentationsOptions;

const displayHistoryPage: Promise<PresentationPage> =
  client.presentations.list(displayHistoryOptions);

void displayHistoryPage.then((page) => {
  const displayIds: readonly (string | null)[] = page.items.map(
    (item) => item.displayId,
  );
  const historyWindowStart: string | null = page.historyWindowStart;
  void displayIds;
  void historyWindowStart;
});
const listEventsOptions = {
  after: 12,
  limit: 200,
} satisfies ListAnalysisEventsOptions;

const watchOptions = {
  after: 12,
  signal: new AbortController().signal,
  timeoutMs: 10_000,
  pollIntervalMs: 1_000,
  reconnectDelayMs: 500,
} satisfies WatchAnalysisOptions;

const timelineOptions = {
  pageSize: 100,
  timeoutMs: 10_000,
} satisfies TimelineOptions;

// `detail` is gone from both readers, and from the event itself.
// @ts-expect-error the option no longer exists
const removedListDetail: ListAnalysisEventsOptions = { detail: "full" };
// @ts-expect-error the option no longer exists
const removedTimelineDetail: TimelineOptions = { detail: "full" };
void removedListDetail;
void removedTimelineDetail;

const eventPagePromise: Promise<AnalysisEventPage> = client.analyses.listEvents(
  "analysis_123",
  listEventsOptions,
);
void eventPagePromise.then((page) => {
  const nextAfter: number | null = page.nextAfter;
  const state: "queued" | "running" | "completed" | "failed" | (string & {}) = page.state;
  void nextAfter;
  void state;
});

const liveEvents: AsyncIterable<AnalysisEvent> = client.analyses.watch(
  "analysis_123",
  watchOptions,
);
void (async () => {
  const collected: AnalysisEvent[] = [];
  for await (const event of liveEvents) {
    const level: AnalysisEventLevel | (string & {}) = event.level;
    const source: AnalysisEventSource | (string & {}) = event.source;
    const type: AnalysisEventType | (string & {}) = event.type;
    const summary: string = event.summary;
    const line: string = describeEvent(event);
    collected.push(event);

    // `data` is typed per known type, reached through the narrowing guard.
    if (isAnalysisEvent(event, "agent.activity")) {
      const activity: AgentActivityData = event.data;
      const activityId: string = activity.activityId;
      const kind: AgentActivityKind | (string & {}) = activity.kind;
      const state: AgentActivityState | (string & {}) = activity.state;
      const stats: AgentActivityStats = activity.stats;
      const notesRead: number | undefined = stats.notesRead;
      const chosen: string | null | undefined = stats.chosen;
      void activityId;
      void kind;
      void state;
      void notesRead;
      void chosen;
    } else if (isAnalysisEvent(event, "plan.rejected")) {
      const rejected: PlanRejectedData = event.data;
      const reason: PlanRejectedReason | (string & {}) = rejected.reason;
      const problems: number = rejected.problems;
      void reason;
      void problems;
    } else if (isAnalysisEvent(event, "plan.submitted")) {
      const submitted: PlanSubmittedData = event.data;
      void submitted.outcome;
      void submitted.actions;
    } else if (isAnalysisEvent(event, "plan.accepted")) {
      const accepted: PlanAcceptedData = event.data;
      const ids: readonly string[] = accepted.presentationIds;
      void ids;
    } else if (isAnalysisEvent(event, "context.materialized")) {
      const context: ContextReadyData = event.data;
      const contents: number = context.contents;
      void contents;
      void context.warnings;
    } else if (isAnalysisEvent(event, "analysis.completed")) {
      const completed: AnalysisCompletedData = event.data;
      void completed.outcome;
      void completed.presentations;
    } else if (isAnalysisEvent(event, "analysis.failed")) {
      const failed: AnalysisFailedData = event.data;
      const code: string = failed.code;
      void code;
    } else if (isAnalysisEvent(event, "analysis.lease_expired")) {
      const expired: AnalysisLeaseExpiredData = event.data;
      const attempt: number = expired.attempt;
      void attempt;
    } else if (isAnalysisEvent(event, "render.finished")) {
      const render: RenderEventData = event.data;
      const presentationId: string = render.presentationId;
      void presentationId;
    } else if (isAnalysisEvent(event, "delivery.confirmed")) {
      const delivery: DeliveryEventData = event.data;
      void delivery.presentationId;
      void delivery.displayId;
    } else if (isAnalysisEvent(event, "analysis.created")) {
      // A known type with no documented payload keeps the open record.
      const data: Record<string, unknown> = event.data;
      void data;
    }

    void level;
    void source;
    void type;
    void summary;
    void line;
  }

  const merged: AnalysisEvent[] = mergeActivities(collected);
  const rerun: AnalysisEvent[] = mergeActivities(new Set(merged));
  void rerun;

  for await (const event of client.analyses.timeline(
    "analysis_123",
    timelineOptions,
  )) {
    void event.seq;
  }
  const archive: AnalysisArchive = await client.analyses.archive("analysis_123");
  void archive.url;
  void archive.expiresAt;
})();

void displayPromise;
void currentPromise;
void contentPromise;
void historyOnly;
void directPromise;
void AuthenticationFailedError;
void SubscriptionRequiredError;
void NoChangeError;
