# 变更记录

版本语义：`1.x.y`，`x` 增加能力，`y` 修复。当前为 **2.0.3**（测试版）。

## 2.0.3 — 低开销与首次安装体验（2026-11-16）

- **工具描述瘦身**：TOOL description 从 ~7.3KB 缩到 ~0.5KB，单次请求固定开销明显下降；
- **自动抽取摘要**：捕获时生成 90+60 字的抽取式摘要（无 LLM 调用），跨会话速览不再因 `summary` 为空而永远空转；配置 `autoSummary: false` 可关闭；
- **身份连续性默认关闭**：只有 `identityNotice: true` 且基线 ≥20 条、连续性 <0.3、间隔 ≥3 天才注入，避免把换模型/换话题误判成"换人"；
- **隐私默认收紧**：`observations` 对 `private` 记录只显示占位符，需 `includePrivate: true` 才返回原文；
- **文档**：README 增加"成本与适用场景"，明确低价值场景建议用官方 session search + notes.md；
- 测试 51 → 52；host fixture 16 项（含自动摘要断言）。

## 2.0.2 — 中文文档为主版本（2026-11-16）

- README 改为**中文为主版本**（README.md），英文移至 README.en.md；两份互相链接；
- 解释发布渠道：当前只有 GitHub Pre-release（测试版），没有发布 Stable/最新版，npm 未发布；
- v2.0.1 文档 Release 转为 Draft（不公开），等确认后再发布；
- 无运行时行为变化；测试 51/51、host fixture 16/16。

## 2.0.1 — 文档发布（2026-11-15）

- DOCS：补齐 v2.0 多语言与开放预设章节、配置项（locale/facets/assistantFacets/capture）、测试数（51 + host 16）、路线状态与变更记录；
- README.zh-CN：重写并同步 v1.14/v2.0（证据层、披露策略、国际化、可配置 facet、安装/限制）；
- CONTRIBUTING：增加语言边界说明（运行时文案必须走 locale，注释/文档可用中文）；
- 无运行时行为变化；测试 51/51、host fixture 16/16。

## 2.0.0 — 多语言与去预设（2026-11-15）

- **运行时国际化**：所有注入文本、facet 标签、工具描述、命令文案改由 `locale/messages.{zh,en}.json` 提供；`locale: auto`（默认）按用户消息语言选择，可强制 `en`/`zh`。
- **去关键词化**：人格标签词表、身份自述短语、实体停用词移入 locale 数据；核心 lint/身份逻辑不再内建中文词表。英文词表同时提供。
- **语言中立分词**：中文二字组 + 拉丁词之外，新增阿拉伯/西里尔/希腊/泰/天城文等脚本的词级回退，避免非中英用户检索为空。
- **预设可配置**：用户/助手 facet 列表可由 `facets`/`assistantFacets` 配置，持久化 schema 不再限定固定 facet；`psychology` 等默认 facet 可移除。
- **文档**：README 英文为主版本，中文移至 `README.zh-CN.md`；注释与设计文档仍可用中文。
- 测试 49 → 51（新增 locale 检测/英文注入/阿拉伯文检索）；host fixture 16 项。
- 诚实边界：英文/其他语言是功能性支持（提示、标签、词表、分词回退），仍需母语者打磨；命令输出仅部分本地化。

## 1.14.0 — 巩固、重算与披露策略（v1.13 + v1.14 合并发布）

- **画像版本绑定自己的来源**：`learn` 写新版本时使用本次提供的来源；旧版本把自己的来源集合留在 `history` 里，不再跨版本累积。
- **`mention` 披露策略**：`proactive / if_asked / never`；默认由 `sensitivity + scope + type` 派生（私密 → never；敏感/短暂/情绪/关系 → if_asked）。`if_asked` 注入带“仅语气，不主动提”标记；`never` 不进入上下文，但仍可用 `observations` 查看。
- **`reflect` 巩固草稿**：按内容相似度聚类当前观察，只有出现在 **≥3 个不同会话** 才生成 `status: proposed` 草稿；草稿不注入，需 `review decision=accept|reject` 后才进入 current/withdrawn。
- **`recompute`**：返回该 facet 仍存活的来源观察、已失效来源 id、上一版内容，供模型一次取齐证据后重写（不自动写入）。
- **`duplicates`**：画像 facet 与当前观察的跨层重复报告（相似度 ≥0.6），只报告不删除。
- **误注入率与校准**：`eval.mjs` 增加 confidence 分桶命中率（calibration），与 false-positive 并列输出。
- 测试 45 → 49；`test-host` 扩展到 16 项（含版本来源绑定）。

## 1.12.3 — 发布可靠性（2026-11-15）

- **卸载不再丢数据**：清理改为 async，先执行待整合、`await flushDirty()`、等待全部在途写入，再 `await domain.close()`。
- **删除级联**：`forget` 删除 exchange 时，清理 facet 的 `sourceExchangeIds` 与 observation 的 `sourceIds`，并标记 `needsRecompute`。
- **可暂停捕获**：`capture: false` 配置 + `/dmem pause|resume|capture`；`stats.capture` 可见。
- **评测数据本地化**：真实评测集/草稿移出仓库（gitignore），包 `files` 移除；CI 使用合成 `eval-queries.fixture.json`；测试与基准中的真实域名替换为 `example.com`。
- **新增 mock host 夹具**：`test-host.mjs` 覆盖持久化、注册、抓取、卸载顺序、重启恢复、`capture:false`、级联删除。
- README/DOCS 修正过时的“访问强化”描述；第 14 章替换为合并版路线。

## 1.12.2 — 印证入口补强

- `observe corroborates=<id>` 必须带 `quote`（≥4 字），插件在当前会话用户消息中校验，找不到时回退会话日志；不通过则拒绝（防止自我印证强化）。
- 推断置信度与 TTL 的衰减锚点改为 `lastCorroboratedAt`（复习重置遗忘曲线）。
- `learn target=user facet=psychology` 必须带真实存在的 `sourceObservationIds`。
- 助手“喜好”去重，只保留助手侧产出约定；文档注明 facet 键名与显示标签的差异。
- 测试 43 → 45。

## 1.12.1 — P1-2 缺陷修复

- TTL 锚点改为 `lastCorroboratedAt`：无关编辑（`contradict`/`correct`/引用清理）不再续期。
- 新增 `observe corroborates=<id>` 显式印证入口：不同会话追加、续期、置信度 +0.1（上限 +0.2）；同会话 no-op。
- `correct` 使用 `scopeOf(original)` 继承派生 scope，短期观察的纠正不再永久化。
- `observe` 修正忽略 `observationType`（此前全部落成 `behavior_observation`）。
- 敏感项即使 `kind=corrected` 也需线索，不每轮注入。
- 测试 41 → 43。

## 1.12.0 — 时间属性与助手画像改造

- 观察 `scope` 读取时按 `type` 派生（旧数据不回写）：transient 3 天 / situational 30 天 / durable 无期限；TTL 只停止注入，不删除。
- 推断有效置信度按 90 天半衰期衰减 + 独立会话有上限增强；`contradict conditional=true` 不计未解矛盾。
- 助手画像：`psychology → 工作方式`、`experience → 可核对经验`，内容改为可验证行为并带来源；旧画像归档可回退。
- 修正 P0 遗留：常驻层敏感项检查覆盖所有分支；线索判定改为不重叠共享词计数；常驻项优先占预算。
- 测试 34 → 41。

## 1.11.0 — P0（注入分层与置信度校准）

- 注入分层：常驻层（偏好/习惯/思考/身份与偏好/习惯/约束/纠正类观察）不依赖话题；线索层需 ≥2 个非停用词或 ≥1 个实体；短消息只注入常驻层。
- 打分保留绝对质量：`bm25n = 2.5×bm25/maxPossible`；IDF 加权 `coverage`，`coverage<0.5` 不给 high/medium。
- 矛盾链接改为复制、计数在渲染前完成。
- 新增 8 条负样本；误报 2/8 → 0/8，正样本保持 10/10 MRR 0.883。
- 测试 31 → 34。

## 1.10.0 — 评审修复

- 置信度在得分序上计算，再按显示排序输出（修复 `recent`/`oldest` 错算）。
- 标签 lint 只认真实存在的来源 id；矛盾只统计双方 current；`forget` 清理悬空引用并恢复被纠正的原观察。
- 画像支持 `sourceObservationIds` 与 `needsRecompute`；观察/画像注入加相关性门控与“纠正 → 自述 → 事实 → 推断”排序。
- 检索不再抬高 importance，加入闲置衰减；BM25 按查询归一化；recency 按时间意图加权；impression 降为 tie-breaker。
- 测试 27 → 31。

## 1.9.0 — 证据层与身份连续性

- 新增 `observations` 证据层：事实/自述/推断/纠正分离；推断必须带置信度与替代解释；纠正优先；矛盾保留。
- `identity`：说话人连续性证据（词汇/实体/风格/间隔/自我声明），只给证据不下结论。
- 回收区、间隔检测、画像过期、置信度检索。

## 1.0–1.8（摘要）

- 一问一答持久化、用户画像 7 facet、助手画像、跨会话检索（BM25 + 短语 + 印象 + 实体 + 时间）、时间窗与排序、印象历史版本、去重与重问检测、`/dmem` 命令、`stats` 健康度、导出 `memory.md`、后台索引与 `repair`、助手画像（v1.6）、回收区（v1.7）、身份证据（v1.8）。
