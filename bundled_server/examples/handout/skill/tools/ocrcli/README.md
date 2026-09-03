# ocrcli — OCR / PDF-to-Markdown CLI

把本地 PDF / 图片转成 Markdown 文本，走 tx 的 glm-OCR 代理（智谱 layout_parsing）。零运行时依赖，与 cloudtex 同套交叉编译。

## 用法

```bash
ocrcli [flags] <input.pdf|input.png|input.jpg>
# 输出 Markdown 到 stdout
ocrcli 讲义.pdf

# 写文件 + 只看 1-3 页 + 完整 JSON
ocrcli --out out.md --pages 1-3 讲义.pdf
ocrcli --json 讲义.pdf
```

| Flag | 默认 | 说明 |
|---|---|---|
| `--endpoint` | `https://6767.chat/api/glm-ocr` | glm-ocr 代理 URL |
| `--out` | stdout | 写 Markdown 到文件 |
| `--json` | 关 | 打印上游完整 JSON（含 md_results/layout） |
| `--pages` | 全部 | 页范围，如 `1-3` 或 `2`（PDF only） |
| `--start-page` / `--end-page` | 0 | 1-based 起止页 |
| `--timeout` | 180 | 上游超时秒数 |
| `--proxy` | 空 | HTTP(S) 代理（glm-ocr 大陆直连，通常留空） |
| `--verbose` | 关 | stderr 打印诊断 |

## 限制（继承 glm-ocr）

- 图片 JPG/PNG ≤10MB，PDF ≤50MB、最多 100 页
- 公网限速：每真实 IP 30 秒 1 次（429）；服务器内部/回环不限
- 识别失败或限速时退出码非 0，stderr 有原因

## 平台二进制

`bin/` 内含 6 个预编译二进制（Go，`-trimpath -ldflags "-s -w"`）：

```
ocrcli-windows-amd64.exe / -arm64.exe
ocrcli-linux-amd64       / -arm64
ocrcli-darwin-amd64      / -arm64
```

选择方式同 cloudtex：`runtime.GOOS/GOARCH` 或 `uname -s -m`。

## 重新编译

```bash
cd tools/ocrcli
go build -trimpath -ldflags "-s -w" -o bin/<target> ./src
```

源码在 `src/main.go`（单文件，零依赖，仅 Go 标准库）。

## agent 集成约定（供 skill 引用）

- PDF/图片资料先用 ocrcli 提取文本再阅读，代替 ReadOS 的 `pdf extract`。
- `--json` 用于调试/结构分析；常规取文本用默认 Markdown 输出。
- 大陆网络不用代理；海外/异常时 `--proxy http://127.0.0.1:7890`。
