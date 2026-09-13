import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthenticationFailedError,
  ConfigurationError,
  Inklet,
  MAX_ASSETS_PER_CONTENT,
} from "../dist/esm/index.js";

const PAT = "il_pat_test_abcdefghijklmnopqrstuvwxyz";
const DISPLAY_ID = "01912345-6789-7abc-def0-123456789abc";
const CONTENT_ID = "01922345-6789-7abc-def0-123456789abc";
const PRESENTATION_ID = "01932345-6789-7abc-def0-123456789abc";

describe("SDK v1 resource reads", () => {
  it("reads Displays, queue, current Presentation, and Presentation details", async () => {
    const display = displayFixture();
    const presentation = presentationFixture();
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        const url = new URL(input);
        switch (url.pathname) {
          case "/api/sdk/v1/displays":
            return json({ items: [display], nextCursor: null, hasMore: false });
          case `/api/sdk/v1/displays/${DISPLAY_ID}`:
            return json(display);
          case `/api/sdk/v1/displays/${DISPLAY_ID}/queue`:
            return json({
              items: [
                {
                  id: PRESENTATION_ID,
                  displayId: DISPLAY_ID,
                  contentIds: [CONTENT_ID],
                  mode: "auto",
                  state: "queued",
                  createdAt: "2026-08-12T10:00:00Z",
                  updatedAt: "2026-08-12T10:01:00Z",
                },
              ],
              nextCursor: null,
              hasMore: false,
            });
          case `/api/sdk/v1/displays/${DISPLAY_ID}/current-presentation`:
            assert.equal(url.searchParams.get("format"), "png");
            return json({ presentation });
          case `/api/sdk/v1/presentations/${PRESENTATION_ID}`:
            assert.equal(url.searchParams.get("format"), "raw2");
            return json({
              ...presentation,
              image: { ...presentation.image, format: "raw2" },
            });
          default:
            throw new Error(`Unexpected URL: ${url}`);
        }
      },
    });

    const page = await client.displays.list();
    assert.equal(page.items[0].capabilities.pixelWidth, 800);
    assert.equal((await client.displays.retrieve(DISPLAY_ID)).name, "Studio");
    assert.equal(
      (await client.displays.listQueue(DISPLAY_ID)).items[0].state,
      "queued",
    );
    assert.equal(
      (await client.displays.current(DISPLAY_ID, { format: "png" })).id,
      PRESENTATION_ID,
    );
    assert.equal(
      (
        await client.presentations.retrieve(PRESENTATION_ID, {
          format: "raw2",
        })
      ).image.format,
      "raw2",
    );
  });

  it("returns null when a Display has no confirmed Presentation", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () => json({ presentation: null }),
    });
    assert.equal(await client.displays.current(DISPLAY_ID), null);
  });

  it("rejects an inverted Display queue time range before requesting", async () => {
    let requested = false;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        requested = true;
        return json({});
      },
    });
    await assert.rejects(
      client.displays.listQueue(DISPLAY_ID, {
        from: "2026-08-12T10:00:00Z",
        to: "2026-08-12T09:00:00Z",
      }),
      ConfigurationError,
    );
    assert.equal(requested, false);
  });
});

describe("SDK v1 asset and Content validation", () => {
  it("keeps image and file MIME kinds distinct", () => {
    const client = new Inklet({ pat: PAT, fetch: async () => json({}) });
    assert.throws(
      () => client.assets.file({
        data: new Uint8Array([1]),
        filename: "not-a-file.png",
        contentType: "image/png",
      }),
      ConfigurationError,
    );
  });

  it("rejects empty binary assets", () => {
    const client = new Inklet({ pat: PAT, fetch: async () => json({}) });
    assert.throws(
      () => client.assets.image({
        data: new Uint8Array(),
        filename: "empty.png",
        contentType: "image/png",
      }),
      ConfigurationError,
    );
  });

  it("rejects more than the backend's maximum Assets before requesting", async () => {
    let requested = false;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        requested = true;
        return json({});
      },
    });
    await assert.rejects(
      client.contents.create(
        {
          mode: "auto",
          assets: Array.from(
            { length: MAX_ASSETS_PER_CONTENT + 1 },
            (_, index) => ({ type: "text", text: `Asset ${index}` }),
          ),
        },
        "too-many-assets-test-1",
      ),
      ConfigurationError,
    );
    assert.equal(requested, false);
  });
});

describe("SDK v1 Push workflow", () => {
  it("creates and confirms a text-only Auto Push", async () => {
    const calls = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        calls.push({ url, init });
        if (url.pathname === "/api/sdk/v1/contents") {
          assert.equal(init.method, "POST");
          assert.equal(
            new Headers(init.headers).get("idempotency-key"),
            "auto-push-test-1",
          );
          assert.deepEqual(JSON.parse(init.body), {
            mode: "auto",
            displayId: null,
            intent: null,
            title: null,
            assets: [{ type: "text", text: "Hello Inklet" }],
          });
          return json({
            content: contentFixture({ state: "pending", stage: "awaiting_upload" }),
            uploadTickets: [],
          }, 201);
        }
        if (url.pathname === `/api/sdk/v1/contents/${CONTENT_ID}/confirm`) {
          return json(contentFixture({ state: "processing", stage: "routing" }));
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    const result = await client.push.auto({
      idempotencyKey: "auto-push-test-1",
      assets: [client.assets.text("Hello Inklet")],
    });

    assert.equal(result.contentId, CONTENT_ID);
    assert.equal(result.state, "processing");
    assert.equal(result.idempotencyKey, "auto-push-test-1");
    assert.equal(calls.length, 2);
  });

  it("uploads Manual Push assets without sending the PAT to storage", async () => {
    let storageFields;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.origin === "https://uploads.example") {
          assert.equal(new Headers(init.headers).get("authorization"), null);
          storageFields = [...init.body.entries()];
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/sdk/v1/contents") {
          const body = JSON.parse(init.body);
          assert.equal(body.mode, "manual");
          assert.equal(body.displayId, DISPLAY_ID);
          return json({
            content: contentFixture({
              mode: "manual",
              displayId: DISPLAY_ID,
              binary: true,
            }),
            uploadTickets: [uploadTicket()],
          }, 201);
        }
        if (url.pathname.endsWith("/confirm")) {
          return json(
            contentFixture({
              mode: "manual",
              displayId: DISPLAY_ID,
              state: "processing",
              stage: "routing",
              binary: true,
              uploaded: true,
            }),
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    const result = await client.push.manual({
      displayId: DISPLAY_ID,
      idempotencyKey: "manual-push-test-1",
      assets: [
        client.assets.image({
          data: new Uint8Array([1, 2, 3]),
          filename: "photo.png",
          contentType: "image/png",
        }),
      ],
    });

    assert.equal(result.content.requestedDisplayId, DISPLAY_ID);
    assert.deepEqual(
      storageFields.slice(0, -1),
      [["key", "sdk/test/photo.png"]],
    );
    assert.equal(storageFields.at(-1)[0], "file");
  });

  it("keeps Hardcode scaling server-side and accepts arbitrary input dimensions", async () => {
    let createBody;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.origin === "https://uploads.example") {
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/sdk/v1/contents") {
          createBody = JSON.parse(init.body);
          return json({
            content: contentFixture({
              mode: "hardcode",
              displayId: DISPLAY_ID,
              binary: true,
            }),
            uploadTickets: [uploadTicket()],
          }, 201);
        }
        if (url.pathname.endsWith("/confirm")) {
          return json(
            contentFixture({
              mode: "hardcode",
              displayId: DISPLAY_ID,
              state: "processing",
              stage: "creating_presentations",
              binary: true,
              uploaded: true,
            }),
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    // These are deliberately not valid PNG dimensions. The SDK only checks
    // type/size and leaves the backend's LANCZOS 800×480 scaling in charge.
    await client.push.hardcode({
      displayId: DISPLAY_ID,
      idempotencyKey: "hardcode-test-1",
      image: client.assets.image({
        data: new Uint8Array([137, 80, 78, 71]),
        filename: "any-size.png",
        contentType: "image/png",
      }),
    });

    assert.equal(createBody.mode, "hardcode");
    assert.equal(createBody.assets[0].sizeBytes, 4);
  });

  it("refreshes a failed upload ticket once before confirming", async () => {
    let uploads = 0;
    let refreshes = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        const url = new URL(input);
        if (url.origin === "https://uploads.example") {
          uploads += 1;
          return new Response(null, { status: uploads === 1 ? 500 : 204 });
        }
        if (url.pathname === "/api/sdk/v1/contents") {
          return json({
            content: contentFixture({ binary: true }),
            uploadTickets: [uploadTicket()],
          }, 201);
        }
        if (url.pathname.endsWith("/upload-tickets")) {
          refreshes += 1;
          return json({
            content: contentFixture({ binary: true }),
            uploadTickets: [uploadTicket()],
          });
        }
        if (url.pathname.endsWith("/confirm")) {
          return json(contentFixture({
            state: "processing",
            stage: "routing",
            binary: true,
            uploaded: true,
          }));
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    await client.push.auto({
      idempotencyKey: "upload-retry-test-1",
      assets: [client.assets.image({
        data: new Uint8Array([1]),
        filename: "retry.png",
        contentType: "image/png",
      })],
    });

    assert.equal(uploads, 2);
    assert.equal(refreshes, 1);
  });
});

describe("SDK v1 targetless Presentation workflow", () => {
  it("generates Scene JSON and PNG without a registered Display", async () => {
    let createBody;
    let contentReads = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === "/api/sdk/v1/contents" && init.method === "POST") {
          createBody = JSON.parse(init.body);
          return json({
            content: contentFixture({
              state: "pending",
              stage: "awaiting_upload",
              output: outputFixture(),
            }),
            uploadTickets: [],
          }, 201);
        }
        if (url.pathname === `/api/sdk/v1/contents/${CONTENT_ID}/confirm`) {
          return json(contentFixture({
            state: "processing",
            stage: "summarizing",
            output: outputFixture(),
          }));
        }
        if (url.pathname === `/api/sdk/v1/contents/${CONTENT_ID}`) {
          contentReads += 1;
          return json(contentFixture({
            state: "ready",
            stage: "complete",
            output: outputFixture(),
            presentationIds: [PRESENTATION_ID],
          }));
        }
        if (url.pathname === `/api/sdk/v1/presentations/${PRESENTATION_ID}`) {
          return json(generatedPresentationFixture());
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    const generation = await client.presentations.generate({
      idempotencyKey: "targetless-generate-1",
      assets: [client.assets.text("A calm weekly summary")],
      output: {
        viewport: { width: 360, height: 170 },
        formats: ["scene", "png"],
      },
    });

    assert.equal(createBody.displayId, null);
    assert.deepEqual(createBody.output, {
      viewport: { width: 360, height: 170 },
      formats: ["scene", "png"],
    });

    const presentation = await client.presentations.waitUntilReady(generation, {
      pollIntervalMs: 100,
      timeoutMs: 1_000,
    });
    assert.equal(contentReads, 1);
    assert.equal(presentation.kind, "generated");
    assert.equal(presentation.displayId, null);
    assert.equal(presentation.scene.data.elements[0].properties.text, "A calm weekly summary");
    assert.equal(presentation.renditions[0].width, 360);
  });

  it("renders another PNG from a stored Scene without rerunning AI", async () => {
    let body;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(
          url.pathname,
          `/api/sdk/v1/presentations/${PRESENTATION_ID}/renditions`,
        );
        assert.equal(init.method, "POST");
        body = JSON.parse(init.body);
        return json(generatedPresentationFixture().renditions[0]);
      },
    });

    const rendition = await client.presentations.render(PRESENTATION_ID, {
      viewport: { width: 360, height: 170 },
    });
    assert.deepEqual(body, {
      viewport: { width: 360, height: 170 },
      formats: ["png"],
    });
    assert.equal(rendition.mediaType, "image/png");
  });

  it("rejects ambiguous output profiles before requesting", async () => {
    let requested = false;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        requested = true;
        return json({});
      },
    });
    await assert.rejects(
      client.presentations.generate({
        assets: [client.assets.text("Hello")],
        output: {
          preset: "macos-widget-medium",
          viewport: { width: 360, height: 170 },
        },
      }),
      ConfigurationError,
    );
    assert.equal(requested, false);
  });
});

describe("SDK v1 errors", () => {
  it("preserves the backend error code, request ID, and details", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () => json(
        {
          error: {
            code: "authentication_failed",
            message: "A valid Inklet personal access token is required.",
            requestId: "req_probe",
            details: { reason: "redacted" },
          },
        },
        401,
        { "x-request-id": "req_probe" },
      ),
    });

    await assert.rejects(client.displays.list(), (error) => {
      assert.ok(error instanceof AuthenticationFailedError);
      assert.equal(error.code, "authentication_failed");
      assert.equal(error.requestId, "req_probe");
      assert.deepEqual(error.details, { reason: "redacted" });
      return true;
    });
  });
});

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers });
}

function displayFixture() {
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
  };
}

function presentationFixture() {
  return {
    id: PRESENTATION_ID,
    displayId: DISPLAY_ID,
    contentIds: [CONTENT_ID],
    mode: "auto",
    state: "confirmed",
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

function outputFixture() {
  return {
    formats: ["scene", "png"],
    preset: null,
    viewport: { width: 360, height: 170 },
    colorMode: "color",
  };
}

function generatedPresentationFixture() {
  return {
    id: PRESENTATION_ID,
    displayId: null,
    contentIds: [CONTENT_ID],
    mode: "auto",
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
    renditions: [{
      id: "01942345-6789-7abc-def0-123456789abc",
      mediaType: "image/png",
      format: "png",
      width: 360,
      height: 170,
      url: "https://cdn.example/generated.png?signature=redacted",
      expiresAt: "2026-08-12T10:15:00Z",
      updatedAt: "2026-08-12T10:02:00Z",
    }],
    image: null,
    failure: null,
    createdAt: "2026-08-12T10:00:00Z",
    updatedAt: "2026-08-12T10:02:00Z",
  };
}

function contentFixture({
  mode = "auto",
  displayId = null,
  state = "pending",
  stage = "awaiting_upload",
  binary = false,
  uploaded = false,
  output,
  presentationIds = [],
} = {}) {
  return {
    id: CONTENT_ID,
    mode,
    requestedDisplayId: displayId,
    intent: null,
    title: null,
    ...(output === undefined ? {} : { output }),
    state,
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
    upload: {
      status: binary && !uploaded ? "awaiting_upload" : "complete",
      failedAssetIndexes: [],
    },
    processing: { stage, warnings: [], error: null },
    presentationIds,
    createdAt: "2026-08-12T10:00:00Z",
    updatedAt: "2026-08-12T10:00:01Z",
  };
}

function uploadTicket() {
  return {
    assetIndex: 0,
    url: "https://uploads.example",
    fields: { key: "sdk/test/photo.png" },
    expiresAt: "2026-08-12T10:15:00Z",
  };
}
