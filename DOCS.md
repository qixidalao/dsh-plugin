# 动态记忆插件 · 详细文档与记忆逻辑

> 版本：2.5.2（`@local/dynamic-memory`）
> 运行时：DeepSeek Harness Host 插件（`ctx.inject(['storageDomain','systemPrompt'])`）
> 数据：`$DSH_HOME/storages/dynamic_memory/`，per-record JSON
> 参考规范：《人类复杂性模型：面向 AI 记忆插件的行为、动机与情境参考规范》

**状态标记**（全文统一使用，避免把规划写成现状）：

| 标记 | 含义 |
|---|---|
| ✅ 已实现 | 代码中存在且有测试覆盖 |
| ⚠️ 已实现·有已知缺陷 | 已实现，但评审中复现了问题，见第 13 章 |
| 📐 规范·未实现 | 第 14 章的设计规范，尚无代码 |

---

## 0. 设计原则：像人的记忆，不是长得像人

### 0.1 判据

“像人”有两种完全不同的含义：

- **长得像人**：拟人口吻（“我记得你说过…”）、情感表演、人设、给助手编一段“心理与经历”。这些是表层，不改变系统能做什么，还会让用户高估系统的可靠性。
- **像人的记忆**：复制人类记忆**起作用的机制**——线索提取、重构、巩固、适应性遗忘、来源监控、联想。判据是**机制与失败模式**，不是语气。

本插件只追求后者。一条设计是否成立，问三个问题：

1. 它对应人类记忆的哪一个功能机制？
2. 去掉所有拟人措辞后，它还有用吗？
3. 它在出错时（过时、误归因、过度泛化）会怎样失败，用户能发现并纠正吗？

本插件的总取舍：**记忆越丰富，认知越审慎**——记住更多不等于更懂人；证据不足时宁可说“不确定”，也不用流畅的叙述掩盖猜测。

### 0.2 刻意不学的部分

人类记忆有一些**缺陷**，不应复制：

| 人类缺陷 | 后果 | 本插件的对策 |
|---|---|---|
| 虚构（confabulation） | 把推断当成记得的事实 | 证据层强制区分 `observed / self_reported / inferred / corrected` |
| 来源遗忘 | 记得内容，忘了从哪来 | 每条观察带 `sourceIds`、`quote`；画像带 `sourceObservationIds` |
| 反复回忆导致失真 | 每次重构都漂移一点 | 原始 `exchanges` 不可变；画像只是可重算的视图 |
| 对近期信息过度加权 | 一句气话盖过长期事实 | 推断必须带 `alternatives` 与 `confidence`；纠正才有最高优先级 |

结论：**要有人类记忆的功能，但比人更诚实**——保留可审计的证据链，让“重构”可以被检查。

### 0.3 机制对照表

| # | 人类记忆机制 | 功能 | 本插件对应 | 状态 | 差距 |
|---|---|---|---|---|---|
| 1 | 线索依赖提取 | 记忆靠线索唤起，不是翻全档案 | `search`：BM25 + 短语 + 实体 + 时间意图；`maxPossible` 归一与 coverage | ✅ | 无向量语义；同义改述召回有限 |
| 2 | 注意与工作记忆容量 | 同时只能装下少量相关内容 | 注入预算 + 常驻/线索分层 | ✅ | 线索判定是词/实体启发式 |
| 3 | 内隐（程序性）vs 外显（情景）记忆 | 偏好与风格每次都起作用但不被“想起”；事件需要线索才浮现 | 画像 facet、观察、exchanges | 📐 | 未区分：`preferences/habits` 应常驻，事件类才需线索 |
| 4 | 重构而非回放 | 回忆是用证据重新构建 | portrait = 证据的归纳视图，`needsRecompute` | ⚠️ | 只打标记，不自动重算；句子级溯源缺失 |
| 5 | 来源监控 | 区分“看到的 / 听说的 / 推出来的” | `kind`、`sourceIds`、标签 lint | ✅ | 无 |
| 6 | 遗忘（衰减） | 不用的降优先级，腾出容量 | importance 衰减、观察 TTL、间隔检测、回收区 | ✅ | TTL 只停止注入；无真正删除 |
| 7 | 巩固 | 零散片段沉淀为模式与图式 | 后台整合：仅近似去重与裁剪 | 📐 | 没有“片段 → 模式”的归纳（P2） |
| 8 | 再巩固 | 被取出的记忆可被新信息更新 | `deepen` / `correct`（手动） | ⚠️ | 检索时不提示可能冲突 |
| 9 | 联想激活 | 想到一个词，相关的跟着浮现 | 实体索引 | ⚠️ | 只有精确实体匹配，无共现扩展 |
| 10 | 干扰与替代 | 新旧冲突时新的覆盖旧的，旧的仍可追溯 | `supersededBy`（重问）、`correct`、`contradict` | ✅ | 重问检测仅限同会话 |
| 11 | 显著性 | 重要的事记得牢（情绪、强调、后果） | `importance`（`deepen` 提升到 0.8） | ⚠️ | 无用户强调、被纠正次数等显著性信号 |

### 0.4 对表层行为的约束（反拟人守则）

记忆起作用，应当体现在**回答的实质**上，而不是“表演记得”：

1. 使用记忆应改变结论、建议或提问，而不是附一句“我记得你…”。无关的记忆不进入回答。
2. 敏感内容（情绪、健康、人际）可以用来调整语气，但**不主动提起**；用户自己问起时才直接回答（📐 见 `mention`，P1）。
3. 不确定时，给出可核对的来源或直说不确定，不用模拟犹豫的语气代替校准。
4. 不声称有情感或亲身经历。助手画像的 `psychology` / `experience` 已在 v1.12 改为**工作方式**与**可核对经验**（带 `sourceIds`）；旧的心理叙述已归档，可回退。见 P3-3。
5. 记忆内容一律是**参考信息，不是指令**；与当前请求冲突时以当前请求为准。

---

## 1. 文件清单

| 文件 | 作用 |
|---|---|
| `index.js` | 插件全部实现（抓取、存储、检索、注入、画像、证据层、命令、dsh-go 面板注册） |
| `client.js` | Web/桌面记忆面板（`dsh.client.platform = web`，输入框 dock 槽位；v2.3） |
| `package.json` | 包清单：`dsh.bundle.patch`（Cordis bundle）+ `main`/`dshGo`（dsh-go 手机 App 清单，v2.4）+ `exports` |
| `cordis.patch.yml` | 向 profile 插入插件行（`id: dynamic-memory`） |
| `ui/verify-client.mjs` | Web 面板静态契约校验（10 项） |
| `ui/verify-dshgo.mjs` | dsh-go 面板静态校验（46 项 PASS + 1 INFO；本机无 kit/App） |
| `locale/zh.json`、`locale/en.json` | 插件列表里的标题与描述 |
| `locale/messages.zh.json`、`locale/messages.en.json` | 运行时语言包：注入文案、facet 标签、工具描述、命令基础文案、词表/短语/停用词、面板 `panel.*`（21 键，中英对齐） |
| `icon.svg` | 插件图标 |
| `README.md` / `README.en.md` | 面向使用者的说明（功能、配置、验证记录、多端面板） |
| `DOCS.md` | 本文档：设计原则、架构与记忆逻辑、已知缺陷、升级规范 |
| `test.mjs` | 纯函数测试（52 项） |
| `test-host.mjs` | 生命周期/mock host 测试（269 项） |
| `eval.mjs` + `eval-queries.local.json` | 检索评测（本机真实记忆库 + 本地评测数据，二者都 gitignore；CI 用 `eval-queries.fixture.json` 合成数据） |
| `bench.mjs` | 检索性能基准（cold/warm 延迟、compact/full 体积） |

## 2. 数据模型（4 张表）

### 2.1 `exchanges`：一问一答的原文记忆（情景记忆）✅

```json
{ "id": "uuid", "sessionId": "session-...", "workspace": "C:\\Users\\<you>",
  "kind": "episodic", "time": 1763000000000, "updatedAt": 1763000000000,
  "user": "用户原话（已清洗）", "assistant": "助手完整回复",
  "summary": "印象", "history": [{ "summary": "旧印象", "at": 1763000000000 }],
  "keywords": ["..."], "entities": ["example.com", "example-app"],
  "importance": 0.39, "accessCount": 2, "lastAccessAt": 1763000000000,
  "sourceIds": [], "supersededBy": null,
  "archivedAt": null, "archivedReason": null, "weight": 1 }
```

`kind` 取值 `episodic / semantic / procedural`。原文不可变；只有 `summary`（印象）可被 `deepen` 改写，旧版本进 `history`。

### 2.2 `portrait`：用户画像（7 个 facet，重构视图）✅

`habits / preferences / thinking / dynamics / psychology / past / identity`。

```json
{ "facet": "preferences", "content": "归纳文本", "updatedAt": 0, "keywords": [],
  "history": [], "sourceExchangeIds": [], "sourceObservationIds": [], "needsRecompute": false }
```

画像是**归纳视图**，不是事实来源；真正的底座是 2.4 的观察。

### 2.3 `self`：助手画像（4 个 facet）✅

`habits / preferences / psychology / experience`，结构同 portrait，键为 `s_<facet>`。v1.12 起 `psychology` 显示为**工作方式**、`experience` 显示为**可核对经验**（**facet 键名为了兼容没有改**，排查时注意键与显示标签的差异）：内容只保留“在本用户这里验证过的做法 / 做过什么、踩过什么坑”，并要求带 `sourceIds`；“助手喜好”只放助手侧的产出约定，不再重复用户偏好（中文/结论先行等留在用户画像里，避免两边各自漂移）。改造前的旧画像已导出到 `$DSH_HOME/storages/dynamic_memory/archive/assistant-and-user-portrait-v1.11.md`，facet 的 `history` 也保留旧版本，可用 `portrait target=assistant includeHistory=true` 回退。

### 2.4 `observations`：证据层 ✅

```json
{ "id": "uuid",
  "type": "explicit_fact|explicit_preference|behavior_observation|self_reflection|inferred_motivation|emotional_state|decision_record|relationship_context|habit_pattern|contradiction|goal|constraint|correction",
  "kind": "observed|self_reported|inferred|corrected",
  "text": "观察内容", "confidence": 0.45, "context": "情境",
  "quote": "用户原话", "alternatives": ["替代解释"], "sourceIds": ["exchange-id"],
  "sessions": ["session-id"],
  "lastCorroboratedAt": 0,
  "scope": "transient|situational|durable",
  "sensitivity": "normal|sensitive|private", "status": "current|superseded|withdrawn",
  "contradicts": ["另一个 observation id"], "conditionalContradicts": ["情境相关的另一条"],
  "correctionOf": "被纠正的 id", "supersededBy": "纠正记录 id",
  "createdAt": 0, "updatedAt": 0 }
```

约束：`inferred` 必须带 `confidence` 与至少一个 `alternatives`；`confidence` 只对 `inferred` 有意义。**时间属性（v1.12）**：`scope` 在读取时按 `type` 派生（旧数据不回写）：`emotional_state → transient`，`goal/decision_record/relationship_context/behavior_observation/inferred_motivation → situational`，其余 `durable`；TTL 只在注入层生效——到期**停止注入**，但记录保留、`observations` 仍可查、`reflect` 也能读。TTL 与推断衰减的锚点是 **`lastCorroboratedAt`**（v1.12.2），只有创建和独立会话印证会更新它。`sessions` 记录独立印证过的会话；独立印证必须通过 `observe corroborates=<id> quote=<当前用户消息里的原文>` 提供**可校验引文**，否则拒绝（防止模型看到自己的推断后自我强化）。引文先在本会话已提交的用户消息里查，找不到时回退到会话日志（`sessionQuery.readSession`）再校验。`inferred` 的有效置信度按锚点起算的半衰期衰减，并按不同会话数给有上限的增强。

## 3. 写入管线（保存一条记忆）✅

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
8. **后台整合**：`turn/end` 后 1.5 秒 debounce，对本会话做近似重复合并、超限裁剪（`maxExchangesPerSession`），并 flush 访问统计。**这一步只做去重与裁剪，不做“片段 → 模式”的归纳**（对照 0.3 第 7 行）。
9. **历史回读**：新 agent 首次出现时，从会话日志回读（`sessionQuery.readSession`）建立该会话索引；启动 3 秒后后台索引未打开过的会话（`indexBudget` 默认 10）。

## 4. 注入管线（每一步组装上下文）✅

顺序与预算（都可配）：

| 顺序 | 区块 | 触发条件 | 预算 |
|---|---|---|---|
| 1 | `## 时间分界（注意）` | 距最近活跃记忆 ≥ `gapDays`（30 天） | 约 150 字 |
| 2 | `## 观察与推断（证据层）` | 有 current 观察 | `observationBudget` 420 字 / 每条 180 字 / 最多 6 条；见 4.1 |
| 3 | `## 身份连续性（注意）` | `identity.label=drifted` 或出现自我声明 | 约 200 字，强调“证据不是判决” |
| 4 | `## 用户画像（参考）` | 有非空 facet，且通过 4.2 门控 | `portraitBudget` 900 字 / 每 facet 240 字；有过期 facet 时提示“可能过时”；`needsRecompute` 的 facet 追加“（来源有变更，待重算）” |
| 5 | `## 助手画像（自查）` | 有非空 facet（`injectAssistantPortrait` 可关） | `assistantBudget` 520 字 / 每 facet 180 字 |
| 6 | `## 记忆速览（其他会话的相关印象）` | 长间隔不注入；与当前请求词重叠 ≥0.06 或实体重叠时才注入 | `digestImpressions` 2 条 × 100 字 |
| 7 | `## 动态记忆（最近印象）` | 仅 `injectRecentExchanges: true` 时（默认关闭，避免重复当前对话） | `recentExchanges` 3 条 × 1200 字 |
| 8 | 指令行 | 有任一区块时 | 一行，说明“同会话历史在对话里，需要时用 search…；值得记的用 deepen，长期画像用 learn” |

**不注入同会话最近问答**的原因：它们本来就在上下文里，越近权重越高，再注入既费 token 又稀释注意力；真正的缺口（上下文压缩后）由模型按需 `search` 补齐。

### 4.1 注入分层：常驻层与线索层（v1.11，P0-1）

- **常驻层（内隐记忆，不做话题门控，只受预算限制）**：
  - 画像 facet：`preferences / habits / thinking / identity`；
  - 观察：`type ∈ {explicit_preference, habit_pattern, constraint, correction}`、所有 `kind=corrected`、以及非敏感且非 `emotional_state/relationship_context` 的 `kind=self_reported`。
  - 效果：用户只发“继续”时，偏好与习惯仍在上下文里。
- **线索层（外显记忆，需要线索）**：画像 facet `past / dynamics / psychology`；其余观察类型（含 `emotional_state`、`inferred_motivation`）。
- **线索判定**（`hasCue`）：
  - 停用词：在用户消息 + 观察中**文档频率 > 30%** 的 token 自动忽略；
  - 与用户最新消息共享 **≥2 个**不同的非停用词，或共享 **≥1 个实体**，才算有线索；
  - 用户消息很短（汉字 <6 且无实体）时，线索层整体不注入，常驻层照常。
- 排序仍是 `corrected → self_reported → observed → inferred`，常驻项整体排在前面；`sensitive` 带“敏感·”前缀；`private` 不展示明文只报条数；未解矛盾只统计双方都 current 的对数，且**在渲染前完整遍历统计**（K5 已修）。
- **时间（v1.12）**：按 `scope` 派生的 TTL 到期后不再注入，提示“N 条观察已过期，停止注入但保留可查”；TTL 锚点是 `lastCorroboratedAt`，**无关编辑不续期**，只有带可校验 `quote` 的独立会话印证会续期并给有上限的置信度增强；`inferred` 的显示置信度从同一锚点起算 `0.5^(ageDays/半衰期)` 衰减。
- 门控提示文字：`（N 条线索不足，未展示）`；画像门控不提示条数，只由 `stats.facetsNeedingRecompute` 兜底。

## 5. 检索与打分（`search`）✅

对候选记录计算：

```
bm25n       2.5 × bm25 / maxPossible
            maxPossible = Σ idf(term) × 2.2（每个查询词的饱和上界）
            这样“只命中一个常见词”的候选不会拿到满额（K2 已修）
coverage    IDF 加权覆盖率 = (命中的词 idf 之和 + 命中实体数 × 平均 idf) / 总 idf
            常见二字组（“所有/练习”）权重天然很低
phrase      整句（去空格）出现在 user/assistant 中 → ×3
impression  query 词出现在印象摘要中，最多 4 个 → 每个 ×0.05（仅作 tie-breaker）
entity      query 实体与记录实体交集，最多 3 个 → 每个 ×0.9
recency     0.4 × exp(-ageDays / 180) × intent         （时间意图 1.0，否则 0.3）
importance  (1 + 0.4 × effectiveImportance) 乘子；effective = stored × exp(-idleDays / 360)
superseded  被重问取代 → ×0.5（includeSuperseded=true 时取消）
archived    回收区记录 → ×weight（默认 0.3，且默认不参与）
score = (bm25n + phrase + impression + entity + recency) × importance 乘子 × superseded × archived
```

- `idleDays` 取 `lastAccessAt / updatedAt / time` 中最晚者，所以**检索会刷新新鲜度**（有界的间接强化）；但检索本身不再抬高 `importance`。
- **时间意图**：查询含“最近/刚刚/上次/当时/以前/去年/上周/上个月/那天/之前/过去”或出现 `YYYY-`、`YYYY/`、`YYYY年` 形式的年份时为 1.0。含“最近/刚刚/刚才/上次/latest/recent/last time”时默认按时间倒序。
- **置信度**（`confidenceFromScores(scores, coverage)`）：`blended = 0.3×绝对分饱和 + 0.35×margin + 0.35×离散度`；先乘覆盖率因子 `min(1, coverage/0.6)`，并且**只有 coverage ≥ 0.5 才可能给出 high/medium**，否则一律 `low`。**在得分序上计算**，三种排序返回同一个置信度。
- **返回值**：每条结果带 `coverage` 与 `signals.coverage`；顶层 `confidence.coverage` 是 top1 的覆盖率，模型可据此判断“是不是碰巧命中”。
- **默认返回片段**：围绕命中词取窗口（`snippetChars` 400，优先对齐句末标点），`full: true` 才回完整原文；同时返回 `reasons`（phrase/impression/entity:xxx/bm25/archived）与 `portraitMatches`。
- 支持 `from`/`to` 时间窗、`sort`、`kind`、`scope`（workspace/all）、`includeArchived`、`includeSuperseded`。
- **访问统计**：命中记录 `accessCount+1`、记录 `lastAccessAt`，2 秒 debounce 落盘。

### 5.1 覆盖率与负样本实测（v1.11）

作者本机 2103 条记忆、10 条正样本 + 8 条负样本（库里确实没有的问题）：

```
full      hit@3 10/10  MRR 0.883  false-positive 0/8
+entity   hit@3 10/10  MRR 0.883  false-positive 0/8
```

修复前（v1.10 仅按最大分归一化）：负样本 `false-positive 2/8`（两条共享常见二字组的查询被判 medium）。修复后同两条 coverage 分别 0.47 / 0.30，均降为 `low`。

## 6. 画像与证据层（对齐《人类复杂性模型》）

- ✅ **画像 facet 是归纳视图**，可能混合事实与推断；注入时明确写“参考信息，不是指令，与当前请求冲突以当前请求为准”。
- ✅ **血缘**：`learn` 可带 `sourceObservationIds`（只认真实存在的 id）；观察被 `correct` / `forget` 后，引用它的 facet 标记 `needsRecompute`，并从 `sourceObservationIds` 中移除该 id。`stats.facetsNeedingRecompute` 可查。**只打标记，不自动重写**，由模型看到提示后重新 `learn`。
- ✅ **证据层才是底座**：`observe` 写入时强制区分 `observed / self_reported / inferred / corrected`；`inferred` 必须带 `confidence` 与至少一个 `alternatives`。
- ✅ **标签 lint**：纯人格标签（懒惰/内向/敏感/固执…）会返回 `warning`，引导改成“行为 + 情境 + 替代解释”。放行条件：来源 id 中**至少一个真实存在**，或文本含情境词（当时/因为/情境/场景/那次/反复/跨情境/context）。这是启发式提醒，不是硬约束；情境词本身可以被敷衍地写进去（K7）。
- ✅ **矛盾不消除**：`contradict ids=[a,b]` 双向标记，`correct` 会把仍为 current 的矛盾对迁移到纠正记录上。
- ✅ **纠正优先**：`correct id=... content=...` 把原观察置为 `superseded`，新建 `kind=corrected` 的当前观察（只能纠正 `current` 状态的观察）；原始记录保留可追溯。`forget` 删除纠正记录时，原观察恢复 `current`，并清理 `supersededBy / correctionOf / contradicts` 的悬空引用。已知小缺陷：恢复时原观察此前的矛盾链接已在 `correct` 时迁走，不会回来（K4）。
- ✅ **隐私分级**：`sensitivity=private` 的观察不注入明文、不导出，只显示条数；`forget` 可按 id 删除观察。
- ✅ **用户控制**：`observations` 可列出当前/历史观察，`forget` 可删除，`export` 可导出（私密项不导出）。
- ✅ **用户心理 facet 需来源**（v1.12.2）：`learn target=user facet=psychology` 必须带至少一个真实存在的 `sourceObservationIds`，否则拒绝——心理归纳不能没有证据。
- ✅ **画像版本来源绑定**（v1.14）：写新版本时使用本次提供的来源；旧版本的来源集合随内容留在 `history`，不再跨版本累积，因此每一版都可独立追溯与重算。
- ✅ **披露策略 `mention`**（v1.14）：`proactive / if_asked / never`；默认由 `sensitivity + scope + type` 派生（私密 → never；敏感/短暂/情绪/关系 → if_asked）。`if_asked` 注入带“仅语气，不主动提”；`never` 不进入上下文但可在 `observations` 查看。
- ✅ **巩固与重算**（v1.14）：`reflect` 只对 **≥3 个不同会话** 出现的相似观察生成 `status: proposed` 草稿（不注入），`review decision=accept|reject` 决定 current/withdrawn；`recompute facet=...` 返回存活来源、失效来源 id 与上一版内容；`duplicates` 报告画像与观察的跨层重复（只报告，不删除）。
- 📐 **评测集**：真实评测数据只在本地（`eval-queries.local.json` / `eval-drafts.local.md`，gitignore）；仓库里只有合成的 `eval-queries.fixture.json` 供 CI 用。P3-1 的 20 条草稿在本地，待评审改写、grep 复核负样本后拆分 dev/test 并冻结。

## 7. 时间维度：间隔、过期、回收区 ✅

| 机制 | 判定 | 行为 |
|---|---|---|
| 间隔检测 | 当前时间 - 最近活跃记录时间 ≥ `gapDays` | 注入“时间分界”，当前对话信息优先；速览停止注入 |
| 自动归档 | 长间隔时，记录 `time` 早于 `archiveAfterDays` | 设 `archivedAt`、`weight=archivedWeight(0.3)`，默认不检索/不注入/不导出 |
| 手工回收/放回 | `archive olderThanDays/ids`、`restore ids` | 同上；可逆 |
| 画像过期 | facet `updatedAt` 早于 `freshDays` | 注入提示“N 项可能过时”，`learn` 可覆盖（旧版本进 history） |
| 印象版本 | `deepen` 改写 | 旧摘要进 `history`，最多 20 版 |
| importance 衰减 | 闲置时间 | 参与打分的 `effectiveImportance = stored × exp(-idleDays/360)`，不改写存储值 |
| 观察 TTL（v1.12） | `scope` 派生的 TTL（transient 3 天 / situational 30 天），锚点是 `lastCorroboratedAt` | **停止注入**，不删除；`observations` 仍可查、`export` 仍导出**（v1.12.1：无关编辑不再续期，只有独立会话印证会）** |
| 推断置信度衰减（v1.12） | 观察创建时间 | `effectiveConfidence = confidence × 0.5^(ageDays/90)` + 独立会话增强（每多 1 个会话 +0.1，上限 +0.2） |

对应人类记忆的“适应性遗忘”：**降优先级，不销毁证据**。

## 8. 身份连续性（`identity`）✅

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
| `portrait` / `learn` | 读/写用户画像；`target=assistant` 操作助手画像；`learn` 支持 `sourceIds`（exchange）与 `sourceObservationIds`（observation） |
| `observe` / `correct` / `observations` / `contradict` | 证据层写入、纠正、列出、标记矛盾 |
| `identity` | 身份连续性证据与建议 |
| `entities` | Top 实体或某实体的相关记录 |
| `index` / `repair` | 索引未打开会话 / 从日志补回缺失用户原话 |
| `archive` / `restore` | 回收区进出 |
| `stats` | 记录/会话/类型/实体/重要度/回收区/间隔/过期/观察计数/`facetsNeedingRecompute`/注入长度/命令状态/`consent`（含 `schemaVersion`） |
| `consent` | C1-C4 同意开关：读状态或传 `consent={memory,inject,profile,sensitive}` 改部分字段（持久化，重载保留） |
| `migrate` | `mode=strip confirm=true`：先导出 memory.md，再剥离旧记录明文；缺 `confirm` 拒绝执行 |
| `scope` | 记忆隔离自查：模式/配置、身份（role+source+sessionId）、命名空间、读写权、`ownerAgentIds`、dormant 画像 |
| `gc` | `confirm=true` 才删 dormant 画像；默认 dry-run（只报告，不删除） |
| `export` | 导出 `memory.md`（用户画像 + 助手画像 + 观察与推断 + 印象 + 统计） |

`/dmem` 命令：`stats | portrait | self | export | search <关键词> | pause | resume | consent … | migrate … | scope | gc [confirm=true]`。

- `/dmem consent [status|on|off|inject on|off|sensitive on|off|profile unified|situational|off]`（唯一写同意状态的入口，工具/面板共用）
- `/dmem migrate mode=strip confirm=true`（破坏性，先导出）
- `/dmem pause|resume`（捕获开关；`memory=off` 时捕获恒停）
- `/dmem scope`（隔离状态）；`/dmem gc`（dry-run）/ `/dmem gc confirm=true`（只删 dormant 画像）

## 10. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `recentExchanges` | 3 | recent 条数 / 旧注入模式条数 |
| `promptCharsPerExchange` | 1200 | 旧注入模式截断 |
| `portraitCharsPerFacet` / `portraitBudget` | 240 / 900 | 用户画像注入预算 |
| `assistantCharsPerFacet` / `assistantBudget` | 180 / 520 | 助手画像注入预算 |
| `injectAssistantPortrait` | true | 是否注入助手画像 |
| `observationChars` / `observationBudget` | 180 / 420 | 证据层注入预算 |
| `ttlTransientDays` / `ttlSituationalDays` | 3 / 30 | 观察 TTL（只停止注入，不删除） |
| `inferenceHalfLifeDays` | 90 | 推断置信度半衰期 |
| `digestImpressions` / `digestChars` | 2 / 100 | 跨会话速览 |
| `injectRecentExchanges` | false | 是否注入同会话最近问答 |
| `snippetChars` | 400 | 片段长度 |
| `maxExchangesPerSession` | 1000 | 单会话上限 |
| `dedupeJaccard` | 0.95 | 近似重复阈值 |
| `timeBoost` / `timeDecayDays` | **0.4**（v1.10 起，此前 0.8）/ 180 | recency 权重与衰减天数；importance 衰减使用 `2 × timeDecayDays` |
| `scope` | workspace | 检索范围 |
| `archiveAfterDays` / `autoArchive` / `archivedWeight` | 730 / true / 0.3 | 回收区 |
| `gapDays` | 30 | 长间隔判定 |
| `freshDays` | 180 | 画像过期 |
| `autoIndexSessions` / `indexBudget` | true / 10 | 后台索引 |
| `warmup` | true | 启动 5 秒后预热缓存 |
| `exportPath` | `$DSH_HOME/storages/dynamic_memory/memory.md` | 导出路径 |

| `locale` | auto | 运行时语言：auto / en / zh；auto 按会话最近用户消息判断 |
| `facets` | 7 个默认 facet | 用户画像 facet 列表，可增删（例如移除 psychology） |
| `assistantFacets` | 4 个默认 facet | 助手画像 facet 列表 |
| `autoSummary` | true | 捕获时生成抽取式摘要（无 LLM），用于跨会话速览 |
| `identityNotice` | false | 是否注入身份连续性提示；开启后需强证据（基线≥20、<0.3、间隔≥3天） |
| `gcRequireInventory` | true | 判 dormant/GC 前必须拿到 listSessions 完整清单；缺失时 gc 只报告不删除 |
| `capture` | true | false 时不自动捕获；运行中也可用 `/dmem pause` |
| `memoryScope` | owner | `owner`（默认，仅 root agent 用 owner 记忆）/ `agent`（每个 agentId 独立命名空间）/ `shared`（旧行为，共用） |
| `ownerAgentIds` | `[]` | 显式指定 owner 会话 id（数组或逗号串）；用于无法从 header/registry 判定身份的宿主 |

## 11. 生命周期与资源 ✅

- 插件激活：打开存储域（失败则降级内存模式，`storage` 字段说明原因）→ 载入 4 表 → 计算间隔 → 必要时自动归档 → 注册工具/命令/注入 → 3 秒后台索引 → 5 秒预热。
- 卸载：清定时器、flush 访问统计、关闭存储域。
- 每个 agent 的 capture 与工具注册绑定在 `agent.ctx`，agent 销毁时自动清理；插件级定时器不随 agent 销毁。

## 12. 验证方式

| 命令 | 内容 | 评审环境复现 |
|---|---|---|
| `node test.mjs` | 52 项纯函数测试：实体、BM25/排序、失效/回收、片段、置信度（排序无关性、覆盖率）、gap/stale、身份连续性、证据层、mention、reflect、跨层重复、scope/TTL、印证引文、locale 检测、非拉丁分词、标签 lint。**不含 dsh-go 断言**（`grep dshGo test.mjs` 为 0） | ✅ 52/52 |
| `node test-host.mjs` | 269 项生命周期/写入路径（内存 mock host：抓取、卸载顺序、重启恢复、级联、版本来源、水合、consent 持久化与 memory off 拦截、**多智能体隔离**（owner 拒绝/注入为空、shared 兼容、显式 ownerAgentIds、agent 命名空间）、**dormant/GC**（清单未验证时零删除、身份无证明 fail-closed））。**同样不含 dsh-go 断言** | ✅ 269/269 |
| `node ui/verify-client.mjs` | Web 面板静态契约（槽位、命令白名单、文案、效果上限） | ✅ 10/10 |
| `node ui/verify-dshgo.mjs` | **dsh-go 的唯一校验来源**：静态检查 manifest/长度/id/placement/view 节点与深度/32KiB/效果上限/toggle→命令映射/locale 对齐，**解析视图树断言每个注册 action 可达**（删按钮会 FAIL），并 import 面板纯函数做断言 | ✅ 46 PASS + 1 INFO（无 kit/App，非端到端） |
| `node eval.mjs` | 10 条正样本 + 8 条负样本，baseline/bm25/+phrase/+entity/full 的 hit@3、MRR 与误报率 | ✅ 本机 9/10、MRR 0.750、FP 1/8 |
| `node eval.mjs --min-coverage 0.6` | 同上，按 coverage 门控重分类低置信标签 | ✅ FP 0/8 |
| `node eval.mjs --fixture` | 合成数据（CI 可跑，5 正 / 2 负） | ✅ 5/5、FP 0/2 |
| `node bench.mjs` | 12 条查询、5 轮预热的 cold/warm 延迟与 compact/full 体积 | ❌ 需要本机记忆库 |

作者本机数据（约 2141 条索引记录、0 条明文）：v1.11.0 全文明文基线为正样本 `10/10, MRR 0.883`；v2.1 剥离原文并按评测标签迁移后为 `9/10, MRR 0.750`（未迁移标签时表观 `7/10, MRR 0.600`），`--min-coverage 0.6` 时误报 `0/8`。剩余 1 条真实损失是摘要截断导致的覆盖缺口（一个部署类查询）。**注意：真实集正样本 10 条、负样本 8 条，不是冻结测试集**，这些数字是本机回归基线。bench warm p50 ≈ 6.8ms、p95 ≈ 13.1ms，compact 3.4KB / full 12.6KB（约 27%）。

**解读这些数字时请注意 K3**：10 条正样本仍小，权重（impression 0.05、phrase 3 等）是在同一批数据上调的；负样本也只有 8 条。`10/10` 是乐观上界，不是泛化结论。P3-1 会把评测集扩到 30+ 条并按 dev/test 划分。

## 13. 设计取舍与已知限制

### 13.1 评审确认的缺陷（K 系列）

| 编号 | 问题 | 证据 | 状态 |
|---|---|---|---|
| K1 | 画像/观察的话题门控误伤跨话题偏好，并放行偶然共享二字组的无关内容 | “继续”→ 仅剩 `identity`；偶发共享词放行无关观察 | ✅ v1.11 已修（P0-1 常驻/线索分层 + 停用词） |
| K2 | `bm25n` 按本次最大值归一化，抹掉绝对匹配质量，无答案查询得到 `high` | 负样本 2/8 误报 medium | ✅ v1.11 已修（maxPossible 归一 + IDF 加权 coverage + coverage≥0.5 门槛） |
| K3 | 评测集小、无负样本、权重在同一批数据上调，无端到端对照 | 见第 12 章 | ⚠️ 部分缓解：新增 8 条负样本与误报率；仍缺端到端对照 |
| K4 | 删除纠正记录、原观察恢复 `current` 时，迁走的矛盾链接不会恢复 | `correct` 把矛盾迁到纠正记录并清空原记录 | ✅ v1.11 已修（改为复制链接，原记录保留） |
| K5 | 观察渲染循环在展示满 6 条/预算耗尽后 `break`，之后的观察不再计入计数 | `break` 位于计数之后 | ✅ v1.11 已修（先完整遍历统计，再渲染） |
| K6 | 观察没有时间属性：“今天很累”与“偏好极简依赖”同样长期保留 | 数据模型无 TTL/衰减 | ✅ v1.12 已修（读取时派生 scope + TTL 停止注入 + 推断置信度衰减） |
| K7 | 标签 lint 是关键词启发式：情境词可被敷衍写入；人格词表固定 | `TRAIT_CONTEXT_HINT` 只检测字面词 | 📐 P3-4 |
| K8 | `needsRecompute` 只打标记，不自动重写 | 见第 6 章 | 📐 P2-3 |
| K9 | TTL 会被无关操作续期：`contradict`/`correct`/删除清理都刷新 `updatedAt`，而过期判定曾以它为准 | 构造 10 天前的 `emotional_state`，把 `updatedAt` 改成 1 天前即不再过期 | ✅ v1.12.1 已修（新增 `lastCorroboratedAt`，只有创建与独立会话印证会更新） |
| K10 | 独立会话增强是死代码；`correct` 记录 scope 写成 `original.scope`（通常 undefined）→ 派生成 durable，短期纠正永久化 | 代码里只有创建与 `correct` 往 `sessions` 加元素；纠正 `emotional_state` 后 400 天不过期 | ✅ v1.12.1 已修（`observe corroborates=<id>` 显式印证；纠正用 `scopeOf(original)`） |
| K11 | `observe` 忽略 `observationType` 参数，所有观察都落成 `behavior_observation` → scope 派生跟着错 | `emotional_state` 观察返回 `scope: situational` | ✅ v1.12.1 已修（`addObservation` 读 `observationType`） |
| K12 | 印证入口不要求证据：模型看到注入的推断后随手 `corroborates` 就能续期/加分（来源混淆） | 代码只检查 id、状态、会话不同 | ✅ v1.12.2 已修（必须带 `quote`，插件在当前会话用户消息里子串校验） |
| K13 | 推断置信度衰减从 `createdAt` 起算，复习过也不重置遗忘曲线 | 365 天前创建、1 天内仍被印证 → 有效置信度 0.036+0.2=0.24 | ✅ v1.12.2 已修（锚点改为 `lastCorroboratedAt`） |

### 13.2 设计取舍（有意为之）

1. **不注入同会话最近问答**：省 token，缺口感由 `search` 补；代价是压缩后模型必须主动检索。
2. **无向量语义检索**：`llm` 服务无 embedding 接口，靠二字组 + 短语 + 实体；同义改述召回有限。P2 给出不加依赖的改进方案。
3. **只索引打开过的会话 + 后台增量**：未打开的历史会话不会自动全量进库。
4. **身份判断是证据不是认证**：共用账号、角色扮演、语言切换都可能误判；阈值故意保守。
5. **推断仍需模型把关**：证据层强制分离与替代解释，但“哪条推断成立”仍是模型判断。
6. **隐私是本地最小化**：数据在本机 JSON，无加密；`private` 观察只在注入/导出层隐藏，磁盘上仍有明文（P3 给出可选加密方案）。
7. **旧数据遗留**：早期抓取产生的少量记录只有助手回复，已用 `repair` 补齐用户原话，但历史顺序无法完全还原。
8. **检索刷新新鲜度**：`lastAccessAt` 参与 importance 衰减，被检索的记忆衰减更慢。这是有界的“用进废退”，不会像旧版 `+0.02` 那样无限强化，但仍是一种弱的富者愈富。

---

## 14. 升级规划（合并版）

排序原则：**先修发布可靠性，再改认知机制**；每项必须带测试；改动打分的项只在冻结评测集（test）上报告，dev 只用于调参。

**发布渠道**：Preview（GitHub `main` + tag）→ 可安装（`plugin_manager install_bundle`，本地/自托管）→ Stable（npm；当前 `private: true`，等作者定包名与许可证后再发）。

**技术原则（摘要）**：先证明收益；不宣传“深度认知”；少依赖；失败可发现；用户可见/可纠正；隐私最小化；写入可回退；卸载不丢数据；评测不被调参污染；**记忆越丰富，认知越审慎**。

| 版本 | 内容 | 状态 |
|---|---|---|
| v1.12.3 | 发布可靠性：卸载时 flush → close 等待在途写入；删除 exchange 级联清理 facet/observation 引用并标待重算；`capture: false` 与 `/dmem pause`；README/DOCS 统一；真实评测数据本地化（gitignore + 合成 fixture 供 CI）；内存版 mock host 夹具 | ✅ |
| v1.13（并入 1.14.0） | 画像版本绑定自己的来源集合；`mention`（默认值由 scope + type + sensitivity 派生）；校准/误注入率指标 | ✅ |
| v1.14 | `reflect`（`status: proposed`，≥3 个会话才起草）；`recompute`；跨层重复检测 | ✅ v1.14.0 |
| v2.0 | 运行时国际化、词表/短语数据化、语言中立分词、facet 可配置、英文 README | ✅ v2.0.0（文档 2.0.1） |
| 之后 | 看指标再决定联想检索等增强；npm 发布等包名/许可证确定 | 📐 |

**明确不做 / 推迟**：

- 不新增 Hypothesis 表：复用 observation 的 `status: proposed` + `contradictingEvidence` 字段，状态映射 `proposed → current → withdrawn`，`weakened` 用有效置信度判断；
- Predictive learning、Meta-learning 的运行时自改先推迟（先证明 Reflect 收益；预测用户行为需要用户明确同意与全程可见）；Meta-learning 只做离线用冻结评测集调参；
- 不使用 “2.0 Cognitive Memory System” 这类命名（与“不宣传深度认知”冲突）。

### P0-1 注入分层：常驻层与线索层（✅ v1.11）

**验收结果（单测）**：消息“继续”时 `preferences` facet 与 `explicit_preference` 观察仍注入；`psychology` facet 与 `inferred_motivation` 观察不注入；消息“最近压力 很大，晚上睡不好”（>6 汉字）时 `emotional_state` 观察按 2 个共享词注入；消息“帮我修一下 index.js 的语法”时不注入。停用词（文档频率 >30%）在真实库上同时被用于线索判定。

**问题**：K1。画像里的偏好与习惯像“程序性记忆”，对每条消息都起作用；事件类内容像“情景记忆”，需要线索才浮现。当前一刀切地用话题词交集过滤。

**规范**：

1. **常驻层**（不做话题门控，只受预算限制）：画像 facet `preferences / habits / thinking / identity`；观察中 `type ∈ {explicit_preference, habit_pattern, constraint, correction}`，以及所有 `kind=corrected` 与 `kind=self_reported`。
2. **线索层**（需要线索）：画像 facet `past / dynamics / psychology`；其余观察类型。
3. **线索判定**：
   - 用 **IDF 加权**的交集，而不是任意一个共享二字组：高频二字组（在观察/exchanges 中的文档频率超过阈值，如 30%）自动视为停用词；
   - 满足其一才算有线索：共享 **≥2 个**不同的非停用词、或共享 **≥1 个实体**；
   - 用户消息很短（如 <6 个汉字且无实体）时，线索层整体不注入，常驻层照常注入。
4. `needsRecompute` 的提示只在 facet 被注入时可见，因此 `stats.facetsNeedingRecompute` 必须继续可查，且 `/dmem stats` 要显示。

**边界（须写进用户文档）**：没有语义检索时，不要求命中同义改述（“别装一堆库”↔“偏好极简依赖”）。常驻层正是为了让这类偏好不依赖字面线索。

**验收测试**：
- 用户消息“继续” → `preferences` facet 仍被注入；
- 用户消息“怎么把这个脚本一直跑在后台” → 观察“不喜欢被一直追问细节”**不**被注入（仅共享单个高频二字组“一直”）；
- 线索层观察与消息共享 2 个以上非停用词时被注入。

### P0-2 打分归一化与覆盖率（✅ v1.11）

**问题**：K2。

**规范（✅ 已实现要点）**：

1. `bm25n = 2.5 × bm25 / maxPossible`，`maxPossible = Σ idf(term) × 2.2`（对查询中每个词取 BM25 饱和上界，`2.2 = k1 + 1`）。
2. `coverage` 采用 **IDF 加权**：`(命中词 idf 之和 + 命中实体数 × 平均 idf) / (全部词 idf + 查询实体数 × 平均 idf)`，避免“所有/练习”这类常见词把覆盖率刷高；随结果与 `signals` 返回。
3. 置信度：`adjusted = blended × min(1, coverage / 0.6)`，并且 **coverage < 0.5 时一律 `low`**（不给 high/medium）。
4. `phraseWeight=3 / entityWeight=0.9 / recency=0.4` 已在新增负样本的评测集上复核：正样本 10/10 MRR 0.883 不变，负样本误报 2/8 → 0/8。

**验收结果**：小库单测中，短语匹配类查询的置信度显著高于无关查询，后者不是 `high`；真实库两条负样本（共享常见二字组）coverage 0.47 / 0.30，均为 `low`；三种排序下置信度仍相同。

### P0-3 矛盾一致性（✅ v1.11）

**规范（已实现）**：

1. `correct` 对矛盾链接是**复制**：纠正记录继承 current 的矛盾对，原记录**保留**自己的 `contradicts`。计数只统计双方都 current 的对，所以不会误报。
2. 删除纠正记录、原观察恢复 `current` 时，其矛盾链接自然仍在（peer 同时指向原记录与纠正记录，删除纠正只移除纠正 id）。
3. 渲染前先完整遍历统计未解矛盾对数与被门控条数，再做带预算渲染，避免 `break` 后漏计（K5）。

**验收结果**：单测构造 10 条观察、其中 4 对矛盾，`observationBudget` 只够显示 2 行时仍输出“4 对未解矛盾”；`correct → forget` 的链接恢复由运行时验证（删纠正后原观察重新 `current`，矛盾链接仍在）。

### P1-1 披露策略 `mention`

**问题**：`sensitivity` 管的是**存储与展示**（`private` 不注入、不导出），没管**模型能不能主动提起**。用户随口说过心情不好，应当能影响语气，但不该被主动复述。

**规范**：observation 增加 `mention: "proactive" | "if_asked" | "never"`。

| 值 | 行为 |
|---|---|
| `proactive` | 可自然引用 |
| `if_asked` | 注入时带标记“仅用于调整语气，不要主动提起”；用户直接问起时才回答。`sensitive` 与 `emotional_state`、`relationship_context` 类型的默认值 |
| `never` | 不进入注入；只保留在本地存档，用户用 `observations` 可查看 |

**验收测试**：`if_asked` 的观察注入文本包含“不要主动提起”；`never` 的观察不出现在注入中；默认值按类型与敏感度派生。

### P1-2 时间属性与置信度衰减（✅ v1.12）

**问题**：K6。人类记忆里，“今天很累”和“一贯偏好简洁”是两类完全不同的东西。

**规范**：

1. 增加 `scope: "transient" | "situational" | "durable"`，默认值按类型派生：

   | scope | 默认类型 | 默认 TTL（可配） |
   |---|---|---|
   | `transient` | `emotional_state` | 3 天 |
   | `situational` | `goal`、`decision_record`、`relationship_context`、`behavior_observation`、`inferred_motivation` | 30 天 |
   | `durable` | `explicit_fact`、`explicit_preference`、`habit_pattern`、`constraint` | 无 |

2. TTL 到期后**不再注入**，但保留并可经 `observations` 查看（降优先级，不销毁）；再次被**独立情境**印证时续期。
3. `inferred` 的有效置信度随时间衰减：`effectiveConfidence = confidence × 0.5^(ageDays / halfLife)`；被**不同会话**独立印证时增强（同一会话重复只算一次），设上限，防止自我强化。
4. `contradict` 支持 `conditional: true`：两条矛盾的观察各带不同 `context` 时，视为“情境相关”而非冲突，不计入“未解矛盾”。

**验收测试**：`emotional_state` 观察 4 天后不再注入但仍可列出；同一会话重复同一推断，`distinctSessions` 不增加；`conditional` 矛盾不计入未解矛盾。

### P2-1 巩固 pass（`reflect`）

**问题**：当前后台整合只做去重与裁剪。人类记忆会把重复出现的片段沉淀成模式。

**规范**：

1. 触发：手动 `reflect`，或空闲时按间隔运行。
2. 步骤：按实体/主题聚类近期观察与 exchanges；某模式在 **≥3 个不同会话**中出现，才生成草稿。
3. 草稿是 `kind=inferred`、`status=proposed` 的观察，必须带 `confidence`、`alternatives`、`sourceIds`；**`proposed` 不注入**，也**不自动写入画像**。
4. 确认流程：模型把草稿呈现给用户，用户认可后转为 `current` 并可 `learn` 进 facet；拒绝则 `withdrawn`。
5. 每次 `reflect` 写一条可读的变更日志（新增/合并/过期了什么），用户可查看。这样画像不会在用户不知情时漂移。

**验收测试**：2 个会话中出现的模式不生成草稿，3 个会话出现则生成；`proposed` 不出现在注入里；拒绝后不再重复提议同一模式。

### P2-2 检索联想（不引入依赖）

**规范**：

1. **分词**：在二字组之外，用 `Intl.Segmenter('zh', { granularity: 'word' })` 的词级 token 作为补充；做特性检测，不可用时回退到现有二字组（Node 默认带完整 ICU）。
2. **实体共现图**：从各 exchange 的 `entities` 惰性构建共现计数；查询时对每个查询实体加入共现次数 ≥2 的 top-3 邻居，权重为 `0.5 × entityWeight`，**只扩展一跳**，`reasons` 标 `assoc:<entity>` 以便审计。
3. **查询改写**：指令行追加一句，首次未命中时让模型换 2–3 种说法再搜（用模型自身做查询扩展，补同义改述的缺口）。

**验收测试**：`Intl.Segmenter` 不可用时全部现有测试仍通过；两个实体在 ≥2 条记录中共现，搜其一能以 `assoc:` 理由召回含另一个的记录；一跳之外的实体不被召回。

### P2-3 `recompute`

**问题**：K8。`needsRecompute` 只是标记，模型需要自己再去翻证据。

**规范**：新增 `recompute facet=<f>` 动作，返回该 facet 当前仍存活的来源观察（按 `corrected → self_reported → observed → inferred` 排序）、被纠正/删除的来源摘要，以及上一版内容，供模型一次性重写；**仍由 `learn` 提交，不自动写入**（保持用户可审计）。

**验收测试**：facet 引用的观察被 `correct` 后，`recompute` 返回纠正后的版本；`learn` 之后 `needsRecompute` 归零。

### P3-1 评测集扩充

1. `eval-queries.json` 扩到 **30+ 条**，其中 **≥10 条无答案负样本**（库里确实没有）。
2. 按 2:1 划分 dev/test：权重只在 dev 上调，在 test 上报告。
3. 新增指标：**误注入率**（无答案查询中置信度 ≥ `medium` 的比例）与 hit@3、MRR 并列。
4. 端到端对照：同一批问题，开启/关闭记忆注入，比较回答质量（人工或固定评分标准），避免只优化检索指标。

### P3-2 显著性信号

`importance` 只应由**显著性事件**抬高：用户明确强调（“记住/一定/别再”）、被 `correct` 的次数、`deepen`。检索命中次数只进 `accessCount`，不参与（现状已如此，规范把“只由显著性抬高”写成约束）。新增 `salience` 字段（0–1），打分用 `max(importance, salience)` 的衰减值。

### P3-3 助手画像改造（✅ v1.12）

对应 0.4 第 4 条。`psychology`（助手心理）、`experience`（助手经历）改为：

- **工作方式**：在本用户这里验证过有效的做法（如“先给结论再给理由”），必须有来源；
- **可核对的经验**：做过什么、踩过什么坑，附 `sourceIds`。

不再保留没有证据来源的“心理叙述”。这样助手画像能真正影响行为，而不是增加拟人的表层。

### P3-4 lint 收紧与可选加密

1. **lint**：人格标签词出现在 `learn` 内容时，要求至少一个真实存在的 `sourceObservationIds`（或 `sourceIds`），**不再用情境词放行**；情境词只用于 `observe` 的提示。词表可配置。
2. **加密**（可选，默认关闭）：用 `node:crypto` 的 AES-256-GCM，密钥由环境变量中的口令经 scrypt 派生；至少加密 `sensitivity=private` 的观察，可选加密全部 exchanges（检索时在内存中解密）。不新增依赖，Termux 可用。代价：口令丢失则不可恢复。

### 14.1 v2.0 多语言与开放预设（✅）

- **运行时国际化**：注入文案、facet 标签、工具描述、命令基础文案由 `locale/messages.{zh,en}.json` 提供；`locale: auto` 按**会话**最近用户消息判断（避免被工具结果/英文系统提示带偏），可强制 `en`/`zh`。
- **去关键词化**：人格标签词表、身份自述短语、实体停用词全部是 locale 数据；核心 lint/身份逻辑不内建中文词表。
- **语言中立分词**：中文二字组 + 拉丁词之外，为阿拉伯/西里尔/希腊/泰/天城文增加词级回退。
- **预设可配置**：`facets`/`assistantFacets` 可增删；持久化 schema 不再限定固定 facet。
- **文档语言**：README 英文为主版本，中文为 `README.zh-CN.md`；注释与本文档可继续用中文。

**边界**：英文/其他语言为功能性可用，仍需母语润色；命令输出只本地化了基础文案；facet 只是可配置，尚未做到从数据自动发现。

### 实施依赖

```
v1.12.3 可靠性（✅）─► v1.13 mention + 画像来源集合 + 冻结评测集（📐）─► v1.14 reflect / recompute / 跨层去重（📐）
```

已完成：P0（v1.11）、P1-2（v1.12–v1.12.2）、P3-3（v1.12）、v1.12.3 发布可靠性。v1.13 起按合并版路线推进；所有打分改动只在冻结 test 集上报告。

---

## 15. 面板与多端（v2.3 Web / v2.4 dsh-go）

### 15.1 为什么需要两份面板

| 端 | 载体 | 能看到的入口 |
|---|---|---|
| Web / 桌面 | `client.js`（`dsh.client.platform = web`） | 输入框 dock 的「记忆面板」（`conversation.input.dock` 槽位） |
| dsh-go 手机 App | `package.json` 的 `dshGo` 清单 + `index.js` 的 `ctx.inject(['dshGo'])` 声明式面板 | 对话详情→插件、全部功能、输入框插件胶囊（`session.tab` / `features` / `chat.panel`） |
| CLI | 无面板 | `/dmem` 命令 |

dsh-go 是 Flutter 原生界面，**不执行 Web client 插件**，所以 v2.3.0 的 `client.js` 在手机上看不到；v2.4.0 另加一份原生贡献。

### 15.2 dsh-go 清单（`package.json`）

```jsonc
{
  "version": "2.4.0",
  "main": "index.js",
  "dshGo": {
    "v": 1,
    "title": { "zh": "记忆", "en": "Memory" },
    "icon": "settings",
    "wants": [],
    "contributes": {
      "panels": [{
        "id": "memory-settings",
        "title": { "zh": "记忆设置", "en": "Memory settings" },
        "icon": "settings",
        "placement": ["session.tab", "features", "chat.panel"],
        "presentation": "page"
      }]
    }
  }
}
```

- `minApp` 省略：本机无 kit/template，App 版本格式无法验证（bridge 0.4.0 是桥接版本，不是 App 版本号）。
- `wants: []`：面板不读剪贴板/输入框/消息；`dsh.client.platform` 仍为 `web`，`dsh.bundle.patch` 与 `exports["./client"]` 保留，Web 面板行为不变。

### 15.3 注册与数据边界

- `ctx.inject(['dshGo'], …)`：只有手机 App 引擎提供 `dshGo` 服务时才执行；桌面/Web/CLI 下不注册（no-op）。
- 只读快照 `dshGoSnapshot()`：`consentStatus()`、`storageState`、`rowsById.size`、`countPlaintextRows()`、上次注入 `chars`；无会话快照时回退最近一次。**不新开网络、不额外读文件、不依赖 agent**。
- 写入**只走命令**：toggle → `/dmem consent …`；导出 → `/dmem export`；暂停/恢复 → `/dmem pause|resume`。actions 只返回声明式 effect（command/copy/toast，≤4），不直接写 storage。

### 15.4 面板能力与视图

- 存储健康：storage（durable/memory）、索引条数、`plaintextRows`、上次注入字符（无则 `—`）。
- C1–C4：显示状态并切换；profile 按 `unified → situational → off → unified` 循环。
- 导出；复制 stats（`storage=… exchanges=… plaintextRows=… injectedChars=… consent=…`）；同意说明 callout（只存本机/无遥测/敏感默认关）。
- 视图为声明式 v2：`stack` + `keyValue` + `list` + `callout` + `actions`；文案取 `locale/messages.*.json` 的 `panel.*`（21 键，中英对齐，title ≤16 字）。约束：面板 ≤32 KiB、≤120 组件、≤8 层；效果 ≤4。
- 面板内容：四个 C1–C4 开关行 + 五个按钮（暂停捕获、恢复捕获、导出、复制状态、同意说明），全部渲染且每个注册 action 都有可达入口（`ui/verify-dshgo.mjs` 交叉断言）。
- 命令语法：memory 开关是 `/dmem consent on|off`（**不是** `consent memory …`）；inject/sensitive 才带键名；profile 走 `unified → situational → off` 循环。
- **范围外**：多智能体记忆隔离（`memoryScope`）当时不在 2.4.0 交付——**已由 2.5.0 交付，见第 16 章**。

### 15.5 安装、生效与卸载

- 清单改动自动重读；`index.js` 改动需 App「引擎」页重启引擎。
- 若桥接只扫 `$DSH_HOME/dsh-go/plugins/` 而不走 profile 依赖发现：`dsh plugin --profile web add <包目录>`（发现规则**未确认**）。
- 卸载：`dsh plugin --profile web remove @local/dynamic-memory`，再删包目录；记忆数据在 `$DSH_HOME/storages/dynamic_memory/`，不受影响。
- 回滚面板：重装 2.3.0（Web），或移除 `dshGo` 清单（App 入口消失，数据不动）。

### 15.6 验证边界（必须写明）

- 本机**无 dsh-go 真机、无 kit `check.mjs`**：**未在 App 实测**渲染、点击、重载保持。
- 只有静态校验：`node ui/verify-dshgo.mjs` 46 PASS + 1 INFO（**dsh-go 的唯一校验来源**；该脚本会解析视图树并 import 面板纯函数，但 `test.mjs`/`test-host.mjs` 里 `dshGo` 出现次数为 0）；`node ui/verify-client.mjs` 10 PASS；单测 52 + 269（不含 dsh-go 断言）；`node eval.mjs --fixture` 通过。
- spec §6 三个接口（同包双身份是否双加载、发现规则、`scope.sessionId` 在 placement 下是否有值）仍需真机确认。

## 16. 多智能体记忆隔离与 dormant 画像 GC（v2.5.0）

### 16.1 问题与目标

teammate/subagent 与主会话共享同一存储时，子 agent 能读用户画像、也能写 owner 记忆（跨 agent 串味）。v2.5.0 给每条记录加 `scopeId`，并在读、写、注入三处走同一套 gate。

### 16.2 三种模式

| memoryScope | 谁用哪份记忆 | 子 agent 读/写 |
|---|---|---|
| `owner`（默认） | 只有 root agent 用 `owner` 命名空间 | 读拒绝、写拒绝（`isolated:true` + 原因），注入为空 |
| `agent` | 每个 `agentId` 一个 `agent:<id>` 命名空间 | 读写自己的命名空间；root agent 仍可见升级前的未标 scope 旧行 |
| `shared` | 全部 agent 共用（旧行为） | 都可读可写；写入折叠回 owner 命名空间 |

### 16.3 身份识别（不猜测，fail-closed）

优先级（`index.js` 的 `resolveIdentity`）：

1. `config.ownerAgentIds`（数组或逗号串）——显式指定，`source=config:ownerAgentIds`；
2. session header：`parentSession` / `origin=subagent` / `delegationDepth>0` → `delegate`，`source=session-header`；
3. `agents.roots()` vs `list()`：roots 为 `owner`、其余为 `delegate`，`source=agents-roots`；
4. 以上都不能证明身份 → `role=unknown`，**不读不写**，提示配置 `ownerAgentIds`。**2.5.1 起去掉了"有 header 即 owner"的回退**，旧 Harness 无委派字段时同样 fail-closed。

实测：`scope=owner`、`identity source=agents-roots`、`canRead/canWrite=true`。

### 16.4 记录与画像主键

- 每条 exchange / observation / portrait 带 `scopeId`：`owner` 或 `agent:<agentId>`（旧数据无 scopeId 视为 owner）。
- 画像存储键：owner → `p_<facet>`；agent → `p_<scopeId>:<facet>`；portrait 另带 `agentId` / `agentPreset` / `identitySource`。
- **主键不是 sessionId**：同一 agent 重开新会话仍落在同一 `agent:<id>` 命名空间。

### 16.5 归档、删除与 dormant

- `archive` / `restore` 只动 exchange；**画像仍 active**（会话还在，人还在）。
- 会话被删除（不在 live agents，也不在 `sessionQuery.listSessions()`）→ 该 scope 画像标 `dormant=true`：**只标不删、不再注入**，`stats.dormantFacets` 与 `/dmem scope` 可见；owner 画像永不被标 dormant。
- **2.5.1 起：只有清单已验证（`listSessions()` 成功返回数组）才会标 dormant**；清单缺失/报错/非数组时不标，只把未知 scope 记入 `unknownScopes`。
- 新会话不会自动继承 dormant 画像（无跨会话身份关联，见 16.7）。

### 16.6 命令与实测

- `/dmem scope`：模式/配置、身份（role + source + sessionId）、命名空间、读/写权、`ownerAgentIds`、`inventory{verified,source,known,gcRequireInventory}`、`dormantReason`、`unknownScopes`、dormant 列表；工具 `action=scope` 等价。
- `/dmem gc`：默认 dry-run（只列孤儿 scope 与 dormant facet 数，不删除）；`/dmem gc confirm=true` 只删 dormant 画像；owner 与活跃 agent 永不触碰；非 owner 级身份被拒绝。
- **2.5.1 起：清单未验证时即使 `confirm=true` 也只报告**（`reason=unverified-inventory`，零删除）；`gcRequireInventory` 默认 true，设为 false 才回到"只看 live agents"的旧行为（有风险，不推荐）。
- 实测：`dormantFacets=0`；inventory verified、gc dry-run 零删除；测试 52 + 269。

### 16.7 诚实限制

1. **Harness 没有独立持久 agentId**：身份来自 session/agent id + header/registry，同一个人换会话无法自动认回。
2. **删除会话后只能 dormant 标记**：没有"人已删除"的持久墓碑，新会话不继承旧画像；需人工 `/dmem gc confirm=true` 才真正清掉。
3. **并发 `agents.roots()` / `listSessions()` 的时序未在真机验证**：清单未验证时系统选择 fail-closed（不标 dormant、不删），因此可能"该清的没清"，但不会误删。
4. 版本 2.5.2 为测试版：npm 未推送、非 Latest。

## 17. 变更记录

### 17.1 插件

| 版本 | 内容 |
|---|---|
| 2.5.2 | 文档漂移修正（docs-only，代码同 2.5.1）：统一测试数 52+269；2.4.0 状态改为测试版已发布；评测口径统一为本机实测 9/10、MRR 0.750、gate 0.6 时 FP 0/8、fixture 5/5，并标注"真实集样本少、非冻结测试集"；隐私清理（无真实域名/本机路径/真实查询原文） |
| 2.5.1 | 隔离 GC 安全加固：`gcRequireInventory` 默认 true——只有 `listSessions()` 成功返回数组才算完整清单，缺失/报错/非数组不标 dormant、gc 即使 confirm=true 也只 dry-run（`reason=unverified-inventory`，零删除）；去掉"有 header 即 owner"回退，身份不可证明即 unknown、fail-closed；scope/stats 暴露 `inventory{verified,source,known,gcRequireInventory}`、`dormantReason`、`unknownScopes`；测试 52 + 269 |
| 2.5.0 | 多智能体记忆隔离：`memoryScope` owner（默认）/agent/shared；身份解析 `ownerAgentIds` > header > `agents.roots()/list()`，无法识别 fail-closed；记录与画像主键改 `scopeId`（owner / agent:<id>）；归档保留画像、删会话标 dormant（不注入、stats 可见）；`/dmem scope` + `/dmem gc`（dry-run 默认、confirm 只删 dormant、不碰 owner/活跃 agent）。实测 scope=owner、identity agents-roots、canRead/Write=true、dormantFacets=0、gc dry-run 零删除；测试 52 + 269。**未真机验证**并发 roots/list 时序；Harness 无持久 agentId（删除只能 dormant） |
| 2.4.0 | dsh-go 原生记忆面板：`package.json` 加 `main: index.js` + `dshGo`（v1、`memory-settings`、`session.tab`/`features`/`chat.panel`、presentation page、title 中英、icon settings、`wants: []`、`minApp` 省略）；`index.js` 用 `ctx.inject(['dshGo'])` 注册只读快照 + 声明式 v2 视图，写路径只发 `/dmem consent|pause|resume|export`，五个按钮齐全（暂停/恢复/导出/复制/同意说明）；新增 `ui/verify-dshgo.mjs`（46 PASS + 1 INFO）作为 dsh-go 的唯一校验（test.mjs/test-host 当时计数，当前基线 52+269；不含 dsh-go 断言）。**未在真机 dsh-go 验证**（无 kit/App），见 §15.6 |
| 2.3.0 | Web/桌面记忆面板：`client.js` 挂在 `conversation.input.dock`（状态/搜索/画像/暂停恢复/C1–C4/导出，全部走 `/dmem`）；`package.json` 加 `exports["./client"]` 与 `dsh.client`；`ui/verify-client.mjs` 10 PASS；live client inspect 确认槽位占位 |
| 2.2.1 | consent 加固：`memory=off` 拒绝显式写入（observe/learn/deepen/correct）；consent 行加 `schemaVersion=1` + v0 迁移；文档同步（测试当时通过，当前基线 52+269；eval 9/10 MRR 0.750、gate 0.6 时 FP 0/8、fixture 5/5） |
| 2.2.0 | C1-C4 同意开关 + `/dmem consent`（持久化、重载保留、真机验证）；`digestCount` 改真实注入快照；eval 标签迁移与 `--min-coverage` 门控（9/10、MRR 0.750、FP 0/8） |
| 2.0.1 | 文档发布版：补齐 v2.0 多语言/开放预设章节、配置项（locale/facets/assistantFacets/capture）、测试数（51 + host 16）、路线状态；README.zh-CN 重写；CHANGELOG 更新 |
| 2.0.0 | 运行时国际化（locale/messages 包，auto 按会话语言）、词表/短语/停用词数据化、语言中立分词回退、facet 可配置、README 英文主版本 + 中文翻译；测试 49 → 51 |
| 1.14.0 | 画像版本来源绑定（不跨版本累积，旧版本来源存入 history）；`mention` 披露策略（proactive/if_asked/never，默认由 sensitivity+scope+type 派生）；`reflect` 巩固草稿（≥3 会话，proposed 不注入）+ `review`；`recompute`；`duplicates` 跨层重复报告；eval 增加 calibration 分桶；测试 45 → 49；host fixture 16 项 |
| 1.12.3 | 发布可靠性：卸载清理改为 async，先等在途写入（`pendingWrites`）、再 flush、再 close；待执行的整合在卸载时执行而不是丢弃；删除 exchange 时级联清理 facet `sourceExchangeIds` 与 observation `sourceIds` 并标 `needsRecompute`；新增 `capture: false` 与 `/dmem pause|resume|capture`；README/DOCS 修正过时的“访问强化”；真实评测数据移出仓库（`eval-queries.local.json` / `eval-drafts.local.md`，gitignore），CI 改用 `eval-queries.fixture.json` 合成数据；新增内存 mock host 夹具；包保持 `private: true` |
| 1.12.2 | 补印证入口两个缺口：`corroborates` 必须带 `quote`，插件在当前会话用户消息里做子串校验（防止模型看到自己的推断后自我强化）；推断置信度与 TTL 的衰减锚点改为 `lastCorroboratedAt`（复习重置遗忘曲线）；`learn target=user facet=psychology` 必须带 `sourceObservationIds`；助手“喜好”去重；新增评测草稿。测试 43 → 45 |
| 1.12.1 | 修复 P1-2 三个实测缺陷：TTL 锚点改为 `lastCorroboratedAt`（无关编辑不续期，只有独立会话印证续期）；新增 `observe corroborates=<id>` 作为显式印证入口（同会话 no-op，不同会话给有上限的置信度增强）；`correct` 用 `scopeOf(original)` 继承派生 scope，短期观察的纠正不再永久化；`observe` 修正忽略 `observationType` 导致全部落成 `behavior_observation`；常驻判断对敏感项的豁免收紧（敏感纠正也需线索）。测试 41 → 43；运行时验证：10 天前的 `emotional_state` 编辑 `updatedAt` 后仍判过期，`corroborates` 使置信度 0.447 → 0.547，纠正 scope 为 transient |
| 1.12.0 | P1-2 时间属性：`scope` 读取时按 type 派生（不回写），TTL 只停止注入不删除，过期观察仍可查；推断置信度按 90 天半衰期衰减 + 独立会话最多 +0.2；`contradict conditional` 不再计入未解矛盾。修正 P0 遗留：常驻层对 `sensitive` 的检查覆盖 type 分支；线索判定改为**不重叠共享词**计数（“后台运行”与“后台”一致）；常驻观察排在预算前。P3-3 助手画像改为“工作方式/可核对经验”并带来源，旧内容归档可回退。测试 34 → 41 项；eval 基线不变（正 10/10 MRR 0.883，负 0/8） |
| 1.11.0 | P0-1 注入分层（常驻：preferences/habits/thinking/identity 与偏好/习惯/约束/纠正类观察；其余需线索：≥2 个非停用词或 ≥1 实体；短消息只注入常驻层）；P0-2 打分保留绝对质量（`bm25n = 2.5×bm25/maxPossible`）+ IDF 加权 `coverage`，`coverage<0.5` 不给 high/medium；P0-3 矛盾链接改为复制、计数前置；测试 31 → 34 项；新增 8 条负样本，误报 2/8 → 0/8，正样本保持 10/10 MRR 0.883 |
| 1.10.0 | 评审修复：置信度在得分序上计算；lint 校验真实来源 id；矛盾只统计双方 current；`forget` 清理悬空引用并恢复被纠正的原观察；画像 `sourceObservationIds` 与 `needsRecompute`；观察/画像注入门控与“纠正 → 自述 → 事实 → 推断”排序；检索不再抬高 importance 并加入闲置衰减；BM25 按查询归一化，recency 按时间意图加权，impression 降为 tie-breaker；`timeBoost` 默认 0.8 → 0.4；测试 27 → 31 项 |
| 1.9.0 | 证据层、身份连续性、回收区、间隔检测、置信度检索 |

### 17.2 本文档

- 2.5.2：版本头 2.5.2；测试数统一 52+269；§16 补 2.5.1 清单验证语义（未验证清单不标 dormant、gc 零删除、无 header 回退）；§17.1 补 2.5.1/2.5.2 行；§17.2 记录本次文档修正；隐私清理（去掉真实域名/本机路径/真实查询原文，§5.1/第 9/12 章）；
- 2.5.1：版本头 2.5.1；§16 补 `gcRequireInventory` 与 `inventory`/`dormantReason`/`unknownScopes` 字段；§12 测试数 269；
- 2.5.0：版本头 2.5.0；第 9 章加 `scope`/`gc` 命令；第 10 章加 `memoryScope`/`ownerAgentIds`；第 12 章更新为 269 项并补隔离/dormant 测试；新增第 16 章「多智能体记忆隔离与 dormant 画像 GC」；变更记录顺延为第 17 章并补 2.5.0 行；
- 2.4.0：版本头 2.4.0；第 1 章文件清单加 `client.js`/`ui/verify-*.mjs`/`test-host.mjs`；第 9 章补 consent/migrate/pause/resume；第 12 章更新测试数（当前基线 52+269）、面板静态校验与 v2.1 后评测数字（9/10、MRR 0.750、gate 0.6 时 FP 0/8）；新增第 15 章「面板与多端」；变更记录顺延为第 16 章并补 2.2.0–2.4.0；
- 1.12.3：版本头、第 14 章替换为合并版路线（发布渠道、技术原则、v1.12.3 → v1.14）、0.1 增加“记忆越丰富，认知越审慎”、文件清单与评测说明改为本地数据 + fixture、15 同步；
- 1.12.2：版本头、2.3（facet 键名与显示标签的差异、助手喜好去重）、2.4（印证引文与复习锚点）、4.1/7（锚点）、6（psychology 需来源、评测草稿）、12（45 项、eval-drafts）、13.1（K12/K13）、14、15 同步；
- 1.12.1：版本头、2.4（`lastCorroboratedAt`）、4.1（TTL 锚点与印证）、7（TTL 行）、12（43 项）、13.1（K9–K11）、14（P1-2 状态）、15 同步；
- 1.12.0：版本头、2.3（助手画像改为工作方式/可核对经验，旧内容归档）、2.4（scope/sessions/conditional 与 TTL 说明）、4.1（过期与推断置信度）、7（TTL/衰减行）、10（ttl 配置）、12（41 项）、13.1（K6 已修）、14（P1-2/P3-3 状态）、15 同步；
- 1.11.0：版本头、第 4/5/12/13.1/14/15 章与代码同步（注入分层、maxPossible 归一、IDF 加权 coverage、P0 状态、测试 34 项、负样本误报 0/8）；
- 1.10.0：版本头与第 1/12 章更新，测试数 27 → 31；第 5 章公式与代码一致，`timeBoost` 默认值 0.4；新增第 0 章（设计原则）、13.1（K 系列缺陷）、第 14 章（升级规范）；所有条目加状态标记；第 12 章标明哪些验证在评审环境复现。
