'use strict';

/**
 * 抖音视频提取网站 —— 零依赖 Node 服务器
 *  - 静态页面托管
 *  - POST /api/extract  提取视频信息
 *  - GET  /api/video    内联视频流代理（用于页面预览）
 *  - GET  /api/download 附件下载代理（触发浏览器下载）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { extract } = require('./extract');
const browserWorker = require('./browser-worker');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// 视频流代理允许的 CDN 域名后缀（防止被当作任意代理滥用）
const ALLOWED_HOST_SUFFIXES = [
  'douyinvod.com',
  'zjcdn.com',
  'douyin.com',
  'iesdouyin.com',
  'snssdk.com',
  'douyinpic.com',
  'douyinstatic.com',
  'bytecdn.cn',
  'bytedance.com',
  'ixigua.com',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, code, message) {
  sendJson(res, code, { success: false, error: message });
}

/** 校验代理目标域名 */
function isAllowedProxyUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith('.' + suffix)
    );
  } catch {
    return false;
  }
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 静态文件服务 */
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    sendError(res, 403, '禁止访问');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendError(res, 404, '页面不存在');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

/** 视频流代理（跟随 302 拿到真实 CDN 地址并转发流） */
async function serveVideoProxy(req, res, url, asAttachment, name) {
  if (!isAllowedProxyUrl(url)) {
    sendError(res, 400, '不允许代理该地址');
    return;
  }

  try {
    const upstream = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        referer: 'https://www.douyin.com/',
        accept: '*/*',
      },
    });
    if (!upstream.ok) {
      sendError(res, 502, `视频源返回 HTTP ${upstream.status}`);
      return;
    }
    const headers = {
      'content-type': upstream.headers.get('content-type') || 'video/mp4',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    };
    if (asAttachment) {
      const safeName = (name || 'douyin-video').replace(/[\\/:*?"<>|]/g, '_');
      headers['content-disposition'] =
        `attachment; filename="${safeName}.mp4"; filename*=UTF-8''${encodeURIComponent(safeName)}.mp4`;
    }
    res.writeHead(200, headers);
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    }
  } catch (e) {
    sendError(res, 502, '视频源请求失败：' + e.message);
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }

  if (pathname === '/api/ping' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      mode: 'local',
      browserChannel: browserWorker.available(),
    });
    return;
  }

  if (pathname === '/api/extract' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        sendError(res, 400, '请求体不是合法 JSON');
        return;
      }
      const text = parsed.url || parsed.text || '';
      if (!text) {
        sendError(res, 400, '请提供要提取的链接');
        return;
      }
      const result = await extract(text);
      sendJson(res, 200, result);
    } catch (e) {
      sendError(res, 422, e.message || '提取失败');
    }
    return;
  }

  if ((pathname === '/api/video' || pathname === '/api/download') && req.method === 'GET') {
    const target = u.searchParams.get('url') || '';
    const name = u.searchParams.get('name') || '';
    if (!target) {
      sendError(res, 400, '缺少 url 参数');
      return;
    }
    await serveVideoProxy(req, res, target, pathname === '/api/download', name);
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res, pathname);
    return;
  }

  sendError(res, 405, '不支持的请求');
});

server.listen(PORT, HOST, () => {
  // 记录 PID，供「停止服务.bat」使用
  try {
    fs.writeFileSync(path.join(__dirname, 'server.pid'), String(process.pid));
  } catch {}
  console.log('');
  console.log('  🎵 抖音视频提取网站已启动');
  console.log(`  请在浏览器打开:  http://${HOST}:${PORT}/index.html`);
  if (browserWorker.available()) {
    console.log('  ✔ 已启用本机浏览器提取通道（Edge/Chrome 无头模式）');
  } else {
    console.log('  ✘ 未检测到 Edge/Chrome，浏览器通道不可用（仅接口通道）');
  }
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('  ⚠ 端口 ' + PORT + ' 已被占用（服务可能已在运行），本窗口即将退出。');
  } else {
    console.error('服务器错误:', e);
  }
  process.exit(1);
});

async function shutdown() {
  try {
    fs.unlinkSync(path.join(__dirname, 'server.pid'));
  } catch {}
  await browserWorker.shutdown().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
