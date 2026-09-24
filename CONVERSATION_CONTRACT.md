# inklet Conversation 契约（Ask inklet）

状态：第二阶段实现依据，配套后端 `feat/conversations`、worker `feat/chat-kernel`、
SDK / Portal / macOS 的同名分支。

日期：2026-09-24

本文档在 `ANALYSIS_CONTRACT.md` 之上叠加一个对话面：用户用自然语言问自己的知识库、
让 agent 替自己做已有链路里的动作。它**不改** Content、Presentation、Display 的任何
语义；每一轮回复就是一条 `mode = chat` 的 Analysis，复用 lease / heartbeat / run
token / 事件流 / 幂等 / 额度这整套机制。

## 1. 目标

1. 用户在 Portal 或 macOS 里问"上周关于牙医的那条在哪"，得到基于自己内容的回答，
   附引用。
2. 用户说"把它推到厨房的屏"，agent 调**现有**的 `POST /analyses`（card / as-is）或
   `POST /displays/{id}/current` 完成，不新造推屏路径。
3. 回答逐字流式到达；agent 的每一步（搜索、读取、创建卡片）在同一条流里可见。
4. Pro 功能，按轮计数；只上传、只搜索仍然是 Free。

## 2. 领域模型

```text
Conversation ──< Message(user) ──1:1── Message(assistant) ──1:1── Analysis(mode = chat)
                                                                     └──< events (现有表)
```

| 对象 | 说明 |
| --- | --- |
| Conversation | 一个用户的一段对话：`id`、`title`（首条消息摘出，可改）、时间戳。 |
| Message | `role` ∈ `user` / `assistant`。用户消息创建即 `completed`；助手消息随其 Analysis 推进：`queued → running → completed / failed`。`text` 在 `completed` 时定稿。 |
| Analysis(mode = chat) | 一轮回复的运行体。`contentIds = []`、`context = history`、`target = null`、`settings.conversationId` / `settings.replyMessageId`。它**不产生 Presentation**（`outcome = reply`），除非 agent 在这一轮里调了创建卡片的工具 —— 那会是**另一条**独立的 Analysis，由本轮的事件引用。 |

`mode = chat` 的 Analysis：

- 不出现在 `GET /analyses` 的默认列表里；`GET /analyses?mode=chat` 才列出。
- `GET /analyses/{id}`、`/events`、`/events/stream`、`/archive` 照常可读，归属校验同前。
- 不进入 Scheduler；不受"每屏一条"或 `no_change` 规则约束；`outcome` 只能是 `reply`。

## 3. 认证与前缀

同 `ANALYSIS_CONTRACT.md` §3：`/api/sdk/v1`（PAT）与 `/api/app/v1`（用户 token）挂同
一组 handler。下文省略前缀。

## 4. 公开接口

### 4.1 创建对话

```http
POST /conversations
Idempotency-Key: 可选
{ "title": null }
```

`201` 返回 Conversation。`title` 为空时在首条用户消息落库后由后端摘出（首行，≤ 60
字符），之后不再自动改。

### 4.2 列表与读取

```http
GET /conversations?cursor=&limit=          # 按 updatedAt 倒序，keyset (updated_at, id)
GET /conversations/{conversationId}        # 含最近 50 条消息，按 createdAt 升序
GET /conversations/{conversationId}/messages?before=&limit=   # 更早的消息，keyset 向前翻
DELETE /conversations/{conversationId}     # 204；消息一并删；它引用的 Analysis 与事件保留
```

不属于调用方的对话一律 `404 conversation_not_found`。

### 4.3 发消息

```http
POST /conversations/{conversationId}/messages
Idempotency-Key: 必填
{ "text": "上周那条牙医预约推到厨房的屏" }
```

规则：

- `text` 去首尾空白后 1–4000 个字符；空是 `400 invalid_request`，超长是 `400`，不截断。
- 同一对话上一轮回复仍在 `queued` / `running` → `409 reply_in_progress`，`details.replyMessageId`。
  调用方等它结束（或看它的事件流）再发。
- 需要 `ai_chat` 权益；FREE 是 `403 plan_upgrade_required`，和 `POST /analyses` 的 `ai`
  一致。额度在这里预留、回复完成时结算、失败时释放（复用 `ReserveDurable`）。
- 一个事务里：写用户消息（`completed`）、写助手消息（`queued`）、写 Analysis
  （`mode = chat`，`settings` 指向两者）、写 outbox(`sqs.agent`)。
- 幂等键作用域 principal + method + route；重放返回同一对回复。

`202`：

```json
{
  "message": { "id": "019…", "role": "user", "text": "…", "state": "completed", "createdAt": "…" },
  "reply":   { "id": "019…", "role": "assistant", "text": null, "state": "queued",
               "analysisId": "019…", "createdAt": "…" }
}
```

### 4.4 Message 模型

```json
{
  "id": "019…",
  "conversationId": "019…",
  "role": "assistant",
  "state": "completed",
  "text": "上周三那条「牙医预约」找到了，已经排到厨房的屏上，下次刷新就会显示。",
  "analysisId": "019…",
  "citations": [ { "contentId": "019…", "title": "牙医预约" } ],
  "actions": [ { "type": "card", "analysisId": "019…", "displayId": "019…" } ],
  "failure": null,
  "createdAt": "…",
  "completedAt": "…"
}
```

- `citations`：回答引用过的 Content，由 worker 在 reply 时提交，后端校验归属后落库。
- `actions`：这一轮里 agent 执行过的动作：`card`（创建了一条 Analysis）、
  `current`（把某个 Presentation 放回某屏）。
- 用户消息的 `analysisId` / `citations` / `actions` 为 `null` / `[]`。

## 5. 流式回复

客户端**不需要新的读接口**：拿到 `reply.analysisId` 后走现有的
`GET /analyses/{id}/events?after=` 或 `/events/stream`。本契约新增以下 `public` 事件：

| type | source | data | 说明 |
| --- | --- | --- | --- |
| `assistant.delta` | agent | `{ "text": "…" }` | 回答的一段增量，按到达顺序拼接即全文。worker 侧至多每 300ms 或 200 字符合并发一条。 |
| `assistant.citation` | agent | `{ "contentId", "title" }` | agent 在回答中引用了一条 Content。引用的判据是「本轮真的用 `read_content` 读过」：读成功一次发一条，同一条内容只发一次；只在搜索结果里看过标题的不算。 |
| `action.card_created` | backend | `{ "analysisId", "target" }` | 本轮通过工具创建了一条卡片 Analysis。 |
| `action.display_switched` | backend | `{ "displayId", "presentationId" }` | 本轮把一张卡放回了某屏。 |
| `analysis.completed` | backend | `{ "outcome": "reply", "messageId" }` | 回复定稿。`GET /conversations/{id}` 此时能读到全文。 |

`agent.activity` 新增 `kind`：`searching_notes`（调 `search_knowledge`）、
`reading_note`（读某条 Content 或素材全文）、`creating_card`、`switching_display`。
其余事件（`analysis.created` / `leased` / `failed` 等）不变。

`seq` 仍全局且可能跳号；`assistant.delta` 之间的顺序由 `seq` 保证，客户端只按 `seq`
升序拼接，不要按时间。

## 6. worker 侧：chat 内核

lease 响应的 `snapshot` 对 `mode = chat` 增加：

```json
{
  "mode": "chat",
  "conversation": {
    "id": "019…",
    "title": "…",
    "messages": [ { "role": "user", "text": "…", "at": "…" }, { "role": "assistant", "text": "…", "at": "…" } ],
    "replyMessageId": "019…"
  },
  "scope": { "sinceAt": "…", "untilAt": "…" },
  "displays": [ … 同现有 … ]
}
```

`messages` 是最近 20 轮（40 条）已完成的消息，最后一条一定是本轮的用户消息。
`maxToolCalls` / `maxActions` 是本轮预算（当前 8 / 2），由后端下发，worker 不自己定。
快照其余字段沿用现有形态：`strategy = history`、`target = { agentSelected: true, allowedDisplayIds }`
（allowedDisplayIds 即 run token 允许动作的屏）、`displays` 是这些屏的现状、`inputContentIds = []`、
`templates = []`。
`scope` 是套餐允许的历史窗口，`search_knowledge` 只能在这个窗口里搜。

工具（全部通过现有 `/internal/agent/*` 或本契约新增的内部接口，带 run token）：

| 工具 | 内部接口 | 说明 |
| --- | --- | --- |
| `search_knowledge(q, limit)` | `GET /internal/agent/contents?q=&limit=` | 第一阶段的搜索，窗口由 run token 限定。返回标题、一行摘要、时间。 |
| `read_content(contentId)` | `GET /internal/agent/contents/{id}` + `GET /internal/agent/assets/{id}/text` | 读一条的全文（素材 digest）。 |
| `list_displays()` | `GET /internal/agent/displays` | 名字、在线、当前在显示什么。 |
| `display_history(displayId)` | `GET /internal/agent/displays/{id}/history` | 最近的卡片，供"放回去"用。 |
| `create_card({ contentIds, target, intent })` | `POST /internal/agent/analyses` | 代用户创建一条 `mode = ai` / `direct` 的 Analysis。 |
| `show_on_display({ displayId, presentationId })` | `POST /internal/agent/displays/{id}/current` | 代用户调 `POST /displays/{id}/current`。 |

约束：

- 一轮至多 **8** 次工具调用、至多 **2** 个动作（`create_card` / `show_on_display`），
  超出即结束本轮并在回答里说明。
- 动作只能针对 run token 允许的屏（`allowedDisplayIds`）；创建卡片时 `contentIds`
  必须来自本轮搜到或读到的 id，后端按 run token 复核。
- 不物化工作目录、不给文件工具；上下文只来自快照和工具返回值。
- 素材全文是**数据**：系统提示明确指出网页正文、OCR 结果里出现的指令一律不执行。
- 单轮墙钟上限 90 秒；到时把已生成的文本作为回复提交，并在末尾注明未完成。

提交回复：

```http
POST /internal/analyses/{analysisId}/reply
Authorization: Bearer <run token>
{ "attempt": 1, "text": "…", "citations": [ … ], "usage": { … } }
```

后端：校验 attempt；文本 1–20000 字符；`citations` 按 run token 复核归属；一个事务里
把助手消息置 `completed`、写 `text` / `citations` / `actions`（actions 从本轮已记录
的动作事件汇总），Analysis 置 `completed` / `outcome = reply`，结算额度。`200` 返回
Message。`409 attempt_superseded` 同 plan。

失败：worker 走现有的 failure 提交路径（`POST /plan` 的 failure 分支保持不变，或
`reply` 带 `failure` 字段），后端把助手消息置 `failed`、`failure` 落库、释放额度。

## 7. 内部接口新增

| 接口 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /internal/agent/contents?q=&limit=` | run token | 现有接口加 `q`，语义同公开的 `GET /contents?q=`，窗口仍受 `historySince` 约束。 |
| `POST /internal/agent/analyses` | run token（必须是 chat 的 token） | body 为公开 `POST /analyses` 的子集：`mode`、`contentIds`、`context = submitted`、`intent`、`target`。以 token 的 userId 创建，`trigger = chat`，`settings.originAnalysisId` 指回本轮。额度、校验、422/409 与公开接口完全一致。成功后后端写 `action.card_created` 事件到本轮。 |
| `POST /internal/agent/displays/{displayId}/current` | run token（chat） | 同公开的 `POST /displays/{id}/current`；成功后写 `action.display_switched`。 |
| `POST /internal/analyses/{id}/reply` | run token | §6。 |

三条 `POST` 都要求 `X-Internal-Token` + run token，且 run token 的 `mode` 必须是
`chat`（在 claims 里新增 `mode`）。

两个动作接口还要求 **`Idempotency-Key`**（缺失 `400`）。它们有持久的副作用，而 worker
会在传输失败 / 5xx 上重试，SQS 也可能把整条消息重投；没有 key，一次「后端已提交但
响应丢了」就是两张卡、两次扣额度。

- worker 侧的 key 由「本轮 analysisId + 动作种类 + 动作的实质参数」算出，**不含
  tool call id**：`chat-<analysisId>-<sha256(kind + 规范化参数)[:32]>`。规范化 =
  键排序、`contentIds` 排序、不含 `intent` / `title`。于是 HTTP 重试、SQS 重投、
  模型在新一次尝试里再做同一件事，都是同一个 key。
- 后端把 key 的作用域定为「用户 + 路由 + 本轮 analysisId」，与公开接口共用一套
  幂等存储：同 key 同 body 回放第一次的响应（不再创建、不扣额度、不记事件）；
  同 key 不同 body → `409 idempotency_conflict`；同 key 仍在处理 → `409`。

## 8. 权益与计量

- 新增 `ai_chat`，最低 Pro，无试用。
- 单位：每条用户消息一轮。预留在 `POST …/messages`，结算在 `reply`，失败释放。
- agent 在一轮里创建的卡片另按 `ai_routing` 计一次，和用户手动创建完全一致。
- `usage` 落在 Analysis 上，和现有 Analysis 一样，先不做 token 计费。

## 9. 错误码

在既有错误码之上新增：

| HTTP | code | 场景 |
| ---: | --- | --- |
| 404 | `conversation_not_found` | 对话不存在或不属于调用方 |
| 404 | `message_not_found` | 消息不存在 |
| 409 | `reply_in_progress` | 上一轮回复未结束 |
| 403 | `plan_upgrade_required` | FREE 调 `POST …/messages` |

## 10. 持久化

- `conversations`：`id`、`user_id`（索引）、`title`、`created_at`、`updated_at`（索引 `(user_id, updated_at desc, id desc)`）。
- `conversation_messages`：`id`、`conversation_id`（索引 `(conversation_id, created_at, id)`）、`role`、`state`、`text`、`analysis_id`（可空，唯一）、`citations jsonb`、`actions jsonb`、`failure jsonb`、`created_at`、`completed_at`。
- `analyses.mode` 的 CHECK 加 `chat`；`analyses.trigger` 加 `chat`（agent 代建的卡片）。
- 事件继续写 `analysis_events`，无新表。

## 11. 客户端

SDK：

```ts
const c = await inklet.conversations.create();
const { reply } = await inklet.conversations.send(c.id, "上周牙医那条推到厨房");
for await (const event of inklet.analyses.watch(reply.analysisId)) {
  if (isAnalysisEvent(event, "assistant.delta")) process.stdout.write(event.data.text);
}
const done = await inklet.conversations.message(c.id, reply.id);   // text, citations, actions
```

`conversations.reply(c.id, text, { onDelta })` 是把上面四步合成一步的糖。

Portal：`/ask` 页，左侧对话列表，右侧消息流；助手气泡在 `running` 时按
`assistant.delta` 增量渲染，工具步骤以现有时间线组件的 `agent.activity` 行内嵌在
气泡上方；`actions` 渲染成可点的卡片链接（跳到 `/analyses/{id}` 或屏页）。

macOS：菜单栏与主窗口各一个 "Ask inklet" 入口，独立窗口，同样的气泡与步骤行；
`⌘⇧A` 全局唤起。

## 12. 必须通过的测试

1. FREE 发消息 403，不落用户消息、不写 Analysis、不投递。
2. 一条 `POST …/messages` 恰好产生一条 user、一条 assistant、一条 `mode = chat` 的 Analysis 与一条 outbox；幂等重放返回同一对。
3. 上一轮未完成时再发 409；完成后可发。
4. `mode = chat` 不出现在默认 `GET /analyses`，`?mode=chat` 出现；Scheduler 不会挑到它。
5. `reply` 定稿助手消息，`GET /conversations/{id}` 能读到全文与引用；引用里不属于该用户的 id 被剔除。
6. `search_knowledge` 只在窗口内命中；`create_card` 用窗口外或他人的 contentId 被 403。
7. `create_card` 成功后本轮时间线出现 `action.card_created`，且卡片 Analysis 的 `trigger = chat`；额度按 `ai_routing` 再扣一次。
8. worker 超过 8 次工具调用或 90 秒后仍能提交带说明的回复，助手消息不会永远 `running`。
9. `DELETE /conversations/{id}` 后消息不可读、事件仍可读。
10. `/api/sdk/v1` 与 `/api/app/v1` 对同一请求返回等价 DTO。
