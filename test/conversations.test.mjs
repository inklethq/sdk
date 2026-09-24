import assert from "node:assert/strict";
import { it } from "node:test";
import { CONTENT_ID, DISPLAY_ID, PAT, PRESENTATION_ID, json } from "./fixtures.mjs";
import { describeFor, loadSdk } from "./sdk.mjs";

const describe = describeFor(import.meta.url);
const { AnalysisFailedError, ConfigurationError, Inklet, describeEvent, isAnalysisEvent } =
  await loadSdk(import.meta.url);

const CONVERSATION_ID = "01962345-6789-7abc-def0-123456789abc";
const USER_MESSAGE_ID = "01972345-6789-7abc-def0-123456789ab1";
const REPLY_ID = "01972345-6789-7abc-def0-123456789ab2";
const CHAT_ANALYSIS_ID = "01982345-6789-7abc-def0-123456789abc";

function conversationFixture(overrides = {}) {
  return {
    id: CONVERSATION_ID,
    title: null,
    lastMessageAt: null,
    createdAt: "2026-09-24T01:00:00.000Z",
    updatedAt: "2026-09-24T01:00:00.000Z",
    ...overrides,
  };
}

function messageFixture(overrides = {}) {
  return {
    id: USER_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    role: "user",
    state: "completed",
    text: "我下次牙医预约是什么时候？",
    analysisId: null,
    citations: [],
    actions: [],
    failure: null,
    createdAt: "2026-09-24T01:00:01.000Z",
    completedAt: "2026-09-24T01:00:01.000Z",
    ...overrides,
  };
}

function replyFixture(overrides = {}) {
  return messageFixture({
    id: REPLY_ID,
    role: "assistant",
    state: "completed",
    text: "你下周二下午三点有牙医预约。",
    analysisId: CHAT_ANALYSIS_ID,
    citations: [{ contentId: CONTENT_ID, title: "牙医预约" }],
    actions: [{ kind: "card_created", analysisId: "an_card", displayId: DISPLAY_ID }],
    createdAt: "2026-09-24T01:00:01.001Z",
    completedAt: "2026-09-24T01:00:09.000Z",
    ...overrides,
  });
}

function event(seq, type, data, extra = {}) {
  return {
    seq,
    at: "2026-09-24T01:00:05.000Z",
    attempt: 1,
    source: type.startsWith("assistant.") || type === "agent.activity" ? "agent" : "backend",
    type,
    level: "info",
    summary: type,
    data,
    ...extra,
  };
}

/** A fake backend for one round: events are served as JSON pages (the polling fallback). */
function chatBackend({ events, reply = replyFixture(), onRequest = () => {} } = {}) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    onRequest({ method, path: url.pathname, search: url.search, init });
    if (method === "POST" && url.pathname === "/api/sdk/v1/conversations") {
      const body = JSON.parse(init.body);
      return json(conversationFixture({ title: body.title }), 201);
    }
    if (method === "GET" && url.pathname === "/api/sdk/v1/conversations") {
      return json({ items: [conversationFixture({ title: "牙医" })], nextCursor: null, hasMore: false });
    }
    if (method === "DELETE" && url.pathname === `/api/sdk/v1/conversations/${CONVERSATION_ID}`) {
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url.pathname === `/api/sdk/v1/conversations/${CONVERSATION_ID}`) {
      return json({
        conversation: conversationFixture({ title: "我下次牙医预约是什么时候？" }),
        messages: [messageFixture(), reply],
        hasMore: true,
      });
    }
    if (method === "GET" && url.pathname === `/api/sdk/v1/conversations/${CONVERSATION_ID}/messages`) {
      return json({ items: [messageFixture({ id: "01972345-6789-7abc-def0-123456789ab0", text: "更早" })], hasMore: false });
    }
    if (method === "POST" && url.pathname === `/api/sdk/v1/conversations/${CONVERSATION_ID}/messages`) {
      return json(
        {
          message: messageFixture(),
          reply: { id: REPLY_ID, state: "queued", analysisId: CHAT_ANALYSIS_ID },
        },
        202,
      );
    }
    if (url.pathname === `/api/sdk/v1/analyses/${CHAT_ANALYSIS_ID}/events/stream` ||
        url.pathname === `/api/sdk/v1/analyses/${CHAT_ANALYSIS_ID}/events`) {
      const after = Number(url.searchParams.get("after") ?? 0);
      const items = events.filter((e) => e.seq > after);
      return json({ items, nextAfter: items.at(-1)?.seq ?? null, hasMore: false, state: "completed" });
    }
    return json({ error: { code: "not_found", message: url.pathname } }, 404);
  };
}

const ROUND = [
  event(2, "agent.activity", { activityId: "c1", kind: "searching_notes", state: "done", steps: 1, stats: { matches: 1 } }),
  event(3, "assistant.citation", { contentId: CONTENT_ID, title: "牙医预约" }),
  event(4, "assistant.delta", { text: "你下周二" }),
  event(5, "assistant.delta", { text: "下午三点有牙医预约。" }),
  event(6, "action.card_created", { analysisId: "an_card", contentIds: [CONTENT_ID], displayId: DISPLAY_ID }),
  event(7, "action.display_switched", { displayId: DISPLAY_ID, presentationId: PRESENTATION_ID }),
  event(8, "analysis.completed", { outcome: "reply", presentations: 0, messageId: REPLY_ID, turns: 3 }),
];

describe("Conversations", () => {
  it("creates, lists, reads, pages and deletes", async () => {
    const calls = [];
    const client = new Inklet({ pat: PAT, fetch: chatBackend({ events: ROUND, onRequest: (c) => calls.push(c) }) });

    const created = await client.conversations.create({ title: "牙医" });
    assert.equal(created.id, CONVERSATION_ID);
    assert.equal(created.title, "牙医");

    const page = await client.conversations.list({ limit: 10 });
    assert.equal(page.items[0].title, "牙医");
    assert.equal(calls.at(-1).search, "?limit=10");

    const detail = await client.conversations.retrieve(CONVERSATION_ID);
    assert.equal(detail.conversation.title, "我下次牙医预约是什么时候？");
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages[1].role, "assistant");
    assert.deepEqual(detail.messages[1].citations, [{ contentId: CONTENT_ID, title: "牙医预约" }]);
    assert.deepEqual(detail.messages[1].actions, [{ kind: "card_created", analysisId: "an_card", displayId: DISPLAY_ID }]);
    assert.equal(detail.hasMore, true);

    const older = await client.conversations.listMessages(CONVERSATION_ID, { before: USER_MESSAGE_ID, limit: 5 });
    assert.equal(older.items[0].text, "更早");
    assert.equal(calls.at(-1).search, `?before=${USER_MESSAGE_ID}&limit=5`);

    await client.conversations.delete(CONVERSATION_ID);
    assert.equal(calls.at(-1).method, "DELETE");
  });

  it("sends a message with an idempotency key and returns the reply handle", async () => {
    const calls = [];
    const client = new Inklet({ pat: PAT, fetch: chatBackend({ events: ROUND, onRequest: (c) => calls.push(c) }) });
    const sent = await client.conversations.send(CONVERSATION_ID, { text: "  我下次牙医预约是什么时候？  ", idempotencyKey: "ask-00000001" });
    assert.equal(sent.message.role, "user");
    assert.equal(sent.reply.id, REPLY_ID);
    assert.equal(sent.reply.state, "queued");
    assert.equal(sent.reply.analysisId, CHAT_ANALYSIS_ID);
    const post = calls.find((c) => c.method === "POST");
    assert.equal(new Headers(post.init.headers).get("idempotency-key"), "ask-00000001");
    assert.deepEqual(JSON.parse(post.init.body), { text: "我下次牙医预约是什么时候？" });
  });

  it("rejects a blank or over-long message before any request", async () => {
    const client = new Inklet({ pat: PAT, fetch: async () => assert.fail("no request expected") });
    await assert.rejects(client.conversations.send(CONVERSATION_ID, "   "), ConfigurationError);
    await assert.rejects(client.conversations.send(CONVERSATION_ID, "字".repeat(4001)), ConfigurationError);
    await assert.rejects(client.conversations.reply(CONVERSATION_ID, ""), ConfigurationError);
  });

  it("reply() streams deltas, relays every event, and resolves with the final Message", async () => {
    const client = new Inklet({ pat: PAT, fetch: chatBackend({ events: ROUND }) });
    const deltas = [];
    const seen = [];
    const result = await client.conversations.reply(CONVERSATION_ID, "我下次牙医预约是什么时候？", {
      onDelta: (text) => deltas.push(text),
      onEvent: (ev) => seen.push(ev.type),
      pollIntervalMs: 100,
    });
    assert.equal(deltas.join(""), "你下周二下午三点有牙医预约。");
    assert.deepEqual(seen, ROUND.map((e) => e.type));
    assert.equal(result.reply.analysisId, CHAT_ANALYSIS_ID);
    assert.equal(result.answer.id, REPLY_ID);
    assert.equal(result.answer.state, "completed");
    assert.equal(result.answer.text, "你下周二下午三点有牙医预约。");
  });

  it("reply() rejects with AnalysisFailedError when the round failed", async () => {
    const failed = [
      event(2, "assistant.delta", { text: "我先" }),
      event(3, "analysis.failed", { code: "empty_reply", message: "nothing came out", source: "agent" }, { level: "error" }),
    ];
    const reply = replyFixture({
      state: "failed",
      text: "",
      citations: [],
      actions: [],
      failure: { code: "empty_reply", message: "nothing came out", stage: "kernel", retryable: true, assetIndex: null },
    });
    const client = new Inklet({ pat: PAT, fetch: chatBackend({ events: failed, reply }) });
    await assert.rejects(client.conversations.reply(CONVERSATION_ID, "你好", { pollIntervalMs: 100 }), (error) => {
      assert.ok(error instanceof AnalysisFailedError);
      assert.equal(error.analysisId, CHAT_ANALYSIS_ID);
      assert.equal(error.details.backendCode, "empty_reply");
      assert.equal(error.details.messageId, REPLY_ID);
      return true;
    });
  });

  it("parses and describes the chat events", async () => {
    const client = new Inklet({ pat: PAT, fetch: chatBackend({ events: ROUND }) });
    const page = await client.analyses.listEvents(CHAT_ANALYSIS_ID);
    const lines = page.items.map(describeEvent);
    assert.deepEqual(lines, [
      "Found 1 note",
      "Cited 牙医预约",
      "assistant.delta",
      "assistant.delta",
      "Started a card from 1 note",
      `Put ${PRESENTATION_ID} back on the display`,
      "Replied",
    ]);
    const delta = page.items.find((e) => isAnalysisEvent(e, "assistant.delta"));
    assert.equal(delta.data.text, "你下周二");
    const done = page.items.find((e) => isAnalysisEvent(e, "analysis.completed"));
    assert.equal(done.data.messageId, REPLY_ID);
    assert.equal(done.data.outcome, "reply");
  });

  it("lists chat Analyses only when asked", async () => {
    const client = new Inklet({
      pat: PAT,
      fetch: async (input) => {
        const url = new URL(input);
        assert.equal(url.searchParams.get("mode"), "chat");
        return json({ items: [], nextCursor: null, hasMore: false });
      },
    });
    await client.analyses.list({ mode: "chat" });
    await assert.rejects(client.analyses.list({ mode: "sideways" }), ConfigurationError);
  });
});
