import assert from "node:assert/strict";
import { it } from "node:test";
import { describeFor, loadSdk } from "./sdk.mjs";
import {
  ANALYSIS_ID,
  CONTENT_ID,
  DISPLAY_ID,
  OTHER_PRESENTATION_ID,
  PAT,
  PRESENTATION_ID,
  analysisFixture,
  contentFixture,
  displayFixture,
  generatedPresentationFixture,
  json,
  outputFixture,
  renditionFixture,
  uploadTicket,
} from "./fixtures.mjs";

const describe = describeFor(import.meta.url);
const {
  ApiError,
  AssetUploadError,
  Inklet,
  InkletError,
  NetworkError,
  NotFoundError,
  OperationAbortedError,
  OperationTimeoutError,
  RateLimitError,
  RequestTimeoutError,
} = await loadSdk(import.meta.url);

describe("Waiting helpers cancel the read in flight", () => {
  const helpers = [
    {
      name: "contents.waitUntilReady",
      message: "Waiting for the Content was aborted.",
      pending: () => json(contentFixture({ binary: true })),
      wait: (client, options) => client.contents.waitUntilReady(CONTENT_ID, options),
    },
    {
      name: "analyses.wait",
      message: "Waiting for the Analysis was aborted.",
      pending: () => json(analysisFixture({ state: "running" })),
      wait: (client, options) => client.analyses.wait(ANALYSIS_ID, options),
    },
    {
      name: "presentations.waitUntilReady",
      message: "Waiting for the Analysis was aborted.",
      pending: () => json(analysisFixture({ state: "queued" })),
      wait: (client, options) => client.presentations.waitUntilReady(ANALYSIS_ID, options),
    },
    {
      name: "displays.waitUntilCurrent",
      message: "Waiting for the Display to switch was aborted.",
      pending: () => json(displayFixture({ currentPresentationId: OTHER_PRESENTATION_ID })),
      wait: (client, options) =>
        client.displays.waitUntilCurrent(DISPLAY_ID, PRESENTATION_ID, options),
    },
  ];

  for (const helper of helpers) {
    it(`${helper.name} aborts mid-request, at once`, async () => {
      const signals = [];
      const client = new Inklet({
        pat: PAT,
        fetch: (_input, init = {}) => {
          signals.push(init.signal);
          if (signals.length === 1) {
            return Promise.resolve(helper.pending());
          }
          // The second read hangs: only an abort that reaches it ends it.
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          });
        },
      });

      const controller = new AbortController();
      const waiting = helper.wait(client, {
        pollIntervalMs: 100,
        timeoutMs: 60_000,
        signal: controller.signal,
      });
      while (signals.length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const abortedAt = Date.now();
      controller.abort();

      await assert.rejects(waiting, (error) => {
        assert.ok(error instanceof OperationAbortedError);
        // Reported the way the wait always reported an abort.
        assert.equal(error.message, helper.message);
        return true;
      });
      assert.ok(Date.now() - abortedAt < 500);
      assert.equal(signals[1].aborted, true);
    });
  }

  it("ends the wait at its deadline even while a read hangs", async () => {
    const signals = [];
    const client = new Inklet({
      pat: PAT,
      fetch: (_input, init = {}) =>
        new Promise((_resolve, reject) => {
          signals.push(init.signal);
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
    });

    const startedAt = Date.now();
    await assert.rejects(
      client.analyses.wait(ANALYSIS_ID, { timeoutMs: 150 }),
      (error) => {
        assert.ok(error instanceof OperationTimeoutError);
        assert.equal(error.details.analysisId, ANALYSIS_ID);
        assert.equal(error.details.timeoutMs, 150);
        return true;
      },
    );
    // The wait's own timeout, not the client's 60-second request timeout.
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(signals[0].aborted, true);
  });

  it("keeps the latest read's details when the deadline passes", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json(displayFixture({
          currentPresentationId: OTHER_PRESENTATION_ID,
          pendingPresentationId: PRESENTATION_ID,
        })),
    });
    await assert.rejects(
      client.displays.waitUntilCurrent(DISPLAY_ID, PRESENTATION_ID, {
        pollIntervalMs: 100,
        timeoutMs: 250,
      }),
      (error) => {
        assert.ok(error instanceof OperationTimeoutError);
        assert.equal(error.details.pendingPresentationId, PRESENTATION_ID);
        return true;
      },
    );
  });
});

describe("Waiting helpers ride out transient failures", () => {
  it("retries a dropped connection, a 503, and a 429 before the next read", async () => {
    const replies = [
      () => {
        throw new TypeError("fetch failed");
      },
      () => json({ error: { code: "processing_unavailable", message: "Busy." } }, 503),
      () => json(analysisFixture({ state: "running" })),
      () => json({ error: { code: "rate_limited", message: "Slow down." } }, 429, { "retry-after": "0" }),
      () => json(analysisFixture({ state: "completed" })),
    ];
    let calls = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => replies[calls++](),
    });

    const analysis = await client.analyses.wait(ANALYSIS_ID, {
      pollIntervalMs: 100,
      timeoutMs: 10_000,
    });
    assert.equal(analysis.state, "completed");
    assert.equal(calls, replies.length);
  });

  it("gives up after three failed reads in a row, with the last failure", async () => {
    let calls = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        calls += 1;
        return json({ error: { code: "internal_error", message: `Failure ${calls}.` } }, 502);
      },
    });

    await assert.rejects(
      client.contents.waitUntilReady(CONTENT_ID, { pollIntervalMs: 100, timeoutMs: 10_000 }),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502);
        assert.equal(error.message, "Failure 4.");
        return true;
      },
    );
    assert.equal(calls, 1 + 3);
  });

  it("counts failures in a row: a good read starts the count again", async () => {
    // Three failures, a read, three more, and then the answer: never four in a row.
    const pattern = ["fail", "fail", "fail", "pending", "fail", "fail", "fail", "ready"];
    let calls = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        const step = pattern[calls++];
        if (step === "fail") {
          throw new TypeError("fetch failed");
        }
        return json(contentFixture({ binary: true, state: step }));
      },
    });
    const content = await client.contents.waitUntilReady(CONTENT_ID, {
      pollIntervalMs: 100,
      timeoutMs: 20_000,
    });
    assert.equal(content.state, "ready");
    assert.equal(calls, pattern.length);
  });

  it("does not retry what will not change: a 404, or a spent quota", async () => {
    for (const [status, code, ErrorClass] of [
      [404, "content_not_found", NotFoundError],
      [429, "quota_exceeded", RateLimitError],
    ]) {
      let calls = 0;
      const client = new Inklet({
        pat: PAT,
        fetch: async () => {
          calls += 1;
          return json({ error: { code, message: "No." } }, status);
        },
      });
      await assert.rejects(
        client.contents.waitUntilReady(CONTENT_ID, { pollIntervalMs: 100 }),
        ErrorClass,
      );
      assert.equal(calls, 1, code);
    }
  });

  it("hands back a Retry-After longer than a minute instead of sleeping on it", async () => {
    let calls = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        calls += 1;
        return json({ error: { code: "rate_limited", message: "Later." } }, 429, { "retry-after": "600" });
      },
    });
    await assert.rejects(
      client.analyses.wait(ANALYSIS_ID, { timeoutMs: 30 * 60_000 }),
      (error) => error instanceof RateLimitError && error.retryAfterMs === 600_000,
    );
    assert.equal(calls, 1);
  });

  it("times out during a backoff with the failure it was retrying as the cause", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () => json({ error: { code: "internal_error", message: "Down." } }, 503),
    });
    await assert.rejects(
      client.analyses.wait(ANALYSIS_ID, { pollIntervalMs: 1_000, timeoutMs: 200 }),
      (error) => {
        assert.ok(error instanceof OperationTimeoutError);
        assert.ok(error.cause instanceof ApiError);
        assert.equal(error.cause.status, 503);
        return true;
      },
    );
  });

  it("retries a request timeout like a dropped connection", async () => {
    let calls = 0;
    const client = new Inklet({
      pat: PAT,
      timeoutMs: 20,
      fetch: (_input, init = {}) => {
        calls += 1;
        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          });
        }
        return Promise.resolve(json(contentFixture({ state: "ready" })));
      },
    });
    const content = await client.contents.waitUntilReady(CONTENT_ID, { pollIntervalMs: 100 });
    assert.equal(content.state, "ready");
    assert.equal(calls, 2);
  });
});

describe("Waiting helpers and states this SDK does not know", () => {
  it("keeps waiting on an unknown Content state until the timeout", async () => {
    let reads = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        reads += 1;
        return json(contentFixture({ binary: true, state: "scanning" }));
      },
    });
    await assert.rejects(
      client.contents.waitUntilReady(CONTENT_ID, { pollIntervalMs: 100, timeoutMs: 250 }),
      OperationTimeoutError,
    );
    assert.ok(reads >= 3, `${reads} reads`);
  });

  it("keeps waiting on an unknown Analysis state until it settles", async () => {
    const states = ["queued", "paused", "resuming", "completed"];
    let reads = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => json(analysisFixture({ state: states[reads++] })),
    });
    const analysis = await client.analyses.wait(ANALYSIS_ID, {
      pollIntervalMs: 100,
      timeoutMs: 5_000,
    });
    assert.equal(analysis.state, "completed");
    assert.equal(reads, 4);
  });
});

describe("No automatic retries for calls that create or change something", () => {
  const calls = [
    ["contents.create", (c) => c.contents.create({ assets: [{ type: "text", text: "Hi" }] }, "no-retry-key-1")],
    ["contents.upload", (c) => c.contents.upload({ assets: [c.assets.text("Hi")] })],
    ["analyses.analyze", (c) => c.analyses.analyze({ contentIds: [CONTENT_ID] })],
    ["analyses.direct", (c) => c.direct({ contentId: CONTENT_ID, target: { displayId: DISPLAY_ID } })],
    ["contents.refreshUploadTickets", (c) => c.contents.refreshUploadTickets(CONTENT_ID, [0])],
    ["presentations.render", (c) => c.presentations.render(PRESENTATION_ID, { viewport: { width: 10, height: 10 } })],
    ["displays.setCurrent", (c) => c.displays.setCurrent(DISPLAY_ID, PRESENTATION_ID)],
    ["displays.advance", (c) => c.displays.advance(DISPLAY_ID)],
  ];

  for (const [name, call] of calls) {
    it(`${name} sends one request on a 503 and on a dropped connection`, async () => {
      for (const failure of [
        () => json({ error: { code: "processing_unavailable", message: "Busy." } }, 503, { "retry-after": "0" }),
        () => {
          throw new TypeError("fetch failed");
        },
      ]) {
        let requests = 0;
        const client = new Inklet({
          pat: PAT,
          fetch: async () => {
            requests += 1;
            return failure();
          },
        });
        await assert.rejects(call(client), (error) => error instanceof ApiError || error instanceof NetworkError);
        assert.equal(requests, 1);
      }
    });
  }
});

describe("Recovering a failed call with its idempotency key", () => {
  it("a Push whose Analysis fails after the upload can be repeated without a second Content", async () => {
    const contentKeys = [];
    const analysisKeys = [];
    let failAnalysis = true;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        const key = new Headers(init.headers).get("idempotency-key");
        if (url.pathname === "/api/sdk/v1/contents") {
          contentKeys.push(key);
          return json({ content: contentFixture({ state: "ready" }), uploadTickets: [] }, 201);
        }
        analysisKeys.push(key);
        if (failAnalysis) {
          throw new TypeError("socket hang up");
        }
        return json(analysisFixture({ state: "queued" }), 202);
      },
    });
    const input = { assets: [client.assets.text("Dentist at 9")] };

    let key;
    await assert.rejects(client.push.auto(input), (error) => {
      assert.ok(error instanceof NetworkError);
      // Generated, because the caller passed none, and the one both steps sent.
      key = error.idempotencyKey;
      assert.match(key, /^sdk-/);
      return true;
    });
    assert.deepEqual(contentKeys, [key]);
    assert.deepEqual(analysisKeys, [key]);

    failAnalysis = false;
    const result = await client.push.auto({ ...input, idempotencyKey: key });
    assert.equal(result.idempotencyKey, key);
    // The retry replays both requests under the same key: the backend returns
    // the Content it already has instead of creating another.
    assert.deepEqual(contentKeys, [key, key]);
    assert.deepEqual(analysisKeys, [key, key]);
  });

  it("generate() and analyze() put the key they sent on the error", async () => {
    const sent = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        sent.push(new Headers(init.headers).get("idempotency-key"));
        if (new URL(input).pathname === "/api/sdk/v1/contents") {
          return json({ content: contentFixture({ state: "ready" }), uploadTickets: [] }, 201);
        }
        return json({ error: { code: "analysis_in_progress", message: "Queue full." } }, 409);
      },
    });

    await assert.rejects(
      client.presentations.generate({ assets: [client.assets.text("Weekly summary")] }),
      (error) => error.code === "analysis_in_progress" && error.idempotencyKey === sent[1],
    );
    assert.equal(sent[0], sent[1]);

    await assert.rejects(
      client.analyze({ contentIds: [CONTENT_ID] }),
      (error) => error.idempotencyKey === sent[2] && /^sdk-/.test(error.idempotencyKey),
    );
    await assert.rejects(
      client.analyze({ contentIds: [CONTENT_ID], idempotencyKey: "caller-chosen-key" }),
      (error) => error.idempotencyKey === "caller-chosen-key",
    );
  });

  it("a response the SDK cannot read still carries the key", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () => json({ id: ANALYSIS_ID }, 202),
    });
    await assert.rejects(
      client.analyze({ contentIds: [CONTENT_ID], idempotencyKey: "unreadable-reply" }),
      (error) => error instanceof InkletError && error.idempotencyKey === "unreadable-reply",
    );
  });

  it("errors from calls that send no key have none", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () => json({ error: { code: "internal_error", message: "No." } }, 500),
    });
    await assert.rejects(
      client.displays.advance(DISPLAY_ID),
      (error) => error instanceof ApiError && error.idempotencyKey === undefined,
    );
  });
});

describe("Storage uploads take the call's signal and their own timeout", () => {
  const image = (client) =>
    client.assets.image({
      data: new Uint8Array([1, 2, 3]),
      filename: "photo.png",
      contentType: "image/png",
    });

  it("aborts an upload in flight without refreshing its ticket", async () => {
    const paths = [];
    const controller = new AbortController();
    const client = new Inklet({
      pat: PAT,
      fetch: (input, init = {}) => {
        const url = new URL(input);
        paths.push(url.pathname);
        if (url.origin === "https://uploads.example") {
          setTimeout(() => controller.abort(), 10);
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          });
        }
        return Promise.resolve(
          json({ content: contentFixture({ binary: true }), uploadTickets: [uploadTicket()] }, 201),
        );
      },
    });

    await assert.rejects(
      client.contents.upload({ assets: [image(client)] }, { signal: controller.signal }),
      (error) => error instanceof OperationAbortedError && /^sdk-/.test(error.idempotencyKey),
    );
    assert.deepEqual(paths, ["/api/sdk/v1/contents", "/"]);
  });

  it("times an upload out by uploadTimeoutMs, not by the call's timeoutMs", async () => {
    let uploads = 0;
    const client = new Inklet({
      pat: PAT,
      uploadTimeoutMs: 20,
      fetch: (input, init = {}) => {
        const url = new URL(input);
        if (url.origin === "https://uploads.example") {
          uploads += 1;
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          });
        }
        return Promise.resolve(
          json({ content: contentFixture({ binary: true }), uploadTickets: [uploadTicket()] }, 201),
        );
      },
    });

    await assert.rejects(
      client.contents.upload({ assets: [image(client)] }, { timeoutMs: 60_000 }),
      (error) => {
        assert.ok(error instanceof AssetUploadError);
        assert.ok(error.cause instanceof RequestTimeoutError);
        assert.equal(error.cause.timeoutMs, 20);
        return true;
      },
    );
    // Timed out, refreshed, and timed out again.
    assert.equal(uploads, 2);
  });

  it("lets a slow upload finish when only the API timeout is short", async () => {
    const client = new Inklet({
      pat: PAT,
      timeoutMs: 20,
      fetch: async (input) => {
        const url = new URL(input);
        if (url.origin === "https://uploads.example") {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return new Response(null, { status: 204 });
        }
        return json({ content: contentFixture({ binary: true }), uploadTickets: [uploadTicket()] }, 201);
      },
    });
    const result = await client.contents.upload({ assets: [image(client)] });
    assert.equal(result.content.id, CONTENT_ID);
  });

  it("carries the signal through generate() into the Presentation read", async () => {
    const signals = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        signals.push(init.signal);
        const url = new URL(input);
        if (url.pathname === "/api/sdk/v1/contents") {
          return json({ content: contentFixture({ state: "ready" }), uploadTickets: [] }, 201);
        }
        if (url.pathname === "/api/sdk/v1/analyses") {
          return json(analysisFixture({ state: "queued", target: { output: outputFixture() } }), 202);
        }
        if (url.pathname === `/api/sdk/v1/analyses/${ANALYSIS_ID}`) {
          return json(analysisFixture({ state: "completed", target: { output: outputFixture() } }));
        }
        return json(generatedPresentationFixture({ renditions: [renditionFixture()] }));
      },
    });
    const controller = new AbortController();
    const generation = await client.presentations.generate(
      { assets: [client.assets.text("Hello")] },
      { signal: controller.signal },
    );
    const presentation = await client.presentations.waitUntilReady(generation, {
      signal: controller.signal,
      pollIntervalMs: 100,
    });
    assert.equal(presentation.id, PRESENTATION_ID);
    // Every request was cancellable through the caller's signal.
    controller.abort();
    assert.equal(signals.length, 4);
    assert.ok(signals.every((signal) => signal.aborted));
  });
});
