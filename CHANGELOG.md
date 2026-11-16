# 变更记录

版本语义：`1.x.y`，`x` 增加能力，`y` 修复。`package.json` 当前为 **2.2.0**；**未发布**——无 Release、非 Latest、npm 未推送（`private: true`）。

## 2.2.0 — 同意开关、digest 实测与评测加固

**当前状态**：v2.2.0 已实现 C1-C4 同意开关并在真机验证；评测标签迁移后真实指标回升。代码以 commit `d6f5b0c release: v2.2.0 consent switches + digest metric + eval hardening` 为准。

- **同意开关 C1-C4（已实现，真机验证）**：`consent.memory / inject / profile / sensitive` 持久化到 storage 的 `consent` 表，重载后保留；真机 `/dmem stats` 验证状态 **`memory=on inject=on profile=unified sensitive=off, storage=durable`**。C1 关闭时：不捕获、不注入、后台索引也停。
- **命令与工具**：`/dmem consent` 看状态；`/dmem consent on|off`（C1）、`/dmem consent inject on|off`（C2）、`/dmem consent sensitive on|off`（C4）、`/dmem consent profile unified|situational|off`（C3）；工具 action 也可传 `consent={memory,inject,profile,sensitive}` 部分字段。
- **digestCount 改真实快照**：`stats` 的 `digestCount` 取上一轮提示组装的实际注入结果（附 `digestTotal` / `digestReason`），不再硬编码；2.1.2 条目里的"真机待验证"由此收口。
- **评测加固（真实集，本机亲手运行）**：迁移评测标签后 hit@3 **9/10**、MRR **0.750**（标签迁移前 7/10、0.600）；加 `--min-coverage 0.6` 后误报 **0/8**（无门控 1/8）；`--fixture` **5/5**（MRR 1.000、FP 0/2）。玩法：`node eval.mjs`、`node eval.mjs --min-coverage 0.6`、`node eval.mjs --fixture`。
- **剩余 1 条真实损失**：`部署 公网 首页 200`——摘要截断（90+60 字符）使 `公网`/`首页` 未被保留，rank 47；属覆盖缺口，非打分问题（详见评测报告）。
- 测试（本机亲自运行，commit `d6f5b0c`）：`test.mjs` **52** 项、`test-host.mjs` **147** 项。
- **明确未做（不写作已完成）**：① 面板 UI（阶段 4）；② 说话者归属（`speaker` 注册表 / exchange `origin` / 助手画像隔离，阶段 3.2）；③ situational 画像按情境分组（`profile=situational` 可选，但分组尚未实现）；④ 真机移动端未测；⑤ **memory off 时的显式写入硬拦截正在修**（当前 C1 关闭会停捕获/注入/后台索引，工具显式写入路径的拦截未完成）。

## 2.1.2（未发布，内容并入 2.2.0）— 索引化收尾与水合可靠性

**当时状态**：v2.1 索引化捕获已落地、真实库迁移完成，水合（按 pointer 回读原文）收尾——真机抽检 **19/20 = 95%**。代码以 commit `60ab15b fix(index-only): execute /dmem migrate and make repair counts live` 为准。

- **存储**：新行只写 `summary` / `keywords` / `entities` / `time` / `textHash` / `pointer`（sessionId+时间）；`user` / `assistant` 为空串。`textHash` 是对"清洗后 user + `\n` + 最后一轮 assistant"的 SHA-256，只用于水合校验，不是加密，也不可还原内容。
- **读取原文**：search 命中后按 pointer 读本地 Harness 会话，用 `textHash` → `summary` 前缀 → 单一时窗候选三级回退配对，返回片段（`full=true` 返回整段）。
- **水合实测（真机抽检）**：20 条命中样本中 **19 条**成功回读（95%）；**1 条显式失败，不伪造片段**——会话 `session-be60e2ac…` 的该行（摘要以"p2继续，自动继续p3 p4…"开头）返回 `sourceAvailable:false`、`user`/`assistant` 为空、`hydrationError: no matching user message in session … (54 candidates)`；属 **no-match**，不是 ambiguous，也不是会话不可读。复跑：`search query="继续 修复 插件" limit=10` 第一条即该样本。
- **失败语义（保持）**：任何未通过校验的命中一律置空并附 `hydrationError`（≤160 字符），哈希/摘要/时窗出现多候选时**拒绝猜测**；摘要、关键词、实体仍可参与检索与排序。
- **迁移已可用**：工具 action `migrate mode=strip confirm=true` 与 `/dmem migrate mode=strip confirm=true` 共用 `migrateStrip`（先导出再剥离，缺 `confirm=true` 拒绝执行）；本机已用其剥离 **2120** 条旧记录原文，释放约 **2.9M** 字符。
- **digest 注入**：代码已改为 summary-based 选取，host 测试断言 `digestCount ≥ 1` 通过；当时真机 `/dmem stats` 仍为 `digestCount=0`（重载后未复现），故当时标"测试通过，真机待验证"——**2.2.0 已改为真实快照，见上**。
- **repair**：不再回写 user/assistant 明文（host 断言明文行保持 0）；`plaintextRows` 已改为实测（`countPlaintextRows`）并新增 `plaintextCleared`，此前"硬编码 0"的问题在本 commit 修正。
- **回滚缺口（诚实边界）**：剥离前的导出是 `memory.md` 可读档案（画像/观察/最近 30 条印象，用户文本 ≤80 字符），**不是逐字备份**；要逐字恢复只能靠剥离前的存储快照。已在 README 写明，不夸大回滚能力。
- **无加密**：不做应用层加密/口令，隐私依赖全盘加密与文件权限；这是产品边界，不是待办。
- **意图**：系统会话是原文唯一来源，插件只存本地派生索引；无遥测、无云同步。
- 测试（commit `60ab15b`，本机亲自运行）：`test.mjs` **52** 项、`test-host.mjs` **93** 项（含水合成功、显式 no-match、歧义拒绝、重复提问去重、migrate 工具/命令的拒绝与成功剥离、repair 实测计数）。
- **历史待验证项（已由 2.2.0 收口）**：真机 digest 注入当时需见 `digestCount ≥ 1` 而不得；2.2.0 已把 `digestCount` 改为真实注入快照。
- **发布状态**：当时 `package.json` 为 2.1.1 且 `private: true`；2.2.0 已升版，仍未发布——无 Release、非 Latest、npm 未推送。

> 勘误：2.1.0 条目里"旧数据迁移与面板留待下一步"已过期——迁移命令 2.1.1 已提供并已执行；仍未做的是面板（阶段 4）与迁移前后对比评测（阶段 2.2）。

## 2.1.1 — 旧数据剥离

- 新增 `migrate mode=strip confirm=true`：先导出 memory.md，再把旧记录的 user/assistant 原文剥离，保留摘要/关键词/实体/指针；返回剥离条数与释放字符数；
- `stats.plaintextRows` 可见还剩多少条明文；
- 回滚方式：保留导出文件；剥离后检索通过本地会话水合片段。

## 2.1.0 — 索引化捕获（第一步）

- 新增 `retainText`（默认 false）：捕获时不再写 user/assistant 原文，只写摘要、关键词、实体、时间、textHash 与 pointer（sessionId+时间）；
- 检索 haystack 支持无原文记录（summary/keywords/entities）；search 命中后用本地 sessionQuery 按时间回读片段，失败标 sourceAvailable:false；
- 加载与 recent 允许仅摘要记录；host fixture 断言存储无明文、摘要存在、可检索；
- 旧数据迁移（/dmem migrate strip）与面板留待下一步；测试 52，host 16。

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
