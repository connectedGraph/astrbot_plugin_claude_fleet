# claude-fleet-server

把你的 **Claude Code CLI 变成可编程的 worker 舰队**：一个 HTTP 任务服务，自动找到机器上
已装的 Claude Code，按你的最低版本要求校验，排队执行任务，可把 LLM 请求路由到任意
供应商（原生 Anthropic 协议或 OpenAI 兼容协议），并支持**断点续跑**、管理面板、MCP 接入。

Turn any installed **Claude Code CLI into a programmable worker fleet** — an HTTP task
service that locates your Claude Code automatically, enforces a minimum-version gate,
queues and runs tasks, routes LLM traffic to any provider (native Anthropic or
OpenAI-compatible), and supports resume, an admin panel, and MCP.

```
Apache License 2.0 · Node.js ≥18 · ESM · zero runtime dependencies
```

---

## 定位 (What this is)

在 handouts-agent-server 的基础上抽象出的**通用内核**：去掉「讲义/PDF/LaTeX」等业务绑定，
只剩大家都能复用的基础设施——

- 🔎 **自动定位 + 版本门槛**：跨平台找 claude 可执行文件（PATH / npm 全局 / `~/.claude/local`
  …），跑 `--version` 校验是否 ≥ 你要求的版本。`fleet doctor` 一键体检。
- 🎛 **任务队列**：异步任务，`meta.json` 持久化，进程重启自动把 `running` 恢复为可重跑。
- ⏯ **断点续跑**：捕获 Claude 的 `session_id`，再次执行用 `--resume` 接着上次上下文。
- 🌐 **固定端点 LLM 代理**：worker 永远只连一个本地地址；面板切换「当前映射」，代理把请求
  透传（Anthropic）或转换（OpenAI）到真实供应商。
- 🧩 **MCP / REST / HTML 面板**：三套接入方式，Bearer 认证 + 本地登录。
- 🔌 **零业务绑定**：业务通过注入 `execute` 钩子进来（示例见 `examples/handout/`）。

## 架构 (Architecture)

```
                    ┌─────────────────────────────── claude-fleet-server ───────────────┐
                    │                                                                  │
   MCP client ──────▶ /mcp            ┌────────────┐    ┌─────────────────────────┐    │
   REST client ─────▶ /api/tasks ────▶│  JobStore  │───▶│ Worker (concurrency=N)  │    │
   Admin browser ───▶ /console        │ (queue+    │    │  └─▶ execute(task,...)  │    │
                    │                 │  persist)  │    │       └─▶ runTask()     │    │
                    │                 └────────────┘    └───────────┬─────────────┘    │
                    │                                              │ spawn claude      │
                    │  /claude/v1/messages (fixed proxy) ◀─────────┘    with local key │
                    │        │   reads providers.active                         │    │
                    │        ├─ anthropic  → pass-through to real provider     │    │
                    │        └─ openai     → convert → forward → synthesize    │    │
                    └──────────────────────────────────────────────────────────┘    │
```

一个 worker = 为你一个任务 spawn 的 `claude -p ...` 子进程。它只带一个固定的本地
`CLAUDE_LOCAL_KEY` 连本机代理，永远不直连外网供应商。

## 快速开始 (Quick start)

```bash
# 1. 体检：自动定位 Claude Code 并核对版本
npm run doctor
# → Claude CLI OK: /usr/local/bin/claude  version 2.1.233 >= 2.0.0

# 2. 配置（复制并编辑）
cp .env.example .env
# 至少设：CLAUDE_LOCAL_KEY=一个随机串；FLEET_ADMIN_USER/PASS
# 想要 Key 认证：FLEET_API_KEYS=key1:alice,key2:bob

# 3. 启动
npm run serve     # 或 node app/server.js

# 4. 打开面板（先登录）
open http://127.0.0.1:3180/console
```

在你的供应商里加一个 `openai` 兼容的 provider 并设为当前映射，然后建任务 —— 走协议转换。

## 环境变量 (Environment)

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3180` / `127.0.0.1` | 监听地址 |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:3180` | 任务/产物链接前缀 |
| `TASK_ROOT` | `./data/tasks` | 任务数据目录 |
| `CLAUDE_BIN` | *(自动发现)* | 显式指定 claude 可执行文件 |
| `CLAUDE_MIN_VERSION` | `2.0.0` | 版本门槛 |
| `CLAUDE_LOCAL_KEY` | *(必填)* | worker 携带的固定代理 key |
| `FLEET_API_KEYS` | *空* | Bearer key 列表，`key:owner` 逗号分隔 |
| `FLEET_ADMIN_USER/PASS` 或 `FLEET_ADMIN_HTPASSWD` | *空* | 本地登录凭据 |
| `FLEET_EXECUTOR` | `lib/claude/executor.js` | 业务执行器模块路径 |
| `FLEET_ARTIFACT_SUFFIX` | `/output/output.bin` | 产物在任务目录内的路径 |
| `AGENT_TIMEOUT_MS` | `900000` | 单任务超时 |
| `WORKER_CONCURRENCY` | `1` | 并行 worker 数 |
| `MAX_*` | ... | 上传大小/数量限额 |

## CLI

```
fleet doctor    locate Claude Code + check version gate + show environment
fleet serve     start the HTTP service
fleet version   print package version
```

## 复用它做新业务 (Extending)

见 [`examples/handout/README.md`](examples/handout/README.md)。核心内核不关心「你的产物是
PDF 还是别的」——写一个 `executor.js` 实现
`(task, store, onProgress) => { bytes, summary }`，设 `FLEET_EXECUTOR` 即可。

## 测试 (Test)

```bash
npm test          # node --test 跑 test/（semver · locate · convert）
```

## License

[Apache License 2.0](./LICENSE).