'use strict';

const $ = (id) => document.getElementById(id);

const inputEl = $('input');
const extractBtn = $('extractBtn');
const clearBtn = $('clearBtn');
const statusEl = $('status');
const resultEl = $('result');
const player = $('player');
const avatarEl = $('avatar');
const authorNameEl = $('authorName');
const authorIdEl = $('authorId');
const videoTitleEl = $('videoTitle');
const statsEl = $('stats');
const downloadBtn = $('downloadBtn');
const openBtn = $('openBtn');
const copyBtn = $('copyBtn');
const toastEl = $('toast');
const offlineBannerEl = $('offlineBanner');

// 双击 index.html 打开（file:// 协议）时，仍然可以通过 CORS 调用本机服务
const API_BASE = location.protocol === 'file:' ? 'http://127.0.0.1:3000' : '';

let toastTimer = null;

/** 检测本地提取服务是否可用 */
async function checkBackend() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(API_BASE + '/api/ping', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const j = await res.json().catch(() => null);
    return !!(j && j.ok);
  } catch {
    return false;
  }
}

/** 把服务端返回的相对地址转换为当前可用的绝对地址 */
function absUrl(u) {
  if (API_BASE && u && u.startsWith('/')) return API_BASE + u;
  return u;
}

/** 持续检测本地服务：服务上线后自动解锁页面（无需手动刷新） */
async function waitForBackend() {
  for (let i = 0; i < 100; i++) {
    if (await checkBackend()) {
      offlineBannerEl.classList.add('hidden');
      extractBtn.disabled = false;
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

waitForBackend();

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

function setStatus(kind, html) {
  if (!kind) {
    statusEl.classList.add('hidden');
    statusEl.innerHTML = '';
    return;
  }
  statusEl.classList.remove('hidden', 'error', 'loading');
  statusEl.classList.add(kind);
  statusEl.innerHTML = html;
}

function formatCount(n) {
  n = Number(n) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}

function renderResult(d) {
  // 视频预览走本机代理（跟随 302 到真实 CDN）
  player.src = absUrl(d.previewUrl) || '';
  player.load();

  avatarEl.src = d.author.avatar || '';
  avatarEl.onerror = () => { avatarEl.style.visibility = 'hidden'; };
  avatarEl.style.visibility = 'visible';

  authorNameEl.textContent = d.author.nickname || '未知作者';
  authorIdEl.textContent = d.author.uniqueId ? '@' + d.author.uniqueId : '';

  videoTitleEl.textContent = d.title || '（无标题）';

  const chips = [
    ['❤️ 点赞', formatCount(d.stats.digg)],
    ['💬 评论', formatCount(d.stats.comment)],
    ['↗️ 分享', formatCount(d.stats.share)],
    ['⭐ 收藏', formatCount(d.stats.collect)],
  ];
  statsEl.innerHTML = '';
  chips.forEach(([label, value]) => {
    const chip = document.createElement('span');
    chip.className = 'stat-chip';
    chip.textContent = `${label} ${value}`;
    statsEl.appendChild(chip);
  });

  downloadBtn.href = absUrl(d.downloadUrl) || '#';
  downloadBtn.setAttribute(
    'download',
    (d.title || '抖音视频').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.mp4'
  );
  openBtn.href = absUrl(d.previewUrl) || '#';
  copyBtn.dataset.url = d.videoUrl || absUrl(d.previewUrl) || '';

  resultEl.classList.remove('hidden');
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function handleExtract() {
  const text = inputEl.value.trim();
  if (!text) {
    setStatus('error', '⚠️ 请先粘贴抖音分享链接');
    inputEl.focus();
    return;
  }

  const backendOk = await checkBackend();
  if (!backendOk) {
    offlineBannerEl.classList.remove('hidden');
    setStatus('error', '⚠️ 本地服务未启动，请双击 启动网站.bat 后刷新本页');
    return;
  }

  extractBtn.disabled = true;
  resultEl.classList.add('hidden');
  setStatus('loading', '<div class="spinner"></div><span>正在解析链接并获取视频信息，请稍候…</span>');

  try {
    const res = await fetch(API_BASE + '/api/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: text }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      throw new Error(json.error || '提取失败，请稍后重试');
    }
    renderResult(json.data);
    setStatus(null);
    showToast('✅ 提取成功，可预览或下载');
  } catch (e) {
    setStatus('error', '⚠️ ' + (e.message || '网络错误，请重试'));
  } finally {
    extractBtn.disabled = false;
  }
}

extractBtn.addEventListener('click', handleExtract);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleExtract();
});
inputEl.addEventListener('paste', () => {
  // 允许粘贴后稍作等待，自动滚动显示按钮
  setTimeout(() => extractBtn.focus(), 50);
});

clearBtn.addEventListener('click', () => {
  inputEl.value = '';
  resultEl.classList.add('hidden');
  player.pause();
  player.removeAttribute('src');
  player.load();
  setStatus(null);
  inputEl.focus();
});

copyBtn.addEventListener('click', async () => {
  const url = copyBtn.dataset.url || '';
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    showToast('📋 已复制视频地址');
  } catch {
    showToast('复制失败，请手动复制');
  }
});

// 预览视频加载出错时提示（源地址可能已过期）
player.addEventListener('error', () => {
  if (player.src) {
    showToast('⚠️ 视频地址已过期，请重新提取');
  }
});
