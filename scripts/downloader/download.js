#!/usr/bin/env node

/**
 * 微信公众号文章本地存档工具（独立实现）
 * 通过无头浏览器渲染文章页，导出正文与媒体资源。
 * 依赖 puppeteer-core（MIT 库），代码为全新编写。
 *
 * 用法:
 *   node download.js "<文章URL>" [--output <目录>] [--no-image] [--no-video]
 *   node download.js --set-output <目录>
 *   node download.js --show-config
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(HERE, 'settings.json');

// ── 本地配置管理器 ──
class SettingsStore {
  constructor(file) {
    this.file = file;
  }

  load() {
    try {
      const config = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (typeof config.defaultOutput === 'string' && config.defaultOutput.trim()) return config;
    } catch {
      // Fall through to a safe default for missing or malformed settings.
    }
    return { defaultOutput: path.join(os.homedir(), 'Downloads', 'wechat-articles') };
  }

  save(patch) {
    const merged = { ...this.load(), ...patch };
    fs.writeFileSync(this.file, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
  }
}

// ── 无头浏览器可执行文件发现 ──
class BrowserLocator {
  static candidates() {
    const list = [];
    if (process.platform === 'win32') {
      const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
        .filter(Boolean);
      for (const root of roots) {
        list.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
        list.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      }
    } else {
      list.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge'
      );
    }
    return list;
  }

  static find() {
    return BrowserLocator.candidates().find((p) => fs.existsSync(p)) || null;
  }
}

// ── 工具函数 ──
const safeSegment = (name) =>
  (name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'untitled-article')
    .replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i, '_$1');

const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

function allowedArticleUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  return (u.hostname === 'mp.weixin.qq.com' && /^\/s\//.test(u.pathname)) ||
    (u.hostname === 'weixin.sogou.com' && u.pathname === '/link' && u.searchParams.has('url'));
}

function extOf(url) {
  try {
    const u = new URL(url);
    const fromQuery = (u.searchParams.get('wx_fmt') || '').toLowerCase();
    const fromPath = path.extname(u.pathname).toLowerCase();
    const ext = fromQuery ? `.${fromQuery}` : fromPath;
    return new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.mp4', '.m3u8', '.flv', '.mp3', '.m4a']).has(ext)
      ? ext : '.jpg';
  } catch {
    return '.jpg';
  }
}

async function pullBinary(url, dest) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const mediaHosts = ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'wx.qlogo.cn', 'mpvideo.qpic.cn', 'res.wx.qq.com'];
  if (parsed.protocol !== 'https:' || !mediaHosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
    console.error(`  ✗ 跳过非微信媒体域名: ${parsed.hostname}`);
    return false;
  }
  try {
    const resp = await fetch(url, { redirect: 'error' });
    if (resp.status >= 400 && resp.status < 500) {
      await resp.body?.cancel();
      console.error(`  ✗ 媒体主机 ${parsed.hostname} 拒绝请求（HTTP ${resp.status}），停止，不自动重试。`);
      return false;
    }
    if (!resp.ok) {
      await resp.body?.cancel();
      throw new Error(`HTTP ${resp.status}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const partial = `${dest}.part`;
    await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(partial, { flags: 'wx' }));
    fs.renameSync(partial, dest);
    return true;
  } catch (e) {
    try { fs.rmSync(`${dest}.part`, { force: true }); } catch { /* best effort cleanup */ }
    console.error(`  ✗ 媒体下载失败（${parsed.hostname}，${e.name || 'Error'}）。`);
    return false;
  }
}

function htmlToMarkdown(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, c) => '#'.repeat(+n) + ' ' + c + '\n\n')
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<img[^>]*?(?:data-src|src)="([^"]*)"[^>]*>/gi, '\n![image]($1)\n')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/div>/gi, '\n')
    .replace(/<div[^>]*>/gi, '')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<\/?[uo]l[^>]*>/gi, '\n')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, c) =>
      c.split('\n').map((l) => '> ' + l).join('\n') + '\n\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```\n\n')
    .replace(/<hr[^>]*>/gi, '\n---\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function scrollThrough(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let walked = 0;
      const step = 300;
      const timer = setInterval(() => {
        const height = document.body.scrollHeight;
        window.scrollBy(0, step);
        walked += step;
        if (walked >= height) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 100);
    });
  });
}

// ── CLI 参数 ──
const argv = process.argv.slice(2);

if (argv.length === 0 || argv.includes('--help')) {
  console.log(`
  微信公众号文章本地存档工具

  用法:
    node download.js <文章URL> [选项]

  选项:
    --output, -o <目录>   输出目录（默认取 settings.json）
    --no-image            跳过图片
    --no-video            跳过视频
    --set-output <目录>   保存默认输出目录
    --show-config         显示当前配置
  `);
  process.exit(0);
}

const store = new SettingsStore(SETTINGS_FILE);

const setIdx = argv.indexOf('--set-output');
if (setIdx !== -1) {
  const dir = argv[setIdx + 1];
  if (!dir) { console.error('缺少目录参数'); process.exit(1); }
  store.save({ defaultOutput: path.resolve(dir) });
  console.log(`默认输出目录 → ${path.resolve(dir)}`);
  process.exit(0);
}

if (argv.includes('--show-config')) {
  console.log(`默认输出目录: ${store.load().defaultOutput}`);
  process.exit(0);
}

const target = argv.find((a) => /^https?:\/\//i.test(a));
if (!target) { console.error('请提供文章 URL'); process.exit(1); }
if (!allowedArticleUrl(target)) {
  console.error('仅支持 HTTPS 微信文章链接或搜狗微信文章跳转链接。');
  process.exit(1);
}

const outIdx = argv.indexOf('--output') !== -1 ? argv.indexOf('--output') : argv.indexOf('-o');
if (outIdx !== -1 && (!argv[outIdx + 1] || argv[outIdx + 1].startsWith('-'))) {
  console.error('--output 需要一个目录参数');
  process.exit(1);
}
const outputDir = outIdx !== -1 ? path.resolve(argv[outIdx + 1]) : store.load().defaultOutput;
const skipImage = argv.includes('--no-image');
const skipVideo = argv.includes('--no-video');

// ── 主执行 ──
async function main() {
  console.log('微信公众号文章本地存档工具');
  console.log(`目标主机: ${new URL(target).hostname}\n`);

  const exe = BrowserLocator.find();
  if (!exe) { console.error('未找到 Chrome/Edge'); process.exit(1); }
  console.log(`浏览器: ${exe}`);

  const pptr = require('puppeteer-core');
  browser = await pptr.launch({
    headless: true,
    executablePath: exe,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    try {
      const requestUrl = request.url();
      if (/^(data|blob):/i.test(requestUrl)) return request.continue();
      const remote = new URL(requestUrl);
      const host = remote.hostname;
      const trustedHost = [
        'mp.weixin.qq.com', 'weixin.sogou.com', 'res.wx.qq.com',
        'mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'wx.qlogo.cn', 'mpvideo.qpic.cn',
      ].includes(host) || ['.qpic.cn', '.qlogo.cn', '.wx.qq.com'].some((suffix) => host.endsWith(suffix));
      if (remote.protocol === 'https:' && trustedHost && !remote.username && !remote.password && !remote.port) {
        return request.continue();
      }
    } catch { /* reject malformed or non-allowlisted requests */ }
    return request.abort('blockedbyclient');
  });

  // 媒体请求探针
  const seenVideos = new Set();
  const seenAudio = new Set();
  let mainDocumentStatus = 0;
  page.on('response', (resp) => {
    if (resp.request().isNavigationRequest() && resp.frame() === page.mainFrame()) {
      mainDocumentStatus = resp.status();
    }
    const u = resp.url();
    const type = resp.headers()['content-type'] || '';
    if (/video\//.test(type) || /\.(mp4|m3u8|flv)(\?|$)/i.test(u) || u.includes('mpvideo.qpic.cn')) {
      seenVideos.add(u);
    }
    if (/audio\//.test(type) || /\.(mp3|m4a)(\?|$)/i.test(u)) {
      seenAudio.add(u);
    }
  });

  // 是否为搜狗跳转链接（weixin.sogou.com/link?url=...）
  const isSogouJump = /^https?:\/\/weixin\.sogou\.com\/link\?/i.test(target);

  // 等待浏览器自然跳转离开搜狗域（最多 12s）；不伪装、不处理验证码
  async function waitForWechatNavigation() {
    try {
      await page.waitForFunction(
        () => /^https?:\/\/mp\.weixin\.qq\.com\//.test(location.href),
        { timeout: 12000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  console.log('加载页面...');
  try {
    await page.goto(target, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (e) {
    console.error(`页面加载失败（${e.name || 'Error'}）。`);
    await browser.close();
    process.exit(1);
  }

  // 搜狗跳转链接：等待浏览器自然跳转到微信文章页
  if (isSogouJump) {
    console.log('检测到搜狗跳转链接，等待自然跳转到微信文章页...');
    const jumped = await waitForWechatNavigation();
    if (!jumped) {
      const current = page.url();
      if (/antispider|verify|验证/i.test(current) || mainDocumentStatus === 403 || mainDocumentStatus === 429) {
        console.error('搜狗跳转被验证/限制拦截，无法解析到微信文章地址。请改用微信文章链接（mp.weixin.qq.com/s/...）直接存档。');
      } else {
        console.error(`未能跳转到微信文章页（当前地址: ${current}）。请改用微信文章链接（mp.weixin.qq.com/s/...）直接存档。`);
      }
      await browser.close();
      process.exit(1);
    }
    console.log('已跳转到微信文章页，继续存档流程。');
  }

  if (mainDocumentStatus >= 400 && mainDocumentStatus < 500) {
    console.error(`平台拒绝或限制访问（HTTP ${mainDocumentStatus}），停止存档；请使用平台提供的正常访问方式。`);
    await browser.close();
    process.exit(1);
  }

  const blocked = await page.evaluate(() => /环境异常|访问频繁|操作过于频繁|请完成验证/.test(document.body?.innerText || ''));
  if (blocked) {
    console.error('页面要求验证或限制访问，停止存档；不尝试绕过限制。');
    await browser.close();
    process.exit(1);
  }

  console.log('等待正文渲染...');
  try {
    await page.waitForSelector('#js_content', { timeout: 15000 });
  } catch {
    console.error('未找到正文（#js_content），文章可能已删除或需登录');
    await browser.close();
    process.exit(1);
  }

  console.log('滚动以触发懒加载...');
  await scrollThrough(page);
  await new Promise((r) => setTimeout(r, 3000));

  const meta = await page.evaluate(() => ({
    title: document.querySelector('#activity-name')?.innerText?.trim()
      || document.querySelector('.rich_media_title')?.innerText?.trim()
      || document.title || '未命名文章',
    author: document.querySelector('#js_name')?.innerText?.trim()
      || document.querySelector('.rich_media_meta_nickname')?.innerText?.trim() || '',
    publishTime: document.querySelector('#publish_time')?.innerText?.trim()
      || document.querySelector('.rich_media_meta_date')?.innerText?.trim() || '',
    digest: document.querySelector('.rich_media_meta_text')?.innerText?.trim() || '',
  }));

  console.log(`标题: ${meta.title}`);
  console.log(`作者: ${meta.author}`);
  console.log(`时间: ${meta.publishTime}`);

  const baseName = safeSegment(meta.title);
  fs.mkdirSync(outputDir, { recursive: true });
  let root;
  for (let n = 1; ; n++) {
    const candidate = path.join(outputDir, n === 1 ? baseName : `${baseName} (${n})`);
    try {
      fs.mkdirSync(candidate);
      root = candidate;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  const imgDir = path.join(root, 'images');
  const vidDir = path.join(root, 'videos');
  fs.mkdirSync(imgDir, { recursive: true });
  fs.mkdirSync(vidDir, { recursive: true });

  if (!skipImage) {
    console.log('\n下载配图...');
    const urls = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('#js_content img').forEach((img) => {
        const src = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (src && !src.startsWith('data:') && !/icon|loading/i.test(src)) out.push(src);
      });
      return out;
    });
    console.log(`发现 ${urls.length} 张图片`);
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i].startsWith('//') ? 'https:' + urls[i] : urls[i];
      const name = `${i + 1}${extOf(u)}`;
      process.stdout.write(`  [${i + 1}/${urls.length}] ${name} ...`);
      const ok = await pullBinary(u, path.join(imgDir, name));
      console.log(ok ? '✓' : '✗');
      if (ok) console.log(`MEDIA:${path.join(imgDir, name)}`);
    }
  }

  if (!skipVideo) {
    console.log('\n查找视频...');
    const domRefs = await page.evaluate(() => {
      const refs = [];
      document.querySelectorAll('video').forEach((v) => {
        const s = v.src || v.querySelector('source')?.src || '';
        if (s) refs.push(s);
      });
      document.querySelectorAll('iframe[data-src*="v.qq.com"], iframe[src*="v.qq.com"], iframe[data-src*="mpvideo"], iframe[src*="mpvideo"]').forEach((f) => {
        const s = f.getAttribute('data-src') || f.getAttribute('src') || '';
        if (s) refs.push(s);
      });
      document.querySelectorAll('[data-mpvid], .js_tx_video_container').forEach((el) => {
        const s = el.getAttribute('data-src') || el.getAttribute('data-url') || '';
        if (s) refs.push(s);
      });
      return refs;
    });

    const targets = [...new Set([...domRefs, ...seenVideos])].filter((u) => /^https?:/.test(u));
    console.log(`DOM 引用: ${domRefs.length} | 网络探针: ${seenVideos.size} | 可下载: ${targets.length}`);

    for (let i = 0; i < targets.length; i++) {
      const u = targets[i];
      const name = `${i + 1}${u.includes('.m3u8') ? '.m3u8' : '.mp4'}`;
      process.stdout.write(`  [${i + 1}/${targets.length}] ${name} ...`);
      const ok = await pullBinary(u, path.join(vidDir, name));
      console.log(ok ? '✓' : '✗');
      if (ok) console.log(`MEDIA:${path.join(vidDir, name)}`);
    }

    for (let i = 0; i < [...seenAudio].length; i++) {
      const u = [...seenAudio][i];
      const name = `audio_${i + 1}${u.includes('.mp3') ? '.mp3' : '.m4a'}`;
      process.stdout.write(`  [audio ${i + 1}] ${name} ...`);
      const ok = await pullBinary(u, path.join(vidDir, name));
      console.log(ok ? '✓' : '✗');
      if (ok) console.log(`MEDIA:${path.join(vidDir, name)}`);
    }
  }

  console.log('\n保存正文...');
  const { bodyHtml, safeBodyHtml } = await page.evaluate(() => {
    const source = document.querySelector('#js_content');
    if (!source) return { bodyHtml: '', safeBodyHtml: '' };
    const bodyHtml = source.innerHTML;
    const clean = source.cloneNode(true);
    clean.querySelectorAll('script,iframe,object,embed,form,base,meta,link,style,svg,math,video,audio,source,picture,canvas').forEach((el) => el.remove());
    clean.querySelectorAll('*').forEach((el) => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name.startsWith('on') || name === 'srcdoc' || name === 'style' || name === 'srcset') {
          el.removeAttribute(attr.name);
        } else if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(name) && /^(javascript|vbscript|data):/i.test(value)) {
          el.removeAttribute(attr.name);
        } else if (name === 'src') {
          // Keep remote media as inert metadata in the archived HTML.
          el.setAttribute('data-original-src', value);
          el.removeAttribute(attr.name);
        }
      }
    });
    return { bodyHtml, safeBodyHtml: clean.innerHTML };
  });

  const htmlFile = path.join(root, 'article.html');
  fs.writeFileSync(htmlFile, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(meta.title)}</title>
<style>body{max-width:800px;margin:0 auto;padding:20px;font-family:sans-serif;line-height:1.8;color:#333}img{max-width:100%}.meta{color:#999;margin:20px 0;font-size:14px}</style>
</head><body><h1>${escapeHtml(meta.title)}</h1><div class="meta">${escapeHtml(meta.author)} · ${escapeHtml(meta.publishTime)}</div>${safeBodyHtml}</body></html>`, 'utf-8');

  const mdFile = path.join(root, 'article.md');
  const md = `# ${meta.title}\n\n> **作者**: ${meta.author}  \n> **时间**: ${meta.publishTime}  \n${meta.digest ? `> **摘要**: ${meta.digest}  \n` : ''}> **原文**: [链接](${target})\n\n---\n\n${htmlToMarkdown(bodyHtml)}`;
  fs.writeFileSync(mdFile, md, 'utf-8');

  fs.writeFileSync(path.join(root, 'metadata.json'), JSON.stringify({
    ...meta, url: target, downloadedAt: new Date().toISOString(),
    capturedVideos: [...seenVideos], capturedAudio: [...seenAudio],
  }, null, 2), 'utf-8');

  await browser.close();

  const imgCount = fs.existsSync(imgDir) ? fs.readdirSync(imgDir).length : 0;
  const vidCount = fs.existsSync(vidDir) ? fs.readdirSync(vidDir).length : 0;
  console.log('\n完成 ✓');
  console.log(`输出: ${root}`);
  console.log(`  article.md   (${Math.round(fs.statSync(mdFile).size / 1024)} KB)`);
  console.log(`  article.html (${Math.round(fs.statSync(htmlFile).size / 1024)} KB)`);
  console.log(`  图片 ${imgCount} | 视频/音频 ${vidCount}`);
  console.log(`MEDIA:${mdFile}`);
  console.log(`MEDIA:${htmlFile}`);
}

let browser;
main().catch(async (e) => {
  console.error('执行出错:', e.message);
  if (browser) await browser.close().catch(() => {});
  process.exitCode = 1;
});
