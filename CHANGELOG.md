# 变更记录

版本语义：`1.x.y`，`x` 增加能力，`y` 修复。`package.json` 当前为 **2.5.2**（测试版，tag 已推送；**npm 未推送**——`private: true`、非 Latest）。

## 2.5.2（docs-only）— 文档漂移修正

- 统一测试数为 **52 + 269**（README / DOCS / PLAN；历史条目只写"测试通过"，不再留旧计数）；
- 修正版本状态：2.4.0 为**测试版、已发布**（与 tag `v2.4.0` 一致），不再是"未发布"；
- 评测口径统一为本机实测：**9/10、MRR 0.750、`--min-coverage 0.6` 时 FP 0/8、fixture 5/5**，并标注"真实集样本少、非冻结测试集"；
- 隐私清理：文档不再含真实域名、本机路径与真实评测查询原文；
- **无运行时改动**，代码与 2.5.1 相同。

## 2.5.1 — 隔离 GC 安全加固

- `gcRequireInventory` 默认 true：只有 listSessions() 成功返回数组才算完整清单；缺失/报错/非数组时不标 dormant、gc 即使 confirm=true 也 dry-run（reason=unverified-inventory），零删除；
- 去掉“有 session header 即 owner”回退：缺 parentSession/origin/delegationDepth 且无 registry/ownerAgentIds 时 role=unknown，读写/注入全拒，绝不静默用 owner；
- scope/stats 暴露 inventory{verified,source,known,gcRequireInventory}、dormantReason、unknownScopes；
- 测试 52 单元 + 269 host；真机 inventory verified=true、known=71、gc dry-run 零删除。

## 2.5.0 — 多智能体记忆隔离与 dormant 画像 GC

**背景**：teammate/subagent 与主会话原先共享同一份记忆库，子 agent 能读到用户画像、也能写入 owner 记忆。2.5.0 引入显式命名空间：owner（用户）默认隔离，子 agent 注入为空、写入被拒。

- **`memoryScope` 三档**：`owner`（默认）——只有顶层（root）agent 使用 owner 记忆，subagent/teammate 读不到也写不进（返回 `isolated:true` 与原因）；`agent`——每个 `agentId` 一个命名空间（root agent 仍可见升级前的未标 scope 旧行）；`shared`——保持旧行为，所有 agent 共用一份（兼容旧安装）。
- **身份识别（不猜测，fail-closed）**：优先级 `config.ownerAgentIds`（数组或逗号串，显式指定）> session header（`parentSession` / `origin=subagent` / `delegationDepth>0` 判为 delegated）> `agents.roots()` vs `list()`（roots 为 owner，其余为非 root delegate）。仍无法识别 → `role=unknown`，**不读不写**，并提示配置 `ownerAgentIds`。实测 `scope=owner`、`identity source=agents-roots`、`canRead/canWrite=true`、`dormantFacets=0`。
- **画像主键改用 scopeId**：`owner` 或 `agent:<agentId>`，**不是 sessionId**；每条 exchange/observation/portrait 都带 `scopeId`（旧数据无 scopeId 视为 owner）。存储键：owner 用 `p_<facet>`，agent 用 `p_<scopeId>:<facet>`；portrait 额外带 `agentId` / `agentPreset`。
- **归档 vs 删除**：`archive` / `restore` 只动 exchange，**画像保持 active**；只有会话被删除（不在 live agents，也不在 session 列表）才把该 scope 的画像标 `dormant`——只标记、不删除、不再注入，`stats.dormantFacets` 与 `/dmem scope` 可见；owner 画像永不被标 dormant。
- **`/dmem scope`**：输出模式（含 configured）、当前身份（role + source + sessionId）、命名空间、读/写权限、显式 `ownerAgentIds`、dormant 画像与说明；工具 `action=scope` 等价。
- **`/dmem gc`**：默认 **dry-run**（只列孤儿 scope 与 dormant facet 数，不删任何东西）；`/dmem gc confirm=true`（工具 `action=gc` + `confirm=true`）**只删 dormant 画像**，不碰 owner、不碰活跃 agent；非 owner 级身份会被拒绝。实测 dry-run 无删除。
- 测试：`test.mjs` **52**、`test-host.mjs` **269**（新增 owner 模式拒绝/注入为空、重载持久化、shared 兼容、显式 ownerAgentIds、agent 模式命名空间、归档保持 active、删除→dormant→不注入、gc dry-run/confirm、owner 不受影响）。
- 评测（本机复跑，v2.5.0）：hit@3 **9/10**、MRR **0.750**（`--min-coverage 0.6` 时误报 **0/8**，无门控 1/8）；`--fixture` **5/5**。
- **诚实限制**：① Harness **没有独立持久 agentId**——身份来自 session/agent id 与 header/registry，同一个人换会话无法自动认回；② 删除会话后**只能标 dormant**，没有"人已删除"的持久墓碑，新会话不会自动继承旧画像；③ **未在真机验证**并发 `agents.roots()` / `listSessions()` 的时序（极短窗口内可能误判 dormant）；④ 2.5.0 为测试版，npm 未推送。

## 2.4.0（测试版，已发布）— dsh-go 原生记忆面板

**背景**：dsh-go 是 Flutter 原生界面，不执行 Web client 插件（v2.3.0 的 `client.js` 只在 Web/桌面可见），手机上看不到任何记忆入口。本次给同一包补一份 dsh-go 原生贡献。

- **清单**：`package.json` 新增 `"main": "index.js"` 与 `dshGo`（`v: 1`、`title.zh/en` 为「记忆」/Memory、`icon: settings`、`wants: []`、`contributes.panels` 一项 `memory-settings`：title「记忆设置」/Memory settings、`placement: ["session.tab","features","chat.panel"]`、`presentation: "page"`）；版本升 2.4.0。`dsh.bundle.patch` 与 `exports["./client"]` 保留 → **Web/桌面面板行为不变**。
- **注册**：`index.js` 末尾 `ctx.inject(['dshGo'], …)`（在既有 return 之前）。只有手机 App 引擎提供 `dshGo` 服务时才执行；桌面/Web/CLI 下子 fiber 不启动，不注册任何东西。
- **只读快照** `dshGoSnapshot()`：读 `consentStatus()`、`storageState`、`rowsById.size`、`countPlaintextRows()` 与上一次注入的 `chars`；**不新开网络、不额外读文件、不依赖 agent**。无会话快照时回退到最近一次。
- **面板能力**：存储健康（storage / 索引条数 / plaintextRows / 上次注入字符）+ **四个 C1–C4 开关行** + **五个按钮（暂停捕获、恢复捕获、导出、复制状态、同意说明）**。视图为声明式 v2（stack / keyValue / list / callout / actions），中英文案取 `locale/messages.*.json` 的 `panel.*`（**21 个键**，zh/en 对齐）；每个注册 action 都有可达入口。
- **写路径只走命令**：toggle 只产生 `/dmem consent …`——memory → `/dmem consent on|off`（注意：不是 `consent memory …`），inject → `/dmem consent inject on|off`，sensitive → `/dmem consent sensitive on|off`，profile 按 `unified → situational → off → unified` 循环（off 可达）；导出发 `/dmem export`；暂停/恢复发 `/dmem pause|resume`。actions 只返回声明式 effect（`command`/`copy`/`toast`，单次 ≤4），**不直接写 storage**，状态与工具/Web 面板共用同一条持久化路径。
- **App 内入口（按 spec）**：对话详情 →「插件」→「记忆设置」；「全部功能」→「记忆设置」；输入框「插件」胶囊 → 弹层（`chat.panel`）。
- **隐私边界**：不新增网络请求；不读剪贴板/输入框/消息（`wants: []`）；导出只写本地 `$DSH_HOME/storages/dynamic_memory/memory.md`。
- **安装/生效**：清单改动自动重读；`index.js` 改动需在 App「引擎」页重启引擎。若桥接只扫 `$DSH_HOME/dsh-go/plugins/` 而没走 profile 依赖发现，需再用 `dsh plugin --profile web add <包目录>`（发现规则仍需真机确认）。
- **卸载/回滚**：`dsh plugin --profile web remove @local/dynamic-memory` 后删包目录；记忆数据在 `$DSH_HOME/storages/dynamic_memory/`，不受影响。回滚面板：重装 2.3.0（Web）或移除 `dshGo` 清单（App 入口消失，数据不动）。
- **自检**：`node ui/verify-dshgo.mjs` 静态 **46 PASS + 1 INFO**（manifest 字段/长度/id 语法/placement/view 节点与深度/≤32KiB/效果上限/四个 toggle→命令映射/中英 locale 对齐，并**解析视图树断言每个注册 action 可达**——删除按钮行会得到 8 FAIL，而不是假 PASS；**dsh-go 的唯一校验来源**），`node test.mjs` 52、`node test-host.mjs`（当时计数；当前基线 52 + 269；二者不含 dsh-go 断言）。
- **补丁**：`a1589e0 fix(go): render pause/resume buttons in the dsh-go memory panel` —— 补渲染暂停/恢复/同意说明按钮，并加固 `ui/verify-dshgo.mjs` 的 action 可达性检查。
- **未验证（诚实边界）**：本机**无 dsh-go 真机、无 kit `check.mjs`**，**未在 App 实测**渲染、点击与重载保持；以上仅为静态校验 + 单测。`dshGo.minApp` 留空：本机无 kit/template，App 版本格式无法验证（bridge 0.4.0 是桥接版本，不是 App 版本号）。spec §6 三个接口（同包双身份是否双加载、发现规则、`panel.scope.sessionId` 是否有值）仍需真机确认。
- **范围外（不属 2.4.0 交付）**：多智能体记忆隔离（`memoryScope`）当时尚未合入 2.4.0——**已由 2.5.0 交付、2.5.1 加固，见上**。

## 2.3.0 — Web/桌面记忆面板（live slot 验证）

- 新增 `client.js`：在 Web 输入框 dock（`conversation.input.dock`）提供记忆操作面板——状态、搜索、用户/助手画像、暂停/恢复捕获、C1–C4 同意开关、导出；所有读写都走 `/dmem` 命令，破坏性操作只提示 `/dmem migrate`、不执行。
- `package.json`：新增 `exports["./client"]`、`dsh.client`（platform web、immediately、inject 三个 client 服务）、`files` 增加 `client.js`。
- 新增 `ui/verify-client.mjs`：10 项静态契约校验（PASS）。
- 真机（Web client inspect）实测：槽位 `conversation.input.dock` 的 occupants 含 `id=dynamic-memory, order=30, active=true`。
- 测试通过（当时计数；当前基线 52 + 269）。

## 2.2.1 — consent 加固与文档同步

- `memory=off` 现在拒绝显式写入（`observe`/`learn`/`deepen`/`correct` 返回明确原因）；读与删除不受影响。
- consent 行增加 `schemaVersion=1` 与 v0 迁移；`stats`/`consent` 暴露 `schemaVersion`。
- 真机验证：consent 持久化 `durable`、`schemaVersion 1`。
- 文档同步到当时口径：测试通过、eval 9/10 MRR 0.750、`--min-coverage 0.6` 时 FP 0/8、fixture 5/5（当前基线 52 + 269）。

## 2.2.0 — 同意开关、digest 实测与评测加固

**当前状态**：v2.2.0 已实现 C1-C4 同意开关并在真机验证；评测标签迁移后真实指标回升。代码以 commit `d6f5b0c release: v2.2.0 consent switches + digest metric + eval hardening` 为准。

- **同意开关 C1-C4（已实现，真机验证）**：`consent.memory / inject / profile / sensitive` 持久化到 storage 的 `consent` 表，重载后保留；真机 `/dmem stats` 验证状态 **`memory=on inject=on profile=unified sensitive=off, storage=durable`**。C1 关闭时：不捕获、不注入、后台索引也停。
- **命令与工具**：`/dmem consent` 看状态；`/dmem consent on|off`（C1）、`/dmem consent inject on|off`（C2）、`/dmem consent sensitive on|off`（C4）、`/dmem consent profile unified|situational|off`（C3）；工具 action 也可传 `consent={memory,inject,profile,sensitive}` 部分字段。
- **digestCount 改真实快照**：`stats` 的 `digestCount` 取上一轮提示组装的实际注入结果（附 `digestTotal` / `digestReason`），不再硬编码；2.1.2 条目里的"真机待验证"由此收口。
- **评测加固（真实集，本机亲手运行）**：迁移评测标签后 hit@3 **9/10**、MRR **0.750**（标签迁移前 7/10、0.600）；加 `--min-coverage 0.6` 后误报 **0/8**（无门控 1/8）；`--fixture` **5/5**（MRR 1.000、FP 0/2）。玩法：`node eval.mjs`、`node eval.mjs --min-coverage 0.6`、`node eval.mjs --fixture`。
- **剩余 1 条真实损失**：一条部署类查询——摘要截断（90+60 字符）使关键 token 未被保留，rank 47；属覆盖缺口，非打分问题（详见评测报告）。
- 测试（本机亲自运行，commit `d6f5b0c`）：`test.mjs` **52** 项、`test-host.mjs` **147** 项。
- **明确未做（不写作已完成）**：① 面板 UI（阶段 4）；② 说话者归属（`speaker` 注册表 / exchange `origin` / 助手画像隔离，阶段 3.2）；③ situational 画像按情境分组（`profile=situational` 可选，但分组尚未实现）；④ 真机移动端未测；⑤ **memory off 时的显式写入硬拦截正在修**（当前 C1 关闭会停捕获/注入/后台索引，工具显式写入路径的拦截未完成）。

## 2.1.2（未发布，内容并入 2.2.0）— 索引化收尾与水合可靠性

**当时状态**：v2.1 索引化捕获已落地、真实库迁移完成，水合（按 pointer 回读原文）收尾——真机抽检 **19/20 = 95%**。代码以 commit `60ab15b fix(index-only): execute /dmem migrate and make repair counts live` 为准。

- **存储**：新行只写 `summary` / `keywords` / `entities` / `time` / `textHash` / `pointer`（sessionId+时间）；`user` / `assistant` 为空串。`textHash` 是对"清洗后 user + `\n` + 最后一轮 assistant"的 SHA-256，只用于水合校验，不是加密，也不可还原内容。
- **读取原文**：search 命中后按 pointer 读本地 Harness 会话，用 `textHash` → `summary` 前缀 → 单一时窗候选三级回退配对，返回片段（`full=true` 返回整段）。
- **水合实测（真机抽检）**：20 条命中样本中 **19 条**成功回读（95%）；**1 条显式失败，不伪造片段**——该行是重复"继续"类指令（原文略），会话内 54 个候选无法唯一定位，返回 `sourceAvailable:false`、`user`/`assistant` 为空、`hydrationError`（no-match）；不是 ambiguous，也不是会话不可读。
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
