import {
  AuthenticationFailedError,
  Inklet,
  NoChangeError,
  SubscriptionRequiredError,
  type Analysis,
  type AnalyzeInput,
  type AutoPushInput,
  type Content,
  type Display,
  type DisplayAdvanceResult,
  type GeneratePresentationInput,
  type HardcodePushInput,
  type InkletClientOptions,
  type InkletRequestOptions,
  type Presentation,
  type PresentationContentRef,
  type PresentationContentRole,
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

const analyzeInput = {
  contentIds: ["content_123"],
  context: "history",
  scope: { since: "72h" },
  target: { output: { preset: "macos-widget-medium" } },
} satisfies AnalyzeInput;

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
void displayPromise;
void currentPromise;
void contentPromise;
void historyOnly;
void directPromise;
void AuthenticationFailedError;
void SubscriptionRequiredError;
void NoChangeError;
