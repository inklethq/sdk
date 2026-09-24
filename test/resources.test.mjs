import assert from "node:assert/strict";
import { it } from "node:test";
import { describeFor, loadSdk } from "./sdk.mjs";
import {
  ANALYSIS_ID,
  CONTENT_ID,
  DISPLAY_ID,
  OTHER_CONTENT_ID,
  OTHER_PRESENTATION_ID,
  PAT,
  PRESENTATION_ID,
  analysisFixture,
  contentFixture,
  displayFixture,
  generatedPresentationFixture,
  json,
  omit,
  outputFixture,
  presentationFixture,
  queueItemFixture,
  renditionFixture,
  uploadTicket,
} from "./fixtures.mjs";

const describe = describeFor(import.meta.url);
const {
  AnalysisFailedError,
  ApiError,
  AssetUploadError,
  AuthenticationFailedError,
  ConfigurationError,
  ConflictError,
  Inklet,
  InvalidResponseError,
  MAX_ASSETS_PER_CONTENT,
  MultiplePresentationsError,
  NetworkError,
  NoChangeError,
  OperationAbortedError,
  OperationTimeoutError,
  RequestTimeoutError,
} = await loadSdk(import.meta.url);


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
    const current = await client.displays.current(DISPLAY_ID, { format: "png" });
    assert.equal(current.id, PRESENTATION_ID);
    assert.equal(current.title, "周五下午 3 点和王老师开会");
    assert.equal(
      (
        await client.presentations.retrieve(PRESENTATION_ID, {
          format: "raw2",
        })
      ).image.format,
      "raw2",
    );
  });

  it("reads a Presentation stored before titles existed as title: null", async () => {
    const { title: _dropped, ...untitled } = presentationFixture();
    const client = new Inklet({ pat: PAT, fetch: async () => json(untitled) });
    assert.equal((await client.presentations.retrieve(PRESENTATION_ID)).title, null);
  });

  it("returns null when a Display has no confirmed Presentation", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () => json({ presentation: null }),
    });
    assert.equal(await client.displays.current(DISPLAY_ID), null);
  });

  it("lists Presentations for one Display, and omits displayId when unset", async () => {
    const queries = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        const url = new URL(input);
        assert.equal(url.pathname, "/api/sdk/v1/presentations");
        queries.push(url.search);
        return json({
          items: [presentationFixture()],
          nextCursor: null,
          hasMore: false,
        });
      },
    });

    const filtered = await client.presentations.list({ displayId: DISPLAY_ID });
    assert.equal(filtered.items[0].displayId, DISPLAY_ID);
    assert.equal(filtered.items[0].kind, "display");

    await client.presentations.list({ scope: "display", displayId: DISPLAY_ID });
    await client.presentations.list({ scope: "display" });
    await client.presentations.list();

    const [alone, explicit, withoutDisplay, bare] = queries.map(
      (search) => new URLSearchParams(search),
    );
    // displayId alone means scope=display on the backend, so the SDK sends no
    // scope of its own and lets that default stand.
    assert.equal(alone.get("displayId"), DISPLAY_ID);
    assert.equal(alone.has("scope"), false);
    assert.equal(queries[0], `?displayId=${DISPLAY_ID}`);
    // An explicit scope is still passed through untouched.
    assert.equal(explicit.get("displayId"), DISPLAY_ID);
    assert.equal(explicit.get("scope"), "display");
    assert.equal(withoutDisplay.has("displayId"), false);
    assert.equal(bare.has("displayId"), false);
    assert.equal(queries[3], "");
  });

  it("composes displayId with state and the paging cursor", async () => {
    let search;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        search = new URL(input).search;
        return json({ items: [], nextCursor: null, hasMore: false });
      },
    });

    await client.presentations.list({
      displayId: DISPLAY_ID,
      state: "expired",
      cursor: "cursor-page-2",
      limit: 10,
    });

    const query = new URLSearchParams(search);
    assert.equal(query.get("displayId"), DISPLAY_ID);
    assert.equal(query.get("state"), "expired");
    assert.equal(query.get("cursor"), "cursor-page-2");
    assert.equal(query.get("limit"), "10");
    assert.equal(query.has("scope"), false);
  });

  it("reads the plan history window off the Presentation page", async () => {
    const bodies = [
      // A Free-plan read: the page discloses the 7-day floor it clamped to.
      {
        items: [presentationFixture()],
        nextCursor: null,
        hasMore: false,
        historyWindowStart: "2026-08-05T00:00:00Z",
      },
      // Nothing clipped: an unlimited plan, or a scope with no Display half.
      {
        items: [presentationFixture()],
        nextCursor: null,
        hasMore: false,
        historyWindowStart: null,
      },
      // A backend that does not send the field at all reads as no floor, the
      // same way nextCursor and other nullable strings tolerate omission.
      {
        items: [presentationFixture()],
        nextCursor: null,
        hasMore: false,
      },
    ];

    const seen = [];
    for (const body of bodies) {
      const client = new Inklet({ pat: PAT, fetch: async () => json(body) });
      const page = await client.presentations.list({ scope: "display" });
      // The rest of the page shape is untouched.
      assert.equal(page.items.length, 1);
      assert.equal(page.nextCursor, null);
      assert.equal(page.hasMore, false);
      seen.push(page.historyWindowStart);
    }

    assert.deepEqual(seen, ["2026-08-05T00:00:00Z", null, null]);
  });

  it("keeps the page's required fields strict alongside the window", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json({
          items: [presentationFixture()],
          nextCursor: null,
          historyWindowStart: "2026-08-05T00:00:00Z",
        }),
    });
    await assert.rejects(
      client.presentations.list({ scope: "display" }),
      InvalidResponseError,
    );
  });

  it("does not put a history window on the Display queue page", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json({
          items: [queueItemFixture()],
          nextCursor: null,
          hasMore: false,
          // The queue is not clamped, so even a stray field is not surfaced.
          historyWindowStart: "2026-08-05T00:00:00Z",
        }),
    });
    const page = await client.displays.listQueue(DISPLAY_ID);
    assert.equal("historyWindowStart" in page, false);
    assert.equal(page.items.length, 1);
  });

  it("rejects an empty displayId filter before requesting", async () => {
    let requested = false;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        requested = true;
        return json({ items: [], nextCursor: null, hasMore: false });
      },
    });
    await assert.rejects(
      client.presentations.list({ displayId: "  " }),
      ConfigurationError,
    );
    assert.equal(requested, false);
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
      // A contentIds entry whose role is not a string at all.
      {
        ...presentationFixture(),
        contentIds: [{ id: CONTENT_ID, role: 1 }],
      },
      // The retired auto/manual/hardcode mode values, and the empty string.
      // These are past values with another meaning, not future ones, so they
      // stay refused while an unknown mode passes through.
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

describe("SDK v1 Content search", () => {
  it("sends a trimmed q, omits a blank one, and refuses one over 200 characters", async () => {
    const urls = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        urls.push(new URL(input));
        return json({ items: [], nextCursor: null, hasMore: false });
      },
    });

    await client.contents.list({ q: "  牙医 dentist  ", limit: 20 });
    await client.contents.list({ q: "   " });
    await client.contents.list({ state: "ready", q: "12%", cursor: "abc" });
    await assert.rejects(
      client.contents.list({ q: "字".repeat(201) }),
      ConfigurationError,
    );

    assert.equal(urls.length, 3);
    assert.equal(urls[0].searchParams.get("q"), "牙医 dentist");
    assert.equal(urls[0].searchParams.get("limit"), "20");
    assert.equal(urls[1].searchParams.has("q"), false);
    assert.equal(urls[2].searchParams.get("q"), "12%");
    assert.equal(urls[2].searchParams.get("state"), "ready");
    assert.equal(urls[2].searchParams.get("cursor"), "abc");
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

  it("surfaces no_presentable_content through the failure details", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () => json(analysisFixture({
        state: "failed",
        failure: {
          code: "no_presentable_content",
          message: "The agent could not use the Contents that were named.",
          stage: "planning",
          retryable: true,
          assetIndex: null,
        },
      })),
    });
    await assert.rejects(client.analyses.wait(ANALYSIS_ID), (error) => {
      assert.ok(error instanceof AnalysisFailedError);
      assert.equal(error.details.backendCode, "no_presentable_content");
      assert.equal(error.details.retryable, true);
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
    assert.equal(rendition.state, "ready");
    assert.equal(rendition.colorMode, "color");
    assert.equal(
      rendition.url,
      "https://cdn.example/generated.png?signature=redacted",
    );
    assert.equal(rendition.expiresAt, "2026-08-12T10:15:00Z");
    assert.equal(rendition.failure, null);
  });

  it("returns a preparing rendition with no URL instead of throwing", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json(renditionFixture({ state: "preparing" }), 202),
    });

    const rendition = await client.presentations.render(PRESENTATION_ID, {
      viewport: { width: 720, height: 340 },
    });
    assert.equal(rendition.state, "preparing");
    assert.equal(rendition.url, null);
    assert.equal(rendition.expiresAt, null);
    assert.equal(rendition.failure, null);
    assert.equal(rendition.colorMode, "color");
    assert.equal(rendition.width, 360);
  });

  it("reads a failed rendition with its own failure", async () => {
    const failure = {
      code: "render_failed",
      message: "The renderer ran out of memory.",
      stage: "render",
      retryable: true,
      assetIndex: null,
    };
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json(generatedPresentationFixture({
          renditions: [renditionFixture({ state: "failed", failure })],
        })),
    });

    const presentation = await client.presentations.retrieve(PRESENTATION_ID);
    const rendition = presentation.renditions[0];
    assert.equal(rendition.state, "failed");
    assert.equal(rendition.url, null);
    assert.equal(rendition.expiresAt, null);
    assert.deepEqual(rendition.failure, failure);
    // A failed rendition does not fail the Presentation it belongs to.
    assert.equal(presentation.state, "ready");
    assert.equal(presentation.failure, null);
  });

  it("keeps a ready rendition the backend could not sign", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json(generatedPresentationFixture({
          renditions: [{
            ...renditionFixture(),
            url: null,
            expiresAt: null,
          }],
        })),
    });

    const rendition =
      (await client.presentations.retrieve(PRESENTATION_ID)).renditions[0];
    assert.equal(rendition.state, "ready");
    assert.equal(rendition.url, null);
    assert.equal(rendition.expiresAt, null);
  });

  it("passes a rendition state it does not know through, url and all", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json({
          ...renditionFixture({ state: "rendering" }),
          colorMode: "sepia",
        }),
    });
    const rendition = await client.presentations.render(PRESENTATION_ID, {
      viewport: { width: 360, height: 170 },
    });
    // Nothing is inferred from the unknown state: `url` still decides.
    assert.equal(rendition.state, "rendering");
    assert.equal(rendition.colorMode, "sepia");
    assert.equal(rendition.url, null);

    const malformed = new Inklet({
      pat: PAT,
      fetch: async () => json({ ...renditionFixture(), state: 3 }),
    });
    await assert.rejects(
      malformed.presentations.render(PRESENTATION_ID, {
        viewport: { width: 360, height: 170 },
      }),
      InvalidResponseError,
    );
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

describe("SDK v1 values the backend adds later", () => {
  it("passes unknown Content, Asset, and upload states through", async () => {
    const content = contentFixture({ binary: true });
    content.state = "archived";
    content.assets[0].type = "audio";
    content.assets[0].uploadState = "scanning";
    const client = new Inklet({ pat: PAT, fetch: async () => json(content) });

    const read = await client.contents.retrieve(CONTENT_ID);
    assert.equal(read.state, "archived");
    assert.equal(read.assets[0].type, "audio");
    assert.equal(read.assets[0].uploadState, "scanning");
  });

  it("passes unknown Analysis mode, trigger, state, context, and outcome through", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json({
          ...analysisFixture(),
          mode: "batch",
          trigger: "webhook",
          state: "paused",
          context: "workspace",
          outcome: "deferred",
        }),
    });
    const analysis = await client.analyses.retrieve(ANALYSIS_ID);
    assert.deepEqual(
      [analysis.mode, analysis.trigger, analysis.state, analysis.context, analysis.outcome],
      ["batch", "webhook", "paused", "workspace", "deferred"],
    );
  });

  it("passes unknown Presentation, rendition, output, and scene values through", async () => {
    const presentation = generatedPresentationFixture({
      renditions: [
        {
          ...renditionFixture(),
          mediaType: "image/webp",
          format: "webp",
          colorMode: "sepia",
          state: "optimizing",
        },
      ],
    });
    presentation.state = "archived";
    presentation.mode = "remix";
    presentation.contentIds = [{ id: CONTENT_ID, role: "reference" }];
    presentation.output = { ...outputFixture(), formats: ["scene", "svg"], colorMode: "sepia" };
    presentation.scene.data.elements.push({
      id: "qr",
      type: "qrcode",
      frame: { x: 0, y: 0, width: 40, height: 40 },
      properties: { value: "https://example.com" },
    });
    presentation.image = {
      url: "https://cdn.example/image.bin?signature=redacted",
      format: "raw8",
      width: 800,
      height: 480,
      expiresAt: "2026-08-12T10:15:00Z",
      updatedAt: "2026-08-12T10:02:00Z",
    };
    const client = new Inklet({ pat: PAT, fetch: async () => json(presentation) });

    const read = await client.presentations.retrieve(PRESENTATION_ID);
    assert.equal(read.state, "archived");
    assert.equal(read.mode, "remix");
    assert.equal(read.contentIds[0].role, "reference");
    assert.deepEqual(read.output.formats, ["scene", "svg"]);
    assert.equal(read.output.colorMode, "sepia");
    assert.equal(read.scene.data.elements[1].type, "qrcode");
    assert.equal(read.image.format, "raw8");
    assert.deepEqual(
      [read.renditions[0].mediaType, read.renditions[0].format, read.renditions[0].colorMode, read.renditions[0].state],
      ["image/webp", "webp", "sepia", "optimizing"],
    );
  });

  it("passes unknown Display formats and queue values through", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/queue")) {
          return json({
            items: [queueItemFixture({ state: "scheduled", mode: "remix" })],
            nextCursor: null,
            hasMore: false,
          });
        }
        return json(
          displayFixture({
            capabilities: {
              ...displayFixture().capabilities,
              supportedOutputFormats: ["png", "raw8"],
            },
          }),
        );
      },
    });
    const display = await client.displays.retrieve(DISPLAY_ID);
    assert.deepEqual(display.capabilities.supportedOutputFormats, ["png", "raw8"]);
    const item = (await client.displays.listQueue(DISPLAY_ID)).items[0];
    assert.equal(item.state, "scheduled");
    assert.equal(item.mode, "remix");
  });

  it("still refuses a value that is not a string at all", async () => {
    const cases = [
      [() => ({ ...contentFixture(), state: 1 }), (c) => c.contents.retrieve(CONTENT_ID)],
      [() => ({ ...analysisFixture(), state: null }), (c) => c.analyses.retrieve(ANALYSIS_ID)],
      [() => ({ ...analysisFixture(), outcome: 2 }), (c) => c.analyses.retrieve(ANALYSIS_ID)],
      [() => ({ ...presentationFixture(), state: "" }), (c) => c.presentations.retrieve(PRESENTATION_ID)],
      [
        () => displayFixture({
          capabilities: { ...displayFixture().capabilities, supportedOutputFormats: ["png", 4] },
        }),
        (c) => c.displays.retrieve(DISPLAY_ID),
      ],
    ];
    for (const [body, call] of cases) {
      const client = new Inklet({ pat: PAT, fetch: async () => json(body()) });
      await assert.rejects(call(client), InvalidResponseError);
    }
  });
});

describe("SDK v1 Content listing and upload tickets", () => {
  it("lists Contents with state, cursor, and limit", async () => {
    let url;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        url = new URL(input);
        return json({
          items: [contentFixture({ binary: true })],
          nextCursor: "cursor-2",
          hasMore: true,
        });
      },
    });

    const page = await client.contents.list({ state: "pending", cursor: "cursor-1", limit: 5 });
    assert.equal(url.pathname, "/api/sdk/v1/contents");
    assert.equal(url.searchParams.get("state"), "pending");
    assert.equal(url.searchParams.get("cursor"), "cursor-1");
    assert.equal(url.searchParams.get("limit"), "5");
    assert.equal(page.items[0].id, CONTENT_ID);
    assert.equal(page.items[0].state, "pending");
    assert.equal(page.nextCursor, "cursor-2");
    assert.equal(page.hasMore, true);

    await client.contents.list();
    assert.equal(url.search, "");
  });

  it("validates list filters before requesting", async () => {
    let requested = false;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        requested = true;
        return json({});
      },
    });
    // The request side stays closed: sending a state the backend does not
    // know can only fail.
    await assert.rejects(client.contents.list({ state: "archived" }), ConfigurationError);
    await assert.rejects(client.contents.list({ limit: 51 }), ConfigurationError);
    await assert.rejects(client.contents.list({ cursor: "" }), ConfigurationError);
    assert.equal(requested, false);
  });

  it("refreshes upload tickets for the named Assets", async () => {
    let request;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        request = { url: new URL(input), method: init.method, body: JSON.parse(init.body) };
        return json({
          content: contentFixture({ binary: true }),
          uploadTickets: [uploadTicket()],
        });
      },
    });

    const refreshed = await client.contents.refreshUploadTickets(CONTENT_ID, [0]);
    assert.equal(request.url.pathname, `/api/sdk/v1/contents/${CONTENT_ID}/upload-tickets`);
    assert.equal(request.method, "POST");
    assert.deepEqual(request.body, { assetIndexes: [0] });
    assert.equal(refreshed.content.id, CONTENT_ID);
    assert.deepEqual(refreshed.uploadTickets[0].fields, { key: "sdk/test/photo.png" });
  });

  it("validates Asset indexes before refreshing", async () => {
    let requested = false;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        requested = true;
        return json({});
      },
    });
    for (const indexes of [[], [0, 0], [-1], [1.5], "0", undefined]) {
      await assert.rejects(
        client.contents.refreshUploadTickets(CONTENT_ID, indexes),
        ConfigurationError,
        JSON.stringify(indexes),
      );
    }
    assert.equal(requested, false);
  });

  it("gives up after a failed upload fails again, keeping what went wrong", async () => {
    let uploads = 0;
    let refreshes = 0;
    const keys = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.origin === "https://uploads.example") {
          uploads += 1;
          return new Response(null, { status: 403 });
        }
        if (url.pathname.endsWith("/upload-tickets")) {
          refreshes += 1;
          return json({
            content: contentFixture({ binary: true }),
            uploadTickets: [uploadTicket()],
          });
        }
        keys.push(new Headers(init.headers).get("idempotency-key"));
        return json({ content: contentFixture({ binary: true }), uploadTickets: [uploadTicket()] }, 201);
      },
    });

    await assert.rejects(
      client.contents.upload({
        assets: [client.assets.image({
          data: new Uint8Array([1]),
          filename: "photo.png",
          contentType: "image/png",
        })],
      }),
      (error) => {
        assert.ok(error instanceof AssetUploadError);
        assert.equal(error.contentId, CONTENT_ID);
        assert.deepEqual(error.failedAssetIndexes, [0]);
        // The storage refusal is kept rather than discarded.
        assert.ok(error.cause instanceof ApiError);
        assert.equal(error.cause.status, 403);
        assert.equal(error.cause.code, "asset_upload_failed");
        // A generated key, so the upload can be retried without a second Content.
        assert.equal(error.idempotencyKey, keys[0]);
        assert.match(error.idempotencyKey, /^sdk-/);
        assert.equal(error.toJSON().idempotencyKey, keys[0]);
        return true;
      },
    );
    assert.equal(uploads, 2);
    assert.equal(refreshes, 1);
  });
});

describe("SDK v1 assets.link", () => {
  it("normalizes an HTTP or HTTPS URL", () => {
    const client = new Inklet({ pat: PAT, fetch: async () => json({}) });
    assert.deepEqual(client.assets.link("  https://Example.com/a b  "), {
      type: "link",
      url: "https://example.com/a%20b",
    });
    assert.equal(client.assets.link("http://example.com").url, "http://example.com/");
  });

  it("refuses anything else", () => {
    const client = new Inklet({ pat: PAT, fetch: async () => json({}) });
    for (const url of [
      "",
      "   ",
      "example.com",
      "ftp://example.com/file",
      "javascript:alert(1)",
      "https://user:secret@example.com/",
      42,
    ]) {
      assert.throws(() => client.assets.link(url), ConfigurationError, String(url));
    }
  });
});

describe("SDK v1 ids in paths and queries", () => {
  it("sends a query-string id encoded once, not twice", async () => {
    const searches = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        searches.push(new URL(input).search);
        return json({ items: [], nextCursor: null, hasMore: false });
      },
    });

    await client.analyses.list({ contentId: " content/with space " });
    await client.presentations.list({ displayId: "display/with space" });

    assert.equal(new URLSearchParams(searches[0]).get("contentId"), "content/with space");
    assert.equal(searches[0], "?contentId=content%2Fwith+space");
    assert.equal(new URLSearchParams(searches[1]).get("displayId"), "display/with space");
    assert.doesNotMatch(searches.join(""), /%25/);
  });

  it("refuses . and .. as ids, which would change the request path", async () => {
    let requested = false;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        requested = true;
        return json({});
      },
    });
    for (const call of [
      () => client.contents.retrieve(".."),
      () => client.contents.retrieve(" . "),
      () => client.analyses.retrieve(".."),
      () => client.displays.retrieve("."),
      () => client.presentations.retrieve(".."),
      () => client.presentations.render("..", { viewport: { width: 10, height: 10 } }),
      () => client.displays.listQueue(".."),
      () => client.analyses.listEvents(".."),
      () => client.analyses.archive("."),
    ]) {
      await assert.rejects(call(), ConfigurationError);
    }
    assert.equal(requested, false);
  });

  it("still sends an id that merely contains dots, as one segment", async () => {
    let path;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        path = new URL(input).pathname;
        return json(contentFixture());
      },
    });
    await client.contents.retrieve("../content.v2");
    assert.equal(path, "/api/sdk/v1/contents/..%2Fcontent.v2");
  });
});

describe("SDK v1 waitUntilReady with more than one Presentation", () => {
  it("throws MultiplePresentationsError naming them, not InvalidResponseError", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json(analysisFixture({
          state: "completed",
          target: { displayIds: [DISPLAY_ID, "display_2"] },
          presentationIds: [PRESENTATION_ID, OTHER_PRESENTATION_ID],
        })),
    });

    await assert.rejects(client.presentations.waitUntilReady(ANALYSIS_ID), (error) => {
      assert.ok(error instanceof MultiplePresentationsError);
      assert.equal(error.code, "analysis_multiple_presentations");
      assert.equal(error.analysisId, ANALYSIS_ID);
      assert.deepEqual(error.presentationIds, [PRESENTATION_ID, OTHER_PRESENTATION_ID]);
      assert.deepEqual(error.details.presentationIds, [PRESENTATION_ID, OTHER_PRESENTATION_ID]);
      assert.match(error.message, /produced 2 Presentations/);
      return true;
    });
  });
});
