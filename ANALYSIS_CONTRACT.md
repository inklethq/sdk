# inklet Analysis 契约（Content → Analysis → Presentation）

> **状态：历史设计契约，已由实现取代。** 这是 2026-09-13 交给后端的一次性实现
> 交底，不是现行接口文档，不要拿它当接口来写代码。现行口径以这三份为准：
>
> - SDK 公开表面 —— 本仓库的 [`README.md`](README.md) 与 [`CHANGELOG.md`](CHANGELOG.md)；
> - 后端接口 —— backend 仓库 `docs/api/sdk-v1.md`；
> - targetless 输出 —— backend 仓库 `docs/api/targetless-presentations.md`。
>
> 正文按原样保留以备查阅。与实现冲突时以代码为准。

日期：2026-09-13

本文档取代 `BACKEND_CONTRACT.md` §7.2、§7.3、§8 中"Content 自带 mode，confirm 即启动处理"的
模型，并把 `TARGETLESS_PRESENTATIONS_CONTRACT.md` 的 targetless 输出收编为 Analysis 的一种目标。
Display、Presentation、队列、current-presentation、上传票据、Scene v1、renditions 的既有契约
不变。

## 0. 写完之后变了什么

只列在代码里核对过的差异。

- **分析事件有了可见性。** 每条事件带 `visibility public|internal`，公开读只返回
  public 的那一档，而且是一个 16 个类型的闭集：`analysis.created` /
  `dispatched` / `leased` / `lease_expired` / `completed` / `failed`、
  `context.materialized`、`agent.activity`、`plan.submitted` / `rejected` /
  `accepted`、`render.finished` / `failed`、`delivery.published` / `confirmed` /
  `failed`。`turn.*`、`tool.*`、`kernel.*`、`assistant.note`、`plan.validated`
  以及所有 `detail` 负载只在内部；公开端点上带 `?detail=` 返回
  `400 invalid_request`。公开的 `seq` 单调但**不连续**（内部事件占掉号）。每条
  公开事件带一句英文 `summary`。
- **新增 `agent.activity`**：合并过的 agent 进度，不是工具调用。
  `{ activityId, kind, state, steps, stats }`，同一条活动随进展被节流着重复下发，
  所以客户端要按 `attempt:activityId` 合并——`activityId` 只在一次 attempt 内唯一
  （SDK 导出 `mergeActivities`）。
- **事件读取端点**：`GET /analyses/{id}/events`（分页）与
  `GET /analyses/{id}/events/stream`（SSE）。SSE 在分析进入终态后发 `event: end`
  并关闭，**渲染与交付的事件发生在终态之后，流里看不到它们**，要用分页回放。
  另有一个内部专用的全量读，不属于公开表面。
- **`GET /presentations` 新增 `displayId` 过滤**：省略 `scope` 时 `displayId` 蕴含
  `scope=display`（不带 `displayId` 时默认仍是 `generated`）；`displayId` 与
  `scope=generated` 同时出现 → `400 invalid_request`。
- **响应新增 `historyWindowStart`**：历史深度额度的下界，RFC3339 UTC 或 `null`。
  FREE 7 天、PRO 不限。同一条地板也落在 `POST /analyses` 上：`scope.since` 在
  **创建时**被抬到地板，`scope.since` 原样回显、`scope.sinceAt` 是实际窗口——
  裁剪，不是拒绝。
- **`Presentation` 新增 `title`**（接受计划时解析，回退链见
  `CHANGELOG.md` 的 0.2.0 一节）。
- **`no_compatible_display` 变成同步的 422**（见下面 §5.1 与 §8 的订正）。
- **切屏的 409 带机器码**：`POST /displays/{displayId}/current` 的
  `409 presentation_not_deliverable` 带 `details = { displayId, presentationId,
  reason }`，`reason ∈ targetless | not_delivered | other_display |
  not_rendered`。`advance` 不会产生这个 409。
- **`plan.rejected.data`** 是 `{ problems: <条数>, reason, attempt }`，
  `reason ∈ target | layout_mismatch | content_refs | schema | other`；问题原文
  只在内部，公开读只给条数。
- **§9「兼容旧 v0.1 SDK」整节作废。** `POST /contents/{contentId}/confirm` 已从
  路由里移除（请求落到 facade 的 404，不是 409、也不是 410）；SDK 专用的旧异步管线
  已下线，SDK 的 Analysis 与其他 Analysis 走同一条执行路径。

## 1. 目标

把"上传素材"和"进入 AI 处理"解耦，让同一条链路同时覆盖：

1. 只上传素材，不跑 agent（后端定时任务稍后统一处理）；
2. 指定一批素材跑一次 agent，只用本次素材；
3. 指定一批素材跑一次 agent，允许 agent 结合用户历史素材；
4. 不上传任何新素材，只让 agent 根据用户最近历史做一次总结；
5. 固定目标 Display、agent 自选 Display、或只生成 Scene/PNG 不下发；
6. 无 AI 的直出（原 hardcode）。

Portal、macOS/iOS、SDK 共用同一套业务服务，只在认证适配器上有差别。

## 2. 领域模型

```text
Content  ──►  Analysis  ──►  Presentation(s)  ──►  (Delivery / Display)
```

| 对象 | 职责 | 生命周期由谁推进 |
| --- | --- | --- |
| Content | 不可变的一次提交：title + assets。只关心素材是否到齐。 | 后端（S3 事件 / 惰性校验） |
| Analysis | 一次处理：读入设置 + `contentIds`，产出 `presentationIds`。原 ProcessingRun。 | 后端 worker |
| Presentation | 不可变的生成结果。和现有契约完全一致。 | 渲染 / 设备确认 |

Content 上**没有** `mode`、`requestedDisplayId`、`processing`、`output`。这些全部搬到 Analysis。

## 3. 认证与前缀

| 前缀 | 认证 | 消费者 |
| --- | --- | --- |
| `/api/sdk/v1` | PAT | `@inklethq/sdk`、服务端集成 |
| `/api/app/v1` | inklet 用户 access token | macOS / iOS / Portal |

两个前缀解析出同一个 `userId` principal，挂同一组 handler。下文路径省略前缀。

## 4. Content

### 4.1 创建

```http
POST /contents
Idempotency-Key: 8-128 个可见 ASCII 字符（必填）
```

```json
{
  "title": "周报",
  "assets": [
    { "type": "text", "text": "明早 9 点牙医" },
    { "type": "link", "url": "https://example.com/report" },
    { "type": "image", "filename": "photo.png", "contentType": "image/png", "sizeBytes": 204800 }
  ]
}
```

- `assets` 1–50 个；类型、大小、允许的 contentType 与 `BACKEND_CONTRACT.md` §6.2 相同。
- `title` 可选，是调用方给的标题，Analysis 生成的标题不会覆盖它。
- 响应 `201`，形状同现有：`{ "content": {...}, "uploadTickets": [...] }`。
- 幂等语义不变：同 key 同 body 返回原 Content 与票据；同 key 不同 body 返回 `409 idempotency_conflict`。

**兼容旧 SDK**：请求体带 `mode` 时保持 v0.1 行为（见 §9）。新 SDK 不再发送 `mode`。

### 4.2 上传与状态推进（不再有 confirm）

调用方把二进制素材直传到票据指向的存储，不带 Authorization。之后**不需要**再调用任何确认接口。

Content 状态：

| 状态 | 含义 |
| --- | --- |
| `pending` | 至少一个二进制素材尚未在存储中确认 |
| `ready` | 所有素材到齐；纯文本/链接的 Content 创建即 `ready` |
| `failed` | 素材损坏、类型不符或票据过期后仍未上传；`failure` 非空 |

后端通过两条路径把素材标记为已上传：

1. **S3 事件通知**（主路径）：对象创建事件 → 后端校验对象 → `assets[i].uploadState = uploaded`；全部到齐后 Content 变 `ready`。
2. **惰性校验**（兜底）：`POST /analyses` 引用了 `pending` 的 Content 时，后端同步对未确认的素材做 HeadObject。仍缺失的返回 `409 asset_not_uploaded`，`details.failedAssets` 列出 `{ contentId, assetIndex }`；调用方补传后重试同一个 Analysis 请求。

`POST /contents/{contentId}/upload-tickets` 保留，用于票据过期或上传失败后补票，语义不变。

### 4.3 响应形状

```json
{
  "id": "019...",
  "title": "周报",
  "state": "ready",
  "assets": [
    { "assetIndex": 0, "type": "text", "text": "…", "url": null, "filename": null,
      "contentType": null, "sizeBytes": null, "uploadState": "uploaded" }
  ],
  "failedAssetIndexes": [],
  "analysisIds": ["019..."],
  "presentationIds": ["019..."],
  "failure": null,
  "createdAt": "2026-09-13T10:00:00Z",
  "updatedAt": "2026-09-13T10:00:01Z"
}
```

- `analysisIds`：引用过这个 Content 的所有 Analysis，按创建时间升序。
- `presentationIds`：上述 Analysis 产生的 Presentation 并集，按创建时间升序。这是派生字段，不再有"最终"语义。
- `failedAssetIndexes`：`uploadState = failed` 的素材下标。

### 4.4 读取

```http
GET /contents/{contentId}
GET /contents?state=pending|ready|failed&cursor=&limit=
```

纯读，不触发校验以外的任何副作用。

## 5. Analysis

### 5.1 创建

```http
POST /analyses
Idempotency-Key: 必填
```

```json
{
  "mode": "ai",
  "contentIds": ["019..."],
  "context": "submitted",
  "scope": null,
  "intent": "做成提醒卡",
  "title": null,
  "target": null
}
```

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `mode` | `ai`（默认）/ `direct` | 是否调用模型。`direct` 即原 hardcode：零 LLM 调用。 |
| `contentIds` | UUID 数组，可为空 | 本次处理的触发素材。空数组表示"不带新素材，只看历史"。 |
| `context` | `submitted` / `history` | `submitted`：只用 `contentIds`；`history`：允许 agent 检索该用户历史 Content。`contentIds` 非空时默认 `submitted`，为空时默认且必须为 `history`。 |
| `scope` | `null` 或 `{ "since": "72h" }` | 仅 `context = history` 时有效。`since` 是相对时长，格式 `^\d+(m\|h\|d)$`，以 Analysis 创建时间为基准回溯。为 `null` 时由后端取默认窗口。 |
| `intent` | 字符串或 `null` | 调用方给 agent 的意图提示。 |
| `title` | 字符串或 `null` | 覆盖生成结果的标题。 |
| `target` | 见下 | 目标。`null` = agent 自选 Display。 |

`target` 三选一：

```json
{ "displayId": "019..." }
{ "displayIds": ["019...", "019..."] }
{ "output": { "formats": ["scene", "png"], "preset": "macos-widget-medium" } }
```

- `displayId` / `displayIds`：固定目标，后端必须同步校验归属；agent 不得替换或增删目标。
- `output`：targetless。语义、preset 注册表、viewport 规则同 `TARGETLESS_PRESENTATIONS_CONTRACT.md` §4。不产生 Delivery，不发 MQTT。
- `null`：agent 自选一台或多台兼容 Display。~~没有可用 Display 时 Analysis `failed`，`failure.code = no_compatible_display`。~~
  **订正（已实现）**：没有可用 Display 时不再收下再异步失败，而是当场
  `422 no_compatible_display`——在预留额度与落行之前，幂等键也会被释放，调用方绑
  完屏可以用同一个键重试。`target.output` 不受此限；显式点名的 `displayId` /
  `displayIds` 由归属校验用 404 / 403 / `display_incompatible` 回答。

校验规则：

- `mode = direct` 时：`contentIds` 恰好一个，且该 Content 恰好包含一个 PNG/JPEG 素材；`context` 必须为 `submitted`；`target` 必填且不能是 `null`。图片按现有 hardcode 行为拉伸到目标几何，零 AI 调用。
- `context = submitted` 且 `contentIds` 为空 → `400 invalid_request`。
- `scope` 出现在 `context = submitted` 的请求里 → `400 invalid_request`。
- `contentIds` 中任一 Content 不属于该用户 → `403 access_denied`；不存在 → `404 content_not_found`。
- `mode = ai` 需要 `ai_routing` 权益；`direct` 保持 Free 可用。

响应 `202`，返回完整 Analysis（见 §5.3）。

### 5.2 状态机与结果

```text
queued ──► running ──► completed (outcome = presentations | no_change)
                  └──► failed    (failure 非空)
```

- `completed` 且 `outcome = presentations`：`presentationIds` 为本次产生的全部 Presentation，已持久化。Presentation 本身可能仍在 `preparing`。
- `completed` 且 `outcome = no_change`：agent 判断没有值得展示的内容。`noChangeReason` 给出简短原因。**这是正常结果，不是失败**，不得表现为 `failed` 或永久 `running`。`context = submitted` 的请求原则上不应返回 `no_change`；若模型如此判断，后端仍以 `no_change` 返回，由调用方决定重试。
- `failed`：`failure` 为 `Problem{ code, message, stage, retryable, assetIndex }`，code 沿用现有异步错误码。

### 5.3 响应形状

```json
{
  "id": "019...",
  "mode": "ai",
  "trigger": "api",
  "state": "completed",
  "outcome": "presentations",
  "noChangeReason": null,
  "contentIds": ["019..."],
  "context": "submitted",
  "scope": null,
  "intent": "做成提醒卡",
  "title": null,
  "target": { "displayId": "019..." },
  "presentationIds": ["019..."],
  "failure": null,
  "createdAt": "2026-09-13T10:00:02Z",
  "updatedAt": "2026-09-13T10:00:20Z"
}
```

- `trigger`：`api`（调用方创建）或 `scheduled`（后端定时任务创建）。
- `target.output` 在响应里是**归一化后**的 output profile（含 `viewport` 与 `colorMode`），不是请求原文。

### 5.4 读取

```http
GET /analyses/{analysisId}
GET /analyses?contentId=&state=&trigger=&cursor=&limit=
```

纯读。列表按 `(createdAt, id)` 倒序，游标分页同现有约定。

### 5.5 定时触发

后端每日任务对每个满足条件的用户创建一条 Analysis：

```json
{ "mode": "ai", "trigger": "scheduled", "contentIds": [], "context": "history", "scope": { "since": "24h" }, "target": null }
```

它走与 API 创建完全相同的执行路径，调用方通过 `GET /analyses?trigger=scheduled` 可见。
是否开启、窗口大小、频率由后端配置，不在本契约内。

## 6. Presentation

不变。每个 Presentation 仍然带 `displayId`（或 `null`）、`contentIds`、`state`、`image` / `scene` /
`renditions`、`failure`、时间戳。`contentIds` 等于产生它的 Analysis 所引用的 Content 子集，由后端
决定顺序。

建议新增字段：`analysisId`（产生它的 Analysis）。SDK 按可空字段解析，缺失时为 `null`。

## 7. 幂等、配额、并发

- `POST /contents` 与 `POST /analyses` 各自要求 `Idempotency-Key`，作用域仍是 principal + method + route，
  因此同一个 key 可以同时用于一次 Content 创建和一次 Analysis 创建。
- 配额按 **Analysis** 计量：`POST /analyses` 且 `mode = ai` 时预留 AI 额度并在接受时结算；只上传 Content
  不扣任何 AI 额度。推送配额在 Presentation 产生 Delivery 时结算。
- 同一用户的 `context = history` Analysis 串行执行；运行期间新建的 Content 记为待处理，本轮完成后可被
  下一轮引用。
- Worker 至少一次投递下必须幂等：一条 Analysis 至多产生一组 Presentation。

## 8. 错误码

在 `BACKEND_CONTRACT.md` §9 之上新增：

| HTTP | code | 场景 |
| ---: | --- | --- |
| 404 | `analysis_not_found` | Analysis 不存在 |
| 409 | `asset_not_uploaded` | 引用的 Content 仍有未上传素材；`details.failedAssets` |
| 409 | `analysis_in_progress` | 同一用户已有一条 `history` Analysis 在跑，且后端选择拒绝而非排队 |

异步失败码（`Analysis.failure.code`）：`no_compatible_display`、`display_incompatible`、
`processing_unavailable`、`invalid_asset`、`internal_error`。

**订正（已实现）**：`no_compatible_display` 现在首先是 `POST /analyses` 的**同步
422**（见 §5.1）。另外实现里还有 `409 presentation_not_deliverable`
（`POST /displays/{displayId}/current`，带 `details.reason`）与
`400 invalid_request`（`Idempotency-Key` 缺失或不合法、`?detail=`、`displayId`
与 `scope=generated` 同时出现）；套餐类拒绝用的是 `plan_upgrade_required`（403）、
`payment_required`（402）与 `quota_exceeded`（429），不是本表设想的
`subscription_required`。

## 9. 兼容旧 v0.1 SDK（已作废）

> **本节整节没有实现。** `POST /contents/{contentId}/confirm` 已从路由里移除，
> 旧的 `mode` + confirm 链路不存在，`/api/raw-items/*` 的适配层也不在现行 SDK
> facade 里。保留原文只为说明当时的打算。

- `POST /contents` 带 `mode` 时：按旧语义创建 Content，并在 `POST /contents/{id}/confirm` 成功后自动创建一条
  `trigger = api` 的 Analysis（`mode` 映射：auto → `ai` + `target = null`；manual → `ai` + `{displayId}`；
  hardcode → `direct` + `{displayId}`；带 `output` → `ai` + `{output}`）。旧响应中的 `processing`、
  `presentationIds` 继续按 v0.1 形状填充。
- `POST /contents/{id}/confirm` 对新 SDK 创建的 Content（无 `mode`）返回 `409 invalid_state`。
- 旧 Portal 的 `/api/raw-items/*` 通过适配层映射到 Content + Analysis，不在本文档展开。

## 10. 持久化建议

- `sdk_contents` 去掉 `mode`、`requested_display_id`、`processing_*`、`output_profile` 的非空约束；
  新增 `title`。或新建 `contents` 表并做 ID 映射。
- 新增 `analyses`：`id`、`user_id`、`mode`、`trigger`、`state`、`outcome`、`no_change_reason`、`context`、
  `scope jsonb`、`intent`、`title`、`target jsonb`、`failure jsonb`、`run_id`、`attempt`、时间戳。
- 新增 `analysis_contents(analysis_id, content_id, position)`。
- `presentations` / `pushes` 增加可空 `analysis_id`。

## 11. 必须通过的测试

1. 只创建 Content 不创建 Analysis 时，不产生任何 worker 消息、Presentation、Push、MQTT，也不扣 AI 额度。
2. 纯文本 Content 创建即 `ready`；含图片的 Content 在 S3 事件到达后变 `ready`。
3. S3 事件丢失时，`POST /analyses` 的惰性校验仍能把素材标为 uploaded 并继续。
4. `contentIds = []` + `context = history` 能产生 Presentation 或明确的 `no_change`。
5. `context = submitted` 的 Analysis 不读取任何非 `contentIds` 的 Content。
6. `target.displayId` 绝不被替换；`target.output` 不产生 Delivery；`mode = direct` 零 LLM 调用。
7. 同 key 重放 `POST /analyses` 不创建第二条 Analysis；worker 重投不产生第二组 Presentation。
8. 旧 v0.1 SDK 的 `mode` + confirm 路径行为不变，且后台能看到它对应的 Analysis。
9. `/api/sdk/v1` 与 `/api/app/v1` 对同一请求返回等价 DTO。
