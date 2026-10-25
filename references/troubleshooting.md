# 常见问题排查

## 发布类

### IP 不在白名单
报错 `ip not in whitelist`。
解：`curl ifconfig.me` 拿公网 IP → 公众号后台「开发 → 基本配置 → IP 白名单」加 IP → 重试。

### wenyan 未安装
`wenyan: command not found`。
解：`npm install -g @wenyan-md/cli`，验证 `wenyan --help`。

### 缺凭证
报错 `WECHAT_APP_ID is required`。
解：
```powershell
setx WECHAT_APP_ID <appid>
setx WECHAT_APP_SECRET <secret>
```
或写入 `~/.workbuddy/TOOLS.md`：
```markdown
export WECHAT_APP_ID=<appid>
export WECHAT_APP_SECRET=<secret>
```

### 缺 frontmatter（最常见）
报错 `未能找到文章封面`。
解：文件顶部必须有 frontmatter，`title` 必填；`cover` 可省（正文首图自动作封面）：
```markdown
---
title: 标题
cover: D:\绝对\路径\封面.jpg
---

# 正文
```
注意：frontmatter 必须在文件最顶部；正文图片用绝对路径。

### 图片上传失败
- 路径错误 → 检查存在性：`Get-Item 路径`
- 格式不支持 → 微信只收 jpg/png/gif
- 超过 10MB → 压缩后再传
- 网络图不可访问 → `curl -I URL` 验证

### 40001 token 失效
用 `python scripts/publisher/publish_with_video.py`（自带 token 刷新与缓存）。

## 检索类

| 现象 | 原因 | 处理 |
|------|------|------|
| 空结果 | 搜狗反爬 / IP 受限 | 放缓频率、稍后重试 |
| url_resolved: false | 搜狗真实链接解析失败 | 正常现象，改用存档模块 |
| 命中 antispider 页 | 触发验证码 | 停用一段时间 |

## 存档类

| 现象 | 原因 | 处理 |
|------|------|------|
| 未找到 Chrome/Edge | 未装或路径特殊 | 安装浏览器，或改 `BrowserLocator.candidates()` |
| puppeteer 启动失败 | 依赖未装 | `cd scripts/downloader && npm install` |
| 环境异常拦截 | 反爬 / 需登录 | 稍后或换网络 |
| 找不到 #js_content | 文章删除或需登录 | 核对链接 |

## 调试

```powershell
$env:DEBUG = "wenyan:*"
wenyan publish -f article.md -t lapis -h solarized-light
```
或先渲染不发布：`wenyan render -f article.md`，确认无误再 publish。

参考：wenyan-cli (github.com/caol64/wenyan-cli) · 微信开发文档 (developers.weixin.qq.com/doc/offiaccount)