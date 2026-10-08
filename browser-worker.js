'use strict';

/**
 * 浏览器提取通道：使用本机 Edge/Chrome（Chromium）无头模式访问抖音分享页。
 *
 * 原理：抖音网页自身的 JS 运行在真实浏览器环境里，会自动完成
 * a_bogus / secsdk 等风控签名并请求接口。我们只需要：
 *   1. 打开分享页（页面脚本自动请求视频数据接口）
 *   2. 拦截页面发出的 iteminfo / aweme/detail 接口响应，直接拿到视频 JSON
 *
 * 这样完全不需要自实现签名算法，抗风控能力也最强。
 */

const fs = require('fs');
const path = require('path');

let chromium = null;
try {
  chromium = require('playwright-core').chromium;
} catch {
  chromium = null;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const EXE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const PROFILE_DIR = path.join(__dirname, 'browser-profile');

let context = null;
let launchPromise = null;
let chain = Promise.resolve(); // 串行锁

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function executablePath() {
  for (const p of EXE_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function available() {
  return !!(chromium && executablePath());
}

async function ensureContext() {
  if (context) return context;
  if (!launchPromise) {
    launchPromise = (async () => {
      const exe = executablePath();
      if (!exe) throw new Error('未找到 Edge/Chrome 浏览器');
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: exe,
        headless: true,
        userAgent: UA,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        viewport: { width: 1440, height: 900 },
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--lang=zh-CN',
          '--mute-audio',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-notifications',
        ],
      });
      await ctx.addInitScript(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
          window.chrome = { runtime: {} };
        } catch {}
      });
      // 拦截音视频等重资源，加快页面加载（不加载视频本身）
      await ctx.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (type === 'media' || type === 'font') return route.abort();
        return route.continue();
      });
      ctx.on('close', () => {
        context = null;
        launchPromise = null;
      });
      context = ctx;
      // 预热：访问一次主页，让站点写入 s_v_web_id / msToken 等会话 Cookie
      try {
        const page = await ctx.newPage();
        await page.goto('https://www.douyin.com/', {
          waitUntil: 'domcontentloaded',
          timeout: 25000,
        });
        await page.waitForTimeout(4000);
        await page.close();
      } catch {}
      return ctx;
    })();
  }
  try {
    return await launchPromise;
  } catch (e) {
    launchPromise = null;
    throw e;
  }
}

/** 深度查找页面数据中的视频条目 */
function findItemInObject(obj, id, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 14) return null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findItemInObject(v, id, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (obj.aweme_id === id && obj.video && obj.video.play_addr) return obj;
  for (const k of Object.keys(obj)) {
    const r = findItemInObject(obj[k], id, depth + 1);
    if (r) return r;
  }
  return null;
}

/** 通过浏览器提取视频条目 */
async function extractViaBrowser(id) {
  // 串行执行（同一个浏览器实例同一时刻只跑一个提取任务）
  const run = chain.then(() => doExtract(id));
  chain = run.catch(() => {});
  return run;
}

async function doExtract(id) {
  const ctx = await ensureContext();
  const page = await ctx.newPage();
  const captured = [];

  try {
    // 拦截视频详情接口的响应
    page.on('response', async (res) => {
      const u = res.url();
      if (/aweme\/v1\/web\/aweme\/detail\/|web\/api\/v2\/aweme\/iteminfo\//.test(u)) {
        try {
          const body = await res.text();
          const j = JSON.parse(body);
          const item = j && (j.aweme_detail || (j.item_list && j.item_list[0]) || null);
          if (item && item.aweme_id === id) captured.push(item);
        } catch {}
      }
    });

    // 打开分享页，等待页面脚本自动请求数据接口
    await page
      .goto(`https://www.iesdouyin.com/share/video/${id}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      .catch(() => {});

    const deadline = Date.now() + 20000;
    while (!captured.length && Date.now() < deadline) {
      await sleep(400);
    }

    // 通道 2：在页面内直接发同源请求（页面 SDK 会自动附加签名）
    if (!captured.length) {
      const viaFetch = await page
        .evaluate(async (awemeId) => {
          try {
            const res = await fetch(
              `/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web` +
                `&pc_client_type=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&aweme_id=${awemeId}`,
              { headers: { accept: 'application/json' } }
            );
            const j = await res.json();
            return j && j.aweme_detail ? j.aweme_detail : null;
          } catch {
            return null;
          }
        }, id)
        .catch(() => null);
      if (viaFetch) captured.push(viaFetch);
    }

    // 通道 3：SSR 内嵌数据（RENDER_DATA / _ROUTER_DATA）
    if (!captured.length) {
      const fromDom = await page
        .evaluate(() => {
          try {
            const el = document.getElementById('RENDER_DATA');
            if (el && el.textContent) return JSON.parse(decodeURIComponent(el.textContent));
          } catch {}
          try {
            const html = document.documentElement.outerHTML;
            const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
            if (m) return JSON.parse(m[1]);
          } catch {}
          return null;
        })
        .catch(() => null);
      const item = fromDom && findItemInObject(fromDom, id);
      if (item) captured.push(item);
    }

    if (captured.length) return captured[0];

    // 判断是否被安全验证拦截
    const title = await page.title().catch(() => '');
    if (/验证|安全中心|验证码/.test(title)) {
      throw new Error(
        '抖音安全验证拦截了自动化浏览器。可先手动打开一次 douyin.com 完成验证后再试，或稍后重试'
      );
    }
    throw new Error('浏览器提取超时，未获取到视频数据，请稍后重试');
  } catch (e) {
    // 浏览器进程异常时自愈：关闭实例，下次重新启动
    if (/Target closed|Protocol error|Browser closed/.test(String(e && e.message))) {
      try {
        if (context) await context.close().catch(() => {});
      } catch {}
      context = null;
      launchPromise = null;
    }
    throw e;
  } finally {
    await page.close().catch(() => {});
  }
}

/** 优雅关闭 */
async function shutdown() {
  if (context) {
    await context.close().catch(() => {});
    context = null;
    launchPromise = null;
  }
}

module.exports = { available, extract: extractViaBrowser, shutdown };
