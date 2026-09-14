import {
  AuthenticationFailedError,
  Inklet,
  NoChangeError,
  SubscriptionRequiredError,
  type Analysis,
  type AnalysisArchive,
  type AnalysisEvent,
  type AnalysisEventLevel,
  type AnalysisEventPage,
  type AnalysisEventSource,
  type AnalysisScope,
  type AnalysisScopeInput,
  type AnalyzeInput,
  type ListAnalysisEventsOptions,
  type TimelineOptions,
  type WatchAnalysisOptions,
  type AutoPushInput,
  type Content,
  type Display,
  type DisplayAdvanceResult,
  type GeneratePresentationInput,
  type HardcodePushInput,
  type InkletClientOptions,
  type InkletRequestOptions,
  type ListPresentationsOptions,
  type Presentation,
  type PresentationContentRef,
  type PresentationContentRole,
  type PresentationPage,
  type WaitUntilCurrentOptions,
} from "@inklethq/sdk";

const options = {
  pat: "inklet_pat_typecheck",
  baseUrl: "http://127.0.0.1:8787/v1",
  fetch: async () => Response.json({ ok: true }),
} satisfies InkletClientOptions;

const client = new Inklet(options);
const requestOptions = {
  method: "POST",
  json: { text: "Hello, Inklet" },
} satisfies InkletRequestOptions;

void client.request<{ ok: boolean }>("/typecheck", requestOptions);

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
  const role: PresentationContentRole | undefined = refs[0]?.role;
  const mode: "ai" | "direct" = presentation.mode;
  void role;
  void mode;
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
  const mode: "ai" | "direct" | undefined = item?.mode;
  void refs;
  void mode;
});
void client.presentations.render("presentation_123", {
  preset: "macos-widget-medium",
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
  detail: "full",
} satisfies ListAnalysisEventsOptions;

const watchOptions = {
  after: 12,
  signal: new AbortController().signal,
  pollIntervalMs: 1_000,
  reconnectDelayMs: 500,
} satisfies WatchAnalysisOptions;

const timelineOptions = {
  detail: "full",
  pageSize: 100,
} satisfies TimelineOptions;

const eventPagePromise: Promise<AnalysisEventPage> = client.analyses.listEvents(
  "analysis_123",
  listEventsOptions,
);
void eventPagePromise.then((page) => {
  const nextAfter: number | null = page.nextAfter;
  const state: "queued" | "running" | "completed" | "failed" = page.state;
  void nextAfter;
  void state;
});

const liveEvents: AsyncIterable<AnalysisEvent> = client.analyses.watch(
  "analysis_123",
  watchOptions,
);
void (async () => {
  for await (const event of liveEvents) {
    const level: AnalysisEventLevel = event.level;
    const source: AnalysisEventSource = event.source;
    const type: string = event.type;
    const summary: string = event.summary;
    const data: Record<string, unknown> = event.data;
    const output: string | undefined = event.detail?.output;
    void level;
    void source;
    void type;
    void summary;
    void data;
    void output;
  }
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
