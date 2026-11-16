# 动态记忆 · DeepSeek Harness 插件

为 Harness agent 提供持久化长期记忆：证据层、用户/助手画像、校准检索、以及小型认知层（巩固草稿、重算、披露策略）。它只补充上下文窗口里没有的内容，不重复注入当前对话。

- **证据优先**：观察分为 `observed / self_reported / inferred / corrected`；推断必须带置信度与至少一个替代解释；用户纠正优先；矛盾保留而不强行合并。
- **没有人格分类器**：存的是"带来源与置信度的可推翻假设"，不是标签。画像 facet 由 `facets` / `assistantFacets` 配置，默认可移除 `psychology`。
- **语言中立核心**：所有运行时文案来自 `locale/messages.{zh,en}.json`；词表、披露默认值、facet 标签都是数据。中文是支持语言，不是硬依赖。
- **时间感知**：观察 scope 读取时派生；TTL 只停止注入，永不删除；推断置信度从最近印证起衰减。
- **披露策略**：`proactive / if_asked / never`；敏感/短暂项默认 `if_asked`，注入时标"仅语气"。
- **安全默认**：删除级联清理引用；卸载先等在途写入再关存储；捕获可暂停。

## 安装（Preview）

这是 DeepSeek Harness 的 Cordis **bundle 插件**，不是独立应用：

1. 克隆仓库；
2. 用插件管理器把仓库路径作为 bundle 安装到当前 profile（`install_bundle`）；
3. 重载后执行 `/dmem stats`，看到 `storage: durable` 即持久化生效；数据在 `$DSH_HOME/storages/dynamic_memory/`。

发布渠道：Preview（`main` + tag）→ 可安装 bundle → Stable（npm 待定；当前 `private: true`）。**2.5.0 为测试版**：tag `v2.5.0` 已推送；npm 未推送、非 Latest；GitHub Release 页面状态未核实。
许可证：AGPL-3.0-only（见 LICENSE）。记忆数据不进仓库；真实评测数据只在本机（gitignore）。

## 验证

```bash
node test.mjs            # 52 项纯函数测试
node test-host.mjs       # 269 项生命周期（内存 mock host）
node eval.mjs --fixture   # 合成评测（不需要真实数据）
node eval.mjs             # 真实集评测（读本机存储）
node ui/verify-client.mjs  # Web 面板静态契约（10 PASS）
node ui/verify-dshgo.mjs   # dsh-go 面板静态校验（46 PASS + 1 INFO）
```

## 文档

- [DOCS.md](./DOCS.md)：架构、数据模型、注入/检索规则、升级路线（中文）
- [CHANGELOG.md](./CHANGELOG.md)：版本历史
- [CONTRIBUTING.md](./CONTRIBUTING.md)：贡献规范
- [README.en.md](./README.en.md)：English version

## 主要配置

`locale`（默认 auto，按会话语言；可强制 en/zh）、`consent`（`memory` / `inject` / `profile` / `sensitive`）、`memoryScope`（`owner` 默认 / `agent` / `shared`）、`ownerAgentIds`（显式指定 owner 会话）、`facets`、`assistantFacets`、`capture`、`ttlTransientDays` / `ttlSituationalDays`、`inferenceHalfLifeDays`、`portraitBudget`、`observationBudget`。披露（mention）默认值由 scope/type/sensitivity 派生。

## 成本与适用场景（v2.0.3）

- 工具描述已从 ~7.3KB 压到 ~0.5KB；每轮自动注入只在有内容时出现，身份连续性默认关闭。
- 默认自动生成**抽取式摘要**，跨会话速览可用；画像/观察仍由模型主动写入，空库时不会凭空产生。
- 若只需要"偶尔翻历史"，官方 session search + `notes.md` 更省；本插件适合需要跨会话连续性、可纠正画像、证据链的场景。
- `private` 观察在工具输出中默认打码，需 `includePrivate: true` 才显示原文。

## v2.1 索引化捕获（已完成，未发布）

定位：**系统会话是原文唯一来源，插件只存本地派生索引**。不是加密产品，也不做云端同步。

- **存什么**：摘要、关键词、实体、时间、`textHash`（SHA-256，仅校验用）、`pointer`（sessionId + 时间）；新记录 `user`/`assistant` 为空串（`retainText: false` 默认）。
- **不存什么**：用户/助手原文副本；不做应用层加密或口令（隐私靠全盘加密与权限）。历史记录已剥离原文：2120 条，释放约 2.9M 字符。
- **原文怎么读**：search 命中后按 pointer 读本地 Harness 会话，依次用 `textHash`、摘要前缀、单一时窗候选配对，返回片段（`full=true` 取整段）。
- **当前状态（真机抽检）**：水合 **19/20 = 95%**；20 条命中样本中 1 条显式失败、不伪造片段——该行是重复"继续"类指令，会话内 54 个候选无法唯一定位，返回 `sourceAvailable:false`、文本为空、`hydrationError: no matching user message (54 candidates)`（no-match，不是 ambiguous，也不是会话不可读）。摘要/关键词/实体仍可检索命中。
- **回滚（有限）**：剥离前会自动导出 `memory.md`，但它是**可读档案**（画像/观察/最近 30 条印象，用户文本只取前 80 字符），不是 2120 条的逐字备份。要逐字恢复请用剥离前的存储快照（复制 `$DSH_HOME/storages/dynamic_memory/`）；日常备份等同理——`/dmem export` 只导出摘要级内容。
- 迁移已可用：工具 action 或 `/dmem migrate mode=strip confirm=true`（共用同一实现，先自动导出 memory.md 再剥离，缺 `confirm=true` 拒绝；破坏性）。

## 同意开关（v2.2，C1-C4）

- `consent.memory / inject / profile / sensitive` 持久化在 storage 的 `consent` 表，重载后保留；真机验证：**`memory=on inject=on profile=unified sensitive=off, storage=durable`**。
- `/dmem consent` 看状态；`/dmem consent on|off`（C1）、`inject on|off`（C2）、`sensitive on|off`（C4）、`profile unified|situational|off`（C3）；工具 action 可传 `consent={memory,inject,profile,sensitive}`。
- C1 关闭时：不捕获、不注入、后台索引停；v2.2.1 起 `memory=off` 还会拒绝显式写入（`observe`/`learn`/`deepen`/`correct`），consent 行带 `schemaVersion=1`。
- **仍未做**：说话者归属（`speaker`/`origin` 隔离）、situational 画像分组、dsh-go 真机未测（仅静态校验）。多智能体记忆隔离已在 v2.5.0 交付（见下节）。

## 多智能体记忆隔离（v2.5.0）

teammate/subagent 默认**读不到也写不进**用户记忆；一个 agent 的记忆不会串到另一个 agent。

- **`memoryScope` 三档**：`owner`（默认，只有 root agent 用 owner 记忆，子 agent 注入空、写入被拒）、`agent`（每个 `agentId` 一个命名空间；root agent 仍可见升级前的旧行）、`shared`（旧行为，所有 agent 共用）。
- **身份识别优先级**：`config.ownerAgentIds` > session header（`parentSession` / `origin=subagent` / `delegationDepth>0`）> `agents.roots()` vs `list()`；无法识别就 **fail-closed**（不读不写），并提示配置 `ownerAgentIds`。
- **画像主键是 `scopeId`**（`owner` 或 `agent:<agentId>`），不是 sessionId；每条 exchange/observation/portrait 带 scopeId，旧数据视为 owner。
- **归档 ≠ 删除**：`archive` 只归档 exchange，画像仍 active；会话真被删除才把对应画像标 `dormant`（不再注入，`stats.dormantFacets` 与 `/dmem scope` 可见），owner 画像永不受影响。
- **`/dmem scope`**：看模式、身份来源、命名空间、读写权、dormant 画像；**`/dmem gc`**：默认 dry-run 不删，`/dmem gc confirm=true` 只删 dormant 画像，不碰 owner 与活跃 agent。
- **实测**：`scope=owner`、`identity source=agents-roots`、`canRead/canWrite=true`、`dormantFacets=0`；gc dry-run 无删除。
- **诚实限制**：Harness **没有独立持久 agentId**，同一个人换会话无法自动认回；删除会话后**只能 dormant 标记**（没有持久墓碑，新会话不继承旧画像）；**未在真机验证**并发 `agents.roots()` / `listSessions()` 的时序。测试 52 + 269。

## 面板：Web 与 dsh-go 手机 App

**为什么手机端要单独做**：dsh-go 是 Flutter 原生界面，**不执行 Web client 插件**；v2.3.0 的 `client.js` 只在 Web/桌面可见，所以手机里需要独立的 `dshGo` 清单 + 声明式视图。

- **Web / 桌面（v2.3.0）**：`client.js` 在输入框 dock（`conversation.input.dock`）提供记忆面板——状态、搜索、画像、暂停/恢复、C1–C4 开关、导出；读写都走 `/dmem`，破坏性操作只提示 `/dmem migrate`。已用 live client inspect 确认槽位占位（`id=dynamic-memory, order=30, active=true`）。
- **dsh-go 手机 App（v2.4.0）**：`package.json` 加 `main: index.js` 与 `dshGo`（`v=1`；面板 `memory-settings`，placement `session.tab` / `features` / `chat.panel`，presentation page；title 中英；icon settings；`wants: []`；`minApp` 省略）。`index.js` 用 `ctx.inject(['dshGo'])` 注册，桌面/Web 无该服务时不执行。
- **App 内入口**：对话详情 →「插件」→「记忆设置」；「全部功能」→「记忆设置」；输入框「插件」胶囊 → 弹层。
- **面板内容**：存储健康（storage / 索引条数 / plaintextRows / 上次注入字符）、**四个 C1–C4 开关**、**五个按钮（暂停捕获、恢复捕获、导出、复制状态、同意说明）**；每个注册 action 都可点。
- **写路径**：toggle 只发 `/dmem consent …`——memory → `/dmem consent on|off`，inject → `/dmem consent inject on|off`，sensitive → `/dmem consent sensitive on|off`，profile 按 `unified → situational → off` 循环；不直接写 storage，与工具/Web 面板共用同一持久化。**不新增网络请求**，不读剪贴板/输入框（`wants: []`）。
- **安装/生效**：清单改动自动重读；`index.js` 改动需在 App「引擎」页重启引擎。若桥接只扫 `$DSH_HOME/dsh-go/plugins/`，还需 `dsh plugin --profile web add <包目录>`（发现规则**未确认**）。
- **卸载/回滚**：`dsh plugin --profile web remove @local/dynamic-memory` 后删包目录；记忆数据在 `$DSH_HOME/storages/dynamic_memory/`，不受影响。回滚面板 = 重装 2.3.0，或移除 `dshGo` 清单（App 入口消失、数据不动）。
- **未实测**：本机**无 dsh-go 真机、无 kit `check.mjs`**，**未在 App 实测**渲染、点击与重载保持；dsh-go 仅有 `node ui/verify-dshgo.mjs` 静态 46 PASS + 1 INFO（**dsh-go 的唯一校验来源**，含视图树 action 可达性断言），单测（当前 52/269）不含 dsh-go 断言。同包双身份、发现规则、`scope.sessionId` 三个接口待真机确认。

## 评测（真实集，本机；v2.5.0 复跑）

- `node eval.mjs`：hit@3 **9/10**、MRR **0.750**（评测标签迁移后；标签迁移前 7/10、0.600）；
- `node eval.mjs --min-coverage 0.6`：误报 **0/8**（无门控 1/8）；
- `node eval.mjs --fixture`：**5/5**（MRR 1.000）；
- 剩余 1 条真实损失：`部署 公网 首页 200`——摘要截断（90+60 字符）丢掉 `公网`/`首页`，属覆盖缺口（详见评测报告）。

## 隔离 GC 安全（v2.5.1）

- `gcRequireInventory: true`（默认）：没有 listSessions 完整清单时，不把任何画像标 dormant，`/dmem gc` 只报告（`reason=unverified-inventory`），即使 `confirm=true` 也不删除；
- 旧 Harness 缺委派字段且未配置 `ownerAgentIds` 时，身份为 unknown，读写与注入被拒，不会回退 owner。

## 已知限制

- 无向量检索：同义改述仍可能漏；检索为字面（中文二字组 + 词脚本 + 实体）。
- 身份连续性只是证据，不是认证。
- `reflect` 草稿需要 ≥3 个不同会话；稀疏数据不会产出。
- 中文已完整验证；英文/其他语言为功能性支持，仍需母语润色。
