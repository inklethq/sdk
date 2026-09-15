import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigurationError,
  Inklet,
  InvalidResponseError,
  NetworkError,
  NotFoundError,
  OperationAbortedError,
  describeEvent,
  mergeActivities,
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
          ": ping\n\nid: 4\nevent: agent.activi",
          "ty\ndata: {\"seq\": 4,\n",
          // A single data payload spread over several `data:` lines.
          'data:  "at": "2026-08-12T10:00:02Z", "attempt": 1, "source": "agent",\n',
          'data:  "type": "agent.activity", "level": "info", "summary": "Reading notes",\n',
          'data:  "data": {"activityId": "a1", "kind": "reading_notes",\n',
          'data:  "state": "active", "steps": 3, "stats": {"notesRead": 2}}}\n\n: ping\n\n',
          "id: 9\nevent: plan.submitted\ndata: ",
          `${JSON.stringify(eventFixture(9, { type: "plan.submitted", data: { round: 1, outcome: "presentations", actions: 2 } }))}\n`,
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
      [1, 4, 9],
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["analysis.created", "agent.activity", "plan.submitted"],
    );
    assert.equal(events[0].source, "backend");
    assert.equal(events[1].summary, "Reading notes");
    assert.deepEqual(events[1].data, {
      activityId: "a1",
      kind: "reading_notes",
      state: "active",
      steps: 3,
      stats: { notesRead: 2 },
    });
    assert.deepEqual(events[2].data, {
      round: 1,
      outcome: "presentations",
      actions: 2,
    });
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

  it("resumes from the last seq seen even though a public stream skips numbers", async () => {
    // Internal events share the sequence and are never returned, so the public
    // stream jumps. Nothing may assume 1, 2, 3.
    const requests = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        requests.push({ url, headers: new Headers(init.headers) });
        if (requests.length === 1) {
          return sse([frame(3), frame(17)]);
        }
        return sse([frame(42), "event: end\ndata: {\"state\": \"completed\"}\n\n"]);
      },
    });

    const seen = await drain(
      client.analyses.watch(ANALYSIS_ID, { after: 2, reconnectDelayMs: 10 }),
    );

    assert.deepEqual(seen, [3, 17, 42]);
    assert.equal(requests[0].url.searchParams.get("after"), "2");
    assert.equal(requests[0].headers.get("last-event-id"), "2");
    // Resumed from 17, the last seq actually delivered, not from 4.
    assert.equal(requests[1].url.searchParams.get("after"), "17");
    assert.equal(requests[1].headers.get("last-event-id"), "17");
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
            items: [eventFixture(2)],
            nextAfter: 2,
            hasMore: false,
            state: "running",
          });
        }
        return json({
          items: [eventFixture(11), eventFixture(30)],
          nextAfter: null,
          hasMore: false,
          state: "completed",
        });
      },
    });

    const events = await drain(
      client.analyses.watch(ANALYSIS_ID, { pollIntervalMs: 100 }),
    );

    assert.deepEqual(events, [2, 11, 30]);
    assert.deepEqual(paths, [
      STREAM_PATH,
      `${EVENTS_PATH}?limit=200`,
      `${EVENTS_PATH}?after=2&limit=200`,
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
  it("sends after and limit, and parses a page", async () => {
    let url;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        url = new URL(input);
        return json({
          items: [
            eventFixture(12, {
              type: "plan.rejected",
              level: "warn",
              source: "backend",
              summary: "The plan was sent back.",
              data: { problems: 3, reason: "layout_mismatch", attempt: 1 },
            }),
          ],
          nextAfter: 12,
          hasMore: true,
          state: "running",
        });
      },
    });

    const page = await client.analyses.listEvents(ANALYSIS_ID, {
      after: 3,
      limit: 200,
    });

    assert.equal(url.pathname, EVENTS_PATH);
    assert.equal(url.searchParams.get("after"), "3");
    assert.equal(url.searchParams.get("limit"), "200");
    assert.equal(url.searchParams.get("detail"), null);
    assert.equal(page.nextAfter, 12);
    assert.equal(page.hasMore, true);
    assert.equal(page.state, "running");
    assert.equal(page.items[0].level, "warn");
    assert.deepEqual(page.items[0].data, {
      problems: 3,
      reason: "layout_mismatch",
      attempt: 1,
    });
  });

  it("never sends detail, and ignores an event that still carries one", async () => {
    let search;
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        search = new URL(input).search;
        return json({
          items: [
            eventFixture(1, {
              type: "analysis.created",
              data: {},
              detail: { input: { path: "in/contents/01/content.md" }, output: "…" },
            }),
          ],
          nextAfter: null,
          hasMore: false,
          state: "running",
        });
      },
    });

    // `detail` is gone from the options, so it cannot reach the query string
    // even when a caller passes it; and a server that still sends one is read
    // without it rather than refused.
    const page = await client.analyses.listEvents(ANALYSIS_ID, { detail: "full" });

    assert.equal(search, "");
    assert.equal("detail" in page.items[0], false);
    assert.deepEqual(page.items[0].data, {});
  });

  it("parses the data of every known public type", async () => {
    const cases = [
      [
        "context.materialized",
        { contents: 2, history: 5, displays: 1, templates: 9, bytes: 41984, vision: true },
        { contents: 2, history: 5, displays: 1, templates: 9, bytes: 41984, vision: true },
      ],
      [
        "context.materialized",
        { contents: 2, history: 0, displays: 1, templates: 9, warnings: 2 },
        { contents: 2, history: 0, displays: 1, templates: 9, warnings: 2 },
      ],
      [
        "agent.activity",
        {
          activityId: "a3",
          kind: "choosing_layout",
          state: "done",
          steps: 6,
          stats: { layoutsSeen: 4, chosen: "Daily Summary", deniedSteps: 1 },
        },
        {
          activityId: "a3",
          kind: "choosing_layout",
          state: "done",
          steps: 6,
          stats: { layoutsSeen: 4, deniedSteps: 1, chosen: "Daily Summary" },
        },
      ],
      [
        // `stats` may be empty, and `chosen` may be an explicit null.
        "agent.activity",
        { activityId: "a1", kind: "other", state: "active", steps: 1, stats: { chosen: null } },
        { activityId: "a1", kind: "other", state: "active", steps: 1, stats: { chosen: null } },
      ],
      ["plan.submitted", { round: 1, outcome: "no_change" }, { round: 1, outcome: "no_change" }],
      [
        "plan.submitted",
        { round: 2, outcome: "presentations", actions: 3 },
        { round: 2, outcome: "presentations", actions: 3 },
      ],
      [
        "plan.rejected",
        { problems: 2, reason: "content_refs", attempt: 1 },
        { problems: 2, reason: "content_refs", attempt: 1 },
      ],
      [
        "plan.accepted",
        { presentationIds: ["p1", "p2"], actions: 2 },
        { presentationIds: ["p1", "p2"], actions: 2 },
      ],
      [
        "analysis.completed",
        { outcome: "presentations", presentations: 2 },
        { outcome: "presentations", presentations: 2 },
      ],
      ["analysis.failed", { code: "no_presentable_content" }, { code: "no_presentable_content" }],
      ["render.finished", { presentationId: "p1" }, { presentationId: "p1" }],
      ["render.failed", { presentationId: "p1" }, { presentationId: "p1" }],
      [
        "delivery.published",
        { presentationId: "p1", displayId: "d1" },
        { presentationId: "p1", displayId: "d1" },
      ],
      [
        "delivery.confirmed",
        { presentationId: "p1", displayId: "d1" },
        { presentationId: "p1", displayId: "d1" },
      ],
      ["delivery.failed", { presentationId: "p1" }, { presentationId: "p1" }],
    ];

    for (const [type, data, expected] of cases) {
      const page = await readOne(eventFixture(1, { type, data }));
      assert.deepEqual(page.items[0].data, expected, type);
      assert.equal(page.items[0].type, type);
    }
  });

  it("keeps fields a known type gained after this SDK shipped", async () => {
    const page = await readOne(
      eventFixture(1, {
        type: "analysis.completed",
        data: { outcome: "presentations", presentations: 1, turns: 7, inputTokens: 900 },
      }),
    );

    assert.deepEqual(page.items[0].data, {
      outcome: "presentations",
      presentations: 1,
      turns: 7,
      inputTokens: 900,
    });
  });

  it("reads plan.rejected problems as a count even when a list arrives", async () => {
    const page = await readOne(
      eventFixture(1, {
        type: "plan.rejected",
        data: { problems: ["a", "b", "c"], reason: "schema", attempt: 2 },
      }),
    );

    assert.equal(page.items[0].data.problems, 3);
    assert.equal(page.items[0].data.reason, "schema");
  });

  it("accepts unknown event types and rejects malformed known ones", async () => {
    const forward = await readOne(
      eventFixture(1, { type: "something.new", data: { shape: "unforeseen" } }),
    );
    assert.equal(forward.items[0].type, "something.new");
    assert.deepEqual(forward.items[0].data, { shape: "unforeseen" });

    // An internal type is not expected on a public read, but if one arrives it
    // is carried rather than refused.
    const internal = await readOne(
      eventFixture(1, { type: "tool.called", data: { tool: "read" } }),
    );
    assert.deepEqual(internal.items[0].data, { tool: "read" });

    // `data` may be omitted entirely; it reads back as an empty object.
    const sparse = await readOne(
      omit(eventFixture(1, { type: "analysis.created" }), "data"),
    );
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
      // A known type whose own fields are missing or out of range.
      activity({ activityId: undefined }),
      activity({ kind: "daydreaming" }),
      activity({ state: "paused" }),
      activity({ steps: -1 }),
      activity({ stats: { notesRead: "many" } }),
      activity({ stats: { chosen: 7 } }),
      eventFixture(1, { type: "plan.rejected", data: { problems: 1, attempt: 1 } }),
      eventFixture(1, {
        type: "plan.rejected",
        data: { problems: 1, reason: "vibes", attempt: 1 },
      }),
      eventFixture(1, { type: "plan.submitted", data: { outcome: "presentations" } }),
      eventFixture(1, { type: "analysis.completed", data: { outcome: "maybe" } }),
      eventFixture(1, { type: "analysis.failed", data: {} }),
      eventFixture(1, { type: "render.finished", data: {} }),
      eventFixture(1, { type: "plan.accepted", data: { presentationIds: [1] } }),
    ]) {
      await assert.rejects(readOne(broken), InvalidResponseError);
    }
  });

  it("validates after and limit before requesting", async () => {
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
    await assert.rejects(client.analyses.listEvents(""), ConfigurationError);
    assert.throws(
      () => client.analyses.watch(ANALYSIS_ID, { pollIntervalMs: 1 }),
      ConfigurationError,
    );
    assert.equal(requested, false);
  });
});

describe("SDK v1 Analysis timeline and archive", () => {
  it("pages through every event, following gapped sequence numbers", async () => {
    const queries = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        const url = new URL(input);
        queries.push(url.search);
        if (queries.length === 1) {
          return json({
            items: [eventFixture(2), eventFixture(9)],
            nextAfter: 9,
            hasMore: true,
            state: "completed",
          });
        }
        return json({
          items: [eventFixture(31)],
          nextAfter: null,
          hasMore: false,
          state: "completed",
        });
      },
    });

    const seen = await drain(client.analyses.timeline(ANALYSIS_ID, { pageSize: 2 }));

    assert.deepEqual(seen, [2, 9, 31]);
    assert.deepEqual(queries, ["?limit=2", "?after=9&limit=2"]);
  });

  it("never asks the Analysis for its state before walking", async () => {
    const paths = [];
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        paths.push(new URL(input).pathname);
        return json({
          items: [eventFixture(1)],
          nextAfter: null,
          hasMore: false,
          state: "running",
        });
      },
    });

    assert.deepEqual(
      await drain(client.analyses.timeline(ANALYSIS_ID, { after: 0 })),
      [1],
    );
    // A running Analysis is walked straight away: there is no depth to gate.
    assert.deepEqual(paths, [EVENTS_PATH]);
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

describe("mergeActivities", () => {
  it("collapses each activity to its latest state at its first position", () => {
    const events = [
      event(1, "context.materialized"),
      activityEvent(2, "a1", { kind: "reading_notes", state: "active", steps: 1, stats: { notesRead: 1 } }),
      activityEvent(3, "a1", { kind: "reading_notes", state: "active", steps: 5, stats: { notesRead: 3 } }),
      activityEvent(4, "a2", { kind: "choosing_layout", state: "active", steps: 1, stats: { layoutsSeen: 1 } }),
      activityEvent(5, "a1", { kind: "reading_notes", state: "done", steps: 7, stats: { notesRead: 4 } }),
      activityEvent(6, "a2", { kind: "choosing_layout", state: "done", steps: 3, stats: { chosen: "Daily Summary" } }),
      event(7, "plan.submitted"),
    ];

    const merged = mergeActivities(events);

    assert.deepEqual(
      merged.map((e) => e.seq),
      // a1 keeps slot two and a2 slot three, each holding its final update.
      [1, 5, 6, 7],
    );
    assert.equal(merged[1].data.state, "done");
    assert.equal(merged[1].data.stats.notesRead, 4);
    assert.equal(merged[2].data.stats.chosen, "Daily Summary");
  });

  it("passes everything else through and accepts any iterable", () => {
    const events = [event(1, "analysis.created"), event(2, "analysis.completed")];
    assert.deepEqual(mergeActivities(events), events);
    assert.deepEqual(mergeActivities(new Set(events)), events);
    assert.deepEqual(mergeActivities([]), []);

    // The same activity id in a later attempt still upserts: one row per id.
    const repeated = mergeActivities([
      activityEvent(1, "a1", { state: "done" }),
      activityEvent(2, "a1", { state: "failed" }),
    ]);
    assert.equal(repeated.length, 1);
    assert.equal(repeated[0].data.state, "failed");
  });

  it("does not mutate the events it was given", () => {
    const first = activityEvent(1, "a1", { state: "active", steps: 1 });
    const second = activityEvent(2, "a1", { state: "done", steps: 4 });
    mergeActivities([first, second]);
    assert.equal(first.data.state, "active");
    assert.equal(first.data.steps, 1);
  });
});

describe("describeEvent", () => {
  it("describes every activity kind and state", () => {
    const cases = [
      [{ kind: "reading_brief", state: "active" }, "Reading the brief"],
      [{ kind: "reading_brief", state: "done" }, "Read the brief"],
      [{ kind: "reading_brief", state: "failed" }, "Could not read the brief"],
      [{ kind: "reading_notes", state: "done", stats: { notesRead: 3 } }, "Read 3 notes"],
      [{ kind: "reading_notes", state: "done", stats: { notesRead: 1 } }, "Read 1 note"],
      [
        { kind: "reading_notes", state: "active", stats: { notesRead: 2 } },
        "Reading notes · 2 so far",
      ],
      [{ kind: "reading_notes", state: "active" }, "Reading notes"],
      [{ kind: "reading_notes", state: "failed" }, "Could not read the notes"],
      [{ kind: "checking_display", state: "active" }, "Checking the Display"],
      [{ kind: "checking_display", state: "done" }, "Checked the Display"],
      [{ kind: "checking_display", state: "failed" }, "Could not check the Display"],
      [
        { kind: "choosing_layout", state: "active", stats: { layoutsSeen: 2 } },
        "Looking at layouts · 2 so far",
      ],
      [
        { kind: "choosing_layout", state: "done", stats: { layoutsSeen: 4 } },
        "Looked at 4 layouts",
      ],
      [
        { kind: "choosing_layout", state: "done", stats: { chosen: "Daily Summary" } },
        "Chose Daily Summary",
      ],
      // A chosen layout outranks the running count while still active.
      [
        {
          kind: "choosing_layout",
          state: "active",
          stats: { layoutsSeen: 3, chosen: "Daily Summary" },
        },
        "Chose Daily Summary",
      ],
      // An explicit null means "looked, has not settled".
      [
        { kind: "choosing_layout", state: "active", stats: { chosen: null } },
        "Looking at layouts",
      ],
      [{ kind: "choosing_layout", state: "failed" }, "Could not settle on a layout"],
      [{ kind: "submitting_plan", state: "active" }, "Submitting the plan"],
      [{ kind: "submitting_plan", state: "done" }, "Submitted the plan"],
      [{ kind: "submitting_plan", state: "failed" }, "Could not submit the plan"],
      [{ kind: "retrying", state: "active" }, "Trying another layout"],
      [{ kind: "retrying", state: "done" }, "Tried another layout"],
      [{ kind: "retrying", state: "failed" }, "Could not find another layout"],
      [{ kind: "other", state: "active" }, "Working"],
      [{ kind: "other", state: "done" }, "Finished a step"],
      [{ kind: "other", state: "failed" }, "A step failed"],
    ];

    for (const [data, expected] of cases) {
      assert.equal(
        describeEvent(activityEvent(1, "a1", data)),
        expected,
        `${data.kind}/${data.state}`,
      );
    }
  });

  it("describes the rest of the public types", () => {
    const cases = [
      [
        "context.materialized",
        { contents: 2, history: 0, displays: 1, templates: 9 },
        "Ready · 2 Contents, 1 Display, 9 layouts",
      ],
      [
        "context.materialized",
        { contents: 1, history: 4, displays: 2, templates: 9, vision: true, warnings: 2 },
        "Ready · 1 Content, 4 from history, 2 Displays, 9 layouts, images · 2 gaps",
      ],
      ["plan.submitted", { round: 1, outcome: "presentations", actions: 3 }, "Submitted the plan · 3 actions"],
      [
        "plan.submitted",
        { round: 2, outcome: "presentations", actions: 1 },
        "Submitted the plan (round 2) · 1 action",
      ],
      [
        "plan.submitted",
        { round: 1, outcome: "no_change" },
        "Submitted the plan · nothing worth showing",
      ],
      ["plan.submitted", { round: 2 }, "Submitted the plan (round 2)"],
      [
        "plan.rejected",
        { problems: 2, reason: "layout_mismatch", attempt: 1 },
        "Plan sent back · 2 problems with the layout it chose",
      ],
      [
        "plan.rejected",
        { problems: 1, reason: "other", attempt: 2 },
        "Plan sent back · 1 problem",
      ],
      [
        "plan.accepted",
        { presentationIds: ["p1", "p2"], actions: 2 },
        "Plan accepted · 2 Presentations",
      ],
      [
        "analysis.completed",
        { outcome: "presentations", presentations: 1 },
        "Finished · 1 Presentation",
      ],
      [
        "analysis.completed",
        { outcome: "no_change", presentations: 0 },
        "Finished · nothing worth showing",
      ],
      ["analysis.failed", { code: "no_presentable_content" }, "Failed · no_presentable_content"],
      ["render.finished", { presentationId: "p1" }, "Rendered p1"],
      ["render.failed", { presentationId: "p1" }, "Could not render p1"],
      [
        "delivery.published",
        { presentationId: "p1", displayId: "d1" },
        "Sent p1 to Display d1",
      ],
      [
        "delivery.confirmed",
        { presentationId: "p1", displayId: "d1" },
        "Display d1 is showing p1",
      ],
      ["delivery.confirmed", { presentationId: "p1" }, "p1 is showing"],
      [
        "delivery.failed",
        { presentationId: "p1", displayId: "d1" },
        "Could not deliver p1 to Display d1",
      ],
    ];

    for (const [type, data, expected] of cases) {
      assert.equal(describeEvent({ ...event(1, type), data }), expected, type);
    }
  });

  it("falls back to the backend summary and stays pure", () => {
    for (const type of ["analysis.created", "analysis.dispatched", "analysis.leased"]) {
      assert.equal(describeEvent(event(1, type)), `A ${type} happened.`);
    }
    // A type this SDK has never seen, and a delivery with nothing to name.
    assert.equal(describeEvent(event(1, "something.new")), "A something.new happened.");
    assert.equal(
      describeEvent({ ...event(1, "delivery.failed"), data: {} }),
      "A delivery.failed happened.",
    );

    const original = activityEvent(1, "a1", { state: "done" });
    const snapshot = structuredClone(original);
    describeEvent(original);
    assert.deepEqual(original, snapshot);
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

async function readOne(item) {
  const client = new Inklet({
    pat: PAT,
    fetch: async () =>
      json({ items: [item], nextAfter: null, hasMore: false, state: "running" }),
  });
  return client.analyses.listEvents(ANALYSIS_ID);
}

function frame(seq, overrides = {}) {
  const item = eventFixture(seq, overrides);
  return `id: ${seq}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`;
}

function eventFixture(seq, overrides = {}) {
  return {
    seq,
    at: "2026-08-12T10:00:02Z",
    attempt: 1,
    source: "agent",
    type: "agent.activity",
    level: "info",
    summary: `Step ${seq}.`,
    data: {
      activityId: `a${seq}`,
      kind: "reading_notes",
      state: "active",
      steps: 1,
      stats: {},
    },
    ...overrides,
  };
}

/** A parsed event, as the SDK would hand it to `describeEvent`. */
function event(seq, type) {
  return {
    seq,
    at: "2026-08-12T10:00:02Z",
    attempt: 1,
    source: "backend",
    type,
    level: "info",
    summary: `A ${type} happened.`,
    data: {},
  };
}

function activityEvent(seq, activityId, data = {}) {
  return {
    ...event(seq, "agent.activity"),
    source: "agent",
    data: {
      activityId,
      kind: "other",
      state: "active",
      steps: 1,
      stats: {},
      ...data,
    },
  };
}

/** A wire fixture whose `agent.activity` data has been broken on purpose. */
function activity(overrides) {
  const data = { ...eventFixture(1).data, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete data[key];
    }
  }
  return { ...eventFixture(1), data };
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
