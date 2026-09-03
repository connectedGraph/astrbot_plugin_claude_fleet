from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import sys
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from mcp.types import CallToolResult, TextContent

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.message_components import At, File, Plain
from astrbot.api.provider import ProviderRequest
from astrbot.api.star import Context, Star, register
from astrbot.core.agent.message import TextPart


PLUGIN_NAME = "astrbot_plugin_claude_fleet"
FILE_ID_RE = re.compile(r"^fleet-file-(\d{6,})$")
TASK_ID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
URL_RE = re.compile(r"https?://[^\s<>]+", re.IGNORECASE)


@register(
    PLUGIN_NAME,
    "connectedGraph",
    "一体化 LaTeX 讲义制作：登记 QQ 文件、本地生成并自动发送 PDF",
    "1.1.0",
)
class ClaudeFleetPlugin(Star):
    def __init__(self, context: Context, config: dict[str, Any] | None = None):
        super().__init__(context)
        self.config = config or {}
        configured_dir = str(self.config.get("storage_dir", "")).strip()
        self.storage_dir = (
            Path(configured_dir)
            if configured_dir
            else Path("data") / "plugin_data" / PLUGIN_NAME
        )
        self.files_dir = self.storage_dir / "files"
        self.artifacts_dir = self.storage_dir / "artifacts"
        self.index_path = self.storage_dir / "index.json"
        self.tasks_path = self.storage_dir / "tasks.json"
        self.audit_path = self.storage_dir / "audit.jsonl"
        self.server_runtime_dir = self.storage_dir / "fleet_server"
        self.server_runtime_path = self.server_runtime_dir / "runtime.json"
        self.plugin_dir = Path(__file__).resolve().parent
        self.bundled_server_dir = self.plugin_dir / "bundled_server"
        self._index: dict[str, dict[str, Any]] = {}
        self._tasks: dict[str, dict[str, Any]] = {}
        self._next_file_number = 1
        self._file_lock = asyncio.Lock()
        self._poll_lock = asyncio.Lock()
        self._poll_wakeup = asyncio.Event()
        self._poller_task: asyncio.Task | None = None
        self._server_process: asyncio.subprocess.Process | None = None
        self._server_log_tasks: list[asyncio.Task] = []
        self._server_log_tail: deque[str] = deque(maxlen=40)
        self._runtime_api_key = ""
        self._server_start_error = ""
        self._load_state()

    async def initialize(self) -> None:
        self._validate_server_url()
        if self._auto_start_server():
            try:
                await self._ensure_bundled_server()
            except Exception as exc:  # noqa: BLE001
                self._server_start_error = str(exc)
                logger.exception("LaTeX 讲义本地服务自动启动失败")
        if self._auto_poll_enabled():
            self._poller_task = asyncio.create_task(
                self._poll_loop(), name="astrbot-claude-fleet-poller"
            )
        logger.info(
            "LaTeX 讲义制作插件已加载: server=%s auto_start=%s owned=%s auto_poll=%s",
            self._server_url(),
            self._auto_start_server(),
            self._server_process is not None,
            self._auto_poll_enabled(),
        )

    async def terminate(self) -> None:
        if self._poller_task is not None:
            self._poller_task.cancel()
            try:
                await self._poller_task
            except asyncio.CancelledError:
                pass
            self._poller_task = None
        await self._stop_bundled_server()

    # -------------------- 消息入口与上下文注入 --------------------

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def capture_files(self, event: AstrMessageEvent):
        components = getattr(getattr(event, "message_obj", None), "message", []) or []
        file_components = [item for item in components if isinstance(item, File)]
        if not file_components:
            return
        records: list[dict[str, Any]] = []
        errors: list[str] = []
        for component in file_components[: self._max_files_per_message()]:
            try:
                records.append(await self._register_file(component, event))
            except Exception as exc:  # noqa: BLE001
                logger.exception("Claude Fleet 文件登记失败")
                errors.append(str(exc))
        event.set_extra("claude_fleet_records", records)
        event.set_extra("claude_fleet_errors", errors)
        fresh = [item for item in records if not item.get("_dedup_reused")]
        if fresh and not event.is_at_or_wake_command:
            text = "\n".join(
                f"已登记文件 {item['file_id']}：{item['name']}（{item['size_bytes']} bytes）"
                for item in fresh
            )
            await event.send(MessageChain([Plain(text)]))

    @filter.on_llm_request()
    async def inject_fleet_context(self, event: AstrMessageEvent, req: ProviderRequest):
        records = event.get_extra("claude_fleet_records", []) or []
        errors = event.get_extra("claude_fleet_errors", []) or []
        text = str(event.message_str or "")
        links = self._extract_urls(text)
        needs_context = bool(
            re.search(
                r"文件|附件|刚才|上面|这份|任务|执行|处理|生成|讲义|PDF|进度|状态|fleet|Claude",
                text,
                re.IGNORECASE,
            )
        )
        if not records and needs_context:
            records = self._recent_files(event, limit=3)
        if not records and not errors and not links:
            return
        lines = [
            "<claude_fleet_context>",
            "你具备真实的本地 Claude Fleet 任务能力。用户要求执行任务时，调用 fleet_submit_task。",
            "fleet_submit_task 成功后立即给出一句简短确认并结束本轮；不要自行循环查询。",
            "插件会直接轮询本地服务，处理中不发消息；完成后自动发送产物，失败只通知一次。",
            "不要调用其他消息工具重复发送原文件、任务 JSON、控制台日志或中间进度。",
        ]
        for item in records:
            lines.append(
                f"file_id={item['file_id']} name={item['name']} size_bytes={item['size_bytes']}"
            )
        for url in links:
            lines.append(f"url={url}")
        if errors:
            lines.append("文件登记错误：" + "；".join(errors))
        lines.append("</claude_fleet_context>")
        req.extra_user_content_parts.append(TextPart(text="\n".join(lines)))

    # -------------------- 命令 --------------------

    @filter.command("fleet状态")
    async def fleet_health_command(self, event: AstrMessageEvent):
        try:
            health = await self._request_json("GET", "/health", auth=False)
            mode = "插件内置服务" if self._server_process is not None else "外部服务"
            yield event.plain_result(
                f"LaTeX 讲义服务正常（{mode}）："
                f"{health.get('service', 'claude-fleet-server')} v{health.get('version', 'unknown')}"
            )
        except Exception as exc:  # noqa: BLE001
            detail = self._server_start_error or str(exc)
            yield event.plain_result(f"LaTeX 讲义服务不可用：{detail}")

    # -------------------- LLM 工具 --------------------

    @filter.llm_tool(name="fleet_submit_task")
    async def fleet_submit_task(
        self,
        event: AstrMessageEvent,
        instructions: str,
        file_ids: str = "",
    ):
        '''向本地 Claude Fleet 提交异步任务。

        Args:
            instructions(string): 完整任务要求；网页链接必须原样保留在这里
            file_ids(string): 可选，逗号分隔的 fleet-file-000001 文件 ID
        '''
        if str(event.get_platform_name() or "").lower() == "cron":
            yield self._tool_result("禁止 Cron 或后台 Agent 创建 Fleet 任务。")
            return
        if not isinstance(instructions, str) or not instructions.strip():
            yield self._tool_result("instructions 不能为空")
            return
        previous = str(event.get_extra("claude_fleet_submitted_task", "") or "")
        if previous:
            yield self._tool_result(
                f"本轮已经提交任务 taskId={previous}，禁止重复提交；立即输出 final message。"
            )
            return
        try:
            requested_ids = self._parse_file_ids(file_ids)
            if not requested_ids:
                requested_ids = [
                    str(item.get("file_id", ""))
                    for item in event.get_extra("claude_fleet_records", []) or []
                    if item.get("file_id")
                ]
            files: list[dict[str, str]] = []
            names: list[str] = []
            for file_id in requested_ids:
                record, path = self._lookup_file(file_id)
                files.append(
                    {
                        "name": str(record.get("name") or file_id),
                        "contentBase64": base64.b64encode(path.read_bytes()).decode("ascii"),
                    }
                )
                names.append(str(record.get("name") or file_id))
            payload: dict[str, Any] = {
                "instructions": instructions.strip(),
                "files": files,
            }
            if names:
                payload["mainFileName"] = names[0]
            result = await self._request_json("POST", "/api/tasks", json_body=payload)
            task_id = str(result.get("taskId", ""))
            if not TASK_ID_RE.fullmatch(task_id):
                raise RuntimeError(f"服务未返回有效 taskId：{result}")
            self._tasks[task_id] = {
                "task_id": task_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "status": str(result.get("status", "queued")),
                "instructions": instructions.strip(),
                "file_ids": requested_ids,
                "file_names": names,
                "session": str(event.unified_msg_origin or ""),
                "platform": str(event.get_platform_name() or ""),
                "sender_id": str(event.get_sender_id() or ""),
                "group_id": str(event.get_group_id() or ""),
            }
            self._save_tasks()
            self._audit("task_submitted", event, task_id=task_id, file_ids=requested_ids)
            event.set_extra("claude_fleet_submitted_task", task_id)
            self._poll_wakeup.set()
            yield self._tool_result(
                f"已提交本地 Claude Fleet 任务，taskId={task_id}。"
                "插件会静默查询并自动发送产物；立即输出一句简短 final message，禁止继续查询或重复提交。"
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("提交 Claude Fleet 任务失败")
            yield self._tool_result(f"提交失败：{exc}")

    @filter.llm_tool(name="fleet_get_task")
    async def fleet_get_task(self, event: AstrMessageEvent, task_id: str):
        '''查询一个本地 Claude Fleet 任务。

        Args:
            task_id(string): fleet_submit_task 返回的 UUID
        '''
        if not TASK_ID_RE.fullmatch(str(task_id or "").strip()):
            yield self._tool_result("task_id 格式无效")
            return
        try:
            result = await self._request_json("GET", f"/api/tasks/{task_id.strip()}")
            delivery = None
            if str(result.get("status", "")).lower() == "succeeded":
                delivery = await self._deliver_artifact(task_id.strip(), result, event=event)
            safe = self._safe_task_result(result)
            if delivery:
                safe["delivery"] = delivery
            yield self._tool_result(json.dumps(safe, ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001
            yield self._tool_result(f"查询失败：{exc}")

    @filter.llm_tool(name="fleet_list_tasks")
    async def fleet_list_tasks(self, event: AstrMessageEvent, limit: int = 5):
        '''列出当前 Fleet API Key 名下最近的任务。

        Args:
            limit(number): 返回数量，1 到 20
        '''
        try:
            size = max(1, min(int(limit), 20))
            result = await self._request_json("GET", f"/api/tasks?limit={size}")
            safe = [self._safe_task_result(item) for item in result if isinstance(item, dict)]
            yield self._tool_result(json.dumps(safe, ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001
            yield self._tool_result(f"列出任务失败：{exc}")

    # -------------------- 后台静默轮询 --------------------

    async def _poll_loop(self) -> None:
        while True:
            try:
                try:
                    await asyncio.wait_for(
                        self._poll_wakeup.wait(), timeout=self._poll_interval_seconds()
                    )
                except TimeoutError:
                    pass
                self._poll_wakeup.clear()
                await self._poll_pending_tasks()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("Claude Fleet 静默轮询异常")

    async def _poll_pending_tasks(self) -> None:
        if self._poll_lock.locked():
            return
        async with self._poll_lock:
            for task_id, saved in list(self._tasks.items()):
                if not isinstance(saved, dict):
                    continue
                if saved.get("delivered_at") or saved.get("terminal_notified_at"):
                    continue
                if saved.get("polling_disabled_reason"):
                    continue
                try:
                    created = datetime.fromisoformat(str(saved.get("created_at", "")))
                    age_hours = (datetime.now(timezone.utc) - created).total_seconds() / 3600
                    if age_hours > self._poll_timeout_hours():
                        await self._notify_failure(
                            saved,
                            {"message": f"超过 {self._poll_timeout_hours()} 小时仍未完成，已停止自动查询"},
                        )
                        saved["polling_disabled_reason"] = "poll_timeout"
                        saved["polling_disabled_at"] = datetime.now(timezone.utc).isoformat()
                        self._save_tasks()
                        continue
                except (TypeError, ValueError):
                    saved["polling_disabled_reason"] = "invalid_created_at"
                    self._save_tasks()
                    continue
                try:
                    result = await self._request_json("GET", f"/api/tasks/{task_id}")
                    status = str(result.get("status", "")).lower()
                    saved["status"] = status
                    saved["last_polled_at"] = datetime.now(timezone.utc).isoformat()
                    saved.pop("last_poll_error", None)
                    self._save_tasks()
                    if status == "succeeded":
                        await self._deliver_artifact(task_id, result)
                    elif status in {"failed", "expired", "cancelled", "canceled"}:
                        await self._notify_failure(saved, result)
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code == 404:
                        saved["polling_disabled_reason"] = "task_not_found_or_expired"
                        saved["polling_disabled_at"] = datetime.now(timezone.utc).isoformat()
                    else:
                        saved["last_poll_error"] = str(exc)[:500]
                    self._save_tasks()
                except Exception as exc:  # noqa: BLE001
                    saved["last_poll_error"] = str(exc)[:500]
                    saved["last_polled_at"] = datetime.now(timezone.utc).isoformat()
                    self._save_tasks()
                    logger.warning("查询 Fleet 任务失败 task_id=%s: %s", task_id, exc)

    async def _deliver_artifact(
        self,
        task_id: str,
        result: dict[str, Any],
        event: AstrMessageEvent | None = None,
    ) -> dict[str, Any]:
        saved = self._tasks.get(task_id)
        if not saved:
            return {"sent": False, "reason": "本地没有任务会话信息"}
        if saved.get("delivered_at"):
            return {"sent": False, "already_sent": True}
        artifact_url = str(result.get("artifactUrl", "")).strip()
        if not artifact_url:
            artifact_url = f"{self._server_url()}/tasks/{task_id}/artifact"
        self._validate_artifact_url(artifact_url)
        async with self._client(timeout=180) as client:
            # Fleet 的 artifact 路由本身是 capability URL，无需携带 API Key。
            response = await client.get(artifact_url)
            response.raise_for_status()
        suffix = self._detect_suffix(response.content)
        filename = f"claude-fleet-{task_id}{suffix}"
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        output = (self.artifacts_dir / filename).resolve()
        if output.parent != self.artifacts_dir.resolve():
            raise RuntimeError("产物路径无效")
        await asyncio.to_thread(output.write_bytes, response.content)
        chain = MessageChain([File(name=filename, file=str(output))])
        if event is not None:
            await event.send(chain)
        else:
            sent = await self.context.send_message(str(saved.get("session", "")), chain)
            if not sent:
                raise RuntimeError("原始 QQ 会话尚未连接，稍后重试发送")
        saved["delivered_at"] = datetime.now(timezone.utc).isoformat()
        saved["artifact_path"] = str(output)
        saved["artifact_bytes"] = len(response.content)
        self._save_tasks()
        self._audit("artifact_delivered", self._audit_event(saved), task_id=task_id, path=str(output))
        return {"sent": True, "filename": filename, "bytes": len(response.content)}

    async def _notify_failure(self, saved: dict[str, Any], result: dict[str, Any]) -> None:
        if saved.get("terminal_notified_at"):
            return
        reason = str(result.get("message") or result.get("error") or "任务执行失败")
        reason = re.sub(r"\s+", " ", reason).strip()[:240]
        parts: list[Any] = []
        if saved.get("group_id") and saved.get("sender_id"):
            parts.append(At(qq=str(saved["sender_id"])))
        parts.append(Plain(f"Claude Fleet 任务失败：{reason}"))
        sent = await self.context.send_message(str(saved.get("session", "")), MessageChain(parts))
        if not sent:
            raise RuntimeError("原始 QQ 会话尚未连接，稍后重试失败通知")
        saved["terminal_notified_at"] = datetime.now(timezone.utc).isoformat()
        self._save_tasks()

    # -------------------- HTTP --------------------

    def _server_url(self) -> str:
        return str(self.config.get("server_url", "http://127.0.0.1:32180")).strip().rstrip("/")

    def _validate_server_url(self) -> None:
        parsed = urlparse(self._server_url())
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("server_url 必须是有效 HTTP(S) 地址")
        local_hosts = {"127.0.0.1", "localhost", "::1"}
        if parsed.hostname.lower() not in local_hosts and not self._allow_remote_server():
            raise ValueError("默认只允许本机 claude-fleet-server；如确需远程地址，请开启 allow_remote_server")

    def _validate_artifact_url(self, artifact_url: str) -> None:
        base = urlparse(self._server_url())
        artifact = urlparse(artifact_url)
        if artifact.scheme not in {"http", "https"} or not artifact.hostname:
            raise ValueError("Fleet 返回了无效 artifactUrl")
        if (artifact.scheme, artifact.hostname, artifact.port) != (
            base.scheme,
            base.hostname,
            base.port,
        ):
            raise ValueError("拒绝从 Fleet 服务之外的地址下载产物")

    def _headers(self) -> dict[str, str]:
        token = self._runtime_api_key or str(self.config.get("api_key", "")).strip()
        return {"Authorization": f"Bearer {token}"} if token else {}

    def _client(self, timeout: float = 30) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=timeout, follow_redirects=True, trust_env=False)

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        auth: bool = True,
    ) -> Any:
        async with self._client() as client:
            response = await client.request(
                method,
                f"{self._server_url()}{path}",
                headers=self._headers() if auth else {},
                json=json_body,
            )
            response.raise_for_status()
            return response.json()

    # -------------------- 内置 Fleet Server --------------------

    async def _ensure_bundled_server(self) -> None:
        parsed = urlparse(self._server_url())
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("自动启动仅支持本机 HTTP 地址；远程或 HTTPS 服务请关闭 auto_start_server")

        configured_key = str(self.config.get("api_key", "")).strip()
        runtime = self._load_or_create_server_runtime(configured_key)
        self._runtime_api_key = configured_key or str(runtime["fleet_api_key"])

        try:
            health = await self._request_json("GET", "/health", auth=False)
            if health.get("service") != "claude-fleet-server":
                raise RuntimeError("server_url 已被其他 HTTP 服务占用")
            logger.info("检测到已运行的 claude-fleet-server，插件不会重复启动或关闭它")
            return
        except (httpx.HTTPError, OSError):
            pass

        entry = self.bundled_server_dir / "bin" / "fleet.js"
        executor = self.bundled_server_dir / "examples" / "handout" / "executor.js"
        skill_dir = self.bundled_server_dir / "examples" / "handout" / "skill"
        if not entry.is_file() or not executor.is_file() or not skill_dir.is_dir():
            raise FileNotFoundError("插件包缺少 bundled_server，无法自动启动讲义服务")

        self._ensure_bundled_tool_permissions()
        node = self._node_executable()
        self._write_provider_config()
        port = parsed.port or 80
        host = parsed.hostname or "127.0.0.1"
        env = os.environ.copy()
        env.update(
            {
                "HOST": host,
                "PORT": str(port),
                "PUBLIC_BASE_URL": self._server_url(),
                "TASK_ROOT": str(self.server_runtime_dir / "tasks"),
                "KEYSTORE_FILE": str(self.server_runtime_dir / "keys.json"),
                "PROVIDERS_FILE": str(self.server_runtime_dir / "providers.json"),
                "FLEET_API_KEYS": f"{self._runtime_api_key}:astrbot",
                "CLAUDE_LOCAL_KEY": str(runtime["claude_local_key"]),
                "FLEET_ADMIN_USER": "admin",
                "FLEET_ADMIN_PASS": str(runtime["admin_password"]),
                "FLEET_EXECUTOR": str(executor),
                "HANDOUT_SKILL_DIR": str(skill_dir),
                "FLEET_ARTIFACT_SUFFIX": "/output/output.pdf",
                "AGENT_MAX_TURNS": str(self._agent_max_turns()),
                "NO_PROXY": "127.0.0.1,localhost,::1",
            }
        )
        claude_bin = str(self.config.get("claude_executable", "")).strip()
        if claude_bin:
            env["CLAUDE_BIN"] = claude_bin
        worker_proxy = str(self.config.get("worker_proxy", "")).strip()
        if worker_proxy:
            env["HTTP_PROXY"] = worker_proxy
            env["HTTPS_PROXY"] = worker_proxy
            env["NODE_USE_ENV_PROXY"] = "1"
        else:
            for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NODE_USE_ENV_PROXY"):
                env.pop(key, None)

        kwargs: dict[str, Any] = {
            "cwd": str(self.bundled_server_dir),
            "env": env,
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
        }
        if sys.platform == "win32":
            kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        self._server_process = await asyncio.create_subprocess_exec(
            node, str(entry), "serve", **kwargs
        )
        assert self._server_process.stdout is not None
        assert self._server_process.stderr is not None
        self._server_log_tasks = [
            asyncio.create_task(self._drain_server_stream(self._server_process.stdout, "stdout")),
            asyncio.create_task(self._drain_server_stream(self._server_process.stderr, "stderr")),
        ]

        deadline = asyncio.get_running_loop().time() + self._server_start_timeout()
        while asyncio.get_running_loop().time() < deadline:
            if self._server_process.returncode is not None:
                tail = " | ".join(self._server_log_tail)
                await self._stop_bundled_server()
                raise RuntimeError(f"内置服务提前退出：{tail or '无日志'}")
            try:
                health = await self._request_json("GET", "/health", auth=False)
                if health.get("ok"):
                    await self._request_json("GET", "/api/tasks/check")
                    logger.info("内置 LaTeX 讲义服务已启动: pid=%s", self._server_process.pid)
                    return
            except (httpx.HTTPError, OSError):
                await asyncio.sleep(0.25)
        tail = " | ".join(self._server_log_tail)
        await self._stop_bundled_server()
        raise TimeoutError(f"内置服务启动超时：{tail or '无日志'}")

    async def _stop_bundled_server(self) -> None:
        process = self._server_process
        self._server_process = None
        if process is not None and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=8)
            except TimeoutError:
                process.kill()
                await process.wait()
        for task in self._server_log_tasks:
            if not task.done():
                task.cancel()
        if self._server_log_tasks:
            await asyncio.gather(*self._server_log_tasks, return_exceptions=True)
        self._server_log_tasks = []

    async def _drain_server_stream(self, stream: asyncio.StreamReader, label: str) -> None:
        while True:
            line = await stream.readline()
            if not line:
                return
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            self._server_log_tail.append(f"{label}: {text[:500]}")
            if label == "stderr":
                logger.warning("[latex-handout-server] %s", text)
            else:
                logger.info("[latex-handout-server] %s", text)

    def _load_or_create_server_runtime(self, configured_key: str) -> dict[str, str]:
        self.server_runtime_dir.mkdir(parents=True, exist_ok=True)
        value: dict[str, Any] = {}
        if self.server_runtime_path.is_file():
            try:
                loaded = json.loads(self.server_runtime_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    value = loaded
            except (OSError, json.JSONDecodeError):
                logger.warning("内置服务 runtime.json 无效，将重新生成缺失字段")
        value["fleet_api_key"] = configured_key or str(value.get("fleet_api_key") or secrets.token_urlsafe(32))
        value["claude_local_key"] = str(value.get("claude_local_key") or secrets.token_urlsafe(32))
        value["admin_password"] = str(value.get("admin_password") or secrets.token_urlsafe(24))
        self._atomic_json_write(self.server_runtime_path, value)
        return {key: str(value[key]) for key in ("fleet_api_key", "claude_local_key", "admin_password")}

    def _write_provider_config(self) -> None:
        base_url = str(self.config.get("provider_base_url", "")).strip().rstrip("/")
        model = str(self.config.get("provider_model", "")).strip()
        api_key = str(self.config.get("provider_api_key", "")).strip()
        if not base_url and not model and not api_key:
            return
        if not base_url or not model:
            raise ValueError("配置模型供应商时，provider_base_url 与 provider_model 必须同时填写")
        provider_type = str(self.config.get("provider_type", "openai")).strip().lower()
        if provider_type not in {"openai", "anthropic"}:
            raise ValueError("provider_type 只能是 openai 或 anthropic")
        if not re.match(r"^https?://", base_url, re.IGNORECASE):
            raise ValueError("provider_base_url 必须是 HTTP(S) 地址")
        path = self.server_runtime_dir / "providers.json"
        data: dict[str, Any] = {"activeProviderId": "astrbot", "providers": {}}
        if path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data = loaded
            except (OSError, json.JSONDecodeError):
                pass
        providers = data.setdefault("providers", {})
        previous = providers.get("astrbot", {}) if isinstance(providers, dict) else {}
        providers["astrbot"] = {
            "type": provider_type,
            "baseUrl": base_url,
            "apiKey": api_key or str(previous.get("apiKey", "")),
            "model": model,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        data["activeProviderId"] = "astrbot"
        self._atomic_json_write(path, data)

    def _node_executable(self) -> str:
        configured = str(self.config.get("node_executable", "")).strip()
        if configured:
            path = Path(configured)
            if not path.is_file():
                raise FileNotFoundError(f"找不到 Node.js：{configured}")
            return str(path)
        found = shutil.which("node")
        if not found:
            raise FileNotFoundError("找不到 Node.js；请安装 Node.js 18+ 或配置 node_executable")
        return found

    def _ensure_bundled_tool_permissions(self) -> None:
        if sys.platform == "win32":
            return
        relative_paths = (
            "bin/fleet.js",
            "examples/handout/skill/tools/cloudtex/bin/cloudtex-linux-amd64",
            "examples/handout/skill/tools/ocrcli/bin/ocrcli-linux-amd64",
        )
        for relative in relative_paths:
            path = self.bundled_server_dir / relative
            if path.is_file():
                path.chmod(path.stat().st_mode | 0o111)

    # -------------------- 文件与状态 --------------------

    async def _register_file(self, component: File, event: AstrMessageEvent) -> dict[str, Any]:
        source_path = await component.get_file()
        if not source_path or not os.path.isfile(source_path):
            raise FileNotFoundError("平台文件无法下载或本地文件不存在")
        source = Path(source_path)
        size = source.stat().st_size
        if size > self._max_file_bytes():
            raise ValueError(f"文件超过大小限制（{self._max_file_bytes()} bytes）")
        digest = await asyncio.to_thread(self._sha256_file, source)
        name = str(getattr(component, "name", "") or source.name)
        sender_id = str(event.get_sender_id() or "")
        group_id = str(event.get_group_id() or "")
        async with self._file_lock:
            now = datetime.now(timezone.utc)
            for existing in self._index.values():
                if (
                    existing.get("sha256") == digest
                    and existing.get("name") == name
                    and existing.get("sender_id") == sender_id
                    and existing.get("group_id") == group_id
                ):
                    try:
                        age = (now - datetime.fromisoformat(str(existing.get("created_at")))).total_seconds()
                    except (TypeError, ValueError):
                        age = 999
                    stored = self.files_dir / str(existing.get("stored_name", ""))
                    if 0 <= age <= 30 and stored.is_file():
                        reused = dict(existing)
                        reused["_dedup_reused"] = True
                        return reused
            file_id = f"fleet-file-{self._next_file_number:06d}"
            self._next_file_number += 1
            suffix = source.suffix[:20]
            stored_name = f"{file_id}{suffix}"
            self.files_dir.mkdir(parents=True, exist_ok=True)
            target = self.files_dir / stored_name
            await asyncio.to_thread(target.write_bytes, source.read_bytes())
            record = {
                "file_id": file_id,
                "name": name,
                "stored_name": stored_name,
                "size_bytes": size,
                "sha256": digest,
                "sender_id": sender_id,
                "group_id": group_id,
                "platform": str(event.get_platform_name() or ""),
                "created_at": now.isoformat(),
            }
            self._index[file_id] = record
            self._save_index()
            return record

    def _lookup_file(self, file_id: str) -> tuple[dict[str, Any], Path]:
        if not FILE_ID_RE.fullmatch(file_id):
            raise ValueError(f"无效文件 ID：{file_id}")
        record = self._index.get(file_id)
        if not record:
            raise FileNotFoundError(f"找不到文件：{file_id}")
        path = (self.files_dir / str(record.get("stored_name", ""))).resolve()
        if path.parent != self.files_dir.resolve() or not path.is_file():
            raise FileNotFoundError(f"文件副本不存在：{file_id}")
        return record, path

    def _recent_files(self, event: AstrMessageEvent, limit: int) -> list[dict[str, Any]]:
        sender_id = str(event.get_sender_id() or "")
        group_id = str(event.get_group_id() or "")
        platform = str(event.get_platform_name() or "")
        records = [
            item
            for item in self._index.values()
            if item.get("sender_id") == sender_id
            and item.get("group_id") == group_id
            and item.get("platform") == platform
        ]
        records.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
        return records[:limit]

    @staticmethod
    def _parse_file_ids(raw: str) -> list[str]:
        if not raw:
            return []
        values = [item.strip() for item in re.split(r"[,，\s]+", str(raw)) if item.strip()]
        invalid = [item for item in values if not FILE_ID_RE.fullmatch(item)]
        if invalid:
            raise ValueError("无效文件 ID：" + ", ".join(invalid))
        return list(dict.fromkeys(values))[:20]

    @staticmethod
    def _extract_urls(text: str) -> list[str]:
        return list(dict.fromkeys(url.rstrip(".,!?)]}>") for url in URL_RE.findall(text or "")))[:10]

    @staticmethod
    def _safe_task_result(result: dict[str, Any]) -> dict[str, Any]:
        return {
            key: result.get(key)
            for key in (
                "taskId",
                "status",
                "statusLabel",
                "phase",
                "createdAt",
                "startedAt",
                "finishedAt",
                "updatedAt",
                "queuePosition",
                "message",
                "error",
                "artifactBytes",
                "artifactUrl",
            )
            if result.get(key) is not None
        }

    @staticmethod
    def _detect_suffix(content: bytes) -> str:
        if content.startswith(b"%PDF"):
            return ".pdf"
        if content.startswith(b"\x89PNG\r\n\x1a\n"):
            return ".png"
        if content.startswith(b"\xff\xd8\xff"):
            return ".jpg"
        if content.startswith(b"PK\x03\x04"):
            return ".zip"
        return ".bin"

    def _load_state(self) -> None:
        try:
            if self.index_path.exists():
                raw = json.loads(self.index_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    self._index = {str(k): v for k, v in raw.items() if isinstance(v, dict)}
            if self.tasks_path.exists():
                raw = json.loads(self.tasks_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    self._tasks = {str(k): v for k, v in raw.items() if isinstance(v, dict)}
        except Exception as exc:  # noqa: BLE001
            logger.warning("读取 Claude Fleet 插件状态失败：%s", exc)
        numbers = [
            int(match.group(1))
            for key in self._index
            if (match := FILE_ID_RE.fullmatch(key))
        ]
        self._next_file_number = max(numbers, default=0) + 1

    def _save_index(self) -> None:
        self._atomic_json_write(self.index_path, self._index)

    def _save_tasks(self) -> None:
        self._atomic_json_write(self.tasks_path, self._tasks)

    def _atomic_json_write(self, path: Path, value: Any) -> None:
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)

    def _audit(self, action: str, event: Any, **fields: Any) -> None:
        entry = {
            "time": datetime.now(timezone.utc).isoformat(),
            "action": action,
            "platform": str(event.get_platform_name() or ""),
            "sender_id": str(event.get_sender_id() or ""),
            "group_id": str(event.get_group_id() or ""),
            **fields,
        }
        try:
            self.storage_dir.mkdir(parents=True, exist_ok=True)
            with self.audit_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception:  # noqa: BLE001
            logger.exception("写入 Claude Fleet 审计日志失败")

    @staticmethod
    def _audit_event(task: dict[str, Any]):
        class AuditEvent:
            def get_platform_name(self):
                return task.get("platform", "")

            def get_sender_id(self):
                return task.get("sender_id", "")

            def get_group_id(self):
                return task.get("group_id", "")

        return AuditEvent()

    @staticmethod
    def _sha256_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _tool_result(text: str) -> CallToolResult:
        return CallToolResult(content=[TextContent(type="text", text=str(text))])

    def _auto_poll_enabled(self) -> bool:
        value = self.config.get("auto_poll_enabled", True)
        return value if isinstance(value, bool) else str(value).lower() not in {"0", "false", "off", "no"}

    def _auto_start_server(self) -> bool:
        value = self.config.get("auto_start_server", True)
        return value if isinstance(value, bool) else str(value).lower() not in {"0", "false", "off", "no"}

    def _allow_remote_server(self) -> bool:
        value = self.config.get("allow_remote_server", False)
        return value if isinstance(value, bool) else str(value).lower() in {"1", "true", "on", "yes"}

    def _poll_interval_seconds(self) -> int:
        try:
            return max(10, min(int(self.config.get("poll_interval_seconds", 15)), 3600))
        except (TypeError, ValueError):
            return 15

    def _poll_timeout_hours(self) -> int:
        try:
            return max(1, min(int(self.config.get("poll_timeout_hours", 24)), 168))
        except (TypeError, ValueError):
            return 24

    def _server_start_timeout(self) -> int:
        try:
            return max(3, min(int(self.config.get("server_start_timeout_seconds", 20)), 120))
        except (TypeError, ValueError):
            return 20

    def _agent_max_turns(self) -> int:
        try:
            return max(5, min(int(self.config.get("agent_max_turns", 60)), 200))
        except (TypeError, ValueError):
            return 60

    def _max_files_per_message(self) -> int:
        try:
            return max(1, min(int(self.config.get("max_files_per_message", 20)), 20))
        except (TypeError, ValueError):
            return 20

    def _max_file_bytes(self) -> int:
        try:
            return max(1, int(self.config.get("max_file_bytes", 8 * 1024 * 1024)))
        except (TypeError, ValueError):
            return 8 * 1024 * 1024
