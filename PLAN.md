# 执行列表（v2.1 → v3）

> 目标：从"复制原文的插件"变成"只存派生数据的本地记忆层"。系统会话是原文唯一来源；插件只留索引、画像、观察与指针。
> 当前版本：`package.json` 2.4.0（阶段 1/2 完成、3.1 完成、4.1 Web 面板完成；**未发布**——无 Release、非 Latest、npm 未推送）。

## 阶段 1：索引化捕获（已完成，未发布）

| # | 任务 | 验收 | 状态 |
|---|---|---|---|
| 1.1 | `exchanges` 新增 `textHash`（原文哈希）与 `pointer`（sessionId + 时间） | 新记录可定位回系统会话 | ✅ 完成 |
| 1.2 | `retainText: false`（默认）：不写 `user`/`assistant` 原文，只写摘要/关键词/实体/时间/指针 | 磁盘单条约 0.3–0.6KB；`stats.plaintextRows=0` | ✅ 完成（新记录生效；旧记录已由迁移剥离） |
| 1.3 | 检索 haystack 支持"无原文"：用 summary/keywords/entities 打分 | 新记录可被关键词检索命中 | ✅ 完成 |
| 1.4 | 检索结果水合：命中后按 pointer 读本地会话，返回片段（默认）或整段（`full=true`），失败标 `sourceAvailable:false` | search 在无原文时仍能返回片段；会话缺失时优雅降级 | ✅ 完成（真机抽检 **19/20 = 95%**；1 条显式 no-match，不伪造） |
| 1.5 | `recent` 等列表允许"仅摘要"记录 | 不因缺 user/assistant 被过滤 | ✅ 完成 |
| 1.6 | 测试：host fixture 断言捕获后无明文、summary 存在、search 命中 | test.mjs + test-host.mjs 通过 | ✅ 完成（本机实测 **52 + 170** 项：含水合、consent、migrate/repair；**不含 dsh-go 断言**，dsh-go 仅由 `ui/verify-dshgo.mjs` 静态校验） |
| 1.7 | 文档：README/DOCS 说明"系统=原文，插件=索引" | 文档与行为一致 | ✅ 完成 |

### 已知限制与未完成项（截至 v2.4.0）

- **水合 19/20 = 95%**：唯一失败样本是显式 no-match——重复"继续"类指令在会话 54 个候选中无法唯一定位，返回空文本 + `hydrationError`，**不伪造**。不是 ambiguous，也不是会话不可读；不阻塞阶段 1。
- 失败行为是契约：`sourceAvailable:false` + `user`/`assistant` 为空 + `hydrationError`（≤160 字符），多候选时拒绝猜测。
- migrate/repair 已收口：`/dmem migrate` 与工具 action 共用 `migrateStrip`（缺 `confirm=true` 拒绝）；repair 不回写明文，`plaintextRows` 实测 + `plaintextCleared`。2.2.1 起 `memory=off` 拒绝显式写入。
- digest：2.2.0 起 `stats.digestCount` 为真实注入快照（附 `digestTotal`/`digestReason`）。
- 面板：Web v2.3.0 已验收（live slot）；dsh-go v2.4.0 只有静态校验 **46 PASS + 1 INFO**——**本机无真机/kit，未在 App 实测**；视图含四个 C1–C4 开关行与五个按钮（暂停捕获、恢复捕获、导出、复制状态、同意说明），每个注册 action 均可达。
- **多智能体记忆隔离（memoryScope）不在 2.4.0 范围**：由 task-14 开发中，未交付。
- **未发布**：无 Release、非 Latest、npm 未推送；`package.json` 2.4.0 且 `private: true`。
- **未做（必须如实标注）**：说话者归属（阶段 3.2）、situational 画像分组、dsh-go 真机验收、market/npm 安装（阶段 4.2）、memoryScope（task-14 进行中）。

## 阶段 2：旧数据迁移（已完成，v2.2.0）

| # | 任务 | 验收 | 状态 |
|---|---|---|---|
| 2.1 | `/dmem migrate strip`：先导出 JSON/Markdown 归档，再剥离旧记录 `user/assistant`，保留 summary/关键词/实体 + 补指针 | 导出可回滚；剥离后 search 仍可用 | ✅ 已执行（本机剥离 2120 条，释放约 2.9M 字符）。⚠️ 回滚缺口：导出只有 memory.md 可读档案（最近 30 条印象、用户文本 ≤80 字符），逐字恢复需剥离前存储快照 |
| 2.2 | 对比评测：剥离前后 hit@3/MRR、磁盘占用 | 给出真实数字与损失说明 | ✅ 完成（本机实测：迁移评测标签后 **9/10、MRR 0.750**；标签迁移前 7/10、0.600；`--min-coverage 0.6` 时 FP 0/8；fixture 5/5。剩余 1 条真实损失：摘要截断使 `部署 公网 首页 200` 未命中） |
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
| 4.1c | 多智能体记忆隔离（`memoryScope`） | 不同 agent 的记忆互不串 | ⏳ 开发中（task-14）——**不在 2.4.0 交付范围** |
| 4.2 | 安装：market index + npm 包 + install 脚本 | 市场可搜到、一键装 | ⏳ 未做（未发布、npm 未推送；桥接发现规则未确认） |
| 4.3 | v3.0：默认索引模式、旧数据迁移完成、对比报告 | 发布说明写清 breaking change | ⏳ 未做 |

## 原则（不再变）

- 不存原文副本；不做应用层加密/口令；隐私靠全盘加密与权限。
- 读原文 = 读本地 Harness 会话，片段优先。
- 不做人格分类；只做证据与说话者归属。
- 每步必须有测试；不改默认行为前先给对比数字。
