# 字体说明

`readex-vivid` 明确使用 TeX Live 自带的 `fandol` 中文字体集，不依赖 macOS、iPadOS 或 Linux 的系统字体，也不要求商业字体。模板刻意避开 `mtpro2` 及其他不可再分发的默认字体。完整 ReadOS TeX 环境必须同时提供标准 CTeX 宏包和 Fandol 字体，因此同一份项目在 ReadOS 与普通 Linux XeLaTeX 环境中使用相同的字体发现方式。

交付前，使用 XeLaTeX 编译，并检查日志中是否存在缺失字体或缺字。如果文档需要特定用户字体，请在项目中记录该选择，并在编译前通过标准命令 `fc-match` 验证。
