# Inklet SDK v0.1 Backend Contract

> **Status: historical design contract, superseded by the implementation.**
> This is the one-off v0.1 handoff written for the backend team on 2026-08-05.
> It is not an API reference, and large parts of it — the Content `mode`, the
> confirm step, the `processing` block — were never built or have since been
> removed. Read the live references instead:
>
> - SDK surface — [`README.md`](README.md) and [`CHANGELOG.md`](CHANGELOG.md)
>   in this repository;
> - backend API — `docs/api/sdk-v1.md` in the backend repository;
> - targetless output — `docs/api/targetless-presentations.md` there too;
> - the design step between this and today — [`ANALYSIS_CONTRACT.md`](ANALYSIS_CONTRACT.md),
>   itself historical.
>
> The body is kept verbatim for reference. Where it disagrees with the code,
> the code wins.

## 0. What changed since this was written

Only deltas verified against the current code.

- **Content no longer carries processing.** `mode`, `displayId`, `intent`,
  `processing`, and the `processing` state are gone from Content (§6.3, §7.2).
  A Content is just `title` plus Assets, with states `pending | ready | failed`,
  and an **Analysis** carries `mode` (`ai` / `direct`), `context`, `scope`,
  `target`, `intent`, and `title`. `auto` / `manual` / `hardcode` survive only
  as SDK helper names.
- **`POST /contents/{contentId}/confirm` is removed** (§7.2). It is not routed
  at all, so a call lands on the facade's 404 — there is no confirm step, and
  uploads are verified by storage events or lazily when an Analysis first
  references the Content. `POST /contents/{contentId}/upload-tickets` is kept.
- **New endpoints** not in this document: `POST /analyses`, `GET /analyses`,
  `GET /analyses/{id}`, `GET /analyses/{id}/events`,
  `GET /analyses/{id}/events/stream` (SSE), `GET /analyses/{id}/archive`,
  `GET /presentations` (list), `POST /presentations/{id}/renditions`,
  `POST /displays/{displayId}/current`, and `POST /displays/{displayId}/advance`.
  The last two make §13's "no queue mutation, no replay" out-of-scope line
  obsolete for manual switching, though the queue itself is still read-only.
- **`Idempotency-Key` is required on `POST /analyses` as well as
  `POST /contents`** (§5.4), with the same 8–128 printable-ASCII rule. Keys are
  scoped per route, so one key covers one Content plus one Analysis. A missing
  or malformed key is `400 invalid_request`; a reused key with a different body
  is `409 idempotency_conflict`; the window is 24 hours. On
  `POST /presentations/{id}/renditions` the header is optional.
- **`no_compatible_display` is a synchronous `422` on `POST /analyses`** when
  the request names no `target` and the account has no usable Display. §9
  already listed the code; what changed is that it is raised at creation,
  before any quota is reserved, rather than only as an async failure.
- **New `409 presentation_not_deliverable`** on `POST /displays/{id}/current`,
  with `details = { displayId, presentationId, reason }` and
  `reason ∈ targetless | not_delivered | other_display | not_rendered`.
  `advance()` never raises it; an empty queue is a `200` with
  `changed: false`.
- **Plan-gated refusals are not `subscription_required`.** The entitlement
  layer publishes `plan_upgrade_required` (403), `payment_required` (402), and
  `quota_exceeded` (429, with `details.limit`, `used`, and `resetAt`).
- **Presentations gained `title`, `analysisId`, `scene`, `renditions`, and
  `output`;** `contentIds` is now an ordered list of `{ id, role }` refs
  (`input` or `context`) rather than bare UUIDs, and `mode` is `ai` / `direct`
  (§6.4). `image` remains for Display Presentations.
- **`GET /presentations` filters by Display.** `displayId` implies
  `scope=display` when `scope` is omitted (the default is otherwise
  `generated`), and `displayId` with `scope=generated` is
  `400 invalid_request`. The page also returns `historyWindowStart`, the
  plan's history-depth floor as RFC3339 UTC or `null` — Free sees 7 days of
  Display Presentations, Pro sees all of them, and the list clamps instead of
  refusing.
- **An Analysis publishes an event stream**, of which the public half is a
  closed set of sixteen types with an English `summary`, a monotonic but
  **non-contiguous** `seq`, and no `detail` at any depth (`?detail=` is a
  `400`). `agent.activity` reports coalesced agent progress. Render and
  delivery events are written after the Analysis is already terminal, so they
  appear in the paged read but never on the SSE stream.
- **Retired plumbing.** The SDK-specific asynchronous pipeline is gone. SDK
  Analyses run on the same execution path as every other Analysis.

> Handoff document for the backend implementation agent.
>
> Baseline reviewed on 2026-08-05:
> the backend API documentation of the time,
> SDK PRDs, and the current `@inklethq/sdk` implementation draft.

## 1. Objective

Implement a stable, additive backend API for the server-side JavaScript/TypeScript SDK. The API must let an authenticated integration:

1. read its Displays and their capabilities;
2. create one Content from Text, Link, Image, File, or a combination;
3. use `auto`, `manual`, or `hardcode` processing mode;
4. read Content processing state and its generated Presentation IDs;
5. read an immutable Presentation, a Display queue, and the Display's actual current Presentation;
6. preview the actual current Presentation without changing queue, device, or presentation state.

The implementation must reuse the existing upload, Summary Worker, Analyze Worker, Render Worker, device, and S3/CloudFront infrastructure where possible. Existing Portal, iOS, and device endpoints must remain backward compatible.

## 2. Required product semantics

These rules are non-negotiable:

- A Push creates exactly one Content.
- Content describes the submitted input and processing result. It is not a display job.
- The backend, not the SDK caller, creates Presentations.
- A Presentation is immutable: `displayId`, `contentIds`, ordering, and rendered result cannot be edited through the SDK API.
- Auto may choose one or more Displays.
- Manual must use the requested Display or fail. It must never silently select another Display.
- Hardcode must use the requested Display and exactly one PNG/JPEG image. It must not use AI; the existing backend image path automatically scales the source to the Display output geometry.
- Content and Presentation states are separate.
- Reading status or previewing a Display must not promote a queued Presentation, publish a Presentation, send MQTT, wake a device, or change the device sync interval.
- “Current Presentation” means the last Presentation confirmed/effective on the physical Display, not merely the latest Presentation URL issued to the device.
- Returning a Content ID does not mean the Content is ready or visible on a Display.

## 3. Compatibility with the current API

### 3.1 Existing primitives that can be reused internally

| Current API | Reuse |
|---|---|
| `POST /api/raw-items/upload` | Existing raw-item record and presigned S3 upload primitive |
| `POST /api/raw-items/{id}/confirm` | Existing S3 `HeadObject` verification and Summary Worker trigger |
| `GET /api/raw-items*` | Existing content storage and processing data |
| `GET /api/devices*` | Existing ownership and last-known device data |
| `GET /api/devices/{id}/pushes` | Existing push history and cursor pagination implementation |
| `POST /api/devices/{id}/custom-push/*` | Existing image upload and render-task plumbing |
| Summary/Analyze/Render workers | Existing asynchronous processing pipeline |

### 3.2 Current behavior that must not become the SDK contract

| Current behavior | Problem | Required change |
|---|---|---|
| PAT acts as the user and has no Project/scope isolation | SDK PRD previously uses “Project Secret Key” language | v0.1 SDK contract is explicitly user-scoped PAT auth. Project-scoped keys are a separate future feature. |
| `GET /api/devices/{id}/push` can promote `QUEUE` to `PUBLISHED` | A GET mutates state and violates read-only Preview | Do not expose it through the SDK facade. Add a truly read-only current-presentation endpoint. |
| `POST /api/devices/{id}/current-push` sends MQTT and changes current push | Violates the SDK low-power/read-only boundary | Do not expose it through the SDK facade. |
| `custom-push/confirm` scales images to 800×480 | This is the intended Hardcode behavior | Reuse the scaling path and keep dimension handling server-side. |
| Analyze Worker scans the user's notes on a schedule/manual trigger | A Push needs deterministic, content-scoped processing | Add a content-scoped orchestration job carrying `contentId`, mode, and optional `displayId`. |
| `latestPushId` can point to a merely `PUBLISHED` push | Preview may not match the physical screen | Track last confirmed/effective Presentation separately from pending/published delivery. |
| Errors are usually `{ "error": "..." }` | SDK needs stable machine-readable classification | Add the error envelope defined below for `/api/sdk/v1`. |

## 4. API namespace and authentication

### Base URL

```text
https://dev.iminklet.com/api/sdk/v1
```

Keep current `/api/*` endpoints unchanged. The new namespace is a facade over existing models/workers and is the stable SDK contract.

### Authentication for v0.1

```http
Authorization: Bearer il_pat_...
```

- Use the currently documented PAT behavior.
- PAT access is scoped to the owning user and their resources.
- PATs do not receive `X-Renewed-Token`.
- PAT creation/list/revocation remain user-access-token-only operations and are not part of the SDK facade.
- Do not claim Project isolation or scopes in v0.1.
- Invalid, expired, revoked, or unknown PATs all return the same public `401 authentication_failed` response to avoid credential-state disclosure.

Project-scoped/service-account keys should be designed separately because they change the ownership and authorization model for every resource in this document.

## 5. Common conventions

### 5.1 Content type, IDs, and timestamps

- Request and response bodies use `application/json`.
- IDs are UUID strings. UUIDv7 is preferred for new records.
- Timestamps are RFC 3339 UTC strings.
- Optional values are returned explicitly as `null`; stable array fields are returned as `[]`, not omitted.
- Unknown request fields may be ignored for forward compatibility, but unknown enum values must return `400 invalid_request`.

### 5.2 Request ID

Every API response must include:

```http
X-Request-Id: <opaque-id>
```

The same value must be included in an error body.

### 5.3 Error envelope

```json
{
  "error": {
    "code": "display_incompatible",
    "message": "The target Display cannot render the submitted content.",
    "requestId": "req_01...",
    "details": {
      "displayId": "display_01..."
    }
  }
}
```

- `code` is stable and machine-readable.
- `message` is safe for developer logs and must never contain a PAT, presigned-policy secret, or complete signed URL.
- `details` is optional and must contain only non-sensitive, actionable data.

### 5.4 Idempotency

`POST /contents` requires:

```http
Idempotency-Key: <8-128 ASCII characters>
```

Rules:

- Scope the key to authenticated principal + method + route.
- Store the request-body hash and result for at least 24 hours.
- Same key and same body returns the original Content and upload-ticket result; it must not create another Content.
- Same key and different body returns `409 idempotency_conflict`.
- Confirmation and upload-ticket refresh operations must also be safe to retry and must never create duplicate Presentations.

### 5.5 Pagination

All new list endpoints use cursor pagination:

```json
{
  "items": [],
  "nextCursor": null,
  "hasMore": false
}
```

- Default `limit` is 20; maximum is 50.
- Invalid cursor or limit returns `400 invalid_request`.
- Cursor ordering must be deterministic, preferably `(createdAt, id)`.

## 6. Resource models

### 6.1 Display

```json
{
  "id": "019...",
  "hardwareId": "a1b2...",
  "thingName": "inklet-a1b2...",
  "name": "Living room",
  "nickname": "Living room",
  "firmware": "1.2.0",
  "batteryPercent": 85,
  "online": true,
  "lastSeenAt": "2026-08-05T10:00:00Z",
  "stateUpdatedAt": "2026-08-05T10:00:00Z",
  "boundAt": "2026-08-01T10:00:00Z",
  "tags": [],
  "syncIntervalMinutes": 5,
  "nextSyncAt": "2026-08-05T10:05:00Z",
  "currentPresentationId": "019...",
  "currentPresentationUpdatedAt": "2026-08-05T09:55:00Z",
  "pendingPresentationId": null,
  "capabilities": {
    "pixelWidth": 800,
    "pixelHeight": 480,
    "orientation": "landscape",
    "colorMode": "mono",
    "supportedImageContentTypes": ["image/png", "image/jpeg"],
    "supportedOutputFormats": ["png", "raw2", "raw4"]
  }
}
```

Rules:

- `online` is returned by the backend. The SDK must not derive it from local time.
- If MQTT connection state and check-in health are different concepts, keep the SDK `online` semantic based on the product's check-in rule and expose raw MQTT connectivity only outside this facade.
- Offline Displays retain capabilities, current Presentation, queue, and last-known state.
- `currentPresentationId` changes only when the backend considers the Presentation confirmed/effective on the device.
- `pendingPresentationId` may point to a published-but-not-confirmed Presentation.

### 6.2 Asset input

Text:

```json
{ "type": "text", "text": "Hello Inklet" }
```

Link:

```json
{ "type": "link", "url": "https://example.com/article" }
```

Image or file metadata:

```json
{
  "type": "image",
  "filename": "photo.png",
  "contentType": "image/png",
  "sizeBytes": 204800
}
```

```json
{
  "type": "file",
  "filename": "report.pdf",
  "contentType": "application/pdf",
  "sizeBytes": 512000
}
```

Rules:

- Text must contain at least one non-whitespace character.
- Link must be an absolute `http` or `https` URL and must not contain URL credentials.
- Maximum binary asset size is 10 MiB per asset.
- v0.1 accepted binary content types:
  - `image/png`
  - `image/jpeg`
  - `image/gif`
  - `image/webp`
  - `image/svg+xml`
  - `application/pdf`
  - `text/plain`
  - `text/markdown`
  - `application/json`
- Hardcode accepts exactly one `image/png` or `image/jpeg` asset.

### 6.3 Content

```json
{
  "id": "019...",
  "mode": "auto",
  "requestedDisplayId": null,
  "state": "processing",
  "assets": [
    { "index": 0, "type": "text", "text": "Hello Inklet" }
  ],
  "upload": {
    "status": "ready",
    "failedAssetIndexes": []
  },
  "processing": {
    "stage": "routing",
    "warnings": [],
    "error": null
  },
  "presentationIds": [],
  "createdAt": "2026-08-05T10:00:00Z",
  "updatedAt": "2026-08-05T10:00:01Z"
}
```

Content states:

| State | Meaning |
|---|---|
| `pending` | Content exists and is waiting for binary upload/confirmation |
| `processing` | Upload is complete; fetch, parsing, summarization, routing, or Presentation creation is running |
| `ready` | Content processing is complete and `presentationIds` is final for this processing run |
| `failed` | Content cannot complete; `processing.error` is present |

Suggested processing stages:

```text
awaiting_upload
fetching_links
summarizing
routing
creating_presentations
complete
failed
```

Warning shape:

```json
{
  "code": "link_fetch_failed",
  "message": "The original link was preserved but could not be fetched.",
  "assetIndex": 1
}
```

Failure shape:

```json
{
  "code": "no_compatible_display",
  "message": "No compatible Display is available.",
  "stage": "routing",
  "retryable": false,
  "assetIndex": null
}
```

### 6.4 Presentation

```json
{
  "id": "019...",
  "displayId": "019...",
  "contentIds": ["019..."],
  "mode": "manual",
  "state": "queued",
  "image": {
    "url": "https://cdn.iminklet.com/render/.../image.png?...",
    "format": "png",
    "width": 800,
    "height": 480,
    "expiresAt": "2026-08-05T10:15:00Z",
    "updatedAt": "2026-08-05T10:01:00Z"
  },
  "failure": null,
  "createdAt": "2026-08-05T10:00:10Z",
  "updatedAt": "2026-08-05T10:01:00Z"
}
```

Presentation states and current DB mapping:

| SDK state | Existing backend status | Meaning |
|---|---|---|
| `preparing` | `PREPARE` | Presentation exists; rendering is running |
| `queued` | `QUEUE` | Final image exists and is waiting for device retrieval |
| `published` | `PUBLISHED` | Delivery URL was issued to the device; not yet confirmed |
| `confirmed` | `CONFIRMED` | Device confirmed the image is displayed |
| `expired` | `EXPIRED` | Presentation is no longer the effective/current result |
| `failed` | `FAILED` | Composition, render, delivery, or confirmation failed |

Do not rename these states to `downloaded`, `presented`, or `superseded` in the backend contract.

The backend may re-sign an expired image URL, but it must reference the same stored render object and must not re-render a visually different image.

## 7. Endpoints

### 7.1 Displays

#### `GET /api/sdk/v1/displays`

List Displays accessible to the authenticated PAT owner.

Query:

```text
cursor?: string
limit?: integer (1-50, default 20)
```

Response `200`:

```json
{
  "items": [{ "id": "019...", "capabilities": { "pixelWidth": 800, "pixelHeight": 480 } }],
  "nextCursor": null,
  "hasMore": false
}
```

Items use the full Display model. A real empty result is `items: []`; backend errors must never be converted to an empty list.

#### `GET /api/sdk/v1/displays/{displayId}`

Return the full Display model.

- `403 access_denied`: authenticated principal cannot access the Display.
- `404 display_not_found`: Display does not exist.

#### `GET /api/sdk/v1/displays/{displayId}/queue`

Return only Presentations currently waiting for this Display.

Query:

```text
cursor?: string
limit?: integer (1-50, default 20)
from?: RFC3339
to?: RFC3339
```

Response `200`:

```json
{
  "items": [
    {
      "id": "019...",
      "displayId": "019...",
      "contentIds": ["019..."],
      "state": "queued",
      "title": "Daily summary",
      "summary": "...",
      "createdAt": "2026-08-05T10:00:00Z"
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

This endpoint is strictly read-only. It does not expose insert, delete, reorder, replace, publish, or refresh operations.

#### `GET /api/sdk/v1/displays/{displayId}/current-presentation`

Read the actual last confirmed/effective Presentation and its preview.

Query:

```text
format?: png | raw2 | raw4 (default png)
```

Response `200` with no current Presentation:

```json
{ "presentation": null }
```

Response `200` with a current Presentation:

```json
{ "presentation": { "id": "019...", "state": "confirmed", "image": { "format": "png", "url": "https://..." } } }
```

Rules:

- Must not call or emulate current `GET /api/devices/{id}/push` promotion behavior.
- Must not mutate queue, status, latest/pending/current IDs, or send MQTT.
- Offline Display may return the last confirmed Presentation and cached render metadata.
- Signed URL refresh is allowed; re-rendering is not.

### 7.2 Content creation and upload

#### `POST /api/sdk/v1/contents`

Required header: `Idempotency-Key`.

Request:

```json
{
  "mode": "auto",
  "displayId": null,
  "intent": null,
  "title": null,
  "assets": [
    { "type": "text", "text": "Today's note" },
    { "type": "image", "filename": "photo.jpg", "contentType": "image/jpeg", "sizeBytes": 204800 }
  ]
}
```

Mode validation:

| Mode | `displayId` | Assets | Processing |
|---|---|---|---|
| `auto` | Must be `null`/omitted | One or more valid assets | AI may select one or more Displays |
| `manual` | Required | One or more valid assets | AI organizes content only for this Display |
| `hardcode` | Required | Exactly one PNG/JPEG image | No AI; server scales to the Display output geometry |

Response `201`:

```json
{
  "content": { "id": "019...", "state": "pending", "mode": "auto", "presentationIds": [] },
  "uploadTickets": [
    {
      "assetIndex": 1,
      "url": "https://<bucket>.s3.<region>.amazonaws.com",
      "fields": { "key": "...", "Content-Type": "image/jpeg" },
      "expiresAt": "2026-08-05T10:15:00Z"
    }
  ]
}
```

- Text and link assets do not receive upload tickets.
- `assetIndex` always refers to the original `assets` array index.
- The caller uploads multipart fields followed by the `file` field directly to S3.
- The PAT must never be sent to the presigned upload origin.

#### `POST /api/sdk/v1/contents/{contentId}/confirm` — removed

> **Not implemented, and not a route.** There is no confirm step: uploads are
> verified by storage events, or lazily when an Analysis first references the
> Content. A call to this path gets the facade's `404`. Processing starts with
> `POST /analyses`, not here.

Verify all binary assets with S3 and start processing.

Success response `200`:

```json
{
  "id": "019...",
  "state": "processing",
  "upload": { "status": "complete", "failedAssetIndexes": [] }
}
```

Partial response `200`:

```json
{
  "id": "019...",
  "state": "pending",
  "upload": { "status": "partial", "failedAssetIndexes": [1] }
}
```

Rules:

- On full confirmation, automatically enqueue the content-scoped processing workflow. The SDK must not need to call `POST /api/analyze/trigger`.
- On partial confirmation, preserve successfully uploaded assets and allow the failed indexes to be uploaded again.
- Repeating confirm after success returns the existing Content and must not enqueue a duplicate job or create duplicate Presentations.
- Manual must preserve its requested Display constraint through every worker message.
- Hardcode validates that the uploaded binary decodes as PNG/JPEG, then scales it to the requested Display geometry before creating its Presentation.

#### `POST /api/sdk/v1/contents/{contentId}/upload-tickets`

Refresh upload tickets for failed/expired binary assets.

Request:

```json
{ "assetIndexes": [1] }
```

Response `200`:

```json
{ "content": { "id": "019..." }, "uploadTickets": [{ "assetIndex": 1, "url": "https://...", "fields": {}, "expiresAt": "2026-08-05T10:30:00Z" }] }
```

Only the Content owner may refresh tickets. Reject text/link indexes and already-finalized Content with stable errors.

### 7.3 Content queries

#### `GET /api/sdk/v1/contents/{contentId}`

Return the full Content model including warnings, structured failure, and `presentationIds`.

#### `GET /api/sdk/v1/contents`

Query:

```text
state?: pending | processing | ready | failed
mode?: auto | manual | hardcode
cursor?: string
limit?: integer (1-50, default 20)
```

Return the common cursor-page envelope with full or documented summary Content items.

### 7.4 Presentations

#### `GET /api/sdk/v1/presentations/{presentationId}`

Query:

```text
format?: png | raw2 | raw4 (default png)
```

Return the full immutable Presentation model.

Authorization must confirm that the authenticated principal can access the target Display and every returned Content relation. The response must never expose another user's signed URL or content IDs.

There are intentionally no SDK endpoints to create, update, delete, reorder, publish, replay, skip, or expire a Presentation in v0.1.

## 8. Processing workflows

### 8.1 Auto

```text
create Content
→ upload/confirm
→ Summary Worker processes only this Content
→ content-scoped Analyze job receives contentId + mode=auto
→ select one or more compatible Displays
→ create immutable Presentation record(s)
→ record presentationIds on Content
→ mark Content ready
→ Render Worker moves each Presentation preparing → queued
→ device check-in moves queued → published → confirmed
```

- Every generated Presentation must include the submitted `contentId`.
- If no compatible/accessible Display exists, fail Content with `no_compatible_display`.
- The analyzer may include additional related Content, but `Presentation.contentIds` is the authoritative record.

### 8.2 Manual

Same workflow as Auto, except:

- `displayId` is required and ownership is checked synchronously during Content creation.
- The requested Display ID is carried through every job.
- Analyzer/render code must never substitute another Display.
- Incompatible target fails with `display_incompatible`.

### 8.3 Hardcode

```text
create Content with one image + displayId
→ upload/confirm
→ decode and verify PNG/JPEG
→ scale to the requested Display output geometry
→ create one immutable Presentation with contentIds=[contentId]
→ mark Content ready
→ convert as required for device transport
→ preparing → queued
```

Hardcode requirements:

- no Summary Worker;
- no Analyze Worker;
- no template composition;
- automatic server-side scaling to the Display output geometry;
- no content rewrite;
- output conversion/dithering is allowed for device delivery.

## 9. Error codes

| HTTP | Code | Use |
|---:|---|---|
| 400 | `invalid_request` | Invalid JSON, field, enum, cursor, URL, or UUID |
| 400 | `invalid_asset` | Invalid asset combination or metadata |
| 401 | `authentication_failed` | Missing/invalid/expired/revoked PAT; do not distinguish publicly |
| 403 | `access_denied` | Principal cannot access Display, Content, or Presentation |
| 404 | `display_not_found` | Display does not exist |
| 404 | `content_not_found` | Content does not exist |
| 404 | `presentation_not_found` | Presentation does not exist |
| 409 | `idempotency_conflict` | Same idempotency key with a different request |
| 409 | `invalid_state` | Operation cannot run in the resource's current state |
| 413 | `asset_too_large` | Binary asset exceeds 10 MiB |
| 422 | `display_incompatible` | Manual target cannot render/process the submitted content |
| 422 | `no_compatible_display` | Auto cannot find a target |
| 429 | `rate_limited` | Rate limit exceeded; include `Retry-After` |
| 500 | `internal_error` | Unexpected server failure |
| 503 | `processing_unavailable` | Required queue/worker dependency unavailable |

Asynchronous failures use the same stable domain codes inside `Content.processing.error` or `Presentation.failure`.

## 10. Worker and persistence requirements

- Add a durable Content ↔ Presentation relation. A Content can relate to many Presentations and a Presentation can relate to many Contents.
- Persist processing mode and requested Display on Content.
- Persist immutable ordered `contentIds` and target Display on Presentation.
- Persist Presentation failure information and add the missing `FAILED` terminal state if it does not exist.
- Separate `currentPresentationId` (confirmed/effective) from `pendingPresentationId` (published/unconfirmed).
- Queue/worker messages need a deduplication key derived from Content + processing run.
- Workers must be safe under at-least-once delivery.
- Content must not become `ready` until its final `presentationIds` for that processing run are persisted.
- Presentation may still be `preparing` or `queued` when Content becomes `ready`.
- Preserve last-known Display data when offline.
- Never log PATs, complete presigned fields, or signed CDN query strings.

## 11. Required acceptance tests

The backend implementation is complete only when automated tests cover at least:

1. PAT can access its own Displays and cannot access another user's Display.
2. Empty Display list is distinguishable from an API failure.
3. Display capabilities include exact pixel dimensions.
4. Create Content is idempotent for same key/body.
5. Reusing an idempotency key with another body returns `idempotency_conflict`.
6. Text, Link, Image, and File each work alone.
7. A mixed Asset submission preserves original asset indexes.
8. Oversized/unsupported assets return stable errors.
9. Partial upload confirmation returns failed asset indexes and preserves successful uploads.
10. Retrying confirm does not duplicate processing jobs or Presentations.
11. Auto records generated Presentation IDs on Content.
12. Manual never changes the requested Display.
13. Hardcode accepts arbitrary source dimensions, invokes the existing automatic scaling behavior, and never invokes AI.
14. Presentation exposes target Display, ordered Content IDs, state, and render metadata.
15. Content `ready` does not imply Presentation `confirmed`.
16. Queue listing is read-only and cursor pagination has no duplicates.
17. Current-presentation read does not promote queue state or send MQTT.
18. No-current-presentation returns `{ "presentation": null }`.
19. Offline Display retains last confirmed Presentation and preview metadata.
20. Signed preview URL refresh references the same render object.
21. Every error includes a matching header/body request ID.
22. Error/log output never contains the complete PAT or signed upload/CDN secret material.

## 12. Suggested backend implementation order

1. Add shared `/api/sdk/v1` auth, error envelope, request ID, and idempotency middleware.
2. Add Display facade with capabilities and separate confirmed/pending Presentation references.
3. Add Content facade over raw-items and the normalized Asset model.
4. Add upload-ticket/confirm retry and job deduplication.
5. Add content-scoped Auto orchestration.
6. Add constrained Manual orchestration.
7. Reuse and validate the existing server-side Hardcode scaling path.
8. Add immutable Presentation resource and read-only queue/current-preview endpoints.
9. Add integration tests and update the backend API documentation.

## 13. Explicitly out of scope for this implementation

- Project-scoped keys, service accounts, or per-token scopes
- Display pairing, unbinding, Wi-Fi configuration, firmware update, or sync-interval mutation
- Presentation editing, queue mutation, replay, skip, cancel, scheduling, rotation, or priority control
- Arbitrary HTML/CSS rendering
- Webhook endpoint management or event signing
- Waking a sleeping Display from an SDK request
- Changing the existing Portal/iOS/device API behavior
