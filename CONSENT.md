# 记忆与画像的同意模型（CONSENT）

> 目的：把"用户是否允许跨会话记忆 / 是否允许画像 / 是否允许敏感推断"变成显式、可撤回的同意，而不是默认全开。
> 状态：**已实现（C1-C4 基础版，v2.2.0 真机验证）**。`consent.memory / inject / profile / sensitive` 持久化在 storage 的 `consent` 表，重载后保留；真机 `/dmem stats` 验证为 `memory=on inject=on profile=unified sensitive=off, storage=durable`。v2.2.1 起 `memory=off` 拒绝显式写入；v2.3/v2.4 面板（Web / dsh-go）可切换；v2.5.0 隔离、v2.5.1 加固（§7）。**未做**：`/dmem forget-session`、说话者归属、situational 画像分组、dsh-go 真机未测。

## 1. 必须单独同意的五件事

| # | 同意项 | 默认 | 说明 |
|---|---|---|---|
| C1 | **跨会话记忆**（写入索引/摘要） | 默认 **开**（`memory=on`）；`/dmem consent off` 关闭 | 关掉后不捕获、不注入、后台索引停；"安装后首启询问"尚未实现 |
| C2 | **每轮自动注入记忆** | 默认 **开**（`inject=on`） | `inject off` = 只检索不注入；注入有预算 |
| C3 | **画像**（用户/助手 facet） | 默认 **unified**；可 `situational`/`off` | 可只允许事实/偏好，不允许心理/人格推断 |
| C4 | **敏感内容**（健康、情绪、关系等） | 默认 **关**（`sensitive=off`） | 开启后仍需 `mention=if_asked`，不主动提起 |
| C5 | **数据出境/共享** | 永不允许 | 本地存储，无遥测、无云端同步；`export` 只写本地文件 |

> 实现口径（v2.2.0）：默认 `memory=on inject=on profile=unified sensitive=off`，兼容既有安装；状态持久化在 storage `consent` 表。设计稿中的"首启询问"与面板 UI 尚未实现。

## 2. 画像的两种形态（用户可选）

| 形态 | 含义 | 建议 |
|---|---|---|
| **统一画像**（默认） | 一份长期画像，分 facet 归纳；不给人格贴标签 | 适合大多数用户 |
| **情境画像** | 同一 facet 可按情境/工作区分别归纳（工作/私人） | 进阶；避免把一种场景的行为当成人格 |
| 关闭画像 | 只存事实型记忆与检索索引 | 只想要"翻历史"的用户 |

明确不做：`introvert/extrovert` 这类固定人格分类；任何"人格标签"必须来自证据并允许推翻。

## 3. 面板（记忆设置）最小字段（设计稿，**面板 UI 尚未实现**）

- 总开关：允许记忆（C1）
- 注入：自动注入 / 仅按需检索 / 关闭（C2）
- 画像：统一 / 情境 / 关闭；人格推断开/关（C3）
- 敏感：不允许 / 允许但不主动提（C4）
- 存储：索引+摘要（默认）/ 保留原文（本地，自担风险）
- 保留期：永久 / N 天 / 仅本会话
- 维护：查看全部记忆、搜索、删除单条/全部、导出、同意记录
- 每会话：本会话不记忆（临时开关）

## 4. 容易漏、但评审一定会问的清单

| 议题 | 建议默认 |
|---|---|
| 第三方信息（他人姓名/隐私） | 不主动记录；出现时按 private 处理 |
| 医疗/心理诊断 | 永不生成诊断；只记录用户自述并标 `self_reported` |
| 敏感属性（性取向、宗教、政治、健康） | 默认不记录；显式同意也不做推断 |
| 未成年人 | 不区分/不推断；敏感项按最高保护 |
| 记忆投毒/提示注入 | 外部内容不得写入画像；写入必须带来源 |
| 删除权 | 删除插件数据不依赖删除会话；可单条/全量 |
| 可携带 | 导出 JSON/Markdown，本地文件 |
| 审计 | 每次写入有来源、时间、kind；画像有版本历史 |
| 纠正权 | 用户纠正优先，旧版本保留可查 |
| 不操纵 | 记忆只调整语气/事实，不用于说服或诱导 |
| 透明 | 面板可看"记住了什么、为什么"（来源） |
| 遥测 | 无 |
| 语言/地区 | 多语言包；不假设文化规范 |

## 5. 用法（v2.2.0 已实现 C1-C4）

```bash
/dmem consent                                   # 看当前状态（+ storage: durable|memory-only）
/dmem consent on | off                          # C1 跨会话记忆；关闭时不捕获、不注入、后台索引停
/dmem consent inject on | off                   # C2 每轮自动注入
/dmem consent sensitive on | off                # C4 敏感观察是否可注入
/dmem consent profile unified | situational | off  # C3 画像（situational 仅形态选择，分组未实现）
```

工具 action 等价写法：`consent={memory, inject, profile, sensitive}`（可只传要改的字段）。状态写入 storage 的 `consent` 表，重载后保留。

仍未实现：`/dmem forget-session`；说话者归属（`speaker`/`origin`）；situational 画像分组；dsh-go 真机验证。（面板已可用：Web v2.3 / dsh-go v2.4；`memory=off` 的显式写入拦截 v2.2.1 已修。）

## 6. 验收

- 未同意时 `stats.exchanges` 不增长、注入为空；
- 关闭画像后 `portrait` 不再注入、不再写入；
- 敏感关闭时 `sensitivity=sensitive` 的观察不注入；
- 删除插件数据不影响 Harness 会话，反之亦然；
- 同意状态可在 `/dmem consent status`、`stats.consent` 与面板（Web v2.3 / dsh-go v2.4）查看。

## 7. 隔离与同意（v2.5.0，v2.5.1 加固）

- 同意开关是**安装级（owner 命名空间）**状态；`memoryScope=owner`（默认）下 teammate/subagent 默认**读不到也写不进** owner 记忆，注入为空——它们不是"各自再同意"，而是根本拿不到。
- 身份无法证明时 **fail-closed**（不读不写）；用 `/dmem scope` 查看 role/source/读写权与 `inventory` 状态，需要显式隔离的宿主配置 `ownerAgentIds`。2.5.1 起去掉"有 header 即 owner"的回退。
- 删除会话只把对应画像标 `dormant`（不注入、stats 可见）；**清单未验证时不标 dormant**，`/dmem gc confirm=true` 也只报告（`unverified-inventory`，零删除）；**owner 画像永不被删**。
- C1–C4 与隔离互不替代：隔离防跨 agent 串味，C1–C4 决定"记不记 / 注不注 / 画像 / 敏感"。
