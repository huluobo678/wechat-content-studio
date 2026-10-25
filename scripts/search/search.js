#!/usr/bin/env node

/**
 * 微信公众号文章检索工具（独立实现，零第三方依赖）
 * 数据源：搜狗微信搜索。本文件为全新编写，与任何既有开源实现无代码级关联。
 *
 * 用法:
 *   node search.js "关键词" [-n 数量] [-o 输出文件] [-r] [-c]
 */

'use strict';

// ── 浏览器标识池：不同设备形态交替使用，降低被限风险 ──
const BROWSER_SIGNATURES = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/124.0.0.0 Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];

const pickSignature = () =>
  BROWSER_SIGNATURES[Math.floor(Math.random() * BROWSER_SIGNATURES.length)];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 带超时与重试的抓取封装（fetch 自动处理内容编码）──
async function getText(url, { timeoutMs = 20000, attempts = 1, extraHeaders = {} } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': pickSignature(),
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...extraHeaders,
        },
        signal: ctrl.signal,
      });
      return { ok: resp.ok, status: resp.status, headers: resp.headers, text: await resp.text() };
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await wait(500 + i * 400);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

// ── 从响应头中收集 Cookie ──
function collectCookies(headers) {
  try {
    return headers.getSetCookie().map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  } catch {
    return '';
  }
}

// ── 预取搜狗会话 Cookie（用于真实链接解析）──
async function acquireSessionCookie() {
  try {
    const { headers } = await getText('https://v.sogou.com/v?ie=utf8&query=&p=40030600', {
      timeoutMs: 10000,
      attempts: 2,
    });
    return collectCookies(headers);
  } catch {
    return '';
  }
}

// ── HTML 片段解析：标题 / 链接 / 摘要 / 来源 / 时间 ──
function deEntify(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseOneItem(blockHtml) {
  const titleMatch = blockHtml.match(/<h3>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
  const summaryMatch = blockHtml.match(/<p class="txt-info"[^>]*>([\s\S]*?)<\/p>/i);
  const accountMatch = blockHtml.match(/<a[^>]*class="account"[^>]*>([\s\S]*?)<\/a>/i) ||
    blockHtml.match(/<span[^>]*class="all-time-y2"[^>]*>([\s\S]*?)<\/span>/i);
  const stampMatch = blockHtml.match(/timeconvert\('?(\d{10})'?\)/i) ||
    blockHtml.match(/>(\d{10})</);

  if (!titleMatch) return null;

  const rawUrl = titleMatch[1] || '';
  const title = deEntify(titleMatch[2].replace(/<[^>]+>/g, ''));

  // 解析相对时间文本（"5小时前" / "3天前" / "刚刚"）
  const timeRaw = (blockHtml.match(/<span class="s2"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '';
  const timeText = deEntify(timeRaw.replace(/<script[\s\S]*?<\/script>/gi, ''));
  const { iso, display, relative } = resolveTime(timeText, stampMatch && stampMatch[1]);

  return {
    title,
    url: rawUrl.startsWith('/') ? 'https://weixin.sogou.com' + rawUrl : rawUrl,
    summary: deEntify((summaryMatch && summaryMatch[1] || '').replace(/<[^>]+>/g, '')),
    source: deEntify((accountMatch && accountMatch[1] || '').replace(/<[^>]+>/g, '')),
    datetime: iso,
    date_text: display,
    date_description: relative || display,
  };
}

// ── 时间归一化：时间戳或相对文本 → ISO + 中文日期 ──
function resolveTime(timeText, stamp) {
  const now = new Date();
  let target = null;

  if (stamp) {
    target = new Date(parseInt(stamp, 10) * 1000);
  } else if (timeText) {
    const day = timeText.match(/(\d+)\s*天前/);
    const hour = timeText.match(/(\d+)\s*小时前/);
    const min = timeText.match(/(\d+)\s*分钟前/);
    if (day) target = new Date(now.getTime() - parseInt(day[1], 10) * 864e5);
    else if (hour) target = new Date(now.getTime() - parseInt(hour[1], 10) * 36e5);
    else if (min) target = new Date(now.getTime() - parseInt(min[1], 10) * 6e4);
  }

  if (!target) return { iso: '', display: '', relative: timeText };

  const pad = (n) => String(n).padStart(2, '0');
  const local = new Date(target.getTime() + 8 * 36e5);
  const iso = [
    local.getUTCFullYear(), '-', pad(local.getUTCMonth() + 1), '-', pad(local.getUTCDate()),
    ' ', pad(local.getUTCHours()), ':', pad(local.getUTCMinutes()), ':', pad(local.getUTCSeconds()),
  ].join('');
  const display = `${target.getFullYear()}年${pad(target.getMonth() + 1)}月${pad(target.getDate())}日`;

  const diffH = Math.floor((now - target) / 36e5);
  const relative = diffH >= 48 ? `${Math.floor(diffH / 24)}天前`
    : diffH >= 1 ? `${diffH}小时前`
    : Math.floor((now - target) / 6e4) >= 1 ? `${Math.floor((now - target) / 6e4)}分钟前`
    : '刚刚';

  return { iso, display, relative };
}

// ── 从整页 HTML 中切出新闻条目块 ──
function sliceItemBlocks(html) {
  const listStart = html.indexOf('<ul class="news-list"');
  if (listStart === -1) return [];
  const listEnd = html.indexOf('</ul>', listStart);
  const region = listEnd === -1 ? html.slice(listStart) : html.slice(listStart, listEnd + 5);

  const blocks = [];
  const liPattern = /<li[\s\S]*?<\/li>/gi;
  let m;
  while ((m = liPattern.exec(region)) !== null) blocks.push(m[0]);
  return blocks;
}

// ── 搜狗跳转链接 → 微信真实地址 ──
async function unwrapLink(sogouUrl, cookie) {
  if (!sogouUrl.includes('weixin.sogou.com')) return { url: sogouUrl, ok: false };

  const cookieLine = cookie
    ? 'ABTEST=7|1716888919|v1; IPLOC=CN5101; ' + cookie
    : 'ABTEST=7|1716888919|v1; IPLOC=CN5101';

  // 手动跟随重定向，截获 Location 头
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(sogouUrl, {
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': pickSignature(), 'Cookie': cookieLine },
    });
    const loc = resp.headers.get('location') || '';
    if (loc.includes('mp.weixin.qq.com')) return { url: loc, ok: true };
    return { url: sogouUrl, ok: false };
  } catch {
    return { url: sogouUrl, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// ── 抓取微信正文纯文本 ──
async function fetchBodyText(articleUrl) {
  if (!articleUrl.includes('mp.weixin.qq.com')) {
    return { text: '', ok: false, reason: '非微信文章链接' };
  }
  try {
    const { ok, status, text } = await getText(articleUrl, { timeoutMs: 30000, attempts: 2 });
    if (!ok) return { text: '', ok: false, reason: `HTTP ${status}` };

    const marker = 'id="js_content"';
    const pos = text.indexOf(marker);
    if (pos === -1) return { text: '', ok: false, reason: '未找到正文容器' };

    // 粗略截取正文区（容器开始到其后约 200KB）
    const bodyRegion = text.slice(pos, pos + 200000);
    const plain = bodyRegion
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

    return { text: plain, ok: plain.length > 0, reason: plain.length > 0 ? '' : '正文为空' };
  } catch (e) {
    return { text: '', ok: false, reason: e.message };
  }
}

// ── 主搜索流程：分页收集 → 可选真实链接 → 可选正文 ──
async function runSearch(keyword, limit = 10, opts = {}) {
  const { resolveUrl = false, fetchBody = false } = opts;
  const capped = Math.min(limit, 50);
  const collected = [];

  const pages = Math.ceil(capped / 10);
  for (let page = 1; page <= pages && collected.length < capped; page++) {
    const q = encodeURIComponent(keyword);
    const searchUrl = `https://weixin.sogou.com/weixin?query=${q}&s_from=input&_sug_=n&type=2&page=${page}&ie=utf8`;
    try {
      const { text } = await getText(searchUrl, { timeoutMs: 30000, attempts: 2 });
      const items = sliceItemBlocks(text)
        .map(parseOneItem)
        .filter(Boolean)
        .slice(0, capped - collected.length);
      collected.push(...items);
    } catch (e) {
      console.error(`第 ${page} 页抓取失败: ${e.message}`);
      break;
    }
    if (page < pages) await wait(600 + Math.random() * 900);
  }

  const results = collected.slice(0, capped);
  const needUnwrap = resolveUrl || fetchBody;
  let cookie = '';

  if (needUnwrap) {
    console.error('正在解析真实链接...');
    cookie = await acquireSessionCookie();
    for (let i = 0; i < results.length; i++) {
      const { url, ok } = await unwrapLink(results[i].url, cookie);
      results[i].url = ok ? url : results[i].url;
      results[i].url_resolved = ok;
      await wait(500 + Math.random() * 800);
    }
  }

  if (fetchBody) {
    console.error('正在抓取正文...');
    let okCount = 0;
    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      const { text, ok, reason } = await fetchBodyText(item.url);
      if (ok) {
        okCount++;
        item.content = text;
        item.word_count = text.length;
      } else {
        console.error(`  [${i + 1}/${results.length}] 失败: ${reason}`);
        item.content = '';
        item.word_count = 0;
      }
      item.content_fetched = ok;
      if (i < results.length - 1) await wait(800 + Math.random() * 1200);
    }
    console.error(`正文抓取完成: 成功 ${okCount}/${results.length}`);
  }

  return results;
}

// ── CLI 入口 ──
function parseArgs(argv) {
  const cfg = { limit: 10, output: '', curl: false, body: false, keyword: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n' || a === '--num') cfg.limit = parseInt(argv[++i], 10) || 10;
    else if (a === '-o' || a === '--output') cfg.output = argv[++i] || '';
    else if (a === '-r' || a === '--resolve-url') cfg.curl = true;
    else if (a === '-c' || a === '--fetch-content') cfg.body = true;
    else if (!a.startsWith('-')) cfg.keyword = a;
  }
  return cfg;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));

  if (!cfg.keyword) {
    console.log(`
微信公众号文章检索工具（零依赖）

用法:
  node search.js <关键词> [选项]

选项:
  -n, --num <N>       结果数量（默认 10，最大 50）
  -o, --output <F>    保存 JSON 结果
  -r, --resolve-url   解析微信真实链接
  -c, --fetch-content 抓取正文（自动启用 -r）

示例:
  node search.js "人工智能" -n 5
  node search.js "人工智能" -n 3 -o result.json -c
`);
    process.exit(0);
  }

  try {
    console.error(`正在检索: "${cfg.keyword}" ...`);
    const articles = await runSearch(cfg.keyword, cfg.limit, {
      resolveUrl: cfg.curl,
      fetchBody: cfg.body,
    });
    const payload = JSON.stringify({ query: cfg.keyword, total: articles.length, articles }, null, 2);

    if (cfg.output) {
      const { writeFileSync } = require('node:fs');
      writeFileSync(cfg.output, payload, 'utf-8');
      console.error(`已保存: ${cfg.output}`);
    }
    console.log(payload);
  } catch (e) {
    console.error('检索失败:', e.message);
    process.exit(1);
  }
}

module.exports = { runSearch, fetchBodyText };

if (require.main === module) main();