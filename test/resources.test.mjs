import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AnalysisFailedError,
  AuthenticationFailedError,
  ConfigurationError,
  ConflictError,
  Inklet,
  InvalidResponseError,
  MAX_ASSETS_PER_CONTENT,
  NoChangeError,
  OperationAbortedError,
  OperationTimeoutError,
} from "../dist/esm/index.js";

const PAT = "il_pat_test_abcdefghijklmnopqrstuvwxyz";
const DISPLAY_ID = "01912345-6789-7abc-def0-123456789abc";
const CONTENT_ID = "01922345-6789-7abc-def0-123456789abc";
const OTHER_CONTENT_ID = "01922345-6789-7abc-def0-123456789abd";
const PRESENTATION_ID = "01932345-6789-7abc-def0-123456789abc";
const OTHER_PRESENTATION_ID = "01932345-6789-7abc-def0-123456789abd";
const ANALYSIS_ID = "01952345-6789-7abc-def0-123456789abc";

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
                queueItemFixture(),
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
    const queued = (await client.displays.listQueue(DISPLAY_ID)).items[0];
    assert.equal(queued.state, "queued");
    assert.equal(queued.mode, "ai");
    assert.deepEqual(queued.contentIds, [
      { id: CONTENT_ID, role: "input" },
      { id: OTHER_CONTENT_ID, role: "context" },
    ]);
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

  it("rejects v0.1 Presentation and queue shapes", async () => {
    const cases = [
      // contentIds as bare UUIDs instead of { id, role } refs.
      { ...presentationFixture(), contentIds: [CONTENT_ID] },
      // A contentIds entry with an unknown role.
      {
        ...presentationFixture(),
        contentIds: [{ id: CONTENT_ID, role: "primary" }],
      },
      // The retired auto/manual/hardcode mode values, and the empty string.
      { ...presentationFixture(), mode: "auto" },
      { ...presentationFixture(), mode: "manual" },
      { ...presentationFixture(), mode: "hardcode" },
      { ...presentationFixture(), mode: "" },
      // mode is required now; it is no longer defaulted to "".
      omit(presentationFixture(), "mode"),
    ];

    for (const body of cases) {
      const client = new Inklet({ pat: PAT, fetch: async () => json(body) });
      await assert.rejects(
        client.presentations.retrieve(PRESENTATION_ID),
        InvalidResponseError,
      );
    }

    for (const item of [
      queueItemFixture({ contentIds: [CONTENT_ID] }),
      queueItemFixture({ mode: "auto" }),
      queueItemFixture({ mode: "" }),
    ]) {
      const client = new Inklet({
        pat: PAT,
        fetch: async () =>
          json({ items: [item], nextCursor: null, hasMore: false }),
      });
      await assert.rejects(
        client.displays.listQueue(DISPLAY_ID),
        InvalidResponseError,
      );
    }
  });
});

describe("SDK v1 manual Display switching", () => {
  it("sets the current Presentation and reports it as pending", async () => {
    const calls = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        calls.push({
          path: url.pathname,
          method: init.method,
          body: init.body ? JSON.parse(init.body) : null,
        });
        return json({
          display: displayFixture({
            currentPresentationId: OTHER_PRESENTATION_ID,
            pendingPresentationId: PRESENTATION_ID,
          }),
        });
      },
    });

    const display = await client.displays.setCurrent(DISPLAY_ID, PRESENTATION_ID);
    assert.deepEqual(calls, [
      {
        path: `/api/sdk/v1/displays/${DISPLAY_ID}/current`,
        method: "POST",
        body: { presentationId: PRESENTATION_ID },
      },
    ]);
    // The panel confirms later, so only pendingPresentationId moves.
    assert.equal(display.pendingPresentationId, PRESENTATION_ID);
    assert.equal(display.currentPresentationId, OTHER_PRESENTATION_ID);
  });

  it("surfaces 409 presentation_not_deliverable as a readable ConflictError", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json(
          {
            error: {
              code: "presentation_not_deliverable",
              message: "That Presentation cannot be shown on this Display.",
              details: {
                presentationId: PRESENTATION_ID,
                displayId: DISPLAY_ID,
                reason: "not_delivered",
              },
            },
          },
          409,
        ),
    });

    await assert.rejects(
      client.displays.setCurrent(DISPLAY_ID, PRESENTATION_ID),
      (error) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(error.code, "presentation_not_deliverable");
        assert.equal(error.status, 409);
        assert.equal(error.details.reason, "not_delivered");
        return true;
      },
    );
  });

  it("advances to the next queued Presentation and reports an empty queue", async () => {
    const calls = [];
    let changed = true;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        calls.push({ path: url.pathname, method: init.method, body: init.body });
        return json({
          display: displayFixture({
            pendingPresentationId: changed ? PRESENTATION_ID : null,
          }),
          changed,
        });
      },
    });

    const advanced = await client.displays.advance(DISPLAY_ID);
    assert.equal(advanced.changed, true);
    assert.equal(advanced.display.pendingPresentationId, PRESENTATION_ID);

    changed = false;
    const empty = await client.displays.advance(DISPLAY_ID);
    assert.equal(empty.changed, false);
    assert.equal(empty.display.id, DISPLAY_ID);

    assert.deepEqual(calls, [
      { path: `/api/sdk/v1/displays/${DISPLAY_ID}/advance`, method: "POST", body: undefined },
      { path: `/api/sdk/v1/displays/${DISPLAY_ID}/advance`, method: "POST", body: undefined },
    ]);
  });

  it("waits until the panel confirms the switch", async () => {
    let reads = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        assert.equal(new URL(input).pathname, `/api/sdk/v1/displays/${DISPLAY_ID}`);
        reads += 1;
        return json(
          reads < 3
            ? displayFixture({
                currentPresentationId: OTHER_PRESENTATION_ID,
                pendingPresentationId: PRESENTATION_ID,
              })
            : displayFixture({
                currentPresentationId: PRESENTATION_ID,
                pendingPresentationId: null,
              }),
        );
      },
    });

    const display = await client.displays.waitUntilCurrent(
      DISPLAY_ID,
      PRESENTATION_ID,
      { pollIntervalMs: 100, timeoutMs: 2_000 },
    );
    assert.equal(display.currentPresentationId, PRESENTATION_ID);
    assert.equal(reads, 3);
  });

  it("times out without cancelling the switch, and honours an abort signal", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json(
          displayFixture({
            currentPresentationId: OTHER_PRESENTATION_ID,
            pendingPresentationId: PRESENTATION_ID,
          }),
        ),
    });

    await assert.rejects(
      client.displays.waitUntilCurrent(DISPLAY_ID, PRESENTATION_ID, {
        pollIntervalMs: 100,
        timeoutMs: 300,
      }),
      (error) => {
        assert.ok(error instanceof OperationTimeoutError);
        assert.equal(error.details.presentationId, PRESENTATION_ID);
        assert.equal(error.details.pendingPresentationId, PRESENTATION_ID);
        return true;
      },
    );

    const controller = new AbortController();
    const aborted = client.displays.waitUntilCurrent(DISPLAY_ID, PRESENTATION_ID, {
      pollIntervalMs: 100,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(aborted, OperationAbortedError);
  });

  it("validates both ids before requesting", async () => {
    let requested = false;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        requested = true;
        return json({});
      },
    });
    await assert.rejects(client.displays.setCurrent(DISPLAY_ID, "  "), ConfigurationError);
    await assert.rejects(client.displays.advance(""), ConfigurationError);
    await assert.rejects(
      client.displays.waitUntilCurrent(DISPLAY_ID, PRESENTATION_ID, { timeoutMs: 0 }),
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

describe("SDK v1 Content upload", () => {
  it("creates a text-only Content without confirming or analyzing", async () => {
    const calls = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        calls.push(url.pathname);
        assert.equal(url.pathname, "/api/sdk/v1/contents");
        assert.equal(init.method, "POST");
        assert.equal(
          new Headers(init.headers).get("idempotency-key"),
          "upload-only-test-1",
        );
        assert.deepEqual(JSON.parse(init.body), {
          title: "Dentist",
          assets: [{ type: "text", text: "明早 9 点牙医" }],
        });
        return json({ content: contentFixture({ state: "ready" }), uploadTickets: [] }, 201);
      },
    });

    const result = await client.contents.upload({
      idempotencyKey: "upload-only-test-1",
      title: "Dentist",
      assets: [client.assets.text("明早 9 点牙医")],
    });

    assert.equal(result.content.id, CONTENT_ID);
    assert.equal(result.content.state, "ready");
    assert.deepEqual(calls, ["/api/sdk/v1/contents"]);
  });

  it("uploads binary Assets without sending the PAT to storage", async () => {
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
          assert.equal(body.mode, undefined);
          assert.equal(body.assets[0].sizeBytes, 3);
          return json({
            content: contentFixture({ binary: true }),
            uploadTickets: [uploadTicket()],
          }, 201);
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    const result = await client.contents.upload({
      assets: [
        client.assets.image({
          data: new Uint8Array([1, 2, 3]),
          filename: "photo.png",
          contentType: "image/png",
        }),
      ],
    });

    assert.equal(result.content.state, "pending");
    assert.deepEqual(storageFields.slice(0, -1), [["key", "sdk/test/photo.png"]]);
    assert.equal(storageFields.at(-1)[0], "file");
  });

  it("refreshes a failed upload ticket once", async () => {
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
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    await client.contents.upload({
      assets: [client.assets.image({
        data: new Uint8Array([1]),
        filename: "retry.png",
        contentType: "image/png",
      })],
    });

    assert.equal(uploads, 2);
    assert.equal(refreshes, 1);
  });

  it("waits until the backend reports the Content ready", async () => {
    let reads = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        reads += 1;
        return json(contentFixture({ binary: true, uploaded: reads > 1, state: reads > 1 ? "ready" : "pending" }));
      },
    });
    const content = await client.contents.waitUntilReady(CONTENT_ID, {
      pollIntervalMs: 100,
      timeoutMs: 1_000,
    });
    assert.equal(content.state, "ready");
    assert.equal(reads, 2);
  });
});

describe("SDK v1 Analysis", () => {
  it("analyzes uploaded Contents with submitted context by default", async () => {
    let body;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(url.pathname, "/api/sdk/v1/analyses");
        assert.equal(init.method, "POST");
        assert.equal(new Headers(init.headers).get("idempotency-key"), "analyze-test-1");
        body = JSON.parse(init.body);
        return json(analysisFixture({ state: "queued" }), 202);
      },
    });

    const analysis = await client.analyze({
      idempotencyKey: "analyze-test-1",
      contentIds: [CONTENT_ID],
      intent: "做成提醒卡",
    });

    assert.deepEqual(body, {
      mode: "ai",
      contentIds: [CONTENT_ID],
      context: "submitted",
      scope: null,
      intent: "做成提醒卡",
      title: null,
      target: null,
    });
    assert.equal(analysis.state, "queued");
    assert.equal(analysis.target, null);
  });

  it("defaults to history context when no Content is given", async () => {
    let body;
    const client = new Inklet({
      pat: PAT,
      fetch: async (_input, init = {}) => {
        body = JSON.parse(init.body);
        return json(
          analysisFixture({
            context: "history",
            scope: { since: "72h", sinceAt: "2026-08-09T10:00:02Z" },
          }),
          202,
        );
      },
    });
    const analysis = await client.analyze({ scope: { since: "72h" } });
    assert.equal(body.context, "history");
    assert.deepEqual(body.contentIds, []);
    // Only `since` goes out; `sinceAt` is resolved by the backend.
    assert.deepEqual(body.scope, { since: "72h" });
    assert.deepEqual(analysis.scope, {
      since: "72h",
      sinceAt: "2026-08-09T10:00:02Z",
    });
  });

  it("never sends sinceAt, and reads a scope without it as null", async () => {
    let body;
    const client = new Inklet({
      pat: PAT,
      fetch: async (_input, init = {}) => {
        body = JSON.parse(init.body);
        return json(
          analysisFixture({ context: "history", scope: { since: "24h" } }),
          202,
        );
      },
    });
    const analysis = await client.analyze({
      // A caller echoing a parsed Analysis scope back must not leak sinceAt.
      scope: { since: "24h", sinceAt: "2026-08-11T10:00:02Z" },
    });
    assert.deepEqual(body.scope, { since: "24h" });
    assert.deepEqual(analysis.scope, { since: "24h", sinceAt: null });
  });

  it("rejects submitted context without Content, and scope with submitted context", async () => {
    let requested = false;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        requested = true;
        return json({});
      },
    });
    await assert.rejects(client.analyze({ context: "submitted" }), ConfigurationError);
    await assert.rejects(
      client.analyze({ contentIds: [CONTENT_ID], scope: { since: "24h" } }),
      ConfigurationError,
    );
    await assert.rejects(
      client.analyze({ contentIds: [CONTENT_ID], target: { displayId: DISPLAY_ID, output: {} } }),
      ConfigurationError,
    );
    assert.equal(requested, false);
  });

  it("sends a targetless output target and parses the normalized profile back", async () => {
    let body;
    const client = new Inklet({
      pat: PAT,
      fetch: async (_input, init = {}) => {
        body = JSON.parse(init.body);
        return json(analysisFixture({ target: { output: outputFixture() } }), 202);
      },
    });
    const analysis = await client.analyze({
      contentIds: [CONTENT_ID],
      target: { output: { preset: "macos-widget-medium" } },
    });
    assert.deepEqual(body.target, { output: { preset: "macos-widget-medium" } });
    assert.equal(analysis.target.output.viewport.width, 360);
  });

  it("runs a direct Analysis for one image without AI", async () => {
    let body;
    const client = new Inklet({
      pat: PAT,
      fetch: async (_input, init = {}) => {
        body = JSON.parse(init.body);
        return json(analysisFixture({ mode: "direct", target: { displayIds: [DISPLAY_ID] } }), 202);
      },
    });
    const analysis = await client.direct({
      contentId: CONTENT_ID,
      target: { displayIds: [DISPLAY_ID] },
    });
    assert.equal(body.mode, "direct");
    assert.equal(body.context, "submitted");
    assert.deepEqual(body.target, { displayIds: [DISPLAY_ID] });
    assert.equal(analysis.mode, "direct");
  });

  it("waits for completion and surfaces no_change as a normal outcome", async () => {
    let reads = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        const url = new URL(input);
        assert.equal(url.pathname, `/api/sdk/v1/analyses/${ANALYSIS_ID}`);
        reads += 1;
        return json(
          reads === 1
            ? analysisFixture({ state: "running" })
            : analysisFixture({
                state: "completed",
                outcome: "no_change",
                noChangeReason: "Nothing new worth showing in the last 72h.",
              }),
        );
      },
    });
    const done = await client.analyses.wait(ANALYSIS_ID, {
      pollIntervalMs: 100,
      timeoutMs: 1_000,
    });
    assert.equal(done.outcome, "no_change");
    assert.match(done.noChangeReason, /Nothing new/);
    assert.equal(reads, 2);
  });

  it("throws AnalysisFailedError with the backend failure", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () => json(analysisFixture({
        state: "failed",
        failure: {
          code: "no_compatible_display",
          message: "No compatible Display is available.",
          stage: "routing",
          retryable: false,
          assetIndex: null,
        },
      })),
    });
    await assert.rejects(client.analyses.wait(ANALYSIS_ID), (error) => {
      assert.ok(error instanceof AnalysisFailedError);
      assert.equal(error.analysisId, ANALYSIS_ID);
      assert.equal(error.details.backendCode, "no_compatible_display");
      return true;
    });
  });

  it("lists Analyses with filters", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        const url = new URL(input);
        assert.equal(url.pathname, "/api/sdk/v1/analyses");
        assert.equal(url.searchParams.get("trigger"), "scheduled");
        assert.equal(url.searchParams.get("contentId"), CONTENT_ID);
        return json({ items: [analysisFixture({ trigger: "scheduled" })], nextCursor: null, hasMore: false });
      },
    });
    const page = await client.analyses.list({ trigger: "scheduled", contentId: CONTENT_ID });
    assert.equal(page.items[0].trigger, "scheduled");
  });
});

describe("SDK v1 Push helpers", () => {
  it("auto Push uploads then analyzes with the same idempotency key", async () => {
    const calls = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        calls.push({
          path: url.pathname,
          key: new Headers(init.headers).get("idempotency-key"),
          body: init.body ? JSON.parse(init.body) : null,
        });
        if (url.pathname === "/api/sdk/v1/contents") {
          return json({ content: contentFixture({ state: "ready" }), uploadTickets: [] }, 201);
        }
        if (url.pathname === "/api/sdk/v1/analyses") {
          return json(analysisFixture({ state: "queued" }), 202);
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    const result = await client.push.auto({
      idempotencyKey: "auto-push-test-1",
      context: "history",
      assets: [client.assets.text("Hello Inklet")],
    });

    assert.equal(result.contentId, CONTENT_ID);
    assert.equal(result.analysisId, ANALYSIS_ID);
    assert.equal(result.state, "queued");
    assert.deepEqual(calls.map((c) => c.path), ["/api/sdk/v1/contents", "/api/sdk/v1/analyses"]);
    assert.deepEqual(calls.map((c) => c.key), ["auto-push-test-1", "auto-push-test-1"]);
    assert.equal(calls[1].body.context, "history");
    assert.equal(calls[1].body.target, null);
  });

  it("manual Push pins the Display; hardcode Push is a direct Analysis", async () => {
    const analyses = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.origin === "https://uploads.example") {
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/api/sdk/v1/contents") {
          return json({
            content: contentFixture({ binary: true }),
            uploadTickets: [uploadTicket()],
          }, 201);
        }
        if (url.pathname === "/api/sdk/v1/analyses") {
          analyses.push(JSON.parse(init.body));
          return json(analysisFixture({ state: "queued" }), 202);
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    const image = () => client.assets.image({
      data: new Uint8Array([137, 80, 78, 71]),
      filename: "any-size.png",
      contentType: "image/png",
    });
    await client.push.manual({ displayId: DISPLAY_ID, assets: [image()] });
    await client.push.hardcode({ displayId: DISPLAY_ID, image: image() });

    assert.deepEqual(analyses[0].target, { displayId: DISPLAY_ID });
    assert.equal(analyses[0].mode, "ai");
    assert.equal(analyses[1].mode, "direct");
    assert.deepEqual(analyses[1].target, { displayId: DISPLAY_ID });
  });
});

describe("SDK v1 targetless Presentation workflow", () => {
  it("generates Scene JSON and PNG without a registered Display", async () => {
    let analysisBody;
    let analysisReads = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === "/api/sdk/v1/contents" && init.method === "POST") {
          return json({ content: contentFixture({ state: "ready" }), uploadTickets: [] }, 201);
        }
        if (url.pathname === "/api/sdk/v1/analyses" && init.method === "POST") {
          analysisBody = JSON.parse(init.body);
          return json(analysisFixture({ state: "queued", target: { output: outputFixture() } }), 202);
        }
        if (url.pathname === `/api/sdk/v1/analyses/${ANALYSIS_ID}`) {
          analysisReads += 1;
          return json(analysisFixture({
            state: "completed",
            outcome: "presentations",
            target: { output: outputFixture() },
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

    assert.deepEqual(analysisBody.target, {
      output: { viewport: { width: 360, height: 170 }, formats: ["scene", "png"] },
    });

    const presentation = await client.presentations.waitUntilReady(generation, {
      pollIntervalMs: 100,
      timeoutMs: 1_000,
    });
    assert.equal(analysisReads, 1);
    assert.equal(presentation.kind, "generated");
    assert.equal(presentation.displayId, null);
    assert.equal(presentation.analysisId, ANALYSIS_ID);
    assert.equal(presentation.scene.data.elements[0].properties.text, "A calm weekly summary");
    assert.equal(presentation.renditions[0].width, 360);
  });

  it("throws NoChangeError when generation completes without a Presentation", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () => json(analysisFixture({
        state: "completed",
        outcome: "no_change",
        noChangeReason: "Nothing to show.",
      })),
    });
    await assert.rejects(
      client.presentations.waitUntilReady(ANALYSIS_ID),
      (error) => error instanceof NoChangeError && error.reason === "Nothing to show.",
    );
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

function omit(record, key) {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function displayFixture(overrides = {}) {
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

function queueItemFixture(overrides = {}) {
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

function presentationFixture() {
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

function analysisFixture({
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

function uploadTicket() {
  return {
    assetIndex: 0,
    url: "https://uploads.example",
    fields: { key: "sdk/test/photo.png" },
    expiresAt: "2026-08-12T10:15:00Z",
  };
}
