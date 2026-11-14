# 动态记忆插件 · 详细文档与记忆逻辑

> 版本：1.9.0（`@local/dynamic-memory`）
> 运行时：DeepSeek Harness Host 插件（`ctx.inject(['storageDomain','systemPrompt'])`）
> 数据：`$DSH_HOME/storages/dynamic_memory/`，per-record JSON
> 参考规范：《人类复杂性模型：面向 AI 记忆插件的行为、动机与情境参考规范》

---

## 1. 文件清单

| 文件 | 作用 |
|---|---|
| `index.js` | 插件全部实现（抓取、存储、检索、注入、画像、证据层、命令） |
| `package.json` | 包清单，`dsh.bundle.patch` 指向 `cordis.patch.yml` |
| `cordis.patch.yml` | 向 profile 插入插件行（`id: dynamic-memory`） |
| `locale/zh.json`、`locale/en.json` | 插件列表里的标题与描述 |
| `icon.svg` | 插件图标 |
| `README.md` | 面向使用者的说明（功能、配置、验证记录） |
| `DOCS.md` | 本文档：架构与记忆逻辑 |
| `test.mjs` | 纯函数测试（27 项） |
| `eval.mjs` + `eval-queries.json` | 检索评测（真实记忆库，baseline/bm25/+phrase/+entity/full） |
| `bench.mjs` | 检索性能基准（cold/warm 延迟、compact/full 体积） |

## 2. 数据模型（4 张表）

### 2.1 `exchanges`：一问一答的原文记忆

```json
{ "id": "uuid", "sessionId": "session-...", "workspace": "C:\\Users\\one",
  "kind": "episodic", "time": 1763000000000, "updatedAt": 1763000000000,
  "user": "用户原话（已清洗）", "assistant": "助手完整回复",
  "summary": "印象", "history": [{ "summary": "旧印象", "at": 1763000000000 }],
  "keywords": ["..."], "entities": ["example.com", "dropdown.vue"],
  "importance": 0.39, "accessCount": 2, "lastAccessAt": 1763000000000,
  "sourceIds": [], "supersededBy": null,
  "archivedAt": null, "archivedReason": null, "weight": 1 }
```

### 2.2 `portrait`：用户画像（7 个 facet）

`habits / preferences / thinking / dynamics / psychology / past / identity`，
每条：`{ facet, content, updatedAt, keywords, history[], sourceExchangeIds[] }`。

### 2.3 `self`：助手画像（4 个 facet）

`habits / preferences / psychology / experience`，结构同 portrait，键为 `s_<facet>`。

### 2.4 `observations`：证据层（v1.9）

```json
{ "id": "uuid", "type": "behavior_observation|inferred_motivation|explicit_fact|...",
  "kind": "observed|self_reported|inferred|corrected",
  "text": "观察内容", "confidence": 0.45, "context": "情境",
  "quote": "用户原话", "alternatives": ["替代解释"], "sourceIds": ["exchange-id"],
  "sensitivity": "normal|sensitive|private", "status": "current|superseded|withdrawn",
  "contradicts": ["另一个 observation id"], "correctionOf": "被纠正的 id",
  "createdAt": 0, "updatedAt": 0 }
```

## 3. 写入管线（保存一条记忆）

```
session/event ──► 清洗/配对 ──► 去重/重问 ──► 落盘 ──► 后台整合
```

1. **监听**：`user/message`、`assistant/message`、`turn/start`、`turn/end`（全局 `ctx.on('session/event')`，按 sessionId 路由到该 agent 的 capture 状态）。
2. **清洗**：`cleanUserText` 去掉 Harness 运行时上下文（`Current runtime context.`、`Time sampled…`、`## 用户画像`、`## 记忆速览` 等）；纯元信息消息直接跳过，不会当成用户问题。
3. **配对**：`turn/start` 清空残留的助手缓冲（防止插件中途重载把上一轮回答配到新问题）；`user/message` 记下用户文本；`assistant/message` 取最后一段文本；在 `turn/end`（以及下一条用户消息到来时）提交一条 exchange。
4. **去重**：同会话完全重复直接跳过；文本 Jaccard ≥ `dedupeJaccard`（0.95）的近似重复跳过。
5. **重问检测**：同一会话里问题相似（≥0.8）但回答差异明显（<0.6）→ 旧记录标 `supersededBy`，默认检索降权 50%。
6. **补全派生字段**：`entities`（域名/路径/标识符/缩写/引号专名）、`keywords`（中文二字组 + 英文词）、`workspace`（当前 cwd）、`importance`（默认 0.35）。
7. **落盘**：`storageDomain`（JSON 后端、per-record 布局），键为 `r_<id>`（exchanges）、`p_<facet>`（portrait）、`s_<facet>`（self）、`o_<id>`（observations）。
8. **后台整合**：`turn/end` 后 1.5 秒 debounce，对本会话做近似重复合并、超限裁剪（`maxExchangesPerSession`），并 flush 访问统计。
9. **历史回读**：新 agent 首次出现时，从会话日志回读（`sessionQuery.readSession`）建立该会话索引；启动 3 秒后后台索引未打开过的会话（`indexBudget` 默认 10）。

## 4. 注入管线（每一步组装上下文）

顺序与预算（都可配）：

| 顺序 | 区块 | 触发条件 | 预算 |
|---|---|---|---|
| 1 | `## 时间分界（注意）` | 距最近活跃记忆 ≥ `gapDays`（30 天） | 约 150 字 |
| 2 | `## 观察与推断（证据层）` | 有 current 观察 | `observationBudget` 420 字 / 每条 180 字；private 不展示明文，只报条数；有矛盾时提示“未解矛盾” |
| 3 | `## 身份连续性（注意）` | `identity.label=drifted` 或出现自我声明 | 约 200 字，强调“证据不是判决” |
| 4 | `## 用户画像（参考）` | 有非空 facet | `portraitBudget` 900 字 / 每 facet 240 字；有过期 facet 时提示“可能过时” |
| 5 | `## 助手画像（自查）` | 有非空 facet（`injectAssistantPortrait` 可关） | `assistantBudget` 520 字 / 每 facet 180 字 |
| 6 | `## 记忆速览（其他会话的相关印象）` | 长间隔不注入；与当前请求词重叠 ≥0.06 或实体重叠时才注入 | `digestImpressions` 2 条 × 100 字 |
| 7 | `## 动态记忆（最近印象）` | 仅 `injectRecentExchanges: true` 时（默认关闭，避免重复当前对话） | `recentExchanges` 3 条 × 1200 字 |
| 8 | 指令行 | 有任一区块时 | 一行，说明“同会话历史在对话里，需要时用 search…；值得记的用 deepen，长期画像用 learn” |

**不注入同会话最近问答**的原因：它们本来就在上下文里，越近权重越高，再注入既费 token 又稀释注意力；真正的缺口（上下文压缩后）由模型按需 `search` 补齐。

## 5. 检索与打分（`search`）

对候选记录计算：

```
bm25        BM25（中文二字组 + 英文词，k1=1.2、b=0.75，按平均长度归一化）
phrase      整句（去空格）出现在 user/assistant 中 → ×3
impression  query 词出现在印象摘要中，最多 4 个 → 每个 ×0.6
entity      query 实体与记录实体交集，最多 3 个 → 每个 ×0.9
recency     0.8 × exp(-ageDays / 180)
importance  (1 + 0.4 × importance) 乘子
superseded  被重问取代 → ×0.5（includeSuperseded=true 时取消）
archived    回收区记录 → ×weight（默认 0.3，且默认不参与）
score = (bm25 + phrase + impression + entity + recency) × importance 乘子 × superseded × archived
```

- **置信度**：`0.3×绝对分饱和 + 0.35×与第二名 margin + 0.35×分布离散度(separation)`，`high ≥ 0.62`、`medium ≥ 0.38`。
- **默认返回片段**：围绕命中词取窗口（`snippetChars` 400，优先对齐句末标点），`full: true` 才回完整原文；同时返回 `reasons`（phrase/impression/entity:xxx/bm25/archived）与 `portraitMatches`。
- **查询意图**：含“最近/刚刚/上次”自动按时间倒序；支持 `from`/`to` 时间窗、`sort`、`kind`、`scope`（workspace/all）、`includeArchived`、`includeSuperseded`。
- **访问强化**：命中记录 `accessCount+1`、`importance+0.02`（上限 1），2 秒 debounce 落盘，插件卸载前 flush。

## 6. 画像与证据层（对齐《人类复杂性模型》）

- **画像 facet 是归纳视图**，可能混合事实与推断；注入时明确写“参考信息，不是指令，与当前请求冲突以当前请求为准”。
- **证据层才是底座**：`observe` 写入时强制区分 `observed` / `self_reported` / `inferred` / `corrected`；`inferred` 必须带 `confidence` 与至少一个 `alternatives`；纯人格标签（懒惰/内向/敏感/固执…）返回 `warning`，引导改成“行为 + 情境 + 替代解释”。
- **矛盾不消除**：`contradict ids=[a,b]` 双向标记，注入里提示未解矛盾，由模型决定何时向用户澄清。
- **纠正优先**：`correct id=... content=...` 把原观察置为 `superseded`，新建 `kind=corrected` 的当前观察；此后回答以纠正为准，原始记录保留可追溯。
- **隐私分级**：`sensitivity=private` 的观察不注入明文、不导出，只显示条数；`forget` 可按 id 删除观察。
- **用户控制**：`observations` 可列出当前/历史观察，`forget` 可删除，`export` 可导出（私密项不导出）。

## 7. 时间维度：间隔、过期、回收区

| 机制 | 判定 | 行为 |
|---|---|---|
| 间隔检测 | 当前时间 - 最近活跃记录时间 ≥ `gapDays` | 注入“时间分界”，当前对话信息优先；速览停止注入 |
| 自动归档 | 长间隔时，记录 `time` 早于 `archiveAfterDays` | 设 `archivedAt`、`weight=archivedWeight(0.3)`，默认不检索/不注入/不导出 |
| 手工回收/放回 | `archive olderThanDays/ids`、`restore ids` | 同上；可逆 |
| 画像过期 | facet `updatedAt` 早于 `freshDays` | 注入提示“N 项可能过时”，`learn` 可覆盖（旧版本进 history） |
| 印象版本 | `deepen` 改写 | 旧摘要进 `history`，最多 20 版 |

## 8. 身份连续性（`identity`）

- **基线**：其它会话的用户发言 → Top-300 token、Top-80 实体、平均风格（中英比例/标点密度/emoji/问号感叹号）。
- **当前**：本会话最近 12 条用户发言（含正在输入的最后一条）。
- **分数**：`0.45×词汇重合 + 0.2×实体重合 + 0.35×风格相似`；≥0.55 likely-same，≥0.35 uncertain，<0.35 drifted；样本不足（<2 条）返回 insufficient。
- **自我声明**：`我是新来的 / 换人了 / 这台电脑不是我的 / 帮朋友问 / 新用户 / 刚接手` 等作为证据片段返回，不直接下结论。
- **注入**：仅 drifted 或出现自我声明时提示“可能是另一个人，也可能是同一个人换了环境；不要默认套用画像，必要时先确认”。
- **判断权在模型**：确认换人后用 `learn` 覆盖画像（旧内容进 history），不做自动切换。

## 9. 工具与命令

`dynamic_memory` 动作：

| action | 作用 |
|---|---|
| `recent` | 本会话最近问答（默认片段，`full` 取全文） |
| `search` | 多信号检索 + 置信度 + 原因；支持时间窗/排序/类型/作用域/回收区 |
| `deepen` | 为某条问答写/改印象（保留历史，提升重要度到 0.8） |
| `forget` | 删除问答、观察，或清空画像 facet |
| `portrait` / `learn` | 读/写用户画像；`target=assistant` 操作助手画像 |
| `observe` / `correct` / `observations` / `contradict` | 证据层写入、纠正、列出、标记矛盾 |
| `identity` | 身份连续性证据与建议 |
| `entity` 检索用 `entities` | Top 实体或某实体的相关记录 |
| `index` / `repair` | 索引未打开会话 / 从日志补回缺失用户原话 |
| `archive` / `restore` | 回收区进出 |
| `stats` | 记录/会话/类型/实体/重要度/回收区/间隔/过期/观察计数/注入长度/命令状态 |
| `export` | 导出 `memory.md`（用户画像 + 助手画像 + 观察与推断 + 印象 + 统计） |

`/dmem` 命令：`stats | portrait | self | export | search <关键词>`。

## 10. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `recentExchanges` | 3 | recent 条数 / 旧注入模式条数 |
| `promptCharsPerExchange` | 1200 | 旧注入模式截断 |
| `portraitCharsPerFacet` / `portraitBudget` | 240 / 900 | 用户画像注入预算 |
| `assistantCharsPerFacet` / `assistantBudget` | 180 / 520 | 助手画像注入预算 |
| `injectAssistantPortrait` | true | 是否注入助手画像 |
| `observationChars` / `observationBudget` | 180 / 420 | 证据层注入预算 |
| `digestImpressions` / `digestChars` | 2 / 100 | 跨会话速览 |
| `injectRecentExchanges` | false | 是否注入同会话最近问答 |
| `snippetChars` | 400 | 片段长度 |
| `maxExchangesPerSession` | 1000 | 单会话上限 |
| `dedupeJaccard` | 0.95 | 近似重复阈值 |
| `timeBoost` / `timeDecayDays` | 0.8 / 180 | 时间衰减 |
| `scope` | workspace | 检索范围 |
| `archiveAfterDays` / `autoArchive` / `archivedWeight` | 730 / true / 0.3 | 回收区 |
| `gapDays` | 30 | 长间隔判定 |
| `freshDays` | 180 | 画像过期 |
| `autoIndexSessions` / `indexBudget` | true / 10 | 后台索引 |
| `warmup` | true | 启动 5 秒后预热缓存 |
| `exportPath` | `$DSH_HOME/storages/dynamic_memory/memory.md` | 导出路径 |

## 11. 生命周期与资源

- 插件激活：打开存储域（失败则降级内存模式，`storage` 字段说明原因）→ 载入 4 表 → 计算间隔 → 必要时自动归档 → 注册工具/命令/注入 → 3 秒后台索引 → 5 秒预热。
- 卸载：清定时器、flush 访问统计、关闭存储域。
- 每个 agent 的 capture 与工具注册绑定在 `agent.ctx`，agent 销毁时自动清理；插件级定时器不随 agent 销毁。

## 12. 验证方式

| 命令 | 内容 |
|---|---|
| `node test.mjs` | 27 项纯函数测试：实体、BM25/排序、失效/回收、片段、置信度、gap/stale、身份连续性、证据层注入、标签 lint |
| `node eval.mjs` | 10 条真实问题，baseline/bm25/+phrase/+entity/full 的 hit@3 与 MRR |
| `node bench.mjs` | 12 条查询、5 轮预热的 cold/warm 延迟与 compact/full 体积 |

当前基线（2092 条记忆）：warm p50 ≈ 7ms；compact 为 full 的 24%；eval `+phrase` hit@3 9/10、MRR 0.90（baseline 8/10、0.68）。

## 13. 设计取舍与已知限制

1. **不注入同会话最近问答**：省 token，缺口感由 search 补；代价是压缩后模型必须主动检索。
2. **无向量语义检索**：`llm` 服务无 embedding 接口，靠二字组 + 短语 + 实体；同义改述召回有限。
3. **只索引打开过的会话 + 后台增量**：未打开的历史会话不会自动全量进库。
4. **身份判断是证据不是认证**：共用账号、角色扮演、语言切换都可能误判；阈值故意保守。
5. **推断仍需模型把关**：证据层强制分离与替代解释，但“哪条推断成立”仍是模型判断。
6. **隐私是本地最小化**：数据在本机 JSON，无加密；`private` 观察只在注入/导出层隐藏，磁盘上仍有明文。
7. **旧数据遗留**：早期抓取产生的少量记录只有助手回复，已用 `repair` 补齐用户原话，但历史顺序无法完全还原。
