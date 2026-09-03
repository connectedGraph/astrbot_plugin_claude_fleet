# Examples / handouts — 把通用内核变成「讲义生成器」

这个示例演示如何给 claude-fleet-server 加一个**业务执行器**：把默认的「生成任意文件」
换成「用 Claude Code 技能 + cloudtex 产出 LaTeX PDF 讲义」。

## 原理

通用内核（`lib/`）完全不知道「讲义」「PDF」「LaTeX」这些词。它只提供：
`JobStore`（任务队列）+ `startWorker.execute`（执行钩子）+ `runner.runTask`（spawn Claude）。

「讲义」这件事全部塞在这个 `executor.js` 里：

- `buildPrompt(...)` 构造讲义的提示词（读 SKILL.md、用 cloudtex 编译）
- `buildPermissions(...)` 限定 Agent 只读写任务目录 + 白名单工具的 Bash
- `assertPdf(output)` 校验产物确实是 `%PDF`
- 通过 `runner.runTask({ ... })` 交给通用运行器

## 启用

```bash
# 方案 A：指定 executor 启动服务器
FLEET_EXECUTOR=./examples/handout/executor.js \
HANDOUT_SKILL_DIR=./examples/handout/skill \
CLAUDE_LOCAL_KEY=xxx \
fleet serve

# 产物后缀：讲义产出 output.pdf（默认执行器产出 output.bin）
FLEET_ARTIFACT_SUFFIX=/output/output.pdf
```

## 目录结构

```
examples/handout/
├── executor.js        # 讲义执行器（依赖注入进通用内核）
└── skill/             # 完整讲义技能（SKILL.md / references / assets / tools / templates）
    ├── SKILL.md       # 讲解义如何排 LaTeX
    ├── references/    # 排版/插图/引用/QA 参考资料
    ├── assets/        # vividbook 等 LaTeX 模板
    └── tools/         # cloudtex 编译 + ocrcli OCR（双平台预编译二进制）
```

> 注：`agent-conf/`（Claude Code 会话/备份/settings）与 `tasks/`（运行时产物）属本地
> 运行状态，**不纳入仓库**。技能内容资产（SKILL.md/references/assets/tools）是完整开源的一部分。

## 不用讲义，换成你的业务？

一个全新业务只需写一个类似的 `executor.js`，实现：
```js
export async function myExecutor(task, store, onProgress) {
  // 1. 构造 prompt
  // 2. 调 runner.runTask({ bin, cwd, prompt, output, validateOutput, onProgress, ... })
  // 3. 返回 { bytes, summary }
}
```
然后 `FLEET_EXECUTOR=./my/executor.js` 启动即可。任务队列、断点续跑、供应商代理、
面板、认证全都不用改。