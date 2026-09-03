# latex讲义制作插件

一个可直接导入 AstrBot 的一体化 LaTeX PDF 讲义制作插件。

ZIP 已包含 [`claude-fleet-server`](https://github.com/connectedGraph/claude-fleet-server)、
本地任务队列、`/mcp` 服务、Claude Code worker、LaTeX 讲义执行器、模板以及编译工具。
不需要再单独克隆或启动 Fleet Server，也不再依赖公网 6767 任务服务。

## 能做什么

- 自动捕获 QQ 私聊文件和群文件，登记为 `fleet-file-000001`。
- 模型自主调用 `fleet_submit_task`，将完整要求、网页链接和多个文件提交给本地服务。
- 插件内部以 REST 静默查询任务，不创建 AstrBot Cron，不周期性唤醒模型。
- Claude Code 在隔离目录中读取资料、编写 LaTeX、调用 cloudtex 编译并校验 PDF。
- 完成后自动下载 PDF，通过 NapCat / OneBot 发回原 QQ 会话。
- 失败最多通知一次；同一轮 Agent 禁止重复提交。
- 内置服务同时提供 Streamable HTTP MCP：`http://127.0.0.1:32180/mcp`。

## 一体化链路

```text
QQ 文件 / 网页链接 / 用户要求
        ↓
AstrBot 登记文件并让模型调用 fleet_submit_task
        ↓
插件内置 Fleet Server（127.0.0.1:32180）
        ↓
Claude Code worker + LaTeX 讲义执行器
        ↓
插件静默查询 REST 状态
        ↓
PDF 完成后经 NapCat 自动发回原 QQ 会话
```

## 前置条件

- AstrBot `>= 4.25.1`
- Node.js `>= 18`
- Claude Code CLI `>= 2.0.0`
- NapCat / OneBot v11（用于 QQ 文件接收和 PDF 发送）
- 一个可用的 OpenAI 兼容或 Anthropic Messages 模型 API

Fleet Server 和讲义资源已包含在插件 ZIP 中；Node.js、Claude Code 与模型 API Key 不会打包。

## 安装

从 Releases 下载 `astrbot_plugin_claude_fleet_v1.1.0.zip`，在 AstrBot WebUI 的插件页面导入，
然后重启 AstrBot。

插件显示名为：

```text
latex讲义制作插件
```

内部插件 ID 继续使用 `astrbot_plugin_claude_fleet`，因此可直接覆盖升级 v1.0.0，避免同时加载两份。

## 必填配置

在 AstrBot 插件配置中填写模型供应商：

| 配置项 | 说明 |
|---|---|
| `provider_type` | `openai` 或 `anthropic` |
| `provider_base_url` | 供应商 Base URL |
| `provider_api_key` | 供应商 API Key |
| `provider_model` | 实际模型 ID |

OpenAI 兼容接口示例：

```text
provider_type = openai
provider_base_url = https://api.example.com/v1
provider_model = example-model
```

Anthropic Messages 接口示例：

```text
provider_type = anthropic
provider_base_url = https://api.anthropic.com/v1
provider_model = claude-model-id
```

`provider_api_key` 只写入 AstrBot 本地配置和插件运行数据，不写进 ZIP、Git 或日志。

## 主要配置

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `auto_start_server` | `true` | 自动启动 ZIP 内置服务 |
| `server_url` | `http://127.0.0.1:32180` | 内置服务地址；端口冲突时可改 |
| `api_key` | 空 | 内置模式留空自动生成；外部模式填写 Bearer Key |
| `node_executable` | 空 | 留空从 PATH 自动查找 Node.js |
| `claude_executable` | 空 | 留空自动查找 Claude Code |
| `worker_proxy` | 空 | 默认不走代理；需要时手动填写 |
| `agent_max_turns` | `60` | 限制 worker 回合数，防止完成后无限自检 |
| `auto_poll_enabled` | `true` | 插件内部静默查询 |
| `poll_interval_seconds` | `15` | 查询间隔 |
| `poll_timeout_hours` | `24` | 自动查询最长时间 |

内置 Fleet API Key、Claude 本地代理 Key 和管理密码会首次启动时随机生成，保存在：

```text
AstrBot/data/plugin_data/astrbot_plugin_claude_fleet/fleet_server/runtime.json
```

## 人格工具白名单

如果人格启用了工具白名单，加入：

```json
[
  "fleet_submit_task",
  "fleet_get_task",
  "fleet_list_tasks"
]
```

推荐提示词：

```text
当用户要求把文件、资料或网页制作成讲义时，调用一次 fleet_submit_task。
instructions 要完整复述用户要求，并原样保留网页链接；有已登记文件时传入准确的 fleet-file ID。
提交成功后只简短确认并结束本轮，不要循环查询，不要再次提交，不要输出工具 JSON。
插件会在后台静默查询，完成后自动发送 PDF，失败只通知一次。
```

## 使用

文件讲义：

1. 在 QQ 发送一个或多个文件。
2. Bot 返回 `已登记文件 fleet-file-000001：资料.pdf`。
3. 发送“把刚才的资料制作成一份中文讲义”。
4. 模型提交一次任务；完成后插件自动发送 PDF。

网页讲义：

```text
阅读 https://example.com/article，把它制作成一份 LaTeX PDF 讲义
```

链接不要求是纯链接消息。模型会把包含链接的完整要求放进 `instructions`。

检查服务：

```text
/fleet状态
```

## 外部 Fleet Server 模式

如需连接自己管理的 Fleet Server：

- 关闭 `auto_start_server`
- 修改 `server_url`
- 填写 `api_key`
- 非本机地址还需开启 `allow_remote_server`

插件只会关闭自己启动的内置进程，不会关闭检测到的外部服务。

## 安全与稳定性

- 内置服务默认仅监听 `127.0.0.1`。
- 本地 REST 请求使用 `trust_env=False`，不会误走系统代理。
- worker 默认不走代理；只有配置 `worker_proxy` 后才启用。
- 产物只允许从与 Fleet Server 同源的 URL 下载，下载时不携带 API Key。
- Base64、完整任务 JSON、控制台日志和中间进度不会发进 QQ 消息。
- 后台轮询不调用 LLM，不创建 Cron，不消耗聊天 Token。
- `agent_max_turns` 与服务端硬超时共同限制内部 Agent 循环。
- 插件停用时只回收自己创建的 Node 进程。

## 已验证

- AstrBot 4.25.1 环境导入，三个 LLM 工具成功登记。
- 插件自动启动内置服务，`/health` 与带 Bearer 的 `/api/tasks/check` 返回 200。
- 插件终止后内置服务端口释放。
- 上游显式测试 12/12 通过。
- 真实 Claude Code 任务完成，cloudtex 生成 `%PDF-1.7`，artifact 下载返回 200。

## 许可证与上游

本插件使用 Apache License 2.0。

ZIP 内嵌的 `claude-fleet-server` 来自 connectedGraph，同样使用 Apache License 2.0；
其原始许可证、README 与源码保留在 `bundled_server/`。详见 `THIRD_PARTY_NOTICES.md`。
