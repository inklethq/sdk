// Wire fixtures shared by the resource suites: what the backend sends for
// each resource, with the ids the suites assert against.

export const PAT = "il_pat_test_abcdefghijklmnopqrstuvwxyz";
export const DISPLAY_ID = "01912345-6789-7abc-def0-123456789abc";
export const CONTENT_ID = "01922345-6789-7abc-def0-123456789abc";
export const OTHER_CONTENT_ID = "01922345-6789-7abc-def0-123456789abd";
export const PRESENTATION_ID = "01932345-6789-7abc-def0-123456789abc";
export const OTHER_PRESENTATION_ID = "01932345-6789-7abc-def0-123456789abd";
export const ANALYSIS_ID = "01952345-6789-7abc-def0-123456789abc";

export function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers });
}

export function omit(record, key) {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export function displayFixture(overrides = {}) {
  return {
    id: DISPLAY_ID,
    hardwareId: "hardware-1",
    thingName: "inklet-studio",
    name: "Studio",
    nickname: "Studio",
    firmware: "1.2.0",
    batteryPercent: 85,
    online: true,
    lastSeenAt: "2026-08-12T10:00:00Z",
    stateUpdatedAt: "2026-08-12T10:00:00Z",
    boundAt: "2026-08-01T10:00:00Z",
    tags: [],
    syncIntervalMinutes: null,
    nextSyncAt: null,
    currentPresentationId: PRESENTATION_ID,
    currentPresentationUpdatedAt: "2026-08-12T10:02:00Z",
    pendingPresentationId: null,
    capabilities: {
      pixelWidth: 800,
      pixelHeight: 480,
      orientation: "landscape",
      colorMode: "mono",
      supportedImageContentTypes: ["image/png", "image/jpeg"],
      supportedOutputFormats: ["png", "raw2", "raw4"],
    },
    ...overrides,
  };
}

export function queueItemFixture(overrides = {}) {
  return {
    id: PRESENTATION_ID,
    displayId: DISPLAY_ID,
    contentIds: [
      { id: CONTENT_ID, role: "input" },
      { id: OTHER_CONTENT_ID, role: "context" },
    ],
    mode: "ai",
    state: "queued",
    createdAt: "2026-08-12T10:00:00Z",
    updatedAt: "2026-08-12T10:01:00Z",
    ...overrides,
  };
}

export function presentationFixture() {
  return {
    id: PRESENTATION_ID,
    displayId: DISPLAY_ID,
    analysisId: ANALYSIS_ID,
    contentIds: [
      { id: CONTENT_ID, role: "input" },
      { id: OTHER_CONTENT_ID, role: "context" },
    ],
    mode: "ai",
    state: "confirmed",
    title: "周五下午 3 点和王老师开会",
    image: {
      url: "https://cdn.example/image.png?signature=redacted",
      format: "png",
      width: 800,
      height: 480,
      expiresAt: "2026-08-12T10:15:00Z",
      updatedAt: "2026-08-12T10:02:00Z",
    },
    failure: null,
    createdAt: "2026-08-12T10:00:00Z",
    updatedAt: "2026-08-12T10:02:00Z",
  };
}

export function outputFixture() {
  return {
    formats: ["scene", "png"],
    preset: null,
    viewport: { width: 360, height: 170 },
    colorMode: "color",
  };
}

// The backend always sends every rendition key, `null` where a state has no
// value for it, so the fixture does too: the shape of a `preparing` rendition
// is the thing these tests are about.
export function renditionFixture({ state = "ready", failure = null } = {}) {
  const ready = state === "ready";
  return {
    id: "01942345-6789-7abc-def0-123456789abc",
    mediaType: "image/png",
    format: "png",
    width: 360,
    height: 170,
    colorMode: "color",
    state,
    url: ready ? "https://cdn.example/generated.png?signature=redacted" : null,
    expiresAt: ready ? "2026-08-12T10:15:00Z" : null,
    updatedAt: "2026-08-12T10:02:00Z",
    failure,
  };
}

export function generatedPresentationFixture({
  renditions = [renditionFixture()],
} = {}) {
  return {
    id: PRESENTATION_ID,
    displayId: null,
    analysisId: ANALYSIS_ID,
    contentIds: [{ id: CONTENT_ID, role: "input" }],
    mode: "ai",
    state: "ready",
    output: outputFixture(),
    scene: {
      mediaType: "application/vnd.inklet.scene+json;version=1",
      version: 1,
      data: {
        version: 1,
        viewport: { width: 360, height: 170 },
        background: "#ffffff",
        elements: [{
          id: "headline",
          type: "text",
          frame: { x: 20, y: 20, width: 320, height: 80 },
          properties: {
            text: "A calm weekly summary",
            fontSize: 28,
            color: "#000000",
          },
        }],
      },
    },
    renditions,
    image: null,
    failure: null,
    createdAt: "2026-08-12T10:00:00Z",
    updatedAt: "2026-08-12T10:02:00Z",
  };
}

export function contentFixture({
  state,
  binary = false,
  uploaded = false,
  analysisIds = [],
  presentationIds = [],
} = {}) {
  return {
    id: CONTENT_ID,
    title: null,
    state: state ?? (binary && !uploaded ? "pending" : "ready"),
    assets: binary
      ? [{
          assetIndex: 0,
          type: "image",
          text: null,
          url: null,
          filename: "photo.png",
          contentType: "image/png",
          sizeBytes: 3,
          uploadState: uploaded ? "uploaded" : "pending",
        }]
      : [{
          assetIndex: 0,
          type: "text",
          text: "Hello Inklet",
          url: null,
          filename: null,
          contentType: null,
          sizeBytes: null,
          uploadState: "uploaded",
        }],
    failedAssetIndexes: [],
    analysisIds,
    presentationIds,
    failure: null,
    createdAt: "2026-08-12T10:00:00Z",
    updatedAt: "2026-08-12T10:00:01Z",
  };
}

export function analysisFixture({
  mode = "ai",
  trigger = "api",
  state = "completed",
  outcome = state === "completed" ? "presentations" : null,
  noChangeReason = null,
  context = "submitted",
  scope = null,
  target = null,
  presentationIds = outcome === "presentations" ? [PRESENTATION_ID] : [],
  failure = null,
} = {}) {
  return {
    id: ANALYSIS_ID,
    mode,
    trigger,
    state,
    outcome,
    noChangeReason,
    contentIds: context === "history" && scope ? [] : [CONTENT_ID],
    context,
    scope,
    intent: null,
    title: null,
    target,
    presentationIds,
    failure,
    createdAt: "2026-08-12T10:00:02Z",
    updatedAt: "2026-08-12T10:00:20Z",
  };
}

export function uploadTicket() {
  return {
    assetIndex: 0,
    url: "https://uploads.example",
    fields: { key: "sdk/test/photo.png" },
    expiresAt: "2026-08-12T10:15:00Z",
  };
}
