# 执行列表（v2.1 → v3）

> 目标：从"复制原文的插件"变成"只存派生数据的本地记忆层"。系统会话是原文唯一来源；插件只留索引、画像、观察与指针。
> 当前版本：2.0.3 → 本次目标 2.1.0

## 阶段 1：索引化捕获（本次）

| # | 任务 | 验收 |
|---|---|---|
| 1.1 | `exchanges` 新增 `textHash`（原文哈希）与 `pointer`（sessionId + 时间） | 新记录可定位回系统会话 |
| 1.2 | `retainText: false`（默认）：不写 `user`/`assistant` 原文，只写摘要/关键词/实体/时间/指针 | 磁盘单条约 0.3–0.6KB；`stats.plaintextRows=0` |
| 1.3 | 检索 haystack 支持"无原文"：用 summary/keywords/entities 打分 | 新记录可被关键词检索命中 |
| 1.4 | 检索结果水合：命中后按 pointer 读本地会话，返回片段（默认）或整段（`full=true`），失败标 `sourceAvailable:false` | search 在无原文时仍能返回片段；会话缺失时优雅降级 |
| 1.5 | `recent` 等列表允许"仅摘要"记录 | 不因缺 user/assistant 被过滤 |
| 1.6 | 测试：host fixture 断言捕获后无明文、summary 存在、search 命中 | test.mjs + test-host.mjs 通过 |
| 1.7 | 文档：README/DOCS 说明"系统=原文，插件=索引" | 文档与行为一致 |

## 阶段 2：旧数据迁移（下一步）

| # | 任务 | 验收 |
|---|---|---|
| 2.1 | `/dmem migrate strip`：先导出 JSON/Markdown 归档，再剥离旧记录 `user/assistant`，保留 summary/关键词/实体 + 补指针 | 导出可回滚；剥离后 search 仍可用 |
| 2.2 | 对比评测：剥离前后 hit@3/MRR、磁盘占用 | 给出真实数字与损失说明 |
| 2.3 | `stats` 增加 `plaintextRows` / `indexedBytes` | 用户能看到"还剩多少明文" |

## 阶段 3：同意与说话者（随后）

| # | 任务 | 验收 |
|---|---|---|
| 3.1 | 同意：C1 记忆 / C2 注入 / C3 画像 / C4 敏感；`/dmem consent` | 未同意不捕获、不注入 |
| 3.2 | 说话者：`speaker` 注册表 + exchange `origin`；助手画像按 speaker 隔离；`/dmem speaker` | 切模型用对应画像；粘贴外部内容显式标记，不写用户画像 |
| 3.3 | 自动识别模型：先验证 Host 是否暴露 model id | 拿不到就保持手动切换，不猜测 |

## 阶段 4：面板与安装（最后）

| # | 任务 | 验收 |
|---|---|---|
| 4.1 | 记忆面板：状态/搜索/画像/证据/暂停/导出/存储模式 | 不敲命令可用 |
| 4.2 | 安装：market index + npm 包 + install 脚本 | 市场可搜到、一键装 |
| 4.3 | v3.0：默认索引模式、旧数据迁移完成、对比报告 | 发布说明写清 breaking change |

## 原则（不再变）

- 不存原文副本；不做应用层加密/口令；隐私靠全盘加密与权限。
- 读原文 = 读本地 Harness 会话，片段优先。
- 不做人格分类；只做证据与说话者归属。
- 每步必须有测试；不改默认行为前先给对比数字。
