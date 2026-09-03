# AstrBot Claude Fleet 本地任务桥接插件

把 AstrBot / NapCat 收到的 QQ 文件与用户任务提交给本机
[`claude-fleet-server`](https://github.com/connectedGraph/claude-fleet-server)，由本地 Claude Code
worker 异步执行，完成后自动把产物发回原 QQ 会话。

本插件默认只连接 `127.0.0.1` 或 `localhost`，不依赖公网任务服务器。

## 主要能力

- 自动捕获 QQ 私聊文件和群文件，登记为 `fleet-file-000001` 形式的稳定 ID。
- LLM 工具 `fleet_submit_task`：把任务要求及一个或多个文件以 Base64 提交到本地 Fleet。
- LLM 工具 `fleet_get_task`：按 `taskId` 查询任务。
- LLM 工具 `fleet_list_tasks`：列出当前 API Key 名下最近任务。
- `/fleet状态`：检查本地服务是否在线。
- 插件内部静默轮询，不使用 AstrBot Cron，不会周期性唤醒模型或消耗聊天 Token。
- 任务成功后自动下载并发送产物；失败最多通知一次。
- 根据文件头自动识别 PDF、PNG、JPEG、ZIP，其他产物按 `.bin` 发送。
- HTTP 客户端使用 `trust_env=False`，访问本机服务不经过系统代理。

## 工作链路

```text
QQ 文件 / 用户要求
        ↓
AstrBot 插件登记文件
        ↓
模型调用 fleet_submit_task（一次）
        ↓
POST http://127.0.0.1:3180/api/tasks
        ↓
claude-fleet-server 排队并启动 Claude Code worker
        ↓
插件直接查询 REST 状态（不唤醒模型）
        ↓
完成后下载 artifact 并发回原 QQ 会话
```

## 前置条件

- AstrBot `>= 4.25.1`
- NapCat / OneBot v11（如需 QQ 文件收发）
- Python 环境中已有 `httpx` 与 AstrBot 自带的 MCP 类型依赖
- Node.js `>= 18`
- 已安装可用的 Claude Code CLI
- 本机已部署 `claude-fleet-server`

## 一、启动本地 claude-fleet-server

先获取服务端：

```powershell
git clone https://github.com/connectedGraph/claude-fleet-server.git
cd claude-fleet-server
npm run doctor
```

最小启动示例：

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "3180"
$env:PUBLIC_BASE_URL = "http://127.0.0.1:3180"
$env:CLAUDE_LOCAL_KEY = "请换成随机本地密钥"
$env:FLEET_API_KEYS = "请换成插件访问密钥:astrbot"
$env:FLEET_ADMIN_USER = "admin"
$env:FLEET_ADMIN_PASS = "请换成管理密码"

npm run serve
```

如果希望 Fleet 专门生成 PDF 讲义：

```powershell
$env:FLEET_EXECUTOR = ".\examples\handout\executor.js"
$env:HANDOUT_SKILL_DIR = ".\examples\handout\skill"
$env:FLEET_ARTIFACT_SUFFIX = "/output/output.pdf"
npm run serve
```

还需要在 Fleet 管理面板中配置实际模型供应商：

```text
http://127.0.0.1:3180/console
```

服务健康检查：

```powershell
curl.exe http://127.0.0.1:3180/health
```

## 二、安装 AstrBot 插件

### ZIP 导入

从 Releases 下载 ZIP，在 AstrBot WebUI 的插件页面中导入，然后重启 AstrBot。

### 手动安装

把仓库目录复制到：

```text
AstrBot/data/plugins/astrbot_plugin_claude_fleet/
```

重启 AstrBot 后，日志应出现：

```text
Claude Fleet 插件已加载: server=http://127.0.0.1:3180 auto_poll=True
```

## 三、插件配置

在 AstrBot WebUI 中填写：

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `server_url` | `http://127.0.0.1:3180` | Fleet 服务地址 |
| `api_key` | 空 | `FLEET_API_KEYS` 中冒号左侧的 Bearer Key |
| `allow_remote_server` | `false` | 是否允许非本机地址 |
| `storage_dir` | 空 | 文件索引、任务状态和产物保存目录 |
| `auto_poll_enabled` | `true` | 是否自动静默查询任务 |
| `poll_interval_seconds` | `15` | 查询间隔，最低 10 秒 |
| `poll_timeout_hours` | `24` | 单个任务最长自动查询时间 |
| `max_files_per_message` | `20` | 单条消息最多登记文件数 |
| `max_file_bytes` | `8388608` | 单文件大小限制 |

`api_key` 示例：

```text
服务端：FLEET_API_KEYS=my-local-key:astrbot
插件：api_key = my-local-key
```

不要把真实 Key 提交到 Git 仓库或截图公开。

## 四、人格工具白名单

如果 AstrBot 人格配置了工具白名单，需要加入：

```json
[
  "fleet_submit_task",
  "fleet_get_task",
  "fleet_list_tasks"
]
```

推荐在人格提示词中加入：

```text
当用户明确要求执行本地 Claude Fleet 任务时，调用一次 fleet_submit_task。
instructions 必须完整复述用户要求并保留网页链接；有文件时传入准确的 fleet-file ID。
提交成功后只简短确认，不要循环查询，也不要发送工具 JSON 或中间日志。
插件会静默查询任务，完成后自动发送产物，失败只通知一次。
```

## 五、使用示例

### 处理文件

1. 用户先发送文件。
2. Bot 回复：`已登记文件 fleet-file-000001：example.pdf`。
3. 用户发送：`@机器人 把刚才文件整理成一份讲义`。
4. 模型调用 `fleet_submit_task`。
5. 任务完成后插件自动发送产物。

### 处理网页

```text
@机器人 阅读 https://example.com/article 并生成一份研究报告
```

模型应把完整 URL 保留在 `instructions` 中；不需要先上传文件。

### 手动检查

```text
/fleet状态
```

## 安全设计

- 默认拒绝连接非本机 Fleet 地址。
- Bearer Key 只通过请求头发送，不写入审计日志。
- 产物只允许从与 Fleet 服务相同的源下载，且下载时不携带 API Key。
- 本地路径、Base64、完整控制台日志不会注入普通聊天消息。
- 后台轮询直接调用 REST，不创建 AstrBot `active_agent` Cron。
- 同一轮模型运行最多允许提交一个任务，阻止工具循环。
- 后台 synthetic/Cron 事件不能创建 Fleet 任务。

## 常见问题

### `/fleet状态` 正常，但提交返回 401

检查插件 `api_key` 是否与服务端 `FLEET_API_KEYS` 中的 key 完全一致，然后重启服务端。

### 任务一直 queued

运行：

```powershell
npm run doctor
```

确认 Claude Code CLI 可被定位，并检查 Fleet 控制台中的供应商配置、队列和 worker 日志。

### 任务成功但 QQ 没收到产物

确认：

- NapCat 与 AstrBot OneBot WebSocket 已连接。
- 原 QQ 会话仍然有效。
- Bot 具有群文件发送权限。
- Fleet 的 `PUBLIC_BASE_URL` 对 AstrBot 进程可访问。

## 开发验证

```powershell
python -m py_compile main.py
```

## 许可证

本插件使用 Apache License 2.0。`claude-fleet-server` 为独立上游项目，同样使用 Apache License 2.0。
