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

发布渠道：Preview（`main` + tag）→ 可安装 bundle → Stable（npm 待定；当前 `private: true`）。
许可证：AGPL-3.0-only（见 LICENSE）。记忆数据不进仓库；真实评测数据只在本机（gitignore）。

## 验证

```bash
node test.mjs          # 51 项纯函数测试
node test-host.mjs     # 16 项生命周期（内存 mock host）
node eval.mjs --fixture# 合成评测（不需要真实数据）
```

## 文档

- [DOCS.md](./DOCS.md)：架构、数据模型、注入/检索规则、升级路线（中文）
- [CHANGELOG.md](./CHANGELOG.md)：版本历史
- [CONTRIBUTING.md](./CONTRIBUTING.md)：贡献规范
- [README.en.md](./README.en.md)：English version

## 主要配置

`locale`（默认 auto，按会话语言；可强制 en/zh）、`facets`、`assistantFacets`、`capture`、`ttlTransientDays` / `ttlSituationalDays`、`inferenceHalfLifeDays`、`portraitBudget`、`observationBudget`。披露（mention）默认值由 scope/type/sensitivity 派生。

## 已知限制

- 无向量检索：同义改述仍可能漏；检索为字面（中文二字组 + 词脚本 + 实体）。
- 身份连续性只是证据，不是认证。
- `reflect` 草稿需要 ≥3 个不同会话；稀疏数据不会产出。
- 中文已完整验证；英文/其他语言为功能性支持，仍需母语润色。
