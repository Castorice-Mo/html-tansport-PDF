---
name: html-to-pdf
description: 把 HTML 文件、整个文件夹或在线网页转成版面可靠的 PDF（纸张/横竖、页边距、页眉页脚页码、背景色、批量）。触发词：HTML 转 PDF、网页转 PDF、html2pdf、打印成 PDF、导出 PDF、网页存成 PDF、html2pdf、html 打印。
version: 0.1.0
license: MIT
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Shell
---

# HTML → PDF

用本机 **Microsoft Edge**（无 Edge 时回落 Chrome）的无头模式渲染，经 DevTools 协议出 PDF：
**零依赖**（不需要 npm/pip 安装任何包，不联网）、中文字体与背景色都按打印样式落盘。

## 何时用

- 手上有一份 HTML（报告、发票、简历、导出后的网页存档），要 PDF 交付或打印。
- 需要控纸张、横竖、边距、页眉页脚与「第 N / M 页」。
- 一次转一批 HTML 文件。
- 在线网页要留档成 PDF。

**不适用**：Office 文档（用 `office-export-pdf`）、扫描件 OCR、需要表单域的 PDF。

## 三步走

1. **问清三件事**：输入（文件 / 目录 / URL）、输出位置、纸张与页眉页脚要求。没说的不传 `--format`（跟随文档 `@page`，缺省 A4）、不加页眉页脚。
2. **跑脚本**（PowerShell；路径含空格要加引号）：

```powershell
$h2p = "$env:USERPROFILE\.agents\skills\html-to-pdf\scripts\html2pdf.mjs"

node $h2p --input .\report.html --output .\report.pdf `
          --format A4 --header "{title}" --footer "第 {page} / {total} 页"
```

3. **验收**：退出码 0，且输出行给出「N 页 · X KB」。脚本已自检 `%PDF-` 签名与非空体积；要视觉确认再渲染首屏（见「验收」）。

## 参数速查

| 目的 | 写法 |
|---|---|
| 纸张 | `--format A4`（A3/A4/A5/A6/B5/Letter/Legal/Tabloid）、自定义 `--format 210x297mm` |
| 横竖 | `--landscape` |
| 边距 | `--margin 16mm`（传 `--format` 时默认 10mm）、`--margin-top/-right/-bottom/-left` 单边覆盖 |
| 页眉页脚 | `--header "{title}"`、`--footer "第 {page} / {total} 页"`；可用 `{page} {total} {title} {url} {date}` |
| 缩放内容 | `--scale 0.9`（0.1–2） |
| 背景色 | 默认就打印；不要背景加 `--no-background` |
| 等 JS 渲染 | `--selector ".chart"` 等元素出现、`--wait 1500` 再等 1.5 秒 |
| 补 CSS | `--css "h1{color:#a33}"` 或 `--css-file fix.css` |
| PDF 标题 | `--title "季度报告"`（写进 PDF 元数据） |
| 批量 | `--input .\pages --output .\pdf`（目录内所有 .html/.htm，不递归） |
| 在线网页 | `--input https://example.com --output site.pdf` |
| 只要路径 | `--quiet`（脚本化时用） |

完整清单：`node $h2p --help`。

## 输入形态

- **单个文件**：`--input a.html` → 默认输出同目录 `a.pdf`；给 `--output` 则以其为准，不以 `.pdf` 结尾会自动补 `.pdf`。
- **目录**：`--input .\pages --output .\pdf`，逐个转，失败的不影响其余，最后给「成功 / 失败」汇总，有失败时退出码 1。
- **URL**：`--input https://…`，渲染的是实时页面（含 JS 后的 DOM）。
- 相对路径的图片、字体、CSS 以 HTML 所在目录为基准解析（脚本已开 `--allow-file-access-from-files`）。

## 打印友好的 HTML（需要微调版面时）

只改需要的几条，别重排原文件；改完另存副本或直接用 `--css` 注入。

```css
@page { size: A4; margin: 18mm 16mm; }        /* 传 --format 时以参数为准 */
.chapter { break-before: page; }              /* 强制分页 */
.card, tr { break-inside: avoid; }            /* 尽量不腰斩 */
table { width: 100%; table-layout: fixed; }   /* 长表格：<thead> 会逐页重复 */
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media print { .no-print, nav, aside { display: none !important; } }
```

要点：

- **尺寸优先级**：不传 `--format`/`--landscape` 时完全跟随文档 `@page`（尺寸与边距）。传了则由脚本注入同值 `@page` 覆盖文档，纸张、方向、边距都听命令行的；想让 CSS 反过来压过参数，加 `--prefer-css-page-size`。
- **中文字体**：优先开源字体（`"Noto Sans SC"`、`"Source Han Sans SC"`）——PDF 要随文分发时，不会牵进商业字体的授权问题；临时自用可换本机字体（如 `"SimSun"`）。别指望临时去取 Google Fonts，用网络字体务必配 `--wait`。
- **图片**：优先相对路径或 `file://` 绝对路径；跨域图片要服务端允许，否则会是空框。
- **页眉页脚遮正文**：上下边距 <15mm 时脚本自动抬到 15mm；要更紧就显式给 `--margin-top 18mm`。
- **宽表**：`--landscape` 或 `--scale 0.75`；别用负边距硬塞。

## 验收

```powershell
# 页数 / 纸张 / 尺寸（PyMuPDF 本机已装）
python -c "import pymupdf; d=pymupdf.open('report.pdf'); print(d.page_count, d[0].rect)"
# 首屏看图（可选）
python -c "import pymupdf; d=pymupdf.open('report.pdf'); d[0].get_pixmap(dpi=110).save('p1.png')"
```

结论以事实为准：页数、体积、首屏图，三者对齐后再交付。用 `present` 把 PDF 交给阁下，源文件保持不动。

## 失败时

按现象查 `references/troubleshooting.md`（空白页、字体、图片、超时、页眉遮挡、宽表、体积）。
排查需保留现场时加 `--keep-open`，脚本会打印临时 profile 路径。

原则：**报错带命令与退出码原样呈现，不静默换引擎、不静默降级**；`--browser` 可指定别的 Chromium 内核。
