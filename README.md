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

- Node.js 20 or newer
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

The default service address is `https://dev.iminklet.com`. A controlled local
or test service can be selected with `baseUrl`.

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
`code: "presentation_not_deliverable"`. `advance()` moves to the next queued
Presentation and returns `changed: false` when the queue is empty, which is a
normal result, not an error.

The Presentation that was on the panel becomes `expired` rather than going back
into the queue, so `displays.listQueue()` always means "not shown yet". To go
back to a previous image, find it in `presentations.list()` and call
`setCurrent()` with it: an `expired` Presentation can be reactivated.

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
Analysis that named no `contentIds`. A stored Scene can be rendered at another
size without rerunning AI:

```ts
const rendition = await inklet.presentations.render(presentation.id, {
  viewport: { width: 720, height: 340 },
});
```

`output.preset` can replace `output.viewport`; supported presets include
`default`, `macos-widget-small`, `macos-widget-medium`, and
`macos-widget-large`.

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

Each helper returns the Content, the Analysis, and the idempotency key it used
for both. When `idempotencyKey` is omitted the SDK generates one; supply your
own for caller-controlled retries.

## Content lifecycle

A Content is `ready` once its Assets are in storage. Text and link Contents are
`ready` immediately; Contents with binary Assets are `pending` until Inklet
has verified the uploads, which happens on its own or when an Analysis first
references the Content.

```ts
const { content } = await inklet.contents.upload({ assets });
await inklet.contents.waitUntilReady(content);   // optional
const stored = await inklet.contents.list({ state: "ready" });
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
  RateLimitError,
  SubscriptionRequiredError,
} from "@inklethq/sdk";

try {
  await inklet.displays.list();
} catch (error) {
  if (error instanceof AuthenticationFailedError) {
    // Replace or reactivate the PAT.
  } else if (error instanceof SubscriptionRequiredError) {
    // Upgrade in the Inklet portal, then retry with the same PAT.
  } else if (error instanceof RateLimitError) {
    // Retry according to your application policy.
  } else if (error instanceof InkletError) {
    console.error(error.code, error.requestId, error.details);
  }
}
```

Authenticated requests refuse absolute URLs and cross-origin redirects.
Credentials are redacted from errors, and storage uploads never include the
PAT.

## Development

```sh
npm ci
npm run check
npm run pack:check
```

`npm run check` builds ESM and CommonJS output, runs strict TypeScript checks,
and executes the test suite.
