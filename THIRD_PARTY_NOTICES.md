# 第三方软件声明

本插件在 `bundled_server/` 中分发以下上游项目：

- 项目：`claude-fleet-server`
- 上游：https://github.com/connectedGraph/claude-fleet-server
- 版权所有：connectedGraph 及项目贡献者
- 许可证：Apache License 2.0

插件包保留了上游的 `LICENSE`、`README.md`、源码、讲义执行器、模板与工具。

为适配 AstrBot 一体化运行，本插件发行版对内嵌副本做了少量集成修改：

- 讲义执行器按实际 `HOST` / `PORT` 连接同进程的 Claude 代理，不再写死 3180。
- 将任务的 `instructions` 正确传入讲义提示词。
- worker 代理由插件配置显式控制，默认不强制使用本机 7890。
- 增加可配置的 Claude Code 最大回合数，防止过度自检或循环。

这些修改不改变上游许可证。
