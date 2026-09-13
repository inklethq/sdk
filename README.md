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

`displays.current()` is read-only and returns `null` when the Display has no
confirmed Presentation.

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
| `contentIds` | Contents to analyze. Omit to analyze recent history only. |
| `context` | `submitted` (default with `contentIds`): only those Contents. `history`: the agent may also read the user's earlier Contents. |
| `scope` | `{ since: "72h" }` look-back window for `history`; the backend picks a default when omitted. |
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

A `no_change` outcome is a normal completion: the agent decided nothing was
worth showing. `analyses.wait()` throws `AnalysisFailedError` only when the
Analysis itself failed.

Scheduled analyses created by Inklet appear in
`inklet.analyses.list({ trigger: "scheduled" })`.

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

`waitUntilReady()` throws `NoChangeError` if the Analysis completed without a
Presentation. A stored Scene can be rendered at another size without rerunning
AI:

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
