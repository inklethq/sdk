import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigurationError,
  ConflictError,
  Inklet,
  InvalidResponseError,
  NetworkError,
  NotFoundError,
  OperationAbortedError,
} from "../dist/esm/index.js";

const PAT = "il_pat_test_abcdefghijklmnopqrstuvwxyz";
const ANALYSIS_ID = "01952345-6789-7abc-def0-123456789abc";
const EVENTS_PATH = `/api/sdk/v1/analyses/${ANALYSIS_ID}/events`;
const STREAM_PATH = `${EVENTS_PATH}/stream`;
const ARCHIVE_PATH = `/api/sdk/v1/analyses/${ANALYSIS_ID}/archive`;

describe("SDK v1 Analysis event stream", () => {
  it("parses SSE split across chunks, with half lines, CRLF, comments, and multi-line data", async () => {
    const requests = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        requests.push({ url: new URL(input), headers: new Headers(init.headers) });
        // One logical stream, deliberately chopped mid-line and mid-JSON.
        return sse([
          "id: 1\r\nevent: analysis.created\r\ndata: ",
          `${JSON.stringify(eventFixture(1, { type: "analysis.created", source: "backend" }))}\r\n\r\n`,
          ": ping\n\nid: 2\nevent: tool.call",
          "ed\ndata: {\"seq\": 2,\n",
          // A single data payload spread over several `data:` lines.
          'data:  "at": "2026-08-12T10:00:02Z", "attempt": 1, "source": "agent",\n',
          'data:  "type": "tool.called", "level": "info", "summary": "调用搜索",\n',
          'data:  "data": {"tool": "search"}, "detail": null}\n\n: ping\n\n',
          "id: 3\nevent: assistant.note\ndata: ",
          `${JSON.stringify(eventFixture(3, { type: "assistant.note" }))}\n`,
          "\nevent: end\ndata: {\"state\": \"completed\"}\n\n",
        ]);
      },
    });

    const events = [];
    for await (const event of client.analyses.watch(ANALYSIS_ID)) {
      events.push(event);
    }

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.pathname, STREAM_PATH);
    assert.equal(requests[0].url.search, "");
    assert.equal(requests[0].headers.get("accept"), "text/event-stream");
    assert.equal(requests[0].headers.get("authorization"), `Bearer ${PAT}`);
    assert.equal(requests[0].headers.get("last-event-id"), null);

    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2, 3],
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["analysis.created", "tool.called", "assistant.note"],
    );
    assert.equal(events[0].source, "backend");
    assert.equal(events[1].summary, "调用搜索");
    assert.deepEqual(events[1].data, { tool: "search" });
    assert.equal(events[1].detail, null);
  });

  it("reconnects from the last seq with Last-Event-ID when the stream drops", async () => {
    const requests = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        requests.push({ url, headers: new Headers(init.headers) });
        if (requests.length === 1) {
          // Closes without an `end` event: a dropped connection.
          return sse([frame(1), frame(2)]);
        }
        return sse([frame(3), "event: end\ndata: {\"state\": \"failed\"}\n\n"]);
      },
    });

    const events = [];
    for await (const event of client.analyses.watch(ANALYSIS_ID, {
      reconnectDelayMs: 10,
    })) {
      events.push(event.seq);
    }

    assert.deepEqual(events, [1, 2, 3]);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url.searchParams.get("after"), "2");
    assert.equal(requests[1].headers.get("last-event-id"), "2");
  });

  it("gives up after five reconnect attempts", async () => {
    let calls = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        calls += 1;
        return sse([]);
      },
    });

    await assert.rejects(
      drain(client.analyses.watch(ANALYSIS_ID, { reconnectDelayMs: 10 })),
      NetworkError,
    );
    assert.equal(calls, 1 + 5);
  });

  it("retries a connection failure and preserves API errors", async () => {
    let calls = 0;
    const flaky = new Inklet({
      pat: PAT,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TypeError("fetch failed");
        }
        return sse([frame(1), "event: end\ndata: {\"state\": \"completed\"}\n\n"]);
      },
    });
    assert.deepEqual(
      await drain(flaky.analyses.watch(ANALYSIS_ID, { reconnectDelayMs: 10 })),
      [1],
    );

    const denied = new Inklet({
      pat: PAT,
      fetch: async () =>
        json({ error: { code: "not_found", message: "No such Analysis." } }, 404),
    });
    await assert.rejects(drain(denied.analyses.watch(ANALYSIS_ID)), NotFoundError);
  });

  it("falls back to polling listEvents when the response is not text/event-stream", async () => {
    const paths = [];
    let pages = 0;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        const url = new URL(input);
        paths.push(`${url.pathname}${url.search}`);
        if (url.pathname === STREAM_PATH) {
          // A proxy that cannot carry SSE answers with its own page.
          return new Response("<html>proxy</html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        pages += 1;
        if (pages === 1) {
          return json({
            items: [eventFixture(1)],
            nextAfter: 1,
            hasMore: false,
            state: "running",
          });
        }
        return json({
          items: [eventFixture(2), eventFixture(3)],
          nextAfter: null,
          hasMore: false,
          state: "completed",
        });
      },
    });

    const events = await drain(
      client.analyses.watch(ANALYSIS_ID, { pollIntervalMs: 100 }),
    );

    assert.deepEqual(events, [1, 2, 3]);
    assert.deepEqual(paths, [
      STREAM_PATH,
      `${EVENTS_PATH}?limit=200`,
      `${EVENTS_PATH}?after=1&limit=200`,
    ]);
  });

  it("aborts before the first request and mid-stream", async () => {
    const before = new AbortController();
    before.abort();
    const idle = new Inklet({ pat: PAT, fetch: async () => sse([]) });
    await assert.rejects(
      drain(idle.analyses.watch(ANALYSIS_ID, { signal: before.signal })),
      OperationAbortedError,
    );

    const controller = new AbortController();
    const client = new Inklet({
      pat: PAT,
      fetch: async (_input, init = {}) =>
        new Response(
          new ReadableStream({
            start(streamController) {
              streamController.enqueue(new TextEncoder().encode(frame(1)));
              // Never completes: only the abort ends this stream.
              init.signal?.addEventListener("abort", () => {
                streamController.error(
                  new DOMException("The operation was aborted.", "AbortError"),
                );
              });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });

    const seen = [];
    await assert.rejects(async () => {
      for await (const event of client.analyses.watch(ANALYSIS_ID, {
        signal: controller.signal,
      })) {
        seen.push(event.seq);
        controller.abort();
      }
    }, OperationAbortedError);
    assert.deepEqual(seen, [1]);
  });

  it("stops reading the stream when the caller breaks out of the loop", async () => {
    let cancelled = false;
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(frame(1)));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });

    for await (const event of client.analyses.watch(ANALYSIS_ID)) {
      assert.equal(event.seq, 1);
      break;
    }

    assert.equal(cancelled, true);
  });
});

describe("SDK v1 Analysis event reads", () => {
  it("sends after, limit, and detail, and parses a page", async () => {
    let url;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        url = new URL(input);
        return json({
          items: [
            eventFixture(4, {
              type: "tool.finished",
              level: "warn",
              detail: {
                input: { query: "weather" },
                output: "{\"ok\":false}",
                isError: true,
                text: "retrying",
              },
            }),
          ],
          nextAfter: 4,
          hasMore: true,
          state: "completed",
        });
      },
    });

    const page = await client.analyses.listEvents(ANALYSIS_ID, {
      after: 3,
      limit: 200,
      detail: "full",
    });

    assert.equal(url.pathname, EVENTS_PATH);
    assert.equal(url.searchParams.get("after"), "3");
    assert.equal(url.searchParams.get("limit"), "200");
    assert.equal(url.searchParams.get("detail"), "full");
    assert.equal(page.nextAfter, 4);
    assert.equal(page.hasMore, true);
    assert.equal(page.state, "completed");
    assert.equal(page.items[0].level, "warn");
    assert.deepEqual(page.items[0].detail, {
      input: { query: "weather" },
      output: "{\"ok\":false}",
      isError: true,
      text: "retrying",
    });
  });

  it("passes through 409 analysis_in_progress for detail=full", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json(
          {
            error: {
              code: "analysis_in_progress",
              message: "Full detail is available once the Analysis finishes.",
            },
          },
          409,
        ),
    });

    await assert.rejects(
      client.analyses.listEvents(ANALYSIS_ID, { detail: "full" }),
      (error) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(error.code, "analysis_in_progress");
        assert.equal(error.status, 409);
        return true;
      },
    );
  });

  it("accepts unknown event types and rejects malformed events", async () => {
    const page = async (item) => {
      const client = new Inklet({
        pat: PAT,
        fetch: async () =>
          json({ items: [item], nextAfter: null, hasMore: false, state: "running" }),
      });
      return client.analyses.listEvents(ANALYSIS_ID);
    };

    const forward = await page(
      eventFixture(1, { type: "kernel.experimental_thing", data: {} }),
    );
    assert.equal(forward.items[0].type, "kernel.experimental_thing");
    assert.deepEqual(forward.items[0].data, {});

    // `data` may be omitted entirely; it reads back as an empty object.
    const sparse = await page(omit(eventFixture(1), "data"));
    assert.deepEqual(sparse.items[0].data, {});

    for (const broken of [
      omit(eventFixture(1), "seq"),
      omit(eventFixture(1), "level"),
      omit(eventFixture(1), "summary"),
      omit(eventFixture(1), "at"),
      { ...eventFixture(1), seq: 1.5 },
      { ...eventFixture(1), source: "user" },
      { ...eventFixture(1), level: "debug" },
      { ...eventFixture(1), type: "" },
      { ...eventFixture(1), data: [1, 2] },
      { ...eventFixture(1), detail: { output: 42 } },
    ]) {
      await assert.rejects(page(broken), InvalidResponseError);
    }
  });

  it("validates after, limit, and detail before requesting", async () => {
    let requested = false;
    const client = new Inklet({
      pat: PAT,
      fetch: async () => {
        requested = true;
        return json({});
      },
    });

    await assert.rejects(
      client.analyses.listEvents(ANALYSIS_ID, { after: -1 }),
      ConfigurationError,
    );
    await assert.rejects(
      client.analyses.listEvents(ANALYSIS_ID, { limit: 201 }),
      ConfigurationError,
    );
    await assert.rejects(
      client.analyses.listEvents(ANALYSIS_ID, { detail: "everything" }),
      ConfigurationError,
    );
    await assert.rejects(client.analyses.listEvents(""), ConfigurationError);
    assert.throws(
      () => client.analyses.watch(ANALYSIS_ID, { pollIntervalMs: 1 }),
      ConfigurationError,
    );
    assert.equal(requested, false);
  });
});

describe("SDK v1 Analysis timeline and archive", () => {
  it("pages through every event", async () => {
    const queries = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        const url = new URL(input);
        queries.push(url.search);
        if (queries.length === 1) {
          return json({
            items: [eventFixture(1), eventFixture(2)],
            nextAfter: 2,
            hasMore: true,
            state: "completed",
          });
        }
        return json({
          items: [eventFixture(3)],
          nextAfter: null,
          hasMore: false,
          state: "completed",
        });
      },
    });

    const seen = await drain(client.analyses.timeline(ANALYSIS_ID, { pageSize: 2 }));

    assert.deepEqual(seen, [1, 2, 3]);
    assert.deepEqual(queries, ["?limit=2&detail=summary", "?after=2&limit=2&detail=summary"]);
  });

  it("checks the Analysis is terminal before walking with detail=full", async () => {
    const paths = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        const url = new URL(input);
        paths.push(url.pathname);
        return json(analysisFixture("running"));
      },
    });

    await assert.rejects(
      drain(client.analyses.timeline(ANALYSIS_ID, { detail: "full" })),
      (error) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(error.code, "analysis_in_progress");
        assert.deepEqual(error.details, { state: "running" });
        return true;
      },
    );
    // Only the state check ran; no event page was requested.
    assert.deepEqual(paths, [`/api/sdk/v1/analyses/${ANALYSIS_ID}`]);
  });

  it("reads full detail once the Analysis is terminal", async () => {
    const queries = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        const url = new URL(input);
        if (url.pathname === `/api/sdk/v1/analyses/${ANALYSIS_ID}`) {
          return json(analysisFixture("failed"));
        }
        queries.push(url.search);
        return json({
          items: [eventFixture(1, { detail: { text: "done" } })],
          nextAfter: null,
          hasMore: false,
          state: "failed",
        });
      },
    });

    const events = [];
    for await (const event of client.analyses.timeline(ANALYSIS_ID, {
      detail: "full",
      after: 0,
    })) {
      events.push(event);
    }

    assert.deepEqual(queries, ["?after=0&limit=100&detail=full"]);
    assert.deepEqual(events[0].detail, { text: "done" });
  });

  it("rejects a page that claims hasMore without advancing", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async () =>
        json({ items: [], nextAfter: null, hasMore: true, state: "completed" }),
    });

    await assert.rejects(
      drain(client.analyses.timeline(ANALYSIS_ID)),
      InvalidResponseError,
    );
  });

  it("returns an archive URL, and NotFoundError when there is none", async () => {
    let path;
    const present = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        path = new URL(input).pathname;
        return json({
          url: "https://archives.example/a.tar.zst?sig=1",
          expiresAt: "2026-08-12T11:00:00Z",
        });
      },
    });

    assert.deepEqual(await present.analyses.archive(ANALYSIS_ID), {
      url: "https://archives.example/a.tar.zst?sig=1",
      expiresAt: "2026-08-12T11:00:00Z",
    });
    assert.equal(path, ARCHIVE_PATH);

    const missing = new Inklet({
      pat: PAT,
      fetch: async () =>
        json(
          {
            error: {
              code: "archive_not_found",
              message: "This Analysis has no archive.",
            },
          },
          404,
        ),
    });
    await assert.rejects(missing.analyses.archive(ANALYSIS_ID), (error) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.code, "archive_not_found");
      return true;
    });
  });
});

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers });
}

function sse(chunks) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

function frame(seq, overrides = {}) {
  const event = eventFixture(seq, overrides);
  return `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function eventFixture(seq, overrides = {}) {
  return {
    seq,
    at: "2026-08-12T10:00:02Z",
    attempt: 1,
    source: "agent",
    type: "tool.called",
    level: "info",
    summary: `第 ${seq} 步`,
    data: { tool: "search" },
    detail: null,
    ...overrides,
  };
}

function analysisFixture(state) {
  return {
    id: ANALYSIS_ID,
    mode: "ai",
    trigger: "api",
    state,
    outcome: state === "completed" ? "presentations" : null,
    noChangeReason: null,
    contentIds: [],
    context: "history",
    scope: null,
    intent: null,
    title: null,
    target: null,
    presentationIds: [],
    failure: null,
    createdAt: "2026-08-12T10:00:02Z",
    updatedAt: "2026-08-12T10:00:20Z",
  };
}

function omit(record, key) {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

async function drain(iterable) {
  const seen = [];
  for await (const event of iterable) {
    seen.push(event.seq);
  }
  return seen;
}
