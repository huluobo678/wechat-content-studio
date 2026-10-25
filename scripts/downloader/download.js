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
      return JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch {
      return { defaultOutput: path.join(os.homedir(), 'Downloads', 'wechat-articles') };
    }
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
  name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);

function extOf(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('wx_fmt')
      ? '.' + u.searchParams.get('wx_fmt')
      : (path.extname(u.pathname) || '.jpg').slice(0, 5);
  } catch {
    return '.jpg';
  }
}

async function pullBinary(url, dest, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          'Referer': 'https://mp.weixin.qq.com/',
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(dest));
      return true;
    } catch (e) {
      if (i === tries - 1) {
        console.error(`  ✗ 下载失败 ${url.slice(0, 80)} → ${e.message}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return false;
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

const outIdx = argv.indexOf('--output') !== -1 ? argv.indexOf('--output') : argv.indexOf('-o');
const outputDir = outIdx !== -1 ? path.resolve(argv[outIdx + 1]) : store.load().defaultOutput;
const skipImage = argv.includes('--no-image');
const skipVideo = argv.includes('--no-video');

// ── 主执行 ──
async function main() {
  console.log('微信公众号文章本地存档工具');
  console.log(`目标: ${target}\n`);

  const exe = BrowserLocator.find();
  if (!exe) { console.error('未找到 Chrome/Edge'); process.exit(1); }
  console.log(`浏览器: ${exe}`);

  const pptr = require('puppeteer-core');
  const browser = await pptr.launch({
    headless: true,
    executablePath: exe,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

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

  console.log('加载页面...');
  try {
    await page.goto(target, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (e) {
    console.error(`加载失败: ${e.message}`);
    await browser.close();
    process.exit(1);
  }

  if (mainDocumentStatus === 403 || mainDocumentStatus === 429) {
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

  const root = path.join(outputDir, safeSegment(meta.title));
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
  const bodyHtml = await page.evaluate(() => document.querySelector('#js_content')?.innerHTML || '');

  const htmlFile = path.join(root, 'article.html');
  fs.writeFileSync(htmlFile, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${meta.title}</title>
<style>body{max-width:800px;margin:0 auto;padding:20px;font-family:sans-serif;line-height:1.8;color:#333}img{max-width:100%}.meta{color:#999;margin:20px 0;font-size:14px}</style>
</head><body><h1>${meta.title}</h1><div class="meta">${meta.author} · ${meta.publishTime}</div>${bodyHtml}</body></html>`, 'utf-8');

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

main().catch((e) => {
  console.error('执行出错:', e.message);
  process.exit(1);
});
