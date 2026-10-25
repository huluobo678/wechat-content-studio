---
name: wechat-content-studio
description: >-
  公众号内容生产链路工具：搜狗微信文章检索、文章本地存档（正文/配图/视频）、
  AI 辅助润色改写（去 AI 腔、降重复、原创化）、wenyan 草稿箱发布。
  适用于搜索公众号文章、下载微信文章、改写降重去AI味、或发布文章到公众号等场景。
description_zh: "公众号文章搜索、存档、润色、发布一站式工具"
description_en: "WeChat OA article search, archiving, rewriting, and publishing toolkit."
version: 1.1.0
agent_created: true
allowed-tools: Read,Write,Edit,Bash,Run
---

# 公众号内容工坊（wechat-content-studio）

> 一条链路覆盖公众号创作：**找文章 → 存本地 → 改写成自己的 → 发草稿箱**。

## 模块总览

| 模块 | 能力 | 触发示例 |
|------|------|----------|
| 🔍 检索 | 按关键词在搜狗微信找文章 | "搜一下XX相关的公众号文章" |
| 💾 存档 | 把文章落盘：正文 + 图 + 视频 | "把这篇公众号文章存下来" |
| ✏️ 改写 | AI 辅助去 AI 腔与降重 | "帮我洗稿 / 改成原创 / 去 AI 味" |
| 📤 发布 | Markdown 一键进公众号草稿箱 | "发到公众号草稿箱" |

---

## 🔍 模块一：文章检索

数据源为搜狗微信搜索。脚本零第三方依赖，直接 `node` 运行即可。

```bash
# 首次无需安装任何依赖（零依赖实现）
node {baseDir}/scripts/search/search.js "关键词" [-n N] [-o 文件] [-r] [-c]
```

| 参数 | 作用 |
|------|------|
| `-n, --num <N>` | 结果条数，默认 10，上限 50 |
| `-o, --output <F>` | 结果写入 JSON 文件 |
| `-r, --resolve-url` | 尝试把搜狗跳转链接解析为微信真实地址 |
| `-c, --fetch-content` | 抓取正文纯文本（自动启用 `-r`） |

输出字段：`title` 标题、`url` 链接、`summary` 摘要、`datetime` 发布时间、`source` 来源公众号；`-c` 时附加 `content` 与 `word_count`。

注意：
- 搜狗反爬较严，`-r` 解析失败是常态，失败时保留搜狗链接并标 `url_resolved: false`
- 脚本内置随机 UA + 请求间隙，但不要高频反复使用
- 正文是纯文本提取，需要完整排版请走模块二

---

## 💾 模块二：文章存档

用无头浏览器渲染微信文章页，绕开限制并触发懒加载，然后保存正文与媒体。需要本地装有 Chrome 或 Edge（自动探测，三平台通用）。

```bash
# 首次：装依赖 + 设默认目录
cd {baseDir}/scripts/downloader && npm install
node {baseDir}/scripts/downloader/download.js --set-output "D:\wechat-articles"

# 存档一篇文章
node {baseDir}/scripts/downloader/download.js "https://mp.weixin.qq.com/s/xxx"

# 跳过图片或视频
node {baseDir}/scripts/downloader/download.js "<url>" --no-image
node {baseDir}/scripts/downloader/download.js "<url>" --no-video
```

落盘结构：

```
<输出目录>/<文章标题>/
├── article.md       # Markdown 正文（含元信息头）
├── article.html     # 完整 HTML
├── metadata.json    # 标题/作者/时间/捕获到的媒体 URL
├── images/          # 配图
└── videos/          # 视频与音频
```

边界说明：
- 微信检测到"环境异常"时会中止，属反爬拦截，稍后或换网络重试
- `m3u8` 流只保存索引，不做切片合并；完整视频需另行用 ffmpeg 处理
- 脚本用全新无头会话，不读取你的登录态，受限文章可能取不到

---

## ✏️ 模块三：AI 辅助改写

由 Agent 直接执行（无脚本）。目标：把文章改成**读起来像人写的、结构不同的、信息完整的**版本。

### 触发方式

"帮我洗稿" / "改成原创" / "降查重" / "去 AI 味" / "重写得更自然"

### 执行流程

1. 取原文 —— 模块一 `-c` 或模块二存档
2. 拆结构 —— 明确文章类型、核心论点、段落层次、可复用的事实骨架
3. 按策略改写 —— 见下
4. 补 frontmatter —— `title` + `cover`
5. 交付 —— 全文 + 3-5 个备选标题 + 改动说明

### 改写策略

**结构层（降重主力）：**
- 段落换序、长段拆短、碎片合并
- 换叙事线：时间线 / 问题导向 / 对比 / 故事 互相转换
- 论据换展开方式：留骨架，换血肉

**语言层（去 AI 腔）：**
- 空洞大词换具体事实：里程碑 / 赋能 / 深远影响 → 直接说发生了什么
- 无出处权威删除：专家认为 / 业内普遍认为
- 高频 AI 词清剿：闭环、抓手、生态、底层逻辑、范式、沉淀、势能
- 填充短语删除：事实上、值得注意的是、总体来说
- 空结尾改实：未来可期 → 具体结论或行动项

**标题与开头：**
- 标题给 3-5 个备选：疑问 / 数字 / 悬念 / 痛点 四型
- 开头换风格：故事 / 数据 / 痛点 / 反问 四式

### 21 项 AI 痕迹检查表

| # | 检查项 | 处理 |
|---|--------|------|
| 1 | 意义膨胀句 | 换具体事实 |
| 2 | 无出处权威引用 | 补来源或删 |
| 3 | 伪深动词 | 换具体动作 |
| 4 | 广告腔 | 客观描述 |
| 5 | 挑战→机遇→展望模板段 | 删模板留结论 |
| 6 | AI 高频词扎堆 | 换日常用词 |
| 7 | "不仅…而且…"滥用 | 直接表达 |
| 8 | 三段式硬拆 | 留重点删填充 |
| 9 | 同义词机械轮换 | 固定用词 |
| 10 | 破折号滥用 | 换句号/逗号 |
| 11 | 加粗滥用 | 去多余强调 |
| 12 | "**X：**"列表模板 | 并成自然段 |
| 13 | 概念堆砌标题 | 口语化 |
| 14 | Emoji 泛滥 | 默认删除 |
| 15 | 聊天语残留 | 删除 |
| 16 | 知识截止声明 | 删除 |
| 17 | 过度讨好 | 客观回应 |
| 18 | 填充短语 | 删除 |
| 19 | "可能会/或许"过模糊 | 改条件判断 |
| 20 | 空洞结尾 | 改实际结论 |
| 21 | "从…到…"假区间 | 列具体事实 |

### 交付判据

- ✅ 朗读通顺，无 AI 腔
- ✅ 无空洞句与模板段
- ✅ 信息密度高、句句有内容
- ✅ 结构与原文显著不同
- ✅ 核心信息完整保留

---

## 📤 模块四：草稿箱发布

基于 wenyan-cli：Markdown → 公众号排版 → 草稿箱。

```bash
# 首次
npm install -g @wenyan-md/cli

# 凭证（环境变量或 ~/.workbuddy/TOOLS.md）
setx WECHAT_APP_ID <appid>
setx WECHAT_APP_SECRET <secret>
```

> 注意：发布机公网 IP 需在公众号后台「开发 → 基本配置 → IP 白名单」中。

```bash
# 常规发布（Windows PowerShell）
powershell -File {baseDir}/scripts/publisher/publish.ps1 -File "D:\article.md"

# 直接 wenyan
wenyan publish -f article.md -t lapis -h solarized-light

# 含视频文章
python {baseDir}/scripts/publisher/publish_with_video.py article.md
```

**Markdown 要求：**

```markdown
---
title: 标题（必填）
cover: D:\绝对\路径\封面.jpg（必填，绝对路径）
---

# 正文
```

- `title` 与 `cover` 缺一不可；图片引用一律绝对路径
- 主题：`default` / `lapis`（推荐）/ `phycat`；高亮：`solarized-light`（推荐）等
- 视频：`![视频描述](media/video.mp4)` 会被自动上传并以 iframe 嵌入

---

## 串联示例

```
检索 → 存档 → 改写 → 发布
node search.js "topic" -n 5 -c
node download.js "https://mp.weixin.qq.com/s/..."
（Agent 按模块三改写）
powershell -File publish.ps1 -File article.md
```

## 使用边界

- 仅供个人学习与自创内容优化
- 反爬有随机 UA 与请求间隙机制，请勿高频使用
- 更多排查见 references/troubleshooting.md