# Changelog

## Unreleased

- Add `Presentation.title`, the name a Display's history shows for the card.
  The backend resolves it when it accepts a plan (the plan's title, else the
  template's title parameter, else the first input Content's title or text
  excerpt, else the Analysis title or template name), so it is `null` only for
  Presentations stored before that.
- Add `PresentationPage.historyWindowStart`, which reports the plan's history
  depth on `presentations.list()`. The Free plan sees the last 7 days of
  Display Presentations and Pro sees all of them; the backend clamps rather
  than refusing, so older rows are omitted from `items` and the RFC3339 UTC
  floor is disclosed here. It is `null` when nothing was clipped, including a
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
  `AnalysisEventDetail`, `AnalysisEventDetailLevel`, `AnalysisEventPage`,
  `ListAnalysisEventsOptions`, `WatchAnalysisOptions`, `TimelineOptions`, and
  `AnalysisArchive`.
- `watch()` parses server-sent events incrementally, resumes from the last
  `seq` with `Last-Event-ID` after a dropped connection (five attempts,
  exponential back-off), and falls back to polling `listEvents()` when an
  intermediate proxy answers with something other than `text/event-stream`.
  `signal` aborts with `OperationAbortedError`.
- Event `type` is an open set: unknown types parse rather than failing the
  stream, so a backend that adds an event type does not break older SDKs.
- `timeline({ detail: "full" })` verifies the Analysis is `completed` or
  `failed` before the first page and otherwise throws `ConflictError` with
  `code: "analysis_in_progress"`, matching the backend's 409.
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
  quota. A Presentation that cannot be shown returns `ConflictError` with
  `code: "presentation_not_deliverable"`.
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
- Add `context: "submitted" | "history"`, `scope.since`, and `target`
  (agent-selected, pinned Displays, or software-only `output`) to Analysis.
- Add `analyses.wait()`, `analyses.list()`, `no_change` outcomes,
  `AnalysisFailedError`, and `NoChangeError`.
- Remove `contents.confirm()`; Content state is now `pending | ready | failed`
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
