# 动态记忆 · 用户画像（dynamic memory）

[![ci](https://github.com/qixidalao/dsh-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/qixidalao/dsh-plugin/actions/workflows/ci.yml)
[![license: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

持久化的长期记忆插件：维护**用户画像**、**助手画像**、**证据层观察**、**跨会话印象**、**实体索引**与**可检索的历史原文**。它只补充上下文窗口里没有的东西，不重复注入当前对话。

> 架构、数据模型、写入/注入管线、打分公式等细节见 [DOCS.md](./DOCS.md)。

## v1.8 身份连续性：证据，而不是判决

能不能判断“你不是他，你是另一个人”？能，但正确的做法不是硬编码“检测到换人就切画像”，而是**从记忆里量出证据，让模型自己判断**。

插件做的事：

| 信号 | 来源 |
|---|---|
| 词汇重合 | 当前会话用户发言的 token，有多少落在历史用户语料的 Top-300 里 |
| 实体重合 | 域名/路径/标识符/缩写等实体与历史实体的交集（例如 `example.com`、`AIOS`） |
| 风格相似 | 中英比例、标点密度、emoji、问号/感叹号比例（styleOf） |
| 时间间隔 | 距最近活跃记忆多少天（复用 v1.7 的 gap 计算） |
| 自我声明 | 原话里的“我是新来的 / 换人了 / 这台电脑不是我的 / 帮朋友问”等表述（只作为证据片段返回） |

- `identity` 动作返回：`continuity`（0–1）、`label`（`likely-same` / `uncertain` / `drifted` / `insufficient`）、`evidence` 明细、baseline 摘要、**recommendation**（也是建议而非结论）。
- 注入：只有 `drifted` 或出现自我声明时，才在上下文里加一段 `## 身份连续性（注意）`，明确写“这是证据不是判决，不要默认套用画像，必要时先确认”。
- 判断权仍在模型：确认换人后，用 `learn` 覆盖画像（旧内容进历史），不会自动把旧画像套给新的人。

**为什么不做自动切换**：共用账号、角色变化（同一个人换工作/换设备）、语言切换，都会产生类似信号；由模型结合对话判断比硬编码更可靠。

实测（当前会话，2092 条记忆、基线 2083 条用户发言）：

```json
{ "continuity": 0.45, "label": "uncertain",
  "evidence": { "vocabOverlap": 0.22, "entityOverlap": 0.04, "styleSimilarity": 0.99,
                "currentMessages": 9, "baselineMessages": 2083, "selfDeclarations": [], "gapDays": 0.02 },
  "recommendation": "证据不足以判定：可以继续参考画像，但降低依赖……" }
```

这正是预期的保守行为：同一个人的话题换了（这次在聊插件，基线里多是 AIOS/部署），词汇与实体重合自然变低，**风格相似度 0.99** 又支持是同一人 —— 综合成 `uncertain` 而不是武断下结论。判断权留给模型，必要时由模型向你确认。

## v1.12.1 P1-2 缺陷修复

| 问题 | 修复 | 运行时验证 |
|---|---|---|
| TTL 会被无关操作续期 | TTL 锚点改为 `lastCorroboratedAt`：创建时设置，之后只有**独立会话印证**才更新；`contradict`/`correct`/引用清理不再续期 | 把 10 天前的 `emotional_state` 的 `updatedAt` 改成 1 天前，重载后仍判过期（`stats.observations.expired=1`，注入提示“1 条观察已过期”） |
| 独立会话增强是死代码 | 新增显式印证入口 `observe corroborates=<id>`：不同会话追加并续期 + 有上限置信度增强，同会话 no-op | 同会话调用返回 `sessionAdded:false`；模拟另一个会话后返回 `sessionAdded:true`，`sessions:2`，有效置信度 0.447 → 0.547 |
| 短期观察的纠正永久化 | `correct` 写 `scope: scopeOf(original)`（派生值），不再依赖通常为 `undefined` 的 `original.scope` | 对 `emotional_state` 纠正后，`observations` 显示纠正 `scope: transient`，不再 400 天不过期 |
| 额外发现：`observe` 忽略 `observationType` | `addObservation` 优先读 `observationType`，所有观察不再一律落成 `behavior_observation`（否则 scope 派生全错） | `emotional_state` 观察返回 `type: emotional_state, scope: transient` |
| 敏感项豁免 | 敏感/私密项即使 `kind=corrected` 也需线索，不每轮注入 | 单测：无关消息下敏感纠正不出现 |

测试 41 → 43 项；eval 基线不变（正 10/10 MRR 0.883，负 0/8）。

## v1.12 时间属性与助手画像改造

| 内容 | 实现 | 验证 |
|---|---|---|
| P1-2 观察 TTL | `scope` 读取时按 type 派生（旧数据不回写）：`emotional_state` transient 3 天、goal/decision/behavior/inference situational 30 天、偏好/事实/约束 durable；**只停止注入，不删除**，`observations` 仍可查 | 单测：4 天前的情绪观察不再注入但报“已过期”；durable 900 天不失效 |
| 推断置信度 | `effectiveConfidence = confidence × 0.5^(ageDays/90)`；独立会话每多 1 个 +0.1（上限 +0.2），同一会话重复不增强 | 单测：90 天后减半；2 个会话高于 1 个；重复同一会话不增 |
| conditional 矛盾 | `contradict conditional=true` 记为“情境相关”，不计入未解矛盾 | 单测：两条 conditional 相互指向时不出现“未解矛盾” |
| P0 遗留修复 | 常驻层 `sensitive` 检查覆盖 type 分支；线索判定改为**不重叠共享词**（“后台运行”与“后台”都算 1 个词）；常驻观察排在预算前 | 单测：敏感 constraint 需线索；`sharedCueWords` 三条断言；预算只够一行时常驻项优先 |
| P3-3 助手画像 | `psychology → 工作方式`、`experience → 可核对经验`，内容改为可验证行为并带 `sourceIds`；旧画像导出到 `storages/dynamic_memory/archive/assistant-and-user-portrait-v1.11.md`，facet `history` 保留旧版本可回退 | 注入里显示新标签；`portrait target=assistant includeHistory=true` 可查旧版 |

测试 34 → 41 项；eval 基线不变：正样本 **10/10 MRR 0.883**、负样本误报 **0/8**。

## v1.11 P0：注入分层与置信度校准

按《人类复杂性模型》升级规范实现 P0 三项（测试 31 → 34，新增 8 条负样本）：

| P0 | 内容 | 效果 |
|---|---|---|
| P0-1 注入分层 | **常驻层**（画像 `preferences/habits/thinking/identity`、偏好/习惯/约束/纠正类观察）不看话题；**线索层**需 ≥2 个非停用词或 ≥1 个实体；停用词按文档频率 >30% 自动判定；短消息（<6 汉字且无实体）只注入常驻层 | 用户只发“继续”时 preferences 仍在；闲聊技术时不再带入心理推断 |
| P0-2 打分归一 | `bm25n = 2.5 × bm25 / maxPossible`（保留绝对匹配质量）；`coverage` 用 IDF 加权，常见二字组不算覆盖；`coverage < 0.5` 一律 `low` | 无答案查询不再给 medium/high：负样本误报 **2/8 → 0/8**；正样本保持 10/10、MRR 0.883 |
| P0-3 矛盾一致性 | `correct` 改为**复制**矛盾链接（原记录保留）；渲染前完整遍历统计，预算截断不再漏计 | 删除纠正后矛盾链接自然恢复；观察很多时“N 对未解矛盾”数字准确 |

打分公式、分层规则与验收记录见 [DOCS.md](./DOCS.md) 第 4、5、14 章。`eval.mjs` 现在同时输出正样本 hit@3/MRR 与负样本误报率。

## v1.10 评审修复（bug 修复 + 打分重做）

按独立评审（基于源码）修复了 4 个已验证 bug 与 5 个设计问题：

| 问题 | 修复 |
|---|---|
| `recent`/`oldest` 下置信度取到最新而非最高分 | 置信度改为**先按得分序计算**，再按显示排序输出；新增 3 条排序回归测试 |
| `learn` 的标签 lint 可用假 `sourceIds` 或长文本绕过 | 只认可**真实存在**的来源 id；去掉长度豁免，改为“有情境描述才放行”；补充假 id/长文本测试 |
| 未解矛盾提示永久残留 | 只统计**双方都 current** 的对；`correct` 把矛盾链接迁移到纠正记录 |
| `forget` 观察留下悬空引用 / 删掉纠正后原观察卡在 superseded | 删除时清理 `contradicts`/`correctionOf`/`supersededBy`，并让原观察恢复 `current` |
| 画像与证据层断开 | `learn` 支持 `sourceObservationIds`；观察被纠正/删除时 facet 标 `needsRecompute`，注入提示“来源有变更，待重算” |
| 观察/画像每轮无条件注入 | 观察按词/实体相关性门控（纠正除外），`sensitive` 带标记；画像 facet 除 `identity` 外同样门控 |
| 渲染顺序不体现“纠正优先” | 注入固定按 纠正 → 自述 → 事实 → 推断 |
| importance 正反馈 | 检索只记 `accessCount`/`lastAccessAt`，不再加分；importance 只由 deepen/纠正提升，并按闲置时间衰减 |
| 分数量纲混杂 | BM25 按本次查询归一到 0–1 后加权；recency 只对时间意图查询满权重（否则 ×0.3）；impression 降为 0.05 的 tie-breaker |

评测（2102 条记忆、10 条查询）从修复前的 `9/10 MRR 0.800` 变为 **`10/10 MRR 0.883`**，与最优消融（+entity）持平；测试从 27 项增至 31 项。详见 [DOCS.md](./DOCS.md) 第 5、6 章。

## v1.9 证据层：按“人类复杂性”规范重做画像的底座

参考《人类复杂性模型》，把“画像就是结论”改成“画像是对证据的归纳”。新增 `observations` 表：

| 字段 | 含义 |
|---|---|
| `type` | `explicit_fact` / `explicit_preference` / `behavior_observation` / `self_reflection` / `inferred_motivation` / `emotional_state` / `decision_record` / `relationship_context` / `habit_pattern` / `contradiction` / `goal` / `constraint` / `correction` |
| `kind` | `observed`（观察到的事实）/ `self_reported`（用户自述）/ `inferred`（推断，必须带 confidence 与至少一个 alternatives）/ `corrected`（用户纠正） |
| `context` / `quote` / `sourceIds` | 情境、原话、来源会话，避免把推断伪装成事实 |
| `sensitivity` | `normal` / `sensitive` / `private`（private 不注入、不导出明文） |
| `contradicts` | 未解矛盾的另一方 id（不自动消除） |
| `status` | `current` / `superseded` / `withdrawn` |

配套行为：

- `observe`：写观察；`inferred` 缺置信度或替代解释会被拒绝；纯人格标签（“懒惰/内向/敏感…”）会返回 `warning`，提示改成“行为+情境+替代解释”。
- `correct`：用户纠正 → 原记录保留为历史（`superseded`），新记录 `kind=corrected` 成为当前理解；未来回答优先用纠正后的版本。
- `contradict`：把两条观察标记为矛盾，**两者都保留**，由模型决定何时向用户澄清。
- `observations`：按状态/类型列出，含 context、alternatives、sensitivity。
- 注入新增 `## 观察与推断（证据层）`：事实/自述/推断分开列，推断带置信度与替代解释，私密观察只显示条数，未解矛盾会提示。
- `learn` 写入人格标签时同样返回 `warning`，引导用证据层而不是贴标签。
- `export` 增加“观察与推断”一节；`stats.observations` 给出 current/inferred/corrections/contradictions 计数。

这与文档的 8.1（事实/观点/推断分离）、8.2（允许矛盾共存）、8.4（用户自述优先）、8.5（预测≠事实）、10（隐私最小化）逐条对应。**画像 facet 仍是“归纳视图”，但证据层是它的底座，且用户纠正优先于任何推断。**

实测（本轮）：写入 1 条事实、1 条自述、1 条推断（0.45，带 3 个替代解释）、1 条私密、1 条人格标签（返回 `warning`）；`correct` 后原推断变 `superseded`、纠正成为 current；`contradict` 后两条互相标记；注入里事实/自述/推断分列、私密只显示条数、未解矛盾有提示；`stats.observations = {current:5, inferred:2, corrections:1, contradictions:2}`；`export` 含“观察与推断”一节。

## 设计取舍：为什么不再注入“最近三条问答”

当前会话的最近几轮本来就在模型上下文里，越近注意力权重越高；再注入一遍既浪费 token 又稀释注意力。所以：

- **默认不注入同会话问答**（`injectRecentExchanges: true` 可恢复旧行为）；
- 注入只保留两段上下文里没有的内容：**用户画像（7 facet）** + **跨会话印象速览**（默认 2 条、每条 ≤100 字）；
- 同会话历史缺失只发生在上下文压缩之后，那种情况由模型按需 `search` 取回细节。

## v1.4 优化：置信度、交互质量、token 预算

| 方向 | 改动 |
|---|---|
| 置信度 | `search` 返回 `confidence {score,label}`（top 分数饱和值 × 与第二名的 margin），每条结果带 `reasons`（phrase / impression / entity:xxx / bm25），模型能判断“这条到底有多可信” |
| 交互质量 | 默认返回**证据片段**（围绕命中词的窗口，默认 400 字），需要引用原文时再 `full: true`；工具描述与返回 JSON 都精简（紧凑序列化） |
| token 预算 | 画像注入改为**总预算 900 字**（`portraitBudget`）+ 每 facet 240 字；跨会话速览**只在与当前用户请求有词重叠时注入**（`digestImpressions` 默认 2），无关时不出现；`recent`/`search` 默认只回片段 |

实测（458 条记忆的当前会话）：注入总长 **1026 字符**（`stats.injection.chars`），同一查询 `search` 的 compact 结果约为 full 的 **25%**（3.5KB vs 14.7KB）；`full: true` 时才返回完整原文。

## v1.7 记忆保质期与回收区

旧记忆会随时间失真（例如隔了几年再回来，世界已经变了）。v1.7 把“时间”变成一等公民：

| 机制 | 规则 | 行为 |
|---|---|---|
| **间隔检测** | 距最近活跃记忆超过 `gapDays`（默认 30 天） | 注入顶部出现 `## 时间分界（注意）`：说明上次活动在多久前，**当前对话的新信息优先**，冲突直接覆盖；跨会话速览不再注入 |
| **自动归档** | 长间隔时，`time` 早于 `archiveAfterDays`（默认 730 天）的记录 | 移入**回收区**：`archivedAt` 置位、`weight` 降到 `archivedWeight`（0.3），默认不参与检索/注入/导出 |
| **手工回收** | `archive olderThanDays=...` 或 `archive ids=[...]` | 同上；`restore ids=[...]` 可放回 |
| **兜底检索** | `search includeArchived=true` | 回收区仍可查，但打 `archived` 标记并按 0.3 权重降序；`archivedHidden` 告诉你有多少条被默认隐藏 |
| **画像过期** | facet 超过 `freshDays`（默认 180 天）未更新 | 注入时提示“其中 N 项可能过时”，仍保留但降权；`learn` 覆盖时旧内容进历史版本 |
| **覆盖即新** | 长间隔后 `learn` / `deepen` 写入 | 新内容成为当前结论，旧内容只留在 `history`，不会被当成新记忆混入 |

这个设计的取舍：**不删除旧记忆**（可回滚、可追溯），但默认把它移出“活跃判断”，只在明确要考古时才查；避免“四年前的偏好”继续影响今天的回答。

## v1.5 升级：处理已知限制 + 性能

| 原限制 | 处理方式 | 验证 |
|---|---|---|
| 只索引“打开过的会话” | 启动 3 秒后后台索引（`indexBudget` 默认 10），并新增 `index` 动作手动推进；`stats` 显示 `knownSessions` / `sessions` / `indexedByUs` | 运行 `index` 可把未打开的会话回读进库 |
| 旧记录只有助手回复 | 新增 `repair` 动作：从会话日志按“同一轮 + 回答时间”重新配对，补回用户原话，并重建关键词与实体 | `repair` 后 `stats.missingUser` 下降 |
| 中文专名抽不到 | 实体抽取增加引号模式（“…” / 「…」 / 《…》），中英文都覆盖 | 单测覆盖 |
| 置信度只是相对分 | 置信度改为 **absolute + margin + 分布离散度(separation)** 三合一；`separation` 衡量“第一名相对其他匹配的 z 分数”，匹配扎堆时自动降级 | 单测“dominant vs crowded” |
| 片段可能切断句子 | 片段边缘向最近的句末标点（。！？!?;\n）扩展，最多 padding limit/4 | 单测句末断言 |
| 速览门控漏同义 | 门控除词重叠外，增加**实体重叠**：当前请求的实体出现在速览记录里就注入 | 见 `renderContext` 逻辑 |
| 检索性能 | 每行 token 频次/长度/集合缓存在 WeakMap（`docOf`），文本变更时精准失效；实体索引与关键词缓存复用 | 基准：cold p95 76ms → warm p50 5.3ms |

基准命令：`node bench.mjs`（12 条查询、5 轮预热，当前 2091 条记忆）：

```
rows: 2091, queries: 12
cold  p50: 8.9 ms  p95: 304.2 ms   ← 首次全量分词；启动 5 秒后后台 warmup，用户首个请求不再走这条路径
warm  p50: 7.0 ms  p95: 14.7 ms
result size: compact 3.5 KB vs full 14.7 KB (24%)
```

实际成效：`index` 把未打开的会话补进库（known 61 / 已索引 45 / 剩余 16，记录从 660 增至 1936）；`repair` 补齐 **249 条**缺用户原话的旧记录，`stats.missingUser` 归零；在 2091 条数据上 warm 检索 p50 仍为 7ms。

## 能力分层（P0 → P4 全部落地）

| 层 | 能力 |
|---|---|
| P0 | 抓取/清洗、BM25 + 短语 + 印象 + 时间衰减检索、时间窗与排序、印象与画像历史版本、来源溯源、近似去重 |
| P1 | 后台整合（turn/end 归并裁剪）、记忆类型分层（episodic/semantic/procedural）、工作区隔离、离线评测 |
| P2 | **实体索引**（域名/路径/标识符/缩写 → 记录）、实体加权检索、`entities` 浏览与相关记录 |
| P3 | **重要度 + 访问强化**（检索命中加分）、**重问检测**（同一问题新答案 → 旧记录标 `supersededBy` 降权）、**Markdown 导出** |
| P4 | **`/dmem` 命令**（stats / portrait / export / search）、`stats` 健康度、纯函数测试套件 |

## 工作原理

- **抓取**：监听 `user/message`、`assistant/message`、`turn/start`、`turn/end`，按“一问一答”配对（只取文本）。`turn/start` 会清掉上一轮残留的助手文本，避免把旧回复配到新问题；插件重载发生在回合中途时也不会串轮。记录保存原话、完整回复、印象（含历史版本）、关键词、实体、工作区、类型、重要度、访问统计、失效标记。
- **清洗**：Harness 注入的运行时上下文（`Current runtime context…`、`Time sampled…`、`## 用户画像`、`## 记忆速览` 等）不会当成用户问题；纯元信息消息跳过。
- **去重**：同会话完全重复跳过；文本 Jaccard ≥ `dedupeJaccard`（0.95）的近似重复跳过。
- **重问检测**：同一会话里问题高度相似（≥0.8）但回答差异明显（<0.6）时，旧记录标 `supersededBy`，默认检索降权 50%。
- **后台整合**：`turn/end` 后 1.5 秒 debounce，合并近似重复、裁剪超限、落盘访问统计。
- **检索**：`search` 多路加权——BM25、短语命中、印象命中、**实体命中**、时间衰减、重要度乘子、失效惩罚；支持时间窗、排序、类型与作用域过滤；同时返回命中的画像 facet。
- **加深**：`deepen` 写入/修订印象，旧摘要进 `history`，重要度提到 0.8。
- **画像**：`learn` 写入/替换 facet（旧内容进历史，可带 `sourceIds`）；`portrait` 读取，`includeHistory` 看历史。`target` 区分**用户画像**（habits / preferences / thinking / dynamics / psychology / past / identity）与 **助手画像**（`target=assistant`：habits / preferences / psychology / experience，见下节）。
- **实体**：从文本抽取域名/URL、文件路径、kebab/snake/dotted 标识符、CamelCase、缩写；`entities` 可看 Top 实体或某实体的相关记录。
- **导出**：`export` 写 `memory.md`（画像 + 最近 30 条印象 + 统计）。
- **持久化**：Harness `storageDomain`（JSON 后端、per-record 布局），重启自动载入；新会话首次出现时从会话日志回读建索引。
- **自愈**：存储不可用时降级为内存模式，`storage` 字段说明原因。

## 数据位置

`$DSH_HOME/storages/dynamic_memory/`（默认 `%USERPROFILE%\.dsh\storages\dynamic_memory`）：

- `exchanges/r_<id>.json`：

```json
{ "version": 1, "record": {
  "id": "...", "sessionId": "...", "workspace": "C:\\Users\\<you>", "kind": "episodic",
  "time": 1763000000000, "updatedAt": 1763000000000,
  "user": "用户原话", "assistant": "助手完整回复",
  "summary": "当前印象", "history": [{ "summary": "旧印象", "at": 1763000000000 }],
  "keywords": ["..."], "entities": ["example.com", "dropdown.vue"],
  "importance": 0.39, "accessCount": 2, "lastAccessAt": 1763000000000,
  "supersededBy": null, "sourceIds": []
} }
```

- `portrait/p_<facet>.json`：用户画像 facet（`content`、`history`、`sourceExchangeIds`）。
- `self/s_<facet>.json`：助手画像 facet（结构同上，facet ∈ habits / preferences / psychology / experience）。
- `memory.md`：`export` 生成的人类可读汇总（用户画像 + 助手画像 + 印象 + 统计）。

## 工具

| action | 作用 |
|---|---|
| `recent` | 本会话最近若干条问答（含印象） |
| `search` | 关键词检索原文；`from`/`to`、`sort`、`kind`、`scope`、`includeSuperseded`；默认返回证据片段 + `confidence` + `reasons`，`full: true` 返回完整段落 |
| `archive` | 把闲置超过 `olderThanDays` 的记录移入回收区（也可用 `ids` 指定）；默认不再参与检索/注入 |
| `restore` | 把 `ids` 从回收区放回活跃集 |
| `entities` | Top 实体（计数）或某实体的相关记录 |
| `index` | 后台/手动索引尚未打开过的会话（`limit` 控制本轮数量） |
| `repair` | 从会话日志补回缺失的用户原话，重建关键词与实体 |
| `deepen` | 写入/修订印象（保留历史版本，提升重要度） |
| `forget` | 删除指定记录；带 `facet` 时清空画像 facet |
| `portrait` | 读取画像（可单查、含历史与来源）；`target=assistant` 读助手画像 |
| `learn` | 写入/替换一个 facet（可选 `sourceIds`）；`target=assistant` 写助手画像 |
| `stats` | 记录/会话/类型/实体/重要度/健康度/命令状态 |
| `export` | 导出 `memory.md`，返回路径与字节数 |

## 命令

在输入框打 `/dmem`：

| 命令 | 作用 |
|---|---|
| `/dmem` 或 `/dmem stats` | 记录数、画像数、实体数、平均重要度、存储状态 |
| `/dmem portrait` | 打印用户画像 |
| `/dmem self` | 打印助手画像 |
| `/dmem search <关键词>` | 返回 3 条相关记忆（日期 + 用户 + 印象） |
| `/dmem export` | 导出 `memory.md` |

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `injectRecentExchanges` | false | 是否注入同会话最近问答 |
| `digestImpressions` | 2 | 跨会话印象速览条数（0 关闭，且需与当前请求有词重叠） |
| `digestChars` | 100 | 速览每段截断长度 |
| `recentExchanges` | 3 | `recent` 默认条数 / 旧注入模式条数 |
| `promptCharsPerExchange` | 1200 | 旧注入模式每段截断 |
| `portraitCharsPerFacet` | 240 | 用户画像单 facet 注入截断 |
| `portraitBudget` | 900 | 用户画像注入总预算（字符） |
| `assistantCharsPerFacet` | 180 | 助手画像单 facet 注入截断 |
| `assistantBudget` | 520 | 助手画像注入总预算（字符） |
| `injectAssistantPortrait` | true | 是否注入助手画像 |
| `snippetChars` | 400 | `search`/`recent` 证据片段长度 |
| `autoIndexSessions` | true | 启动后自动索引未打开过的会话 |
| `indexBudget` | 10 | 每次自动索引的会话数上限 |
| `warmup` | true | 启动 5 秒后预热分词/片段缓存 |
| `gapDays` | 30 | 多久算“长时间没联系”，触发时间分界提示 |
| `archiveAfterDays` | 730 | 长间隔时，比这更旧的记录自动进回收区 |
| `autoArchive` | true | 长间隔时自动归档 |
| `archivedWeight` | 0.3 | 回收区记录在 `includeArchived` 检索中的权重 |
| `freshDays` | 180 | 画像 facet 超过多久算“可能过时” |
| `maxExchangesPerSession` | 1000 | 单会话上限 |
| `dedupeJaccard` | 0.95 | 近似重复阈值 |
| `timeBoost` | 0.8 | 时间衰减权重 |
| `timeDecayDays` | 180 | 时间衰减尺度 |
| `scope` | workspace | 默认检索范围 |
| `exportPath` | `$DSH_HOME/storages/dynamic_memory/memory.md` | 导出路径 |

## 测试与评测

```powershell
node test.mjs   # 纯函数测试（27 项）
node eval.mjs   # 检索评测（10 条真实问题）
```

纯函数测试覆盖：实体抽取与索引、实体-only 查询、失效降权、重要度加权、时间排序与时间窗、访问强化、重问判定、上下文清洗。

检索评测（当前 2091 条真实记忆，k=3；随数据增长数字会变化）：

```
baseline  hit@3: 8/10  MRR: 0.683
bm25      hit@3: 8/10  MRR: 0.800
+phrase   hit@3: 9/10  MRR: 0.900
+entity   hit@3: 9/10  MRR: 0.900
full      hit@3: 9/10  MRR: 0.850
```

> 语料从 458 条扩到 2091 条后，同样的查询面对的候选多了 4 倍，个别目标掉出 top-3（`部署 公网 首页 200`）；短语/实体两档仍是 9/10、MRR 0.90，优于 baseline 的 8/10、0.68。

- BM25 把两条查询从第 3 位提到第 1 位；
- 短语命中让 `Dropdown.vue` 从榜外进到第 1；
- 实体加权在这组查询上未额外提升（短语已覆盖），但支撑了实体浏览与实体-only 查询；
- 印象加权最初 1.2 时会把“部署 公网 首页 200”的目标挤下去，扫权重后定为 0.6。

## 已验证

- 安装后 `application: applied`，工具与 `/dmem` 命令在当前 Agent 可用；
- 注入只含用户画像 + 助手画像 + 相关跨会话速览，不重复同会话问答；`stats.injection.chars` 可读当前注入长度（**1704 字符**：用户画像约 1026、助手画像约 600）；
- `index` 实测把 10 个未打开会话补进库：known 61 / 已索引 45 / 剩余 16，记录 660 → 1936；
- `repair` 实测补齐 249 条缺用户原话的旧记录，`stats.missingUser` 从 249 归零；
- `search` 默认返回片段 + `confidence {score,label,margin,separation}` + `reasons`，`full: true` 才返回完整原文；
- `entities` 返回 Top 实体与指定实体的相关记录；实体数从 1002 增至 1600；
- 访问强化实测：连续检索同一条记录，重要度 0.35 → 0.37 → 0.39；
- `export` 写出 `memory.md`（用户画像 + **助手画像** + 最近 30 条印象 + 统计）；时间窗、排序、`deepen`/`learn` 历史版本、`sourceIds`、`forget` 均实测通过；
- **助手画像**：4 个 facet（习惯/喜好/心理/经历）写入后立即出现在 `## 助手画像（自查）`，落盘 `self/s_<facet>.json`，`export` 与 `/dmem self` 可读；
- **回收区**：`archive ids=[...]` 后 `stats.archived=1`，默认检索的 `total` 与 `archivedHidden` 变化、`includeArchived=true` 才能看到（带 `archived` 标记、权重 0.3）；`restore` 后回到活跃集，重载后状态仍保持；
- **时间分界**：长间隔注入与画像过时提示由纯函数测试覆盖（`gapDays ≥ 30` 时出现“时间分界”，且速览不再注入）。
- 后台整合 `lastConsolidatedAt` 会被 `turn/end` 触发；
- 纯函数测试 16/16 通过（含置信度分离度、句末片段、引号实体、失效降权、重问判定）。
- 基准：2091 条记忆下 warm 检索 p50 7.0ms、p95 14.7ms；compact 结果为 full 的 24%。

## 已知限制

1. **没有向量语义检索**：同义改述（“部署” vs “上线”）召回有限，靠二字组、短语与实体；真语义需要 embedding provider（当前 `llm` 服务只提供 chat 流，不含 embedding）。
2. **只索引“打开过的会话”**：未打开的历史会话不会自动进库。
3. **重问检测是启发式**：问题相似 + 回答差异才判重问，措辞变化大时会漏。
4. **旧记录有 250 条只有助手回复**（早期抓取覆盖导致），已标记 `userMissing`，仍参与检索。
5. **实体抽取基于正则**：中文专名（无英文词形）抽不到，靠二字组兜底。
