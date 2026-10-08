'use strict';

/**
 * 抖音视频信息提取核心逻辑（零依赖，基于 Node 内置 fetch）
 * 支持：
 *  - v.douyin.com/xxx 短链（自动跟随重定向）
 *  - www.douyin.com/video/xxx
 *  - www.douyin.com/discover?modal_id=xxx
 *  - www.iesdouyin.com/share/video/xxx
 *  - 包含链接的整段分享文案
 *
 * 提取通道（自动依次尝试）：
 *  1. 本机无头浏览器通道（浏览器内自动完成官方签名，最可靠）
 *  2. 官方 iteminfo 接口（ttwid Cookie + X-Bogus 签名）
 *  3. 分享页 HTML 内嵌 _ROUTER_DATA 数据解析
 */

const browserWorker = require('./browser-worker');
const { generateXbogus } = require('./xbogus');

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TIMEOUT_MS = 15000;

/* ---------------- 基础工具 ---------------- */

function withTimeout(promise, ms = TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('请求超时，请重试')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function randomMsToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 107; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* ---------------- Cookie 管理 ---------------- */

let cookieJar = '';

function collectCookies(res) {
  try {
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    for (const c of setCookies) {
      const pair = c.split(';')[0].trim();
      if (!pair) continue;
      const [k, v] = pair.split('=');
      if (!k || !v) continue;
      const key = `${k}=`;
      const idx = cookieJar.indexOf(key);
      const entry = `${k}=${v}`;
      if (idx === -1) {
        cookieJar = cookieJar ? `${cookieJar}; ${entry}` : entry;
      } else {
        // 替换同名 Cookie
        const end = cookieJar.indexOf(';', idx);
        cookieJar =
          end === -1
            ? cookieJar.slice(0, idx) + entry
            : cookieJar.slice(0, idx) + entry + cookieJar.slice(end);
      }
    }
  } catch {}
}

/** 访问抖音页面获取 ttwid 等 Cookie（接口必需） */
async function ensureCookies() {
  const sources = [
    { url: 'https://www.douyin.com/', ua: UA_DESKTOP },
    { url: 'https://www.iesdouyin.com/', ua: UA_MOBILE },
  ];
  for (const s of sources) {
    try {
      const res = await withTimeout(
        fetch(s.url, {
          headers: {
            'user-agent': s.ua,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9',
          },
        })
      );
      collectCookies(res);
      await res.arrayBuffer().catch(() => {});
      if (/ttwid=/.test(cookieJar)) return cookieJar;
    } catch {}
  }
  return cookieJar;
}

/** 浏览器风格的通用请求头 */
function browserHeaders(extra = {}, ua = UA_DESKTOP) {
  return Object.assign(
    {
      'user-agent': ua,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
    extra
  );
}

/* ---------------- 链接解析 ---------------- */

/** 从整段文案中提取 URL */
function pickUrl(text) {
  const s = String(text || '').trim();
  const m = s.match(/https?:\/\/[^\s"'<>【】（）()\[\]{}，。；、！？]+/i);
  if (!m) return null;
  return m[0].replace(/[），。；;、,，!！?？]+$/, '');
}

/** 从 URL 中提取视频 ID */
function extractId(url) {
  const u = String(url || '');
  const patterns = [
    /\/video\/(\d{10,})/,
    /modal_id=(\d{10,})/,
    /\/share\/video\/(\d{10,})/,
    /video_id=(\d{10,})/,
  ];
  for (const p of patterns) {
    const m = u.match(p);
    if (m) return { id: m[1], type: 'video' };
  }
  const note = u.match(/\/note\/(\d{10,})/);
  if (note) return { id: note[1], type: 'image' };
  return null;
}

/** 跟随重定向拿到最终 URL（用于 v.douyin.com 短链） */
async function followRedirects(url) {
  const res = await withTimeout(
    fetch(url, {
      redirect: 'follow',
      headers: browserHeaders(
        { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        UA_MOBILE
      ),
    })
  );
  collectCookies(res);
  await res.arrayBuffer().catch(() => {});
  return res.url || url;
}

/* ---------------- 提取通道 ---------------- */

/** 通道 2：官方 iteminfo 接口（带 ttwid Cookie + X-Bogus 签名） */
async function tryItemInfoApi(id) {
  const baseQuery = `item_ids=${id}`;
  const xb = generateXbogus(baseQuery);
  const res = await withTimeout(
    fetch(
      `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?${baseQuery}&X-Bogus=${encodeURIComponent(xb)}`,
      {
        headers: browserHeaders({
          referer: 'https://www.iesdouyin.com/',
          cookie: cookieJar,
          msToken: randomMsToken(),
        }),
      }
    )
  );
  collectCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`iteminfo 接口异常（HTTP ${res.status}）`);
  }
  const list = json && json.item_list;
  if (Array.isArray(list) && list.length && list[0].video) return list[0];
  throw new Error((json && json.status_msg) || 'iteminfo 接口未返回视频数据');
}

/** 深度查找页面数据中的 item_list */
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
  if (Array.isArray(obj.item_list) && obj.item_list.length) {
    const hit = obj.item_list.find((it) => it && it.aweme_id === id) || obj.item_list[0];
    if (hit && hit.video) return hit;
  }
  for (const k of Object.keys(obj)) {
    const r = findItemInObject(obj[k], id, depth + 1);
    if (r) return r;
  }
  return null;
}

/** 通道 3：解析分享页 HTML 内嵌的 _ROUTER_DATA */
async function trySharePage(id) {
  const res = await withTimeout(
    fetch(`https://www.iesdouyin.com/share/video/${id}/`, {
      headers: browserHeaders(
        {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          cookie: cookieJar,
        },
        UA_MOBILE
      ),
    })
  );
  collectCookies(res);
  const html = await res.text();
  const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m) throw new Error(`分享页解析失败（HTTP ${res.status}）`);
  let data = null;
  try {
    data = JSON.parse(m[1]);
  } catch {
    throw new Error('分享页数据解析失败');
  }
  const item = findItemInObject(data, id);
  if (item) return item;
  throw new Error('分享页未找到视频数据');
}

/** 依次尝试所有通道（浏览器通道优先） */
async function fetchItemInfo(id) {
  await ensureCookies();
  const errors = [];
  const channels = [];

  // 通道 1：本机无头浏览器（最可靠）
  if (browserWorker.available()) {
    channels.push({
      name: '浏览器通道',
      fn: () => browserWorker.extract(id),
    });
  }
  // 通道 2：iteminfo 接口（X-Bogus）
  channels.push({ name: 'iteminfo 接口', fn: () => tryItemInfoApi(id) });
  // 通道 3：分享页 HTML 解析
  channels.push({ name: '分享页解析', fn: () => trySharePage(id) });

  for (const ch of channels) {
    try {
      const item = await ch.fn();
      if (item) return item;
    } catch (e) {
      errors.push(`${ch.name}: ${e.message || e}`);
    }
  }
  const detail = errors.join('；') || '未知错误';
  throw new Error(`获取视频信息失败（${detail}）。可能原因：视频已删除/仅自己可见、抖音风控拦截，请稍后重试或更换网络`);
}

/* ---------------- 结果组装 ---------------- */

function firstUrl(list) {
  if (Array.isArray(list) && list.length) return list[0];
  return '';
}

/** 构建无/有水印视频地址候选 */
function buildVideoUrls(item) {
  const video = item.video || {};
  const playAddr = video.play_addr || {};
  const urlList = (playAddr.url_list || []).slice();
  const uri = playAddr.uri || '';

  const candidates = [];
  for (const u of urlList) {
    candidates.push(u.replace(/playwm/i, 'play')); // playwm -> play 去水印
  }
  if (uri) {
    // 官方播放接口（302 跳转到真实 CDN 无水印地址）
    candidates.push(
      `https://www.douyin.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`
    );
  }
  const unique = [...new Set(candidates.filter(Boolean))];
  const first = unique[0] || null;
  const name = encodeURIComponent((item.desc || '抖音视频').slice(0, 60));
  return {
    raw: first,
    previewUrl: first ? `/api/video?url=${encodeURIComponent(first)}` : null,
    downloadUrl: first ? `/api/download?url=${encodeURIComponent(first)}&name=${name}` : null,
  };
}

/**
 * 主入口：输入分享链接或整段文案，返回视频信息
 */
async function extract(text) {
  const url = pickUrl(text);
  if (!url) {
    throw new Error('未识别到链接，请粘贴完整的抖音分享链接或文案');
  }

  let target = url;
  let parsed = extractId(url);

  if (!parsed && /v\.douyin\.com/i.test(url)) {
    target = await followRedirects(url);
    parsed = extractId(target);
  }

  if (!parsed) {
    throw new Error('无法从链接中解析出视频 ID，请确认链接来自抖音分享');
  }
  if (parsed.type === 'image') {
    throw new Error('暂不支持图文（图集）内容，仅支持视频');
  }

  const item = await fetchItemInfo(parsed.id);
  if (!item) throw new Error('获取视频信息失败，该视频可能已删除或不可见');

  const video = buildVideoUrls(item);
  const author = item.author || {};
  const music = item.music || {};
  const stats = item.statistics || {};

  return {
    success: true,
    data: {
      awemeId: parsed.id,
      title: item.desc || '',
      createTime: item.create_time || 0,
      author: {
        nickname: author.nickname || '',
        uniqueId: author.unique_id || author.short_id || '',
        avatar: firstUrl(author.avatar_thumb ? author.avatar_thumb.url_list : []),
      },
      cover:
        firstUrl(item.video && item.video.cover ? item.video.cover.url_list : []) ||
        firstUrl(item.video && item.video.origin_cover ? item.video.origin_cover.url_list : []),
      videoUrl: video.raw,
      previewUrl: video.previewUrl,
      downloadUrl: video.downloadUrl,
      music: {
        title: music.title || '',
        author: music.author || '',
        url: firstUrl(music.play_url ? music.play_url.url_list : []),
      },
      stats: {
        digg: stats.digg_count || 0,
        comment: stats.comment_count || 0,
        share: stats.share_count || 0,
        collect: stats.collect_count || 0,
      },
      shareUrl: target,
    },
  };
}

module.exports = { extract, pickUrl, extractId };
