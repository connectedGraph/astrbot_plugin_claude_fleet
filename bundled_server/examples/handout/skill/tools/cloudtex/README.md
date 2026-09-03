# cloudtex — 零环境 LaTeX 云编译 CLI

把一个 LaTeX 项目编译成**恰好一个 PDF**。不需要本地 TeX 环境。

## 交付保证

无论成功还是失败，`--output` 指定的路径上**永远只会出现一个 PDF**：

- 成功 → 编译出的讲义 PDF
- 全部路径失败 → 内置的单页「交付转换失败」PDF（stderr 附带各路径失败原因）

## 降级链

1. **ytotech**（主力）— `latex.ytotech.com/builds/sync`，支持多文件、二进制图片、xelatex/pdflatex/lualatex。2026-08-31 实测：多章中文讲义（ctexbook + 自定义 cls + fandol 字体）产出与本地 MiKTeX 完全一致。
2. **texlivenet**（备选）— `texlive.net/cgi-bin/latexcgi`（TeX Live 社区服务器）。限制：
   - 只接受**文本文件**；项目含 PNG/PDF 等二进制素材时本路径主动弃权（不伪造结果）；
   - 服务器强制拍平目录（`chapters/ch1.tex` → `chapters--ch1.tex`，工具自动改写引用）；
   - 服务器是 TeX Live 2026 新内核：**xparse 的 `g` 参数类型已移除**，使用 `{m m m g}` 这类旧式 `\NewDocumentCommand` 的 cls（含本 skill 内置 vividbook v1.2.9）在此路径必然编译失败，属预期行为，不是工具 bug。
3. **local** — 本机 latexmk / xelatex / pdflatex / lualatex（MiKTeX 或 TeX Live 任一）。
4. **失败页** — 全部失败时交付内置失败页 PDF，退出码 1。

## 用法

```
cloudtex --project <项目目录> --main main.tex --output <交付.pdf> [flags]
```

| Flag | 默认 | 说明 |
|---|---|---|
| `--project` | 必填 | LaTeX 项目目录（含 main.tex 与章节、cls、assets） |
| `--main` | `main.tex` | 主文档，相对 `--project` |
| `--output` | 必填 | 交付 PDF 路径（必须 `.pdf` 结尾；目录不存在会自动创建） |
| `--engine` | `xelatex` | `xelatex` \| `pdflatex` \| `lualatex` |
| `--timeout` | `8m` | 每条路径的时间预算（如 `90s`、`3m`） |
| `--proxy` | 环境 HTTP_PROXY | 代理地址，如 `http://127.0.0.1:7890`（大陆环境建议显式给） |
| `--source` | 完整链 | 调试用，强制单条路径：`ytotech` \| `texlivenet` \| `local` |
| `--max-upload` | 41943040 | 云路径上传字节预算 |
| `--verbose` | 关 | stderr 输出每条路径的诊断 |
| `--version` | | 打印版本 |

退出码：`0` 成功；`1` 交付了失败页；`2` 用法/收集错误（未写输出）。

## 依赖收集

工具扫描主文档及所有 `.tex/.cls/.sty`，递归收集 `\input/\include/\subfile/\import/\includegraphics/\lstinputlisting/\bibliography/\documentclass/\RequirePackage/\LoadClass` 引用的项目内文件。`.aux/.log` 等编译残留不收集。引用不存在的文件不报错（交给编译日志裁决）。

## 平台二进制

`bin/` 内含 6 个预编译二进制（Go 1.26，`-trimpath -ldflags "-s -w"`）：

```
cloudtex-windows-amd64.exe / cloudtex-windows-arm64.exe
cloudtex-linux-amd64       / cloudtex-linux-arm64
cloudtex-darwin-amd64      / cloudtex-darwin-arm64
```

agent 选择方式：`runtime.GOOS/GOARCH` 或 `uname -s -m`；Windows amd64 场景直接用 `.exe`。二进制无任何运行时依赖，复制到临时目录或原地执行皆可。

## 重新编译

```
cd tools/cloudtex
go build -trimpath -ldflags "-s -w" -o bin/<target> ./src
```

失败页 PDF 内嵌于 `src/failpdf/fail.pdf`（A4 单页，XeLaTeX 预渲染）。

## agent 集成约定（供 skill 引用）

- 调用前先根据当前平台挑二进制；`--verbose` 打开以便把失败链写进报告。
- 大陆网络环境传 `--proxy http://127.0.0.1:7890`（不通则 `7897`）。
- 判断成功与否以退出码 + `--output` 文件为准；退出码 1 时 stderr 已含各路径失败详情，如实转告用户「本次交付的是失败页」。
