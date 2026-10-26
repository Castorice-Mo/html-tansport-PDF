# HTML → PDF 故障排查

脚本退出码：`0` 成功、`1` 转换失败、`2` 参数错误。下面按现象排。

## 1. 输出全白 / 只有页眉页脚

| 原因 | 处理 |
|---|---|
| SPA 还没渲染完就打印 | 等元素：`--selector "#app .content"`；或 `--wait 2000` |
| 内容在 iframe 里 | 打印的是主 frame；改用 `--selector` 确认 iframe 已加载，或在 HTML 里把内容提升到主文档 |
| 内容靠 `IntersectionObserver` 懒加载 | 注入 `--css "*{content-visibility:visible!important}"`，或先滚动到底（本脚本不滚动，需改 HTML） |
| `display:none` 的打印样式 | `@media print` 里隐藏了正文；用 `--css "@media print{.hide{display:block!important}}"` 覆盖 |

## 2. 中文变方块 / 变成宋体

- 字体名写本机真实名称（`"Noto Sans SC"`、`"Source Han Sans SC"`、`"SimSun"`）；中文名如 `"微软雅黑"` 不稳定。
- **可变字体（VF）会被拆成一堆 Type3**：Chromium 无法把 VF 嵌成 CID 字体，字形退化为逐字 Type3，体积翻倍、部分打印店不认。改用同族静态字重实例（如 fontTools 从 VF 生成 wght=400/700 静态文件）即可回到 Type0。
- Web 字体（`@font-face` 远程）可能来不及加载：加 `--wait 1500`，或改成本地字体。
- 极端情况 PDF 内嵌字体但系统缺失 → 打印到 PNG 复核（见 SKILL.md「验收」）。

## 3. 图片缺失 / 空框

- 相对路径按 **HTML 所在目录** 解析；从别处运行时不要改 cwd 的假设，直接给绝对路径最稳。
- `file://` 页面签名限制：脚本已加 `--allow-file-access-from-files`；仍失败就换 `--input http://localhost:…`。
- 跨域 `http(s)` 图片：渲染端不做 CORS 拦截，但图床防盗链会返回 403，需本地化。
- SVG 内联 `<use href="...">` 引外部文件：受同上限制。

## 4. 表格 / 卡片被拦腰切断

- 小元素：`break-inside: avoid`。
- 大表格：`break-inside` 对跨页大表无效，靠 `<thead>` 自动重复表头 + `table-layout: fixed`。
- 仍难看：`--scale 0.85` 让内容整体缩小，减少页数。

## 5. 页眉页脚压住正文

- 上下边距 <15mm 且启用了页眉/页脚时，脚本自动抬到 15mm。
- Chromium 页眉页脚画在**页边距区域内**，正文可用高度 = 纸高 − 上下边距；要正文更多就别开页眉页脚。

## 6. 干等超时

- `--timeout 120000` 放宽导航超时；`--wait` 只影响加载后的额外等待。
- 长时间未 `load` 的页面（挂着的统计脚本）：改用 `--selector` 判断目标元素，配合 `--timeout 30000`。

## 7. 尺寸不对 / 内容被缩得很难看

- 给了 `--format` → 内容按纸缩放，CSS `@page` 尺寸被忽略。
- 想以 `@page` 为准：去掉 `--format`，或加 `--prefer-css-page-size`。
- 自定义纸：`--format 210x297mm`、`--format 8.5x11in`。

## 8. 浏览器起不来 / 连接超时

- 安全软件拦截无头进程，或 Edge 正在自动更新：换 `--browser "C:\Program Files\Google\Chrome\Application\chrome.exe"`。
- 端口占用：脚本用 `--remote-debugging-port=0` 自动选口，一般不会冲突；仍失败看临时 profile 是否有 `DevToolsActivePort`。
- 报 `no browser found`：显式 `--browser <exe>` 或设环境变量 `HTML2PDF_BROWSER`。

## 9. PDF 体积过大

- 图片是主因：源 HTML 里换成压缩图，或 `--no-background`。
- Chromium 的 `printToPDF` 不暴露图片质量参数；要更低体积只能先处理图片，或转完用 PyMuPDF 重压缩（会重编码）。

## 10. 输出不是 PDF / 签名错

- 输出目录不可写、磁盘满、路径含非法字符。脚本会先 `mkdir -p` 再写；失败时看 `err.message`。
- 只有 `%PDF-` 但 0 页：极端空 DOM，检查 `--selector` 是否指向了隐藏节点。
