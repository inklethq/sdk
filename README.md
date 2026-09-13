# `@inklethq/sdk`

Official server-side JavaScript and TypeScript SDK for Inklet.

The v0.1 release supports PAT authentication, Display and Presentation reads,
Content lifecycle operations, and high-level Auto, Manual, and Hardcode Push
workflows.

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

## Generate a Presentation without a Display

Use `presentations.generate()` when the result will be shown in software, a
Widget, a website, or a device adapter owned by the caller. This path does not
register a Display, publish a queue entry, or send MQTT.

```ts
const generation = await inklet.presentations.generate({
  idempotencyKey: "weekly-card-2026-08-29",
  intent: "Create a calm, glanceable summary",
  assets: [
    inklet.assets.text("Revenue increased 12% this week."),
  ],
  output: {
    viewport: { width: 360, height: 170 },
    formats: ["scene", "png"],
  },
});

const presentation = await inklet.presentations.waitUntilReady(generation);

console.log(presentation.scene?.data);
console.log(presentation.renditions[0]?.url);
```

The Scene uses the versioned
`application/vnd.inklet.scene+json;version=1` media type. A stored Scene can be
rendered at another size without rerunning AI:

```ts
const rendition = await inklet.presentations.render(presentation.id, {
  viewport: { width: 720, height: 340 },
});
```

`output.preset` can replace `output.viewport`; supported presets include
`default`, `macos-widget-small`, `macos-widget-medium`, and
`macos-widget-large`.

## Push

Asset helpers validate supported content types and the 10 MiB per-binary-asset
limit. Binary assets are uploaded directly to temporary storage URLs; the PAT
is sent only to Inklet API endpoints.

### Auto

Auto Push lets Inklet choose compatible Displays.

```ts
const result = await inklet.push.auto({
  idempotencyKey: "daily-brief-2026-08-12",
  title: "Daily brief",
  intent: "Make the key update easy to scan",
  assets: [
    inklet.assets.text("Revenue is up 12% week over week."),
    inklet.assets.link("https://example.com/report"),
  ],
});
```

### Manual

Manual Push targets one Display while allowing Inklet to process and lay out
the supplied assets.

```ts
import { readFile } from "node:fs/promises";

const image = inklet.assets.image({
  data: await readFile("chart.png"),
  filename: "chart.png",
  contentType: "image/png",
});

const result = await inklet.push.manual({
  displayId: "display_123",
  assets: [image, inklet.assets.text("This week's trend")],
});
```

### Hardcode

Hardcode Push targets one Display and accepts exactly one PNG or JPEG. Inklet
keeps the existing server behavior: it automatically scales the submitted
image to the Display output size. The SDK intentionally does not require the
source image dimensions to match the panel.

```ts
import { readFile } from "node:fs/promises";

const result = await inklet.push.hardcode({
  displayId: "display_123",
  image: inklet.assets.image({
    data: await readFile("poster.jpg"),
    filename: "poster.jpg",
    contentType: "image/jpeg",
  }),
});
```

All high-level Push methods return the Content, generated idempotency key, and
known Presentation IDs. When `idempotencyKey` is omitted, the SDK generates
one and returns it in the result. For caller-controlled retries, supply and
reuse your own key.

Push processing is asynchronous. A successful call commonly returns a
`processing` Content with no Presentation IDs yet. Poll
`inklet.contents.retrieve(result.contentId)` until the Content becomes `ready`
or `failed`. A `ready` Content means its Presentation IDs are persisted; an
individual Presentation may briefly remain `preparing` while the render worker
finishes the PNG, RAW2, and RAW4 files.

## Content lifecycle

The lower-level Content resource is available when an application needs to
control individual lifecycle calls:

```ts
const content = await inklet.contents.retrieve("content_123");
const contents = await inklet.contents.list({ mode: "manual", state: "ready" });
const confirmed = await inklet.contents.confirm(content.id);
```

`contents.create()` and `contents.refreshUploadTickets()` are also public, but
most applications should use `inklet.push.*`, which handles upload tickets,
one ticket refresh/retry, and confirmation.

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
