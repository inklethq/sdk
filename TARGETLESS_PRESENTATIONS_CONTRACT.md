# inklet Targetless Presentation Contract

Status: implementation handoff for the backend service

Target SDK release: v0.1.x

This document is additive to `BACKEND_CONTRACT.md`. Existing Display Push,
queue, MQTT, Hardcode scaling, and confirmed-current behavior must remain
backward compatible.

## 1. Product objective

An authenticated user must be able to generate a visual Presentation without
owning or registering an inklet Display.

The generated Presentation has two public outputs:

1. versioned `inklet Scene v1` JSON;
2. zero or more PNG renditions.

A physical or software Display is a later delivery destination. Generation
must not create a fake Device row, publish a Push, send MQTT, or require a
compatible Display.

## 2. Required domain split

```text
Content -> targetless Presentation -> Scene + Renditions
                                   -> optional future Delivery -> Display
```

- Content remains the immutable submitted input and processing result.
- A targetless Presentation is owned directly by the user through its Content.
- A PNG rendition is derived from the persisted Scene and an output profile.
- The existing `pushes` table remains the Display delivery/queue model.
- The existing Display Presentation response remains supported during the
  migration, but new targetless Presentations must not be stored as fake
  `pushes` with fake `device_id` values.

## 3. Authentication surfaces

The same service and DTOs must be mounted behind two authentication adapters:

| Prefix | Authentication | Consumer |
| --- | --- | --- |
| `/api/sdk/v1` | PAT | `@inklethq/sdk` and server integrations |
| `/api/app/v1` | inklet user access token | macOS/iOS/Portal clients |

Both adapters resolve the same `userId` principal and call the same business
services. Do not duplicate processing logic. Existing PAT error behavior and
user-token refresh behavior remain unchanged.

The targetless endpoints are Pro-gated when `mode=auto`. Targetless Hardcode
remains Free and preserves the current stretch-to-output behavior.

## 4. Extend Content creation

Existing endpoint:

```http
POST /api/sdk/v1/contents
POST /api/app/v1/contents
Idempotency-Key: 8-128 printable ASCII characters
```

Add optional `output`:

```json
{
  "mode": "auto",
  "displayId": null,
  "intent": "Create a calm, glanceable summary",
  "title": "Weekly summary",
  "output": {
    "formats": ["scene", "png"],
    "viewport": {
      "width": 360,
      "height": 170
    },
    "colorMode": "color"
  },
  "assets": [
    {
      "type": "text",
      "text": "Revenue increased 12% this week."
    }
  ]
}
```

Rules:

- Presence of `output` means targetless generation.
- Targetless generation must omit `displayId` or send it as `null`.
- Targetless generation supports `mode=auto` and `mode=hardcode`.
- `mode=manual` remains Display-specific and must reject `output`.
- Absence of `output` preserves all current v0.1 Push behavior.
- A targetless Content produces exactly one Presentation.
- `formats` defaults to `["scene", "png"]`.
- Allowed v0.1 formats are `scene` and `png`.
- `preset` and `viewport` are mutually exclusive.
- When neither is supplied, use the default 800x480 preview profile.
- Viewport width and height are integers in `1...8192`.
- `colorMode` is `color`, `grayscale`, or `monochrome`; default `color`.
- The normalized output profile is persisted on the Content and returned in
  every Content response.

Preset registry required for the macOS integration:

| Preset | Canonical viewport | Color mode |
| --- | --- | --- |
| `default` | 800x480 | color |
| `macos-widget-small` | 170x170 | color |
| `macos-widget-medium` | 360x170 | color |
| `macos-widget-large` | 360x376 | color |

The canonical viewport is a layout coordinate system. The Widget renderer may
scale it to the actual family size supplied by WidgetKit.

### Normalized Content field

```json
{
  "output": {
    "formats": ["scene", "png"],
    "preset": null,
    "viewport": {
      "width": 360,
      "height": 170
    },
    "colorMode": "color"
  }
}
```

For legacy Display-bound Content, `output` is `null`.

Upload tickets, direct-to-storage upload, one-ticket refresh, confirmation,
idempotency, Content states, warnings, and errors retain the current contract.

## 5. Processing behavior

### Auto targetless generation

After Content confirmation:

1. verify uploaded assets;
2. fetch links;
3. summarize/analyze with the existing content-scoped AI worker;
4. create a public `inklet Scene v1` document using the normalized output
   profile;
5. persist the Presentation and its Content link atomically;
6. mark Content `ready` only after its single Presentation ID is durable;
7. enqueue requested PNG renditions;
8. never enter Display routing, create a Push row, or send MQTT.

Scene generation may complete before PNG rendering. In that case the
Presentation is `preparing` until every requested initial rendition is ready.
The Content may already be `ready`, because the Presentation ID is durable.

### Hardcode targetless generation

- Accept exactly one PNG/JPEG.
- Do not run Summary, Analyze, template selection, or any AI call.
- Emit a Scene whose only image fills the viewport with `fit: "stretch"`.
- PNG rendering must preserve the current Hardcode behavior: stretch directly
  to the requested output geometry, with no aspect-ratio preservation,
  letterbox, or crop.

## 6. Scene v1

Media type:

```text
application/vnd.inklet.scene+json;version=1
```

Envelope returned on a Presentation:

```json
{
  "scene": {
    "mediaType": "application/vnd.inklet.scene+json;version=1",
    "version": 1,
    "data": {
      "version": 1,
      "viewport": {
        "width": 360,
        "height": 170
      },
      "background": "#ffffff",
      "elements": []
    }
  }
}
```

Each v1 element has:

```json
{
  "id": "headline",
  "type": "text",
  "frame": {
    "x": 20,
    "y": 20,
    "width": 320,
    "height": 80
  },
  "properties": {
    "text": "Revenue increased 12%",
    "fontSize": 28,
    "fontWeight": 600,
    "color": "#000000",
    "align": "leading"
  }
}
```

Required v1 element types:

- `text`
- `image`
- `shape`

Common rules:

- Frames use integer coordinates in the Scene viewport.
- Width and height must be positive.
- Element IDs are unique inside one Scene.
- `properties` is always a JSON object.
- Unknown optional properties must be preserved by storage and ignored by
  renderers that do not understand them.
- Scene JSON must not contain PATs, user access tokens, presigned upload
  policies, private object keys, or permanent third-party credentials.
- Image properties may contain a short-lived read URL in API responses, but
  the persisted Scene should reference an owned asset/file ID and sign it at
  response time.

## 7. Presentation response

Extend the existing response without removing legacy fields:

```json
{
  "id": "019...",
  "displayId": null,
  "contentIds": ["019..."],
  "mode": "auto",
  "state": "ready",
  "output": {
    "formats": ["scene", "png"],
    "preset": "macos-widget-medium",
    "viewport": {
      "width": 360,
      "height": 170
    },
    "colorMode": "color"
  },
  "scene": {
    "mediaType": "application/vnd.inklet.scene+json;version=1",
    "version": 1,
    "data": {
      "version": 1,
      "viewport": {
        "width": 360,
        "height": 170
      },
      "background": "#ffffff",
      "elements": []
    }
  },
  "renditions": [
    {
      "id": "019...",
      "mediaType": "image/png",
      "format": "png",
      "width": 360,
      "height": 170,
      "url": "https://...",
      "expiresAt": "2026-08-29T20:15:00Z",
      "updatedAt": "2026-08-29T20:00:00Z"
    }
  ],
  "image": null,
  "failure": null,
  "createdAt": "2026-08-29T20:00:00Z",
  "updatedAt": "2026-08-29T20:01:00Z"
}
```

Rules:

- Targetless `displayId` is `null`.
- Existing Display Presentation `displayId` remains a UUID string.
- Existing Display `image` remains supported.
- New targetless responses use `scene` and `renditions`; `image` is `null`.
- Targetless state is `preparing`, `ready`, or `failed`.
- Existing Display states remain unchanged.
- A targetless Presentation is authorized through its owning Content user, not
  through a Device owner.
- The signed URL lifetime should remain 15 minutes and may be regenerated by a
  GET without changing Presentation state.

## 8. Presentation endpoints

### List

```http
GET /api/sdk/v1/presentations?scope=generated&state=ready&limit=20
GET /api/app/v1/presentations?scope=generated&state=ready&limit=20
```

`scope` is `generated`, `display`, or `all`; default `generated`.

Return the existing cursor page envelope.

### Retrieve

```http
GET /api/sdk/v1/presentations/{presentationId}
GET /api/app/v1/presentations/{presentationId}
```

Retrieval is pure read. It may sign rendition URLs and asset URLs inside the
Scene, but must not render, publish, enqueue, or wake a Display.

### Create another PNG rendition

```http
POST /api/sdk/v1/presentations/{presentationId}/renditions
POST /api/app/v1/presentations/{presentationId}/renditions
Idempotency-Key: optional but recommended
```

```json
{
  "formats": ["png"],
  "viewport": {
    "width": 720,
    "height": 340
  },
  "colorMode": "color"
}
```

Return one rendition object. Rendering a new size must reuse the persisted
Scene and must not rerun AI.

Use a unique key over:

```text
presentation_id + format + width + height + color_mode
```

Concurrent identical requests return the same rendition/job instead of
creating duplicate render work.

If rendering is asynchronous, return `202` with the same rendition shape plus
`state: "preparing"`; GET Presentation later returns the completed rendition.
The v0.1 SDK accepts a synchronous ready rendition, so synchronous response is
preferred for the first implementation.

## 9. Persistence changes

Recommended new tables:

### `presentations`

- `id uuid primary key`
- `user_id uuid not null index`
- `mode text not null`
- `state text not null index`
- `output_profile jsonb not null`
- `scene_version integer`
- `scene jsonb`
- `failure jsonb`
- `created_at timestamptz`
- `updated_at timestamptz`

### `presentation_renditions`

- `id uuid primary key`
- `presentation_id uuid not null index`
- `format text not null`
- `media_type text not null`
- `width integer not null`
- `height integer not null`
- `color_mode text not null`
- `file_id uuid`
- `state text not null`
- `failure jsonb`
- `created_at timestamptz`
- `updated_at timestamptz`

### Content link

Reuse `sdk_presentation_contents` only if it can reference both the new
`presentations` table and legacy `pushes` without ambiguous IDs. Prefer a new
`presentation_contents` link for the clean model and keep the legacy link
during migration.

Add nullable `output_profile jsonb` to `sdk_contents`.

Do not relax `devices.thing_name` or introduce BYOD fields in this release;
those belong to Display Protocol v0.2.

## 10. Worker and queue changes

- Add a targetless branch before Display routing.
- Keep one atomic processing-run claim and at-least-once dedup semantics.
- Persist the Scene before enqueueing PNG work.
- Render jobs carry `presentationId`, `renditionId`, and normalized output
  profile rather than relying on global 800x480 constants.
- Legacy Display render jobs continue using the existing fleet profile.
- A render callback completes the rendition; it must not change any Device,
  Push, queue, or MQTT state for a targetless Presentation.
- Redrive must distinguish failed AI/Scene work from failed rendition work.

## 11. macOS app acceptance path

The macOS app uses `/api/app/v1` with its existing access token:

1. `POST /contents` with `output.preset=macos-widget-medium`;
2. upload binary assets to returned tickets without Authorization;
3. `POST /contents/{id}/confirm`;
4. poll `GET /contents/{id}` until `ready` or `failed`;
5. retrieve its one Presentation;
6. download the best matching PNG rendition immediately;
7. store PNG and Scene JSON in the shared Widget App Group;
8. reload the Widget timeline.

The Widget never receives a PAT or access token and never depends on a signed
URL remaining valid. The host app owns network access and writes durable local
cache files for WidgetKit.

## 12. Required tests

- Auto targetless generation succeeds for a user with no Devices.
- Targetless generation creates no Device, Push, queue entry, or MQTT call.
- Targetless Hardcode performs no AI work and stretches to requested viewport.
- Existing Auto Push without `output` still routes to compatible Displays.
- Existing Manual/Hardcode Display Push behavior is unchanged.
- `manual + output` is rejected.
- `output + displayId` is rejected.
- Free Auto targetless generation returns `subscription_required`.
- Free targetless Hardcode succeeds.
- Content confirmation and job redelivery create one targetless Presentation.
- Presentation ownership does not leak across PATs/users.
- Scene contains no credentials or permanent signed URLs.
- Multiple rendition sizes reuse one Scene and do not rerun AI.
- Identical concurrent rendition requests deduplicate.
- GET/list/retrieve never mutates processing or Display state.
- `/api/sdk/v1` PAT and `/api/app/v1` JWT return equivalent DTOs.

## 13. Explicitly deferred to v0.2

- custom Display registration;
- device enrollment token;
- capability reporting;
- Quote/0 provider credentials and adapter;
- generic Display pull protocol;
- Scene delivery/confirmation semantics;
- dynamic device transports;
- BYOD changes to `devices`.

