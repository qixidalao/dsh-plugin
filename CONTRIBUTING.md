# 贡献与评审指南

这是一个 DeepSeek Harness 插件（Host 侧，无构建步骤）。欢迎从「评审、实验、文档」三个方向参与。

## 先跑起来

```bash
git clone https://github.com/qixidalao/dsh-plugin.git
cd dsh-plugin
node --check index.js     # 语法
node test.mjs             # 27 项纯函数测试
```

`eval.mjs` / `bench.mjs` 需要真实的记忆库（`$DSH_HOME/storages/dynamic_memory/exchanges/`），本地有数据时再跑：

```bash
node eval.mjs            # 检索质量（hit@3 / MRR）
node bench.mjs           # 延迟与输出体积
```

## 目录

| 路径 | 说明 |
|---|---|
| `index.js` | 全部实现（抓取、存储、检索、注入、画像、证据层、命令） |
| `DOCS.md` | 架构与记忆逻辑，**评审先读这个** |
| `README.md` | 使用说明与版本演进 |
| `test.mjs` | 纯函数测试（改逻辑必须补/改测试） |
| `eval.mjs` + `eval-queries.json` | 检索评测集与脚本 |
| `bench.mjs` | 性能基准 |

## 代码约束

- 不引入运行时依赖（当前只有 Node 内建模块），保持单文件可审计；
- 所有记忆写入必须可追溯到会话文本（`sourceIds` / `quote`），不写无法验证的结论；
- 推断必须带 `confidence` 与至少一个 `alternatives`；
- 新增行为要有纯函数测试；改动打分/注入要更新 `eval.mjs` 的基线并说明差异。

## 记忆数据的边界

- 仓库**不包含**任何用户记忆数据；数据在本机 `$DSH_HOME/storages/dynamic_memory/`；
- 提交示例、日志、截图前，先脱敏（不要带真实项目名、路径、账号）；
- 不要为了让测试通过而内置个人数据，用合成数据写 fixture。

## 隐私与伦理

- 不把心理推断伪装成医学诊断；
- 不对用户做敏感属性推断（健康、性取向、宗教等）并持久化；
- 用户纠正优先于任何推断；
- `sensitivity=private` 的观察不注入明文、不导出。

## 提交信息

```
feat(memory): <做什么>
fix(memory): <修什么，附复现方式>
docs: <改了什么文档>
test: <补了哪些用例>
```

PR 描述请包含：动机、改动点、验证方式（命令 + 输出）、对评分/注入的影响。

## 语言边界

- 运行时文案（注入、标签、工具描述、命令）必须走 `locale/messages.*.json`，不得直接写死中文或英文；
- 核心认知逻辑不得依赖某一语言的词表/分词；词表、短语、停用词放 locale 数据；
- 代码注释与设计文档可以用中文（作者母语），但 README 以英文为主版本，中文放 `README.zh-CN.md`；
- 新增语言时同时补语言包与多语言测试。
