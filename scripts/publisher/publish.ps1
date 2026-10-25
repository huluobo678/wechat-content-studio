# publish.ps1 — 将 Markdown 文章发布为微信公众号草稿（基于 wenyan-cli）
# 用法: powershell -File publish.ps1 -File <markdown文件> [-Theme <主题>] [-Highlight <高亮>]

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$File,
    [string]$Theme = "lapis",
    [string]$Highlight = "solarized-light"
)

$ErrorActionPreference = "Stop"

function Write-Step($Text, $Color) { Write-Host $Text -ForegroundColor $Color }

# 1. 检查 wenyan-cli；不在发布时自动安装全局软件
if (-not (Get-Command wenyan -ErrorAction SilentlyContinue)) {
    Write-Step "wenyan-cli 未安装。请先阅读并确认依赖后手动安装: npm install -g @wenyan-md/cli" Red
    exit 1
}

# 2. 从当前进程环境读取凭证；不从 Agent 可读取的说明文件加载密钥
$AppId = $env:WECHAT_APP_ID
$AppSecret = $env:WECHAT_APP_SECRET

if (-not $AppId -or -not $AppSecret) {
    Write-Step "缺少微信公众号凭证。请在当前 PowerShell 会话设置 WECHAT_APP_ID / WECHAT_APP_SECRET。不要把密钥写入 Skill、Markdown 或 Agent 可读取的说明文件。" Red
    exit 1
}

# 3. 校验文件存在
if (-not (Test-Path $File)) {
    Write-Step "文件不存在: $File" Red
    exit 1
}

# 4. 执行发布
Write-Step "发布文章..." Green
Write-Host "  文件: $File"
Write-Host "  主题: $Theme / 高亮: $Highlight"

$previousAppId = $env:WECHAT_APP_ID
$previousAppSecret = $env:WECHAT_APP_SECRET
try {
    $env:WECHAT_APP_ID = $AppId
    $env:WECHAT_APP_SECRET = $AppSecret
    wenyan publish -f $File -t $Theme -h $Highlight
    $publishExitCode = $LASTEXITCODE
} finally {
    $env:WECHAT_APP_ID = $previousAppId
    $env:WECHAT_APP_SECRET = $previousAppSecret
}

if ($publishExitCode -eq 0) {
    Write-Step "发布成功！草稿已进入公众号后台草稿箱" Green
    Write-Step "https://mp.weixin.qq.com/" Yellow
} else {
    Write-Step "发布失败。常见原因:" Red
    Write-Step "  1. IP 未加入公众号后台白名单" Yellow
    Write-Step "  2. Markdown 缺 title，或没有可用正文图片且未提供 cover" Yellow
    Write-Step "  3. 凭证错误或已过期" Yellow
    exit 1
}
