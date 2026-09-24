# `@inklethq/sdk`

Official server-side JavaScript and TypeScript SDK for Inklet.

The SDK supports PAT authentication, Display and Presentation reads, Content
upload, Analysis (with or without the user's earlier uploads as context), and
one-call Auto, Manual, and Hardcode Push helpers.

Targetless Presentation generation is available for software-only experiences:
it produces versioned Scene JSON and PNG renditions without requiring a
registered Display.

Auto and Manual Push use Inklet AI processing and require an active Pro
subscription. Hardcode Push does not use AI and remains available on the Free
plan. Subscription checkout and management stay in the
[Inklet portal](https://portal.iminklet.com/subscription), not in this SDK.

## Requirements

- Node.js 22 or newer
- An Inklet personal access token (PAT)
- A trusted server environment

Never expose a PAT in a browser bundle. The SDK rejects browser use before a
request is sent.

## Install

```sh
npm install @inklethq/sdk
```

## Initialize

```ts
import { Inklet } from "@inklethq/sdk";

const inklet = new Inklet({
  pat: process.env.INKLET_PAT!,
});
```

CommonJS is supported too:

```js
const { Inklet } = require("@inklethq/sdk");

const inklet = new Inklet({ pat: process.env.INKLET_PAT });
```

`secretKey` remains available as a compatibility alias for `pat`; do not pass
both options. Client construction validates configuration without making a
network request.

The default service address is `https://dev.iminklet.com`, the hosted Inklet
API. A controlled local or test service can be selected with `baseUrl`.

### Timeouts and cancellation

Every HTTP request has a timeout: 60 seconds by default, and 5 minutes for
each storage upload, which moves the file itself. Both are set on the client,
and every method takes `{ signal, timeoutMs }` as its last argument to change
them for one call:

```ts
const inklet = new Inklet({
  pat: process.env.INKLET_PAT!,
  timeoutMs: 30_000,        // each API request
  uploadTimeoutMs: 600_000, // each storage upload
});

const controller = new AbortController();
const page = await inklet.displays.list({ limit: 20, signal: controller.signal });
const display = await inklet.displays.retrieve(page.items[0].id, { timeoutMs: 5_000 });
```

A request that runs out of time throws `RequestTimeoutError`, a
`NetworkError`. An aborted call throws `OperationAbortedError` with the
signal's reason as its `cause`, and the abort reaches a request already in
flight, including inside the waiting helpers. Neither undoes anything the
backend had already accepted.

A per-call `timeoutMs` applies to each request the call sends, not to the call
as a whole; pass `AbortSignal.timeout(ms)` as the `signal` for an overall
limit. On `watch()` and `requestRaw()` it covers getting the response headers,
so a stream that runs for minutes is not cut off.

The waiting helpers and `timeline()` only ever read, so they ride out up to
three transient failures in a row — a dropped connection, a timeout, or HTTP
408, 429, 500, 502, 503, or 504 — backing off and honouring `Retry-After`;
`watch()` reconnects on the same failures (see [Transport](#transport)). Calls
that create or change something are never retried for you; see
[Idempotency](#idempotency) for retrying them safely.

## Versioning

The SDK is pre-1.0. A minor release (`0.3` → `0.4`) can break the API and
lists each break under **Breaking** in the [changelog](CHANGELOG.md); a patch
release does not. npm's default `^0.3.0` range already stays on `0.3.x`.

Fields the backend reports as a fixed set of words — `state`, `mode`,
`format`, an activity's `kind` — are typed as the values this SDK knows plus
any other string. A backend that adds a value therefore never breaks an
installed SDK: the new value reads through as it is, a waiting helper treats
an unknown state as not finished yet, and `describeEvent()` falls back to a
generic line. Compare against the values you handle and keep a default branch.

## Displays and Presentations

```ts
const page = await inklet.displays.list({ limit: 20 });
const display = await inklet.displays.retrieve(page.items[0].id);

const queue = await inklet.displays.listQueue(display.id, {
  from: new Date("2026-08-01T00:00:00Z"),
  limit: 20,
});

const current = await inklet.displays.current(display.id, { format: "png" });
if (current) {
  const presentation = await inklet.presentations.retrieve(current.id, {
    format: "raw2",
  });
}
```

`displays.current()` is a read and returns `null` when the Display has no
confirmed Presentation. To change what is on the panel, see
[Switch the image on a Display](#switch-the-image-on-a-display).

`listQueue()` only covers what has not been shown yet. For one Display's
history, filter the Presentation list by that Display:

```ts
// Everything this panel has shown or is about to show, newest first.
const history = await inklet.presentations.list({
  displayId: display.id,
  limit: 20,
});

// Narrow it to one state: what is on the panel now, or what it showed before.
const live = await inklet.presentations.list({
  displayId: display.id,
  state: "published",
});
const previous = await inklet.presentations.list({
  scope: "display", // the explicit form of what displayId already implies
  displayId: display.id,
  state: "expired",
});
```

`displayId` combines with `state`, `cursor`, and `limit`. `scope` is optional
alongside it and defaults to `display`; `scope: "all"` narrows to the Display
half just the same, and `scope: "generated"` contradicts the filter and is an
`ApiError` with `code: "invalid_request"`. An unknown Display id, or one
belonging to someone else, returns an empty page; an id that is not well formed
is rejected the same way as a contradictory scope.

Without a `displayId`, `scope` defaults to `generated` instead, so a bare
`presentations.list()` returns the software-only Presentations and none of the
Display ones. Ask for `scope: "display"` or `scope: "all"` when you want those.

How far back that history reaches depends on the plan: the Free plan sees the
last 7 days of Display Presentations, Pro sees all of them. The list clamps
rather than failing — older rows are left out — and the page says where the
floor is in `historyWindowStart`, so you can show the user what they are
looking at:

```ts
const history = await inklet.presentations.list({ displayId: display.id });

if (history.historyWindowStart) {
  const since = new Date(history.historyWindowStart);
  console.log(`Showing history since ${since.toLocaleDateString()}`);
}
```

`historyWindowStart` is an RFC3339 UTC timestamp, or `null` when no floor
applies — an unlimited plan, or a `scope: "generated"` read, which has no
Display half. It reports the floor whenever one applies, not only when rows
were actually left out, so it is safe to render as "history starts here" on a
page that happens to be short. Nothing is deleted: the hidden Presentations
come back on the same call after an upgrade. `displays.listQueue()`,
`displays.current()`, and `presentations.retrieve()` are unaffected, so a
Presentation whose id you already hold stays readable either way.

## Upload, then analyze

Uploading and analyzing are separate steps. A Content is just the submitted
Assets; nothing is processed until an Analysis references it.

```ts
// 1. Store Content. No AI runs, no quota is spent.
const { content } = await inklet.contents.upload({
  title: "Dentist",
  assets: [inklet.assets.text("Dentist at 9am tomorrow")],
});

// 2. Analyze it. Inklet picks compatible Displays.
const analysis = await inklet.analyze({
  contentIds: [content.id],
  intent: "Make a reminder card",
});

const done = await inklet.analyses.wait(analysis);
if (done.outcome === "presentations") {
  console.log(done.presentationIds);
} else {
  console.log("no change:", done.noChangeReason);
}
```

`analyze()` options:

| Option | Meaning |
| --- | --- |
| `contentIds` | Contents to analyze. Omit to analyze recent history only. When you pass Contents, the Analysis never completes as `no_change`: every Content you name appears in at least one Presentation, or the Analysis fails with `no_presentable_content`. |
| `context` | `submitted` (default with `contentIds`): only those Contents. `history`: the agent may also read the user's earlier Contents. |
| `scope` | `{ since: "72h" }` look-back window for `history`; the backend picks a default when omitted. It resolves `since` to an absolute `sinceAt` at creation time, echoed back on `analysis.scope`, so a queued Analysis reads the window it was created with. |
| `target` | Omit for agent-selected Displays, `{ displayId }` / `{ displayIds }` to pin, or `{ output }` for a software-only Scene/PNG. |
| `intent`, `title` | Hints for the agent; `title` overrides the generated title. |

The same plan history depth applies to `context: "history"`, so an earlier
`scope.since` than the plan allows is clamped at creation instead of rejected —
read `analysis.scope.sinceAt` for the window the agent actually explored.

```ts
// Combine new Content with earlier uploads.
await inklet.analyze({ contentIds: [content.id], context: "history", intent: "Merge into today's to-do" });

// Nothing new: summarize the last three days.
await inklet.analyze({ scope: { since: "72h" } });

// Software-only output for a Widget.
await inklet.analyze({ contentIds: [content.id], target: { output: { preset: "macos-widget-medium" } } });

// One image straight to Displays, no AI.
const { content: img } = await inklet.contents.upload({ assets: [inklet.assets.image({ data, filename: "a.png", contentType: "image/png" })] });
await inklet.direct({ contentId: img.id, target: { displayIds: [displayId] } });
```

Omitting `target` asks Inklet to pick the Displays, so it needs at least one
usable one. An account with none is refused at creation — HTTP 422,
`code: "no_compatible_display"` — instead of running a full pass and failing
at the end with a message about the Content. A `{ output }` target is
unaffected: a software-only Presentation needs no Display.

A `no_change` outcome is a normal completion and is only possible when you
pass no `contentIds`: the agent looked at recent history and decided nothing
was worth showing. `analyses.wait()` throws `AnalysisFailedError` only when the
Analysis itself failed; the backend code is on `error.details.backendCode`.

`analyses.wait()` and `presentations.waitUntilReady()` default to
`timeoutMs: 120_000`, which suits a `submitted` Analysis. Analyses with
`context: "history"` run one at a time per user, and scheduled ones queue the
same way, so they can stay `queued` much longer:

```ts
const done = await inklet.analyses.wait(analysis, { timeoutMs: 15 * 60_000 });
```

A timeout throws `OperationTimeoutError` but does not cancel the Analysis;
`inklet.analyses.retrieve(analysis.id)` still returns it once it finishes.

Scheduled analyses created by Inklet appear in
`inklet.analyses.list({ trigger: "scheduled" })`.

### Idempotency

`POST /analyses` and `POST /contents` both require an `Idempotency-Key`, and
the SDK always sends one: your `idempotencyKey` when you pass it, otherwise a
generated `sdk-<uuid>`. A key is 8 to 128 printable ASCII characters with no
spaces; anything else is a `ConfigurationError` before the request leaves.

Replaying a key returns the original resource rather than creating a second
one. The same key with a different body is a `ConflictError` with
`code: "idempotency_conflict"`. Keys are scoped per route, so one key can
cover both the Content and the Analysis — which is exactly what `push.*` and
`presentations.generate()` do, and why they return the key they used. A
request the backend *rejects* releases its key, so a call that failed on a
fixable problem can be retried under the same one.

A call that fails for another reason — a timeout, a dropped connection, a `5xx`
— may still have created something, so retry it with the key it used rather
than a fresh one. Every error such a call throws carries that key, including
one the SDK generated:

```ts
import { NetworkError } from "@inklethq/sdk";

try {
  await inklet.push.auto({ assets });
} catch (error) {
  if (error instanceof NetworkError && error.idempotencyKey) {
    // Same input, same key: replays what the first attempt created.
    await inklet.push.auto({ assets, idempotencyKey: error.idempotencyKey });
  } else {
    throw error;
  }
}
```

The backend keeps keys for 24 hours, and the retry has to send the same input.

## Follow an Analysis

An Analysis publishes an ordered event stream: what the agent was given, what
it is working on, what it planned, and how the result was rendered and
delivered. `watch()` follows it live and ends on its own once the Analysis is
`completed` or `failed`.

```ts
import { describeEvent } from "@inklethq/sdk";

const analysis = await inklet.analyze({ contentIds: [content.id] });

for await (const ev of inklet.analyses.watch(analysis.id)) {
  console.log(describeEvent(ev));
}
```

The stream is a progress report, not the run's log. It answers *where is this
now*, and it is a closed set of sixteen types:

| Stage | Types |
| --- | --- |
| Accepted | `analysis.created` · `analysis.dispatched` · `analysis.leased` · `analysis.lease_expired` |
| Working | `context.materialized` · `agent.activity` |
| Planning | `plan.submitted` · `plan.rejected` · `plan.accepted` |
| Result | `render.finished` · `render.failed` · `delivery.published` · `delivery.confirmed` · `delivery.failed` |
| Finished | `analysis.completed` · `analysis.failed` |

The Result row lands *after* the Analysis is already terminal: the run ends
when the plan is accepted, and only then do the Presentations render and a
panel fetch and confirm them — which for an offline panel can be days later.
`watch()` closes at the terminal state and so never yields those, by design;
nobody should hold a stream open waiting for a sleeping Display. Read them
afterwards with `timeline()` or `listEvents()`, which page over every event
the run has.

The agent's own working log — each turn, each tool call and its arguments and
output, the sentences a rejected plan was faulted for — **is not part of the
public API** and is not readable at any depth. Those are the run's
implementation: they name our workspace paths and change whenever the agent
does, and a UI built on them would break on a release that changed nothing you
can see. There is no depth option in the SDK, and a hand-rolled `?detail=` on
the public endpoint is rejected rather than honoured.

Every event carries `seq`, `at`, `attempt`, `source` (`agent` or `backend`),
`type`, `level`, a ready-to-display English `summary`, and structured `data`.

`seq` is monotonic and is what you pass back as `after` to resume — but it is
**not contiguous**. The sequence is shared with the run's internal events,
which you never receive, so a public stream skips numbers. Treat it as an
ordering and a resume token, never as a count or an index.

`data` is typed per event type, and only the fields the SDK declares are
validated: anything else the backend sends on a known type is passed through
rather than dropped, so a payload that gains a field still reads. `type` itself
is open too — a type this SDK has never seen parses as
`Record<string, unknown>` rather than failing the stream — so reach for the
payload through `isAnalysisEvent()`, which narrows both:

```ts
import { isAnalysisEvent } from "@inklethq/sdk";

for await (const ev of inklet.analyses.watch(analysis.id, { after: lastSeq, signal })) {
  if (isAnalysisEvent(ev, "plan.accepted")) console.log(ev.data.presentationIds);
  else if (ev.level === "error") console.error(ev.summary);
  lastSeq = ev.seq;
}
```

### `agent.activity`

A run of related agent steps arrives as one activity rather than one event per
step: `{ activityId, kind, state, steps, stats }`, where `kind` is
`reading_brief`, `reading_notes`, `checking_display`, `choosing_layout`,
`submitting_plan`, `retrying`, or `other`, and `state` is `active`, `done`, or
`failed`. `stats` counts only what applies — `notesRead`, `layoutsSeen`,
`chosen`, `failedSteps`, `deniedSteps` — and omits the rest rather than
sending zeros.

The same `activityId` arrives several times as the activity runs: throttled
`active` updates, then a final `done` or `failed`. **Upsert by `attempt` and
`activityId` together** instead of appending, or hand the list to
`mergeActivities()`, which keeps each activity at the position it first
appeared and replaces it with its latest state:

```ts
import { describeEvent, mergeActivities } from "@inklethq/sdk";

const steps = mergeActivities(events).map(describeEvent);
// "Ready · 3 Contents, 1 Display, 9 layouts"
// "Read 4 notes"
// "Chose Daily Summary"
// "Submitted the plan · 2 actions"
```

`activityId` restarts at `a1` every time the agent loop does, so a retried run
has one `a1` per attempt. Keying on the id alone folds the second attempt's
first activity into the first attempt's row, which is why the key is the pair.

`describeEvent()` turns `type` and `data` into one English line, falling back
to the backend's `summary`. It is pure and has no locale option.

### Transport

`watch()` handles the transport for you:

- It reads server-sent events, and reconnects from the last `seq` with
  `Last-Event-ID` if the connection drops or the server answers with a
  transient status — 408, 429, 500, 502, 503, or 504 (five attempts in a row,
  exponential back-off that honours `Retry-After`) — so nothing is lost across
  a reconnect.
- If the response is not `text/event-stream` — which is what an intermediate
  proxy that cannot carry streaming responses returns — it falls back to
  polling `listEvents()` every `pollIntervalMs` (1,000 ms by default) until the
  Analysis is terminal. The events you receive are the same either way.
- `signal` aborts the iteration with `OperationAbortedError`. Breaking out of
  the `for await` loop closes the connection.

`timeline()` reads the stream after the fact, paging for you, and works on a
running Analysis as well as a finished one. It is also the only way to see the
Result row, so it is what a finished run's timeline should be rebuilt from:

```ts
await inklet.analyses.wait(analysis);

for await (const ev of inklet.analyses.timeline(analysis.id)) {
  if (ev.level !== "info") console.warn(ev.summary);
}
```

For manual paging, `listEvents(id, { after, limit })` returns one page plus
`nextAfter`, `hasMore`, and the current `state`.

`analyses.archive(id)` returns a short-lived `{ url, expiresAt }` for the full
run archive, or throws `NotFoundError` with `code: "archive_not_found"` when
there is none.

### Streaming to a Portal or browser UI

This SDK is server-only: a personal access token must never reach a browser, so
run `watch()` on your server and relay events to the client over your own
channel (SSE, WebSocket, or whatever the Portal already uses).

Merge on whichever side owns the list. On the browser side that is an upsert
keyed by `attempt` and `activityId`, so a late `active` update never appends a
second row and a retry never overwrites the attempt before it:

```ts
function apply(rows: Map<string, string>, ev: AnalysisEvent) {
  const key = isAnalysisEvent(ev, "agent.activity")
    ? `${ev.attempt}:${ev.data.activityId}`
    : String(ev.seq);
  rows.set(key, describeEvent(ev));
}
```

If the client instead re-reads the timeline on reconnect, `mergeActivities()`
does the same thing in one call before rendering.

In browser code, read that relay with `fetch` plus `ReadableStream`, not
`EventSource`: `EventSource` cannot set request headers, cannot send a body,
and hides the response status and content type, so it cannot tell a real
stream from one a proxy has downgraded. Reading the body yourself is what lets
the SDK fall back to polling and resume from the last `seq`, and the same
applies to your relay:

```ts
const response = await fetch("/api/analysis-events?id=" + id, {
  headers: { accept: "text/event-stream" },
  signal,
});
const reader = response.body!.getReader();
const decoder = new TextDecoder();
// Buffer partial lines: chunk boundaries fall anywhere, including mid-line.
```

## Switch the image on a Display

Picking what is on the panel needs no AI and no new Content. Neither call
consumes AI or push quota.

```ts
// The panel confirms asynchronously: setCurrent moves pendingPresentationId,
// and currentPresentationId follows once the panel has fetched the image.
await inklet.displays.setCurrent(displayId, presentationId);
await inklet.displays.waitUntilCurrent(displayId, presentationId, {
  timeoutMs: 10 * 60_000,
});

const { changed } = await inklet.displays.advance(displayId);
```

`setCurrent()` accepts a Presentation of yours that has already been delivered
to this Display and finished rendering; anything else is a `ConflictError` with
`code: "presentation_not_deliverable"`. `error.details` carries
`{ displayId, presentationId, reason }`, and `reason` is the machine-readable
half — branch on it rather than on the message:

| `details.reason` | What it means |
| --- | --- |
| `targetless` | A generated Presentation. It has no panel to go back to. |
| `not_delivered` | Never delivered to any Display. |
| `other_display` | Delivered, but to a different Display. |
| `not_rendered` | Delivered here, but the image is not rendered yet. |

A Presentation belonging to someone else is `403`, not this conflict.
`advance()` picks the next queued Presentation instead of naming one, so it
never raises this; it returns `changed: false` when the queue is empty, which
is a normal result, not an error.

The Presentation that was on the panel becomes `expired` rather than going back
into the queue, so `displays.listQueue()` always means "not shown yet". To go
back to a previous image, find it in
`presentations.list({ displayId, state: "expired" })` and call `setCurrent()`
with it: an `expired` Presentation can be reactivated.

`waitUntilCurrent()` polls until the panel confirms. An offline panel confirms
at its next sync, so a timeout here throws `OperationTimeoutError` without
cancelling the switch.

## Generate a Presentation without a Display

`presentations.generate()` is `contents.upload()` plus `analyze()` with an
`output` target. It does not register a Display, publish a queue entry, or
send MQTT.

```ts
const generation = await inklet.presentations.generate({
  intent: "Create a calm, glanceable summary",
  assets: [inklet.assets.text("Revenue increased 12% this week.")],
  output: { viewport: { width: 360, height: 170 }, formats: ["scene", "png"] },
});

const presentation = await inklet.presentations.waitUntilReady(generation);
console.log(presentation.scene?.data);
console.log(presentation.renditions[0]?.url);
```

An `output` target always produces exactly one Presentation, so
`waitUntilReady()` returns it; it throws `NoChangeError` only when handed an
Analysis that named no `contentIds`, and `MultiplePresentationsError` (with
`presentationIds`) when handed one that produced several — one pinned to
several Displays, say — so use `analyses.wait()` for those. A stored Scene can be rendered at another size
without rerunning AI:

```ts
const rendition = await inklet.presentations.render(presentation.id, {
  viewport: { width: 720, height: 340 },
});
```

`output.preset` can replace `output.viewport`; supported presets include
`default`, `macos-widget-small`, `macos-widget-medium`, and
`macos-widget-large`.

Each rendition carries its own `state` — `preparing`, `ready`, or `failed` —
alongside the `colorMode` it was rendered in. Rendering is asynchronous, so a
new geometry comes back `preparing` with `url: null`; read the Presentation
again until it is `ready`. A `failed` rendition carries the reason in its own
`failure` and changes nothing else: the Scene stays readable, sibling
renditions keep their URLs, and asking for the same geometry again returns the
same rendition rather than starting a second render.

```ts
for (const rendition of presentation.renditions) {
  if (rendition.url !== null) {
    console.log(rendition.width, rendition.url, "expires", rendition.expiresAt);
  }
}
```

`url` and `expiresAt` are `null` together, so branch on `url` rather than on
`state`: they are also absent on the rare `ready` rendition the backend could
not sign. A `url` is short-lived — read the Presentation again for a fresh one;
that never re-renders.

A generated Presentation is never queued, published, confirmed, or expired —
it is `preparing`, `ready`, or `failed` — so a `scope: "generated"` list, which
is what a bare `presentations.list()` is, rejects any other `state` with
`invalid_request`. Under `scope: "all"` the same filter simply matches nothing
on the generated half.

## Push helpers

`inklet.push.*` are one-call wrappers over `contents.upload()` followed by
`analyze()` or `direct()`. Binary assets are uploaded directly to temporary
storage URLs; the PAT is sent only to Inklet API endpoints.

```ts
// Auto: Inklet chooses compatible Displays.
await inklet.push.auto({
  intent: "Make the key update easy to scan",
  context: "history",           // optional; default "submitted"
  assets: [inklet.assets.text("Revenue is up 12% week over week.")],
});

// Manual: one Display, AI layout.
await inklet.push.manual({ displayId, assets: [image, inklet.assets.text("This week's trend")] });

// Hardcode: one PNG/JPEG, no AI, scaled server-side.
await inklet.push.hardcode({ displayId, image });
```

Each helper returns the Content, the Analysis, and the one idempotency key it
used for both — pass your own `idempotencyKey` for caller-controlled retries.

## Content lifecycle

A Content is `ready` once its Assets are in storage. Text and link Contents are
`ready` immediately; Contents with binary Assets are `pending` until Inklet
has verified the uploads, which happens on its own or when an Analysis first
references the Content.

```ts
const { content } = await inklet.contents.upload({ assets });
await inklet.contents.waitUntilReady(content);   // optional
const stored = await inklet.contents.list({ state: "ready" });

// Search the library: every term must appear on the same Content — its title,
// or an Asset's text, link, filename, or what Inklet read out of an image or
// file. Substring match, so CJK works; paging is the same as an unfiltered list.
const found = await inklet.contents.list({ q: "dentist thursday" });
```

`contents.create()` and `contents.refreshUploadTickets()` remain public for
applications that manage uploads themselves.

## Errors

Every SDK error extends `InkletError`. Backend error codes, status, request ID,
and structured details are preserved.

```ts
import {
  AuthenticationFailedError,
  InkletError,
  PermissionDeniedError,
  RateLimitError,
} from "@inklethq/sdk";

try {
  await inklet.displays.list();
} catch (error) {
  if (error instanceof AuthenticationFailedError) {
    // Replace or reactivate the PAT.
  } else if (
    error instanceof PermissionDeniedError &&
    error.code === "plan_upgrade_required"
  ) {
    // Upgrade in the Inklet portal, then retry with the same PAT.
  } else if (error instanceof RateLimitError) {
    // Back off, or wait for details.resetAt when an allowance is spent.
  } else if (error instanceof InkletError) {
    console.error(error.code, error.requestId, error.details);
  }
}
```

The class comes from the HTTP status; `code` and `details` come from the
backend and are the stable parts. `message` is written for a human reading a
log and is not a contract — never branch on it.

| Status · `code` | SDK error | Raised by |
| --- | --- | --- |
| 400 `invalid_request` | `ApiError` | A bad field, cursor, or id; `displayId` with `scope: "generated"`; a missing or malformed `Idempotency-Key` |
| 401 | `AuthenticationFailedError`, `RevokedSecretKeyError`, or `InvalidSecretKeyError` | Any PAT problem; the backend does not distinguish them publicly |
| 402 `payment_required` | `ApiError` | The subscription's payment failed |
| 403 `access_denied` | `PermissionDeniedError` | The resource belongs to someone else |
| 403 `plan_upgrade_required` | `PermissionDeniedError` | A Pro-only operation on the Free plan |
| 404 `*_not_found` | `NotFoundError` | Unknown Display, Content, Analysis, Presentation, or run archive |
| 409 `idempotency_conflict` | `ConflictError` | The same key with a different body |
| 409 `presentation_not_deliverable` | `ConflictError` | `setCurrent()`; see `details.reason` above |
| 409 `analysis_in_progress` | `ConflictError` | Too many Analyses already queued for this user |
| 413 `asset_too_large` | `PayloadTooLargeError` | An Asset over the size limit |
| 422 `no_compatible_display` | `ApiError` | `analyze()` with no `target` and no usable Display |
| 429 `quota_exceeded` | `RateLimitError` | A plan allowance is spent; `details` carries `quota`, `limit`, `used`, and `resetAt` |
| 429 `rate_limited` | `RateLimitError` | Too many requests; back off and retry |

`quota_exceeded` and `rate_limited` share a class and mean different things:
back-off clears one, and only time or an upgrade clears the other, which is
what `details.resetAt` is for. When the response carried `Retry-After`,
`RateLimitError` and `ApiError` expose it as `retryAfterMs`, otherwise `null`.

Anything else keeps the backend's `code` on an `ApiError`, so a code this table
does not list is still readable rather than swallowed. `SubscriptionRequiredError`
is still exported and still matches `code: "subscription_required"`, but current
backends refuse a plan-gated call with `plan_upgrade_required` or
`payment_required` instead. Errors raised before a request goes out are
`ConfigurationError`. `NetworkError` means no response arrived, and its
subclass `RequestTimeoutError` (`code: "request_timed_out"`, with `timeoutMs`)
means one request ran out of time. `AnalysisFailedError`, `NoChangeError`,
`MultiplePresentationsError`, and `OperationTimeoutError` come from the waiting
helpers rather than from a response, and `OperationAbortedError` from any call
whose `signal` was aborted. An error from a call that sent an
`Idempotency-Key` carries it as `idempotencyKey`.

Authenticated requests refuse absolute URLs and follow no redirects.
Credentials are redacted from errors, and storage uploads never include the
PAT. A response that is not JSON — a proxy's error page, say — is reported by
its status and a short excerpt, never verbatim.

## Development

```sh
npm ci
npm run check
npm run pack:check
```

`npm run check` builds ESM and CommonJS output, runs strict TypeScript checks,
and executes the test suite.

## CI

Every pull request and every push to `main` runs four checks on GitHub Actions.

| Check | What it does | Run it locally |
| --- | --- | --- |
| `Node.js 22` / `24` / `26` | `npm ci`, then `npm run check` and `npm run pack:check` on each supported release | `npm ci && npm run check && npm run pack:check` |
| `Dependency audit` | Reports advisories rated high or critical. Advisory only: it never fails the build | `npm audit --audit-level=high` |
| `Analyze JavaScript and TypeScript` | CodeQL security queries, also on a weekly schedule | — |
| `gitleaks` | Scans the full commit history for leaked credentials | `docker run --rm -v "$PWD:/repo:ro" ghcr.io/gitleaks/gitleaks:v8.30.1 git /repo --config /repo/.gitleaks.toml --redact` |

The Node.js matrix covers the whole range the package claims in `engines`.

`.gitleaks.toml` silences the fake PATs and idempotency keys used as fixtures,
each scoped to the single rule it trips. Never add a real credential to that
allowlist: revoke it and rewrite the history instead.

## License

[MIT](LICENSE)
