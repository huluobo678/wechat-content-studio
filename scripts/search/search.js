#!/usr/bin/env node

/**
 * 微信公众号文章检索工具（独立实现，零第三方依赖）
 * 数据源：搜狗微信搜索。本文件为全新编写，与任何既有开源实现无代码级关联。
 *
 * 用法:
 *   node search.js "关键词" [-n 数量] [-o 输出文件] [-r] [-c]
 */

'use strict';

// 温和节流：仅作为请求间隔，避免高频连续请求；不涉及身份伪装或限制规避。
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 单次标准请求；若服务限制访问或发生网络错误，不自动伪装身份或重试。
async function getText(url, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const start = new URL(url);
    let current = start;
    let resp;
    for (let hop = 0; hop <= 3; hop++) {
      resp = await fetch(current, { signal: ctrl.signal, redirect: 'manual' });
      const location = resp.headers.get('location');
      if (resp.status < 300 || resp.status >= 400 || !location) break;
      const next = new URL(location, current);
      if (next.protocol !== 'https:' || next.hostname !== start.hostname ||
          next.username || next.password || next.port || hop === 3) break;
      await resp.body?.cancel();
      current = next;
    }
    return { ok: resp.ok, status: resp.status, headers: resp.headers, url: current.href, text: await resp.text() };
  } finally {
    clearTimeout(timer);
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

  const rawUrl = deEntify(titleMatch[1] || '');
  let articleUrl;
  try {
    articleUrl = new URL(rawUrl, 'https://weixin.sogou.com');
  } catch {
    return null;
  }
  if (articleUrl.protocol !== 'https:' || articleUrl.hostname !== 'weixin.sogou.com' ||
      articleUrl.username || articleUrl.password || articleUrl.port) return null;
  const title = deEntify(titleMatch[2].replace(/<[^>]+>/g, ''));

  // 解析相对时间文本（"5小时前" / "3天前" / "刚刚"）
  const timeRaw = (blockHtml.match(/<span class="s2"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '';
  const timeText = deEntify(timeRaw.replace(/<script[\s\S]*?<\/script>/gi, ''));
  const { iso, display, relative } = resolveTime(timeText, stampMatch && stampMatch[1]);

  return {
    title,
    url: articleUrl.href,
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
async function unwrapLink(sogouUrl) {
  let parsed;
  try { parsed = new URL(sogouUrl); } catch { return { url: sogouUrl, ok: false }; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'weixin.sogou.com' ||
      parsed.username || parsed.password || parsed.port) return { url: sogouUrl, ok: false };
  try {
    // 只检查 HTTP Location，并仅接受微信文章域名；不自动跟随外部跳转。
    const resp = await getText(sogouUrl, { timeoutMs: 8000 });
    const location = resp.headers.get('location');
    if (location) {
      const destination = new URL(location, sogouUrl);
      if (destination.protocol === 'https:' && destination.hostname === 'mp.weixin.qq.com' &&
          !destination.username && !destination.password && !destination.port && /^\/s\//.test(destination.pathname)) {
        return { url: destination.href, ok: true };
      }
    }

    return { url: sogouUrl, ok: false };
  } catch {
    return { url: sogouUrl, ok: false };
  }
}

// ── 抓取微信正文纯文本 ──
async function fetchBodyText(articleUrl) {
  let parsed;
  try { parsed = new URL(articleUrl); } catch { return { text: '', ok: false, reason: '无效文章链接' }; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'mp.weixin.qq.com' ||
      parsed.username || parsed.password || parsed.port) {
    return { text: '', ok: false, reason: '非微信文章链接' };
  }
  try {
    const { ok, status, text } = await getText(articleUrl, { timeoutMs: 30000 });
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
      const { ok, status, text } = await getText(searchUrl, { timeoutMs: 30000 });
      if (!ok) {
        console.error(`第 ${page} 页请求被拒绝（HTTP ${status}），停止检索，不自动重试。`);
        break;
      }
      const items = sliceItemBlocks(text)
        .map(parseOneItem)
        .filter(Boolean)
        .slice(0, capped - collected.length);
      collected.push(...items);
    } catch (e) {
      console.error(`第 ${page} 页抓取失败: ${e.message}`);
      break;
    }
    // 页间温和节流，避免高频连续请求
    if (page < pages) await delay(700 + Math.random() * 500);
  }

  const results = collected.slice(0, capped);
  const needUnwrap = resolveUrl || fetchBody;

  if (needUnwrap) {
    console.error('正在解析真实链接...');
    for (let i = 0; i < results.length; i++) {
      const { url, ok } = await unwrapLink(results[i].url);
      results[i].url = ok ? url : results[i].url;
      results[i].url_resolved = ok;
      // 链接解析间温和节流
      if (i < results.length - 1) await delay(500 + Math.random() * 500);
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
      // 正文抓取间温和节流
      if (i < results.length - 1) await delay(700 + Math.random() * 600);
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
