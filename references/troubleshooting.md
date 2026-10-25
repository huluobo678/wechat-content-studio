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
$env:WECHAT_APP_ID = "<appid>"
$env:WECHAT_APP_SECRET = "<secret>"
```
密钥只从当前命令进程的环境变量读取。不要写入 Skill、Markdown、聊天记录或 Agent 可读取的 `TOOLS.md`。

### 缺 frontmatter（最常见）
报错 `未能找到文章封面`。
解：文件顶部必须有 frontmatter，`title` 必填；正文没有可用图片时才需提供 `cover`：
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
确认 AppID/Secret 与公众号接口权限无误后再重试。视频脚本按需获取 token，不将 token 写入本地缓存；不要把凭证或完整请求 URL 发给他人排查。

## 检索类

| 现象 | 原因 | 处理 |
|------|------|------|
| 空结果 | 搜索无匹配或服务限制访问 | 检查关键词和官方可用入口；若服务拒绝/限制访问，停止自动请求，不通过更换网络、伪装身份或重试绕过限制 |
| url_resolved: false | 搜狗未完成正常跳转或访问受限 | 使用平台正常可访问的微信原文链接；若平台拒绝/要求验证，停止请求，不通过其他方式绕过 |
| 命中 antispider 页 | 服务限制访问或要求验证 | 停止自动抓取；使用平台提供的正常访问方式，遵守其条款，不自动处理验证码或规避限制 |

## 存档类

| 现象 | 原因 | 处理 |
|------|------|------|
| 未找到 Chrome/Edge | 未装或路径特殊 | 安装浏览器，或改 `BrowserLocator.candidates()` |
| puppeteer 启动失败 | 依赖未装或安装不完整 | `cd scripts/downloader && npm ci` |
| 环境异常拦截 | 平台拒绝访问或需要验证/登录 | 停止请求；不换网络绕过、不模拟登录、不尝试规避平台限制 |
| 找不到 #js_content | 文章删除、页面结构变化或需登录 | 核对链接和正常访问权限；若仍不可访问则停止，不尝试绕过限制 |

## 调试

```powershell
$env:DEBUG = "wenyan:*"
wenyan publish -f article.md -t lapis -h solarized-light
```
或先渲染不发布：`wenyan render -f article.md`，确认无误再 publish。发布脚本不会自动安装全局依赖；首次安装前先核对依赖来源和版本。

参考：wenyan-cli (github.com/caol64/wenyan-cli) · 微信开发文档 (developers.weixin.qq.com/doc/offiaccount)
