/**
 * Ask inklet: conversations with the knowledge base (CONVERSATION_CONTRACT).
 *
 * A Conversation is a list of Messages. Every user message starts one round:
 * the backend answers with an assistant Message backed by an Analysis of
 * `mode: "chat"`, and that Analysis's event stream is how the reply arrives —
 * `assistant.delta` carries the text as it is written, `assistant.citation`
 * the notes it drew on, `action.*` what the agent did on the user's behalf,
 * and `analysis.completed` (`outcome: "reply"`) marks the Message final.
 */

import {
  createIdempotencyKey,
  parseProblem,
  validateIdempotencyKey,
} from "./contents.js";
import {
  AnalysisFailedError,
  ConfigurationError,
  InvalidResponseError,
  withIdempotencyKey,
} from "./errors.js";
import {
  isAnalysisEvent,
  watchAnalysisEvents,
  type AnalysisEvent,
  type WatchAnalysisOptions,
} from "./events.js";
import type { PresentationProblem } from "./presentations.js";
import {
  SDK_API_PREFIX,
  appendCursorAndLimit,
  callOptions,
  encodePathSegment,
  expectBoolean,
  expectEnum,
  expectRecord,
  expectRecordArray,
  expectString,
  nullableRecord,
  nullableString,
  parsePage,
  requireId,
  validateLimit,
  type CallOptions,
  type ResourceTransport,
} from "./resource.js";

export type ConversationMessageRole = "user" | "assistant";

/** The assistant Message follows its Analysis; a user Message is `completed` at once. */
export type ConversationMessageState = "queued" | "running" | "completed" | "failed";

export type MessageActionKind = "card_created" | "display_switched";

/** The backend's bound on a user message, in characters. */
export const MAX_MESSAGE_LENGTH = 4_000;

export interface Conversation {
  id: string;
  /** Set from the first user message when absent; may be `null` until then. */
  title: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationPage {
  items: readonly Conversation[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** A Content the reply drew on: one per `read_content` the agent made. */
export interface MessageCitation {
  contentId: string;
  title: string;
}

/** Something the agent did for the user during a round. */
export interface MessageAction {
  kind: MessageActionKind | (string & {});
  analysisId?: string;
  displayId?: string;
  presentationId?: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: ConversationMessageRole | (string & {});
  state: ConversationMessageState | (string & {});
  /** Final once `state` is `completed`; empty before that on an assistant Message. */
  text: string;
  /** The Analysis behind an assistant Message; `null` on a user Message. */
  analysisId: string | null;
  citations: readonly MessageCitation[];
  actions: readonly MessageAction[];
  failure: PresentationProblem | null;
  createdAt: string;
  completedAt: string | null;
}

/** A Conversation with its most recent Messages, oldest first. */
export interface ConversationDetail {
  conversation: Conversation;
  messages: readonly ConversationMessage[];
  /** More Messages exist before `messages[0]`; page back with `listMessages`. */
  hasMore: boolean;
}

export interface MessagePage {
  items: readonly ConversationMessage[];
  hasMore: boolean;
}

export interface CreateConversationInput {
  title?: string | null;
}

export interface ListConversationsOptions extends CallOptions {
  cursor?: string;
  limit?: number;
}

export interface ListMessagesOptions extends CallOptions {
  /** A Message id; the page holds Messages strictly before it, oldest first. */
  before?: string;
  limit?: number;
}

export interface SendMessageInput {
  text: string;
  idempotencyKey?: string;
}

/** What `POST …/messages` returns: the user Message and the reply's handle. */
export interface SendMessageResult {
  message: ConversationMessage;
  reply: {
    id: string;
    state: ConversationMessageState | (string & {});
    analysisId: string;
  };
}

export interface ReplyOptions extends WatchAnalysisOptions {
  idempotencyKey?: string;
  /** Called with each piece of the reply as it is written. */
  onDelta?: (text: string) => void;
  /** Called with every event of the round, deltas included. */
  onEvent?: (event: AnalysisEvent) => void;
}

export interface ReplyResult extends SendMessageResult {
  /** The assistant Message once it settled: `completed` or `failed`. */
  answer: ConversationMessage;
}

export class ConversationsResource {
  readonly #transport: ResourceTransport;

  constructor(transport: ResourceTransport) {
    this.#transport = transport;
  }

  async create(
    input: CreateConversationInput = {},
    options: CallOptions = {},
  ): Promise<Conversation> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("create requires an input object.");
    }
    if (input.title !== undefined && input.title !== null && typeof input.title !== "string") {
      throw new ConfigurationError("title must be a string or null.");
    }
    const response = await this.#transport.request(`${SDK_API_PREFIX}/conversations`, {
      ...callOptions(options),
      method: "POST",
      json: { title: input.title ?? null },
    });
    return parseConversation(expectRecord(response));
  }

  async list(options: ListConversationsOptions = {}): Promise<ConversationPage> {
    const query = new URLSearchParams();
    appendCursorAndLimit(query, options);
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/conversations${suffix}`,
      callOptions(options),
    );
    return parsePage(response, parseConversation);
  }

  async retrieve(conversationId: string, options: CallOptions = {}): Promise<ConversationDetail> {
    const id = encodePathSegment(conversationId, "conversationId");
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/conversations/${id}`,
      callOptions(options),
    );
    const record = expectRecord(response);
    return {
      conversation: parseConversation(expectRecord(record.conversation)),
      messages: expectRecordArray(record.messages).map(parseMessage),
      hasMore: expectBoolean(record, "hasMore"),
    };
  }

  async listMessages(
    conversationId: string,
    options: ListMessagesOptions = {},
  ): Promise<MessagePage> {
    const id = encodePathSegment(conversationId, "conversationId");
    const query = new URLSearchParams();
    if (options.before !== undefined) {
      query.set("before", requireId(options.before, "before"));
    }
    if (options.limit !== undefined) {
      query.set("limit", String(validateLimit(options.limit)));
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const response = await this.#transport.request(
      `${SDK_API_PREFIX}/conversations/${id}/messages${suffix}`,
      callOptions(options),
    );
    const record = expectRecord(response);
    return {
      items: expectRecordArray(record.items).map(parseMessage),
      hasMore: expectBoolean(record, "hasMore"),
    };
  }

  /** Delete a Conversation and its Messages. The Analyses behind them stay. */
  async delete(conversationId: string, options: CallOptions = {}): Promise<void> {
    const id = encodePathSegment(conversationId, "conversationId");
    await this.#transport.request(`${SDK_API_PREFIX}/conversations/${id}`, {
      ...callOptions(options),
      method: "DELETE",
    });
  }

  /**
   * Post a user message and start a round. Returns at once with the reply's
   * Message id and the Analysis to follow; `reply()` does the following.
   */
  async send(
    conversationId: string,
    input: SendMessageInput | string,
    options: CallOptions = {},
  ): Promise<SendMessageResult> {
    const id = encodePathSegment(conversationId, "conversationId");
    const { text, idempotencyKey } = normalizeSendInput(input);
    validateIdempotencyKey(idempotencyKey);
    try {
      const response = await this.#transport.request(
        `${SDK_API_PREFIX}/conversations/${id}/messages`,
        {
          ...callOptions(options),
          method: "POST",
          headers: { "idempotency-key": idempotencyKey },
          json: { text },
        },
      );
      return parseSendResult(expectRecord(response));
    } catch (error) {
      throw withIdempotencyKey(error, idempotencyKey);
    }
  }

  /**
   * Ask and wait for the answer: `send()`, then follow the reply's Analysis
   * until it settles, handing each `assistant.delta` to `onDelta`. Resolves
   * with the final Message; rejects with `AnalysisFailedError` when the round
   * failed.
   */
  async reply(
    conversationId: string,
    input: SendMessageInput | string,
    options: ReplyOptions = {},
  ): Promise<ReplyResult> {
    if (!options || typeof options !== "object") {
      throw new ConfigurationError("reply options must be an object.");
    }
    const { idempotencyKey, onDelta, onEvent, ...watch } = options;
    const send = typeof input === "string" ? { text: input } : { ...input };
    if (idempotencyKey !== undefined) {
      send.idempotencyKey = idempotencyKey;
    }
    const sent = await this.send(conversationId, send, {
      ...(watch.signal === undefined ? {} : { signal: watch.signal }),
    });
    let failure: AnalysisEvent | undefined;
    for await (const event of watchAnalysisEvents(this.#transport, sent.reply.analysisId, watch)) {
      onEvent?.(event);
      if (isAnalysisEvent(event, "assistant.delta")) {
        onDelta?.(event.data.text);
      } else if (isAnalysisEvent(event, "analysis.failed")) {
        failure = event;
      }
    }
    const answer = await this.message(conversationId, sent.reply.id, {
      ...(watch.signal === undefined ? {} : { signal: watch.signal }),
    });
    if (answer.state === "failed" || failure !== undefined) {
      throw new AnalysisFailedError(
        answer.failure?.message ?? failure?.summary ?? "Inklet could not answer.",
        {
          analysisId: sent.reply.analysisId,
          details: {
            conversationId,
            messageId: sent.reply.id,
            ...(answer.failure
              ? {
                  stage: answer.failure.stage,
                  retryable: answer.failure.retryable,
                  backendCode: answer.failure.code,
                }
              : {}),
          },
        },
      );
    }
    return { ...sent, answer };
  }

  /**
   * One Message by id. Reads the Conversation's recent Messages and pages
   * back while the id is older than what has been read.
   */
  async message(
    conversationId: string,
    messageId: string,
    options: CallOptions = {},
  ): Promise<ConversationMessage> {
    const wanted = requireId(messageId, "messageId");
    const detail = await this.retrieve(conversationId, options);
    let page: { items: readonly ConversationMessage[]; hasMore: boolean } = {
      items: detail.messages,
      hasMore: detail.hasMore,
    };
    for (let hops = 0; ; hops += 1) {
      const found = page.items.find((message) => message.id === wanted);
      if (found !== undefined) {
        return found;
      }
      const oldest = page.items[0];
      if (!page.hasMore || oldest === undefined || hops >= MAX_MESSAGE_PAGES) {
        throw new ConfigurationError(
          `Message ${wanted} is not in Conversation ${conversationId}.`,
        );
      }
      page = await this.listMessages(conversationId, { ...options, before: oldest.id });
    }
  }
}

const MAX_MESSAGE_PAGES = 20;

function normalizeSendInput(
  input: SendMessageInput | string,
): { text: string; idempotencyKey: string } {
  const raw = typeof input === "string" ? { text: input } : input;
  if (!raw || typeof raw !== "object" || typeof raw.text !== "string") {
    throw new ConfigurationError("send requires text.");
  }
  const text = raw.text.trim();
  if (text.length === 0) {
    throw new ConfigurationError("text must not be blank.");
  }
  if ([...text].length > MAX_MESSAGE_LENGTH) {
    throw new ConfigurationError(
      `text must be at most ${MAX_MESSAGE_LENGTH} characters.`,
    );
  }
  return { text, idempotencyKey: raw.idempotencyKey ?? createIdempotencyKey() };
}

export function parseConversation(record: Record<string, unknown>): Conversation {
  return {
    id: expectString(record, "id"),
    title: nullableString(record.title),
    lastMessageAt: nullableString(record.lastMessageAt),
    createdAt: expectString(record, "createdAt"),
    updatedAt: expectString(record, "updatedAt"),
  };
}

export function parseMessage(record: Record<string, unknown>): ConversationMessage {
  const text = record.text;
  if (typeof text !== "string") {
    throw new InvalidResponseError();
  }
  return {
    id: expectString(record, "id"),
    conversationId: expectString(record, "conversationId"),
    role: expectEnum<ConversationMessageRole>(record.role),
    state: expectEnum<ConversationMessageState>(record.state),
    text,
    analysisId: nullableString(record.analysisId),
    citations: parseCitations(record.citations),
    actions: parseActions(record.actions),
    failure: parseProblem(nullableRecord(record.failure ?? null)),
    createdAt: expectString(record, "createdAt"),
    completedAt: nullableString(record.completedAt),
  };
}

function parseCitations(value: unknown): MessageCitation[] {
  if (value === undefined || value === null) {
    return [];
  }
  return expectRecordArray(value).map((item) => {
    const title = item.title;
    return {
      contentId: expectString(item, "contentId"),
      title: typeof title === "string" ? title : "",
    };
  });
}

function parseActions(value: unknown): MessageAction[] {
  if (value === undefined || value === null) {
    return [];
  }
  return expectRecordArray(value).map((item) => {
    const action: MessageAction = { kind: expectEnum<MessageActionKind>(item.kind) };
    for (const key of ["analysisId", "displayId", "presentationId"] as const) {
      const id = item[key];
      if (typeof id === "string" && id.length > 0) {
        action[key] = id;
      }
    }
    return action;
  });
}

function parseSendResult(record: Record<string, unknown>): SendMessageResult {
  const reply = expectRecord(record.reply);
  return {
    message: parseMessage(expectRecord(record.message)),
    reply: {
      id: expectString(reply, "id"),
      state: expectEnum<ConversationMessageState>(reply.state),
      analysisId: expectString(reply, "analysisId"),
    },
  };
}
