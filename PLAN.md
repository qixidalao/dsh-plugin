# 执行列表（v2.1 → v3）

> 目标：从"复制原文的插件"变成"只存派生数据的本地记忆层"。系统会话是原文唯一来源；插件只留索引、画像、观察与指针。
> 当前版本：`package.json` 2.5.2（阶段 1/2 完成、3.1 完成、4.1 Web 面板完成、阶段 5 完成；**2.5.2 为测试版**：tag 已推送，2.5.2 为 docs-only，npm 未推送、非 Latest）。

## 阶段 1：索引化捕获（已完成）

| # | 任务 | 验收 | 状态 |
|---|---|---|---|
| 1.1 | `exchanges` 新增 `textHash`（原文哈希）与 `pointer`（sessionId + 时间） | 新记录可定位回系统会话 | ✅ 完成 |
| 1.2 | `retainText: false`（默认）：不写 `user`/`assistant` 原文，只写摘要/关键词/实体/时间/指针 | 磁盘单条约 0.3–0.6KB；`stats.plaintextRows=0` | ✅ 完成（新记录生效；旧记录已由迁移剥离） |
| 1.3 | 检索 haystack 支持"无原文"：用 summary/keywords/entities 打分 | 新记录可被关键词检索命中 | ✅ 完成 |
| 1.4 | 检索结果水合：命中后按 pointer 读本地会话，返回片段（默认）或整段（`full=true`），失败标 `sourceAvailable:false` | search 在无原文时仍能返回片段；会话缺失时优雅降级 | ✅ 完成（真机抽检 **19/20 = 95%**；1 条显式 no-match，不伪造） |
| 1.5 | `recent` 等列表允许"仅摘要"记录 | 不因缺 user/assistant 被过滤 | ✅ 完成 |
| 1.6 | 测试：host fixture 断言捕获后无明文、summary 存在、search 命中 | test.mjs + test-host.mjs 通过 | ✅ 完成（本机实测 **52 + 269** 项：含水合、consent、migrate/repair、多智能体隔离与 dormant GC；**不含 dsh-go 断言**，dsh-go 仅由 `ui/verify-dshgo.mjs` 静态校验） |
| 1.7 | 文档：README/DOCS 说明"系统=原文，插件=索引" | 文档与行为一致 | ✅ 完成 |

### 已知限制与未完成项（截至 v2.5.2）

- **水合 19/20 = 95%**：唯一失败样本是显式 no-match——重复"继续"类指令在会话 54 个候选中无法唯一定位，返回空文本 + `hydrationError`，**不伪造**。不是 ambiguous，也不是会话不可读；不阻塞阶段 1。
- 失败行为是契约：`sourceAvailable:false` + `user`/`assistant` 为空 + `hydrationError`（≤160 字符），多候选时拒绝猜测。
- migrate/repair 已收口：`/dmem migrate` 与工具 action 共用 `migrateStrip`（缺 `confirm=true` 拒绝）；repair 不回写明文，`plaintextRows` 实测 + `plaintextCleared`。2.2.1 起 `memory=off` 拒绝显式写入。
- digest：2.2.0 起 `stats.digestCount` 为真实注入快照（附 `digestTotal`/`digestReason`）。
- 面板：Web v2.3.0 已验收（live slot）；dsh-go v2.4.0 只有静态校验 **46 PASS + 1 INFO**——**本机无真机/kit，未在 App 实测**；视图含四个 C1–C4 开关行与五个按钮（暂停捕获、恢复捕获、导出、复制状态、同意说明），每个注册 action 均可达。
- **隔离（v2.5.0–2.5.1）的诚实限制**：Harness **无独立持久 agentId**（身份来自 session/agent id + header/registry，换会话无法认回同一人）；删除会话后**只能标 dormant**（无持久墓碑，新会话不继承旧画像）；2.5.1 起**清单未验证就不标 dormant、gc 零删除**（fail-closed，宁可不清也不误删）；并发 `agents.roots()` / `listSessions()` 的时序**未真机验证**。
- **未发布**：2.5.2 为测试版；npm 未推送、非 Latest；`package.json` 2.5.2 且 `private: true`。
- **未做（必须如实标注）**：说话者归属（阶段 3.2）、situational 画像分组、dsh-go 真机验收、market/npm 安装（阶段 4.2）。

## 阶段 2：旧数据迁移（已完成，v2.2.0）

| # | 任务 | 验收 | 状态 |
|---|---|---|---|
| 2.1 | `/dmem migrate strip`：先导出 JSON/Markdown 归档，再剥离旧记录 `user/assistant`，保留 summary/关键词/实体 + 补指针 | 导出可回滚；剥离后 search 仍可用 | ✅ 已执行（本机剥离 2120 条，释放约 2.9M 字符）。⚠️ 回滚缺口：导出只有 memory.md 可读档案（最近 30 条印象、用户文本 ≤80 字符），逐字恢复需剥离前存储快照 |
| 2.2 | 对比评测：剥离前后 hit@3/MRR、磁盘占用 | 给出真实数字与损失说明 | ✅ 完成（本机实测：迁移评测标签后 **9/10、MRR 0.750**；标签迁移前 7/10、0.600；`--min-coverage 0.6` 时 FP 0/8；fixture 5/5。剩余 1 条真实损失：一条部署类查询因摘要截断未命中；真实集样本少、非冻结测试集） |
| 2.3 | `stats` 增加 `plaintextRows` / `indexedBytes` | 用户能看到"还剩多少明文" | ✅ 完成（`plaintextRows` 已提供；`indexedBytes` 未单独输出，用磁盘占用代替） |


## 阶段 3：同意与说话者（3.1 已完成，其余待做）

| # | 任务 | 验收 | 状态 |
|---|---|---|---|
| 3.1 | 同意：C1 记忆 / C2 注入 / C3 画像 / C4 敏感；`/dmem consent` | 未同意不捕获、不注入 | ✅ 完成（C1-C4 基础版；真机验证 `memory=on inject=on profile=unified sensitive=off, storage=durable`；持久化、重载保留） |
| 3.2 | 说话者：`speaker` 注册表 + exchange `origin`；助手画像按 speaker 隔离；`/dmem speaker` | 切模型用对应画像；粘贴外部内容显式标记，不写用户画像 | ⏳ 未做 |
| 3.3 | 自动识别模型：先验证 Host 是否暴露 model id | 拿不到就保持手动切换，不猜测 | ⏳ 未做 |

## 阶段 4：面板与安装（Web 面板完成；dsh-go 待真机；发布未做）

| # | 任务 | 验收 | 状态 |
|---|---|---|---|
| 4.1 | Web/桌面记忆面板：状态/搜索/画像/暂停/导出/C1–C4 | 不敲命令可用 | ✅ 完成（v2.3.0，`conversation.input.dock`；live slot 验证；破坏性操作只提示 `/dmem migrate`） |
| 4.1b | dsh-go 手机 App 原生面板（`dshGo` 清单 + 声明式 v2 视图） | App 三处入口可打开并切换开关 | ⚠️ 代码与静态校验完成（**46 PASS + 1 INFO**）；四个 C1–C4 开关 + 五个按钮（暂停捕获、恢复捕获、导出、复制状态、同意说明）；**未在真机 App 实测** |
| 4.1c | 多智能体记忆隔离（`memoryScope`） | 不同 agent 的记忆互不串 | ✅ 完成（v2.5.0 交付、v2.5.1 加固，详见阶段 5） |
| 4.2 | 安装：market index + npm 包 + install 脚本 | 市场可搜到、一键装 | ⏳ 未做（未发布、npm 未推送；桥接发现规则未确认） |
| 4.3 | v3.0：默认索引模式、旧数据迁移完成、对比报告 | 发布说明写清 breaking change | ⏳ 未做 |

## 阶段 5：多智能体隔离与 dormant GC（已完成，v2.5.0 → 2.5.2）

| # | 任务 | 验收 | 状态 |
|---|---|---|---|
| 5.1 | `memoryScope` 三档：`owner`（默认）/`agent`/`shared`；owner 下子 agent 注入空、写入拒绝 | 子 agent 读不到/写不进 owner 记忆 | ✅ 完成（owner 模式 delegated 返回 `isolated:true`；agent 模式按 `agentId` 分域；shared 兼容旧行为） |
| 5.2 | 身份识别优先级：`config.ownerAgentIds` > session header > `agents.roots()`/`list()`；无法证明身份 fail-closed | 不猜测身份 | ✅ 完成（实测 `identity source=agents-roots`、`canRead/canWrite=true`；2.5.1 去掉"有 header 即 owner"回退） |
| 5.3 | 画像主键 `scopeId=owner|agent:<id>`，不用 sessionId；每条记录带 scopeId | 跨会话/跨 agent 不串画像 | ✅ 完成（旧数据无 scopeId 视为 owner） |
| 5.4 | 归档保留画像；删除会话标 dormant（不注入、stats 可见）；`/dmem gc` 默认 dry-run，confirm 才删 dormant | dormant 可清理且不误删 | ✅ 完成（实测 `dormantFacets=0`；2.5.1 起清单未验证则不标 dormant、gc 零删除） |
| 5.5 | 命令：`/dmem scope`（模式/身份/权利/dormant）与工具 `action=scope\|gc` | 可自查隔离状态 | ✅ 完成 |
| 5.6 | 诚实限制文档化：无持久 agentId、删除只能 dormant、并发 roots/list 时序未真机验证 | 文档与行为一致 | ✅ 完成（README/CHANGELOG/DOCS） |
| 5.7 | 2.5.1 隔离 GC 安全加固：`gcRequireInventory` 默认 true；清单缺失/报错/非数组时不标 dormant、gc 不删（`unverified-inventory`）；身份无证明即 unknown | 清单不可信时零删除 | ✅ 完成（测试 52 + 269；真机 inventory verified、gc dry-run 零删除） |
| 5.8 | 2.5.2 文档漂移修正（docs-only）：测试数统一 52+269、2.4.0 状态、评测口径、隐私清理 | 文档与代码/发布状态一致 | ✅ 完成（代码同 2.5.1，无运行时改动） |

**阶段 5 已知风险**：并发 `agents.roots()` / `listSessions()` 的时序未在真机验证；Harness 无独立持久 agentId，换会话无法自动认回同一人。

## 原则（不再变）

- 不存原文副本；不做应用层加密/口令；隐私靠全盘加密与权限。
- 读原文 = 读本地 Harness 会话，片段优先。
- 不做人格分类；只做证据与说话者归属。
- 每步必须有测试；不改默认行为前先给对比数字。
