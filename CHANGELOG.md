# Changelog

## Unreleased

- Add `contents.list({ q })`, the knowledge search: whitespace-separated
  terms that must all appear on the same Content — its title, or an Asset's
  text, URL, filename, digest summary, digest text, or tag. Case-insensitive
  substring match, so CJK text matches without tokenisation. The SDK trims
  it, sends nothing for a blank value, and rejects more than 200 characters
  (`MAX_CONTENT_SEARCH_LENGTH`) with `ConfigurationError` before a request.
  Paging and ordering are those of the unfiltered list.

## 0.3.0

The first release on npm since 0.1.0. 0.2.0, 0.2.1, and 0.2.2 were tagged but
never reached the registry — their publish runs failed — so upgrading from
0.1.0 brings everything listed under them as well as this. This release is
about surviving a backend that grows under the SDK and a network that stalls.

- **Breaking:** Fields the backend reports as a fixed set of words are open:
  the values this SDK knows plus `(string & {})`. A value it has never seen
  reads through instead of throwing `InvalidResponseError`, so a backend that
  adds one no longer breaks every installed SDK. This covers `Content.state`;
  `ContentAsset.type` and `.uploadState`; `Analysis.mode`, `.trigger`,
  `.state`, `.context`, and `.outcome`; `Presentation.mode` and `.state`;
  `PresentationContentRef.role`; `PresentationImage.format`;
  `PresentationRendition.mediaType`, `.format`, `.colorMode`, and `.state`;
  `PresentationOutput.formats` and `.colorMode`; `InkletSceneElement.type`;
  `DisplayCapabilities.supportedOutputFormats`; `DisplayQueueItem.mode` and
  `.state`; `AnalysisEvent.source` and `.level`; `AnalysisEventPage.state`;
  `AgentActivityData.kind` and `.state`; `PlanRejectedData.reason`;
  `PlanSubmittedData.outcome` and `AnalysisCompletedData.outcome`; and
  `PushResult.state`. The named types (`AnalysisState`, `PresentationState`,
  …) are still the closed sets, and request options still accept only those,
  so assigning one of these fields to its named type no longer compiles, and
  `=== "ready"` does not narrow the open member away. A value that is not a
  non-empty string is still refused, and so are the retired Presentation
  modes `auto`, `manual`, and `hardcode`. The waiting helpers treat an unknown
  state as not finished yet; `describeEvent()` describes an unknown activity
  kind like `other`, an unknown activity state as still running, and an
  unknown rejection reason with its generic sentence.
- **Breaking:** Every request has a timeout. Add `InkletClientOptions.timeoutMs`
  (default 60,000 ms, each API request) and `.uploadTimeoutMs` (default
  300,000 ms, each storage upload); either must be a whole number from 1 to
  2,147,483,647, or the client throws `ConfigurationError`. A request that runs
  out of time throws the new `RequestTimeoutError`, a `NetworkError` with
  `code: "request_timed_out"` and `timeoutMs`. For `request()` the timeout runs
  until the body is read; for `requestRaw()` and `watch()` it ends when the
  headers arrive, so a long stream is not cut off.
- Add `CallOptions { signal?, timeoutMs? }` as a trailing optional argument to
  `contents.upload()`, `.create()`, `.retrieve()`, and
  `.refreshUploadTickets()`; `analyses.analyze()`, `.direct()`, `.create()`,
  `.retrieve()`, and `.archive()`; `presentations.generate()` and `.render()`;
  `displays.retrieve()`, `.setCurrent()`, and `.advance()`; `push.auto()`,
  `.manual()`, and `.hardcode()`; and `inklet.analyze()` / `inklet.direct()`.
  `ListContentsOptions`, `ListAnalysesOptions`, `ListAnalysisEventsOptions`,
  `ListPresentationsOptions`, `RetrievePresentationOptions`,
  `ListDisplaysOptions`, and `CurrentPresentationOptions` extend it, and
  `WatchAnalysisOptions`, `TimelineOptions`, and `InkletRequestOptions` gain
  `timeoutMs`. An abort now cancels the request in flight — including inside
  `waitUntil*()` and `analyses.wait()`, which used to notice it only between
  polls — and throws `OperationAbortedError` with the signal's reason as
  `cause`. A waiting helper's `timeoutMs` is now a hard deadline that also
  cancels a hung read.
- The waiting helpers, `analyses.wait()`, `timeline()`, and `watch()`'s polling
  fallback ride out up to three transient failures in a row — a network error,
  a timeout, or HTTP 408, 429 (but not `quota_exceeded`), 500, 502, 503, or
  504 — backing off from the poll interval, doubling up to 30 s, and never
  sooner than `Retry-After`. `watch()` reconnects on the same statuses within
  its budget of five attempts. A `Retry-After` longer than 60 s is not slept
  through; its error is thrown with `retryAfterMs` set. Calls that create or
  change something are never retried.
- Add `RateLimitError.retryAfterMs` and `ApiError.retryAfterMs`: the response's
  `Retry-After`, delta-seconds or an HTTP-date, in milliseconds, or `null`.
- Add `InkletError.idempotencyKey`. Every error from a call that sent an
  `Idempotency-Key` carries it, including one the SDK generated, so a call that
  failed after the backend may already have acted on it — `push.*`,
  `presentations.generate()`, `analyze()`, `contents.upload()` — can be retried
  under the same key instead of creating a duplicate Content.
- **Breaking:** `presentations.waitUntilReady()` throws the new
  `MultiplePresentationsError` (`code: "analysis_multiple_presentations"`, with
  `analysisId` and `presentationIds`) instead of `InvalidResponseError` when the
  Analysis produced more than one Presentation.
- **Breaking:** `InkletRequestOptions.headers` is `InkletRequestHeaders` and
  `.body` is `InkletRequestBody | null`, both exported. The declarations no
  longer need the DOM lib: a Node project with `lib: ["ES2022"]` and
  `skipLibCheck: false` failed with TS2304.
- **Breaking:** Remove `UnsupportedOperationError`, which nothing threw and the
  package entry point never exported. The `AnalysesResource` constructor takes
  only its transport.
- **Breaking:** Require Node.js 22 or newer. Node.js 20 reached end of life in
  April 2026.
- **Packaging:** `exports` has separate `import` and `require` conditions, each
  with its own `types`, so a CommonJS consumer (a `.cts` file under
  `module: node16`) no longer fails with TS1479. `dist/types/` is gone; the
  declarations sit next to each build. `./package.json` is exported, and `src/`
  ships so that source maps resolve.
- **License:** MIT. Earlier releases were `UNLICENSED`.
- **Fix:** `analyses.list({ contentId })` and `presentations.list({ displayId })`
  no longer encode the id twice.
- **Fix:** A path id of `.` or `..` is refused with `ConfigurationError` before
  anything is sent, instead of addressing a different route.
- **Fix:** `AssetUploadError.cause` is the underlying failure of the first Asset
  that still failed; it used to be dropped.
- **Fix:** A non-JSON error body, such as a proxy's HTML page, becomes a short
  message — `The Inklet API returned HTTP 502: …` with the page's `<title>` or
  at most 200 characters of its text, credentials redacted — instead of the
  whole page.
- **Fix:** A bare `event: end` frame with no `data:` line ends `watch()`. It was
  dropped, which led to reconnects and finally a `NetworkError`.
- **Fix:** `describeEvent()` no longer reads an inherited property for a
  rejection `reason` such as `"constructor"`.
- Fix the `repository`, `homepage`, and `bugs` links, which pointed at the
  repository's old location.

## 0.2.2 — 2026-09-16 (tagged, never published to npm)

One fix to Presentation rendition parsing. The SDK modelled a rendition as
always having a URL; the backend has always been able to send one without.

- **Fix:** a rendition whose `url` and `expiresAt` are `null` no longer throws
  `InvalidResponseError`. The backend sends both as `null` whenever a rendition
  is `preparing` or `failed`, and rendering is asynchronous — so
  `presentations.render()` threw on every new geometry, and
  `presentations.retrieve()` and `presentations.list()` threw for any
  Presentation holding a rendition that had not landed or had failed.
- Add `state` (`preparing` | `ready` | `failed`), `colorMode`, and `failure` to
  `PresentationRendition`. The backend already sent all three; only the type
  was missing them. `state` is each rendition's own lifecycle — a `failed`
  rendition leaves its Presentation and its siblings untouched, and `failure`
  is the only place that reason appears. `colorMode` is part of a rendition's
  identity: the backend deduplicates on format, geometry, and colour mode
  together. The new `PresentationRenditionState` type is exported.
- **Changed types:** `PresentationRendition.url` and `.expiresAt` are now
  `string | null`. Branch on `url` rather than on `state`: they are `null`
  together on `preparing` and `failed`, and also on the rare `ready` rendition
  the backend could not sign, which it reports link-less rather than failing
  the whole read. Code that read `rendition.url` as a `string` now needs a null
  check; nothing is removed or renamed.

## 0.2.1 — 2026-09-15 (tagged, never published to npm)

Three corrections to the Analysis event stream, found while the Portal built
its timeline on these types. No API is removed or renamed.

- **Fix:** `mergeActivities()` keys by `attempt` **and** `activityId`, not by
  `activityId` alone. `activityId` restarts at `a1` every time the agent loop
  restarts, so on a retried run the old key folded attempt two's first activity
  into attempt one's row and the retry disappeared from the timeline. Each
  activity still keeps the position of its first appearance. Upserting by hand
  wants the same pair: `` `${event.attempt}:${event.data.activityId}` ``.
- Add `analysis.lease_expired` to `AnalysisEventType`, with
  `AnalysisLeaseExpiredData` (`{ attempt }`, plus anything else the backend
  sends, passed through untouched). It is written by the backend at `warn` when
  a worker's lease runs out before it returns a result: the attempt is
  abandoned and the run is handed back out, so it reads like the end and is
  not — the Analysis stays `running` and the next `analysis.leased` carries
  `attempt + 1`. `describeEvent()` says "Attempt 2 timed out — retrying".
- **Changed copy:** `describeEvent()` now matches the wording the Portal
  shows, so the two never say the same thing two ways. `agent.activity` reads
  "Reading your notes · 3 read" / "Read 3 notes", "Checking the display" /
  "Checked the display" (lower case: it is the object, not the type),
  "Looking at layouts · 2 so far" / "Looked at 2 layouts · chose Daily
  Summary", "Checking the plan" / "Submitted the plan", and "Working · 4
  steps" / "Worked through 4 steps". A `failed` activity is described by what
  it was attempting rather than by a finished sentence it never reached —
  "Reading your notes · 3 read — failed", not "Could not read the notes" — and
  `failedSteps` and `deniedSteps` append "· 1 step failed" and "· 2 steps
  blocked" before that marker. `plan.rejected` says what the plan got wrong and
  that it is being redone ("The first layout didn't fit — trying another (2
  problems)") instead of "Plan sent back · 2 problems with the layout it
  chose": a rejected plan is not a failed run. Nothing branches on these
  strings; `type` and `data` are unchanged.

## 0.2.0 — 2026-09-15 (tagged, never published to npm)

The Analysis event stream is now a public progress report rather than a window
onto the run. Everything in this release follows from that.

- **Breaking:** `AnalysisEvent.type` is a closed set widened with
  `(string & {})`. A public reader returns only `analysis.created`,
  `analysis.dispatched`, `analysis.leased`, `analysis.completed`,
  `analysis.failed`, `context.materialized`, `agent.activity`,
  `plan.submitted`, `plan.rejected`, `plan.accepted`, `render.finished`,
  `render.failed`, `delivery.published`, `delivery.confirmed`, and
  `delivery.failed`. The agent's own working log — `turn.*`, `tool.*`,
  `kernel.*`, `assistant.note`, `plan.validated` — is internal and never
  appears. A type this SDK has never seen still parses, so a backend that adds
  one does not break an older SDK. Adds `AnalysisEventType`.
- **Breaking:** `AnalysisEvent.data` is typed per event type instead of always
  being `Record<string, unknown>`. Adds `AgentActivityData`,
  `AgentActivityKind`, `AgentActivityState`, `AgentActivityStats`,
  `AnalysisCompletedData`, `AnalysisFailedData`, `ContextReadyData`,
  `DeliveryEventData`, `PlanAcceptedData`, `PlanRejectedData`,
  `PlanRejectedReason`, `PlanSubmittedData`, and `RenderEventData`. Parsing
  stays tolerant: a known type validates the fields it is defined to carry and
  passes every other field through, so a payload that gains a field still
  reads. Adds `AnalysisEventOf` and `AnalysisEventWithType`.
- **Breaking:** `AnalysisEvent.detail` is gone, along with
  `AnalysisEventDetail`, `AnalysisEventDetailLevel`,
  `ListAnalysisEventsOptions.detail`, and `TimelineOptions.detail`. Verbatim
  tool inputs and outputs and model text are not part of the public API at any
  depth. `timeline()` no longer reads the Analysis first, because there is no
  longer a depth that requires a terminal state: the `409`
  `analysis_in_progress` pre-check went with the option. A server that still
  sends `detail` is read without it rather than refused.
- **Breaking:** `AnalysisEvent.summary` is English. There is no locale option.
- Add `isAnalysisEvent(event, type)`, which narrows an event to one known type
  and its `data` with it. TypeScript cannot use `type` as a discriminant while
  the open member is in the union, so `event.type === "agent.activity"` narrows
  `type` but not `data`; this does both.
- Add `mergeActivities(events)`, which collapses every `agent.activity` to its
  latest state per `activityId`. One activity reports itself several times —
  throttled `active` updates, then `done` or `failed` — so a raw list renders
  the same row repeatedly. Each activity keeps the position of its first
  appearance and every other event passes through untouched.
- Add `describeEvent(event)`, a pure function returning one English line from
  `type` and `data`, falling back to the backend's `summary`. It is what makes
  `agent.activity` readable: the backend has no sentence for it, because what
  it means depends on counters that change while it runs.
- Document that `seq` is monotonic but **not contiguous** on a public stream:
  the sequence is shared with internal events that are never returned, so
  numbers are skipped. It remains a valid `after` cursor, and resuming across a
  reconnect is unaffected. Nothing in the SDK assumed contiguity.

- Add `Presentation.title`, the name a Display's history shows for the card.
  The backend resolves it when it accepts a plan (the plan's title, else the
  template's title parameter, else the first input Content's title or text
  excerpt, else the Analysis title or template name), so it is `null` only for
  Presentations stored before that.
- Add `PresentationPage.historyWindowStart`, which reports the plan's history
  depth on `presentations.list()`. The Free plan sees the last 7 days of
  Display Presentations and Pro sees all of them; the backend clamps rather
  than refusing, so older rows are omitted from `items` and the RFC3339 UTC
  floor is disclosed here whenever one applies, not only when rows were left
  out. It is `null` when none does: an unlimited plan, or a
  `scope: "generated"` read, which has no Display half. `items`, `nextCursor`,
  and `hasMore` are unchanged, and `displays.listQueue()`,
  `displays.current()`, and `presentations.retrieve()` are unaffected.
- Document that `Analysis.scope.sinceAt` may be later than the requested
  `scope.since`: the same plan history depth clamps a `context: "history"`
  window at creation instead of rejecting it, and `sinceAt` is the window the
  agent actually explored.
- Add `presentations.list({ displayId })`, which filters the list to
  Presentations targeted at one Display and is how a Display's history is read:
  `displays.listQueue()` only covers what has not been shown yet. It combines
  with `state`, `cursor`, and `limit`. `scope` is optional alongside it and
  defaults to `display`; `scope: "all"` narrows to the Display half just the
  same, while `scope: "generated"` contradicts the filter and is rejected with
  `code: "invalid_request"`. An unknown or foreign Display id returns an empty
  page.
- Add the Analysis event stream: `analyses.watch()` follows a running Analysis
  live and yields `AnalysisEvent`s as the agent works, `analyses.listEvents()`
  reads one page, `analyses.timeline()` pages through every event, and
  `analyses.archive()` returns a short-lived run-archive URL. Adds
  `AnalysisEvent`, `AnalysisEventLevel`, `AnalysisEventSource`,
  `AnalysisEventPage`, `ListAnalysisEventsOptions`, `WatchAnalysisOptions`,
  `TimelineOptions`, and `AnalysisArchive`.
- `watch()` parses server-sent events incrementally, resumes from the last
  `seq` with `Last-Event-ID` after a dropped connection (five attempts,
  exponential back-off), and falls back to polling `listEvents()` when an
  intermediate proxy answers with something other than `text/event-stream`.
  `signal` aborts with `OperationAbortedError`.
- Document that `watch()` ends at the terminal state and therefore does not
  yield `render.*` or `delivery.*`: those are written after the Analysis is
  already `completed`, and a Presentation waiting on an offline panel can take
  days to confirm. `timeline()` and `listEvents()` return them.
- Document `422 no_compatible_display`: an `analyze()` with no `target` asks
  the agent to pick a Display, so an account with none is refused at creation
  rather than running a full pass and failing with a Content-shaped code. It
  surfaces as `ApiError` with that `code`, and `target: { output }` is exempt.
- Add `InkletClient.requestRaw()`, which returns the raw `Response` for
  streaming endpoints, and a matching `requestRaw` on the internal resource
  transport. `request()` now keeps a caller-supplied `accept` header, and an
  aborted request throws `OperationAbortedError` instead of `NetworkError`.

- **Breaking:** `Presentation.contentIds` and `DisplayQueueItem.contentIds` are
  ordered `{ id, role }` refs instead of bare UUIDs, where `role` is `input`
  (named by the Analysis) or `context` (retrieved from history by the agent).
  Add `PresentationContentRef` and `PresentationContentRole`.
- **Breaking:** `Presentation.mode` and `DisplayQueueItem.mode` are now the
  `AnalysisMode` values `ai` / `direct` and are required. The retired
  `auto` / `manual` / `hardcode` values and the empty-string default are
  rejected. Target, context, and trigger are read from the Analysis through
  `Presentation.analysisId`.
- Add `displays.setCurrent()`, `displays.advance()`, and
  `displays.waitUntilCurrent()` for manual switching, with
  `DisplayAdvanceResult` and `WaitUntilCurrentOptions`. Both writes land on
  `pendingPresentationId` until the panel confirms, replace the previous image
  with an `expired` one rather than requeueing it, and consume no AI or push
  quota. A Presentation `setCurrent()` cannot show returns `ConflictError` with
  `code: "presentation_not_deliverable"` and `details.reason` — `targetless`,
  `not_delivered`, `other_display`, or `not_rendered` — so a UI can say which
  rule was broken without matching on the message. `advance()` picks from the
  queue and never raises it.
- Split Analysis scope: requests take `AnalysisScopeInput { since }` and only
  `since` is sent; responses carry `AnalysisScope { since, sinceAt }`, the
  absolute window the backend resolved when the Analysis was created.
- Document that naming `contentIds` rules out `no_change` (the Analysis fails
  with `no_presentable_content` instead), that `context: "history"` Analyses
  queue rather than conflict so `wait({ timeoutMs })` should be raised for
  them, and that a Content failed with `upload_expired` can be re-ticketed back
  to `pending`.
- Decouple upload from processing: `contents.upload()` stores Content without
  running AI; `inklet.analyze()` / `inklet.direct()` start an Analysis over
  `contentIds` and/or the user's history and produce Presentations.
- `POST /analyses` requires an `Idempotency-Key`, so `analyze()`, `direct()`,
  and `analyses.create()` always send one: the caller's `idempotencyKey` when
  given, otherwise a generated `sdk-<uuid>`. Keys are validated locally as 8 to
  128 printable ASCII characters without spaces, the same rule `POST /contents`
  already used, and are scoped per route — which is why `push.*` and
  `presentations.generate()` cover their Content and their Analysis with one
  key and return it.
- Add `context: "submitted" | "history"`, `scope.since`, and `target`
  (agent-selected, pinned Displays, or software-only `output`) to Analysis.
- Add `analyses.wait()`, `analyses.list()`, `no_change` outcomes,
  `AnalysisFailedError`, and `NoChangeError`.
- **Breaking:** Remove `contents.confirm()`; Content state is now `pending | ready | failed`
  and only tracks Asset ingestion.
- `push.*` and `presentations.generate()` are now wrappers over upload plus
  Analysis and accept `context`.
- Document the wire contract in `ANALYSIS_CONTRACT.md`.
- Add `SubscriptionRequiredError` for plan-gated SDK operations.
- Document that Auto and Manual Push require Pro while Hardcode remains
  available on Free.
- Add targetless `presentations.generate()`, `waitUntilReady()`, list, and
  rendition rendering so Scene JSON and PNG output no longer require a
  registered Display.
- Add the typed, versioned `inklet Scene v1` contract and output profiles for
  software surfaces such as macOS Widgets.

## 0.1.0 — 2026-08-13

- Add typed Display, Content, Presentation, Asset, and Push resources.
- Add Auto, Manual, and Hardcode Push workflows.
- Add direct presigned uploads without forwarding the PAT to storage.
- Refresh failed upload tickets once and retry binary uploads.
- Preserve backend error codes, request IDs, and structured details.
- Add strict Asset, pagination, time-range, and Content request validation.
- Keep Hardcode image dimensions server-controlled: PNG/JPEG inputs are
  automatically scaled to the target Display output size.
- Document asynchronous Content and Presentation lifecycle behavior.
- Verify Auto, Manual, and Hardcode against the dev backend, including real
  PNG, RAW2, and RAW4 downloads.

## 0.1.0-alpha.1 — 2026-07-24

- Publish the server-only PAT-authenticated client foundation.
- Add ESM, CommonJS, and TypeScript declaration builds.
- Add browser-environment, credential-leak, URL, and redirect protections.
