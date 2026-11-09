'use strict';

/* =========================================================
 * AI 图片生成与编辑 · 纯前端网页版
 * 依赖：浏览器 fetch + IndexedDB，无需构建、无需后端
 * ========================================================= */

const $ = (sel, root = document) => root.querySelector(sel);

const CFG_KEY = 'gipw.config.v1';
const MAX_ITEMS = 60;

const state = {
  cfg: { apiUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-1' },
  refs: [],
  items: [],
  busy: false,
};

/* ---------------- 配置 ---------------- */

function loadCfg() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) Object.assign(state.cfg, JSON.parse(raw) || {});
  } catch (_) { /* 忽略 */ }

  $('#apiUrl').value = state.cfg.apiUrl || '';
  $('#apiKey').value = state.cfg.apiKey || '';
  $('#model').value = state.cfg.model || '';
  updateBadge();
}

function readCfg() {
  state.cfg = {
    apiUrl: $('#apiUrl').value.trim(),
    apiKey: $('#apiKey').value.trim(),
    model: $('#model').value.trim() || 'gpt-image-1',
  };
  return state.cfg;
}

function persistCfg() {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(state.cfg)); } catch (_) { /* 配额或隐私模式 */ }
  updateBadge();
}

function updateBadge() {
  const el = $('#cfgBadge');
  const ok = !!(state.cfg.apiUrl && state.cfg.apiKey);
  el.textContent = ok ? `已配置 · ${state.cfg.model}` : '未配置';
  el.classList.toggle('ok', ok);
}

/* ---------------- 接口地址 ---------------- */

function endpoints(base) {
  let b = (base || '').trim();
  if (!b) return null;
  b = b.replace(/\/+$/, '');

  // 用户直接贴了完整接口地址
  if (/\/images\/(generations|edits)$/i.test(b)) {
    const root = b.replace(/\/images\/(generations|edits)$/i, '');
    return { gen: `${root}/images/generations`, edit: `${root}/images/edits`, models: `${root}/models` };
  }
  return { gen: `${b}/images/generations`, edit: `${b}/images/edits`, models: `${b}/models` };
}

function isDalle(model) { return /^dall-e/i.test(model || ''); }
function isDalle3(model) { return /^dall-e-3/i.test(model || ''); }

function currentSize() {
  const v = $('#size').value;
  if (v === 'custom') {
    const w = clampInt($('#sizeW').value, 64, 8192);
    const h = clampInt($('#sizeH').value, 64, 8192);
    return `${w}x${h}`;
  }
  if (v === 'auto' && isDalle(state.cfg.model)) return '';
  return v;
}

function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function buildFields() {
  const model = state.cfg.model || 'gpt-image-1';
  const dalle = isDalle(model);
  const f = { model };

  // 只发送用户显式选择的参数，默认值留给接口决定，兼容更多中转/第三方模型
  const size = currentSize();
  if (size && size !== 'auto') f.size = size;

  const q = $('#quality').value;
  if (q && q !== 'auto') f.quality = dalle ? (q === 'hd' || q === 'high' ? 'hd' : 'standard') : q;

  let n = clampInt($('#count').value, 1, 4);
  if (isDalle3(model)) n = 1;
  if (n > 1) f.n = String(n);

  if (dalle) {
    f.response_format = 'b64_json';
  } else {
    const bg = $('#background').value;
    if (bg && bg !== 'auto') f.background = bg;
    const fmt = $('#format').value;
    if (fmt && fmt !== 'png') f.output_format = fmt;
  }
  return f;
}

/* ---------------- 请求 ---------------- */

async function requestImages(prompt) {
  const cfg = state.cfg;
  const ep = endpoints(cfg.apiUrl);
  const useEdit = state.refs.length > 0;
  const url = useEdit ? ep.edit : ep.gen;

  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const fields = buildFields();
  let body;

  if (useEdit) {
    body = new FormData();
    for (const r of state.refs) {
      const blob = await (await fetch(r.dataUrl)).blob();
      body.append('image', blob, r.name || 'image.png');
    }
    body.append('prompt', prompt);
    Object.entries(fields).forEach(([k, v]) => body.append(k, v));
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ ...fields, prompt });
  }

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body });
  } catch (_) {
    throw new Error('网络请求失败：地址不可达，或被浏览器 CORS 拦截（该接口可能禁止网页直连）。');
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }

  if (!res.ok) throw new Error(httpError(res, data, text));

  const list = (data && (data.data || data.output)) || [];
  const mime = $('#format').value === 'jpeg' ? 'jpeg' : $('#format').value === 'webp' ? 'webp' : 'png';
  const out = [];

  for (const d of list) {
    if (d && d.b64_json) out.push(`data:image/${mime};base64,${d.b64_json}`);
    else if (d && d.url) out.push(d.url);
  }
  if (!out.length) throw new Error('接口返回成功，但没有解析到图片数据（data[].b64_json / url）。');
  return out;
}

function httpError(res, data, text) {
  const msg =
    (data && data.error && (data.error.message || data.error.type)) ||
    (data && data.message) ||
    (text || '').slice(0, 240) ||
    res.statusText;
  const hints = {
    400: '（参数不被支持，试试换尺寸 / 质量 / 模型）',
    401: '（API Key 无效或缺失）',
    403: '（无权限，可能未开通该模型）',
    404: '（地址或模型名不对，检查 API 地址是否包含 /v1）',
    429: '（频率或额度受限）',
  };
  return `HTTP ${res.status}：${msg}${hints[res.status] || ''}`;
}

/* ---------------- 生成流程 ---------------- */

async function generate() {
  if (state.busy) return;

  const cfg = readCfg();
  persistCfg();

  const raw = $('#prompt').value.trim();
  if (!raw) return setStatus('请先输入提示词', 'err');
  if (!cfg.apiUrl) return setStatus('请先填写 API 地址', 'err');

  const prompts = $('#batch').checked
    ? raw.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean)
    : [raw];

  const btn = $('#generate');
  state.busy = true;
  btn.disabled = true;
  btn.classList.add('busy');

  try {
    for (let i = 0; i < prompts.length; i++) {
      setStatus(`生成中…（${i + 1}/${prompts.length}）`, 'loading');
      const images = await requestImages(prompts[i]);
      const sizeText = currentSize();
      images.forEach((dataUrl) => addItem({
        dataUrl,
        prompt: prompts[i],
        model: cfg.model,
        sizeText,
        createdAt: Date.now(),
      }));
    }
    setStatus(`完成，新增 ${prompts.length} 组图片`, 'ok');
  } catch (err) {
    setStatus(err.message || String(err), 'err');
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

function setStatus(msg, type) {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status${type ? ' ' + type : ''}`;
}

/* ---------------- 参考图 ---------------- */

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f && f.type.startsWith('image/'));
  if (!files.length) return;

  files.forEach((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      state.refs.push({
        id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: file.name || 'image.png',
        dataUrl: reader.result,
      });
      renderRefs();
    };
    reader.readAsDataURL(file);
  });
}

function renderRefs() {
  const box = $('#refs');
  box.textContent = '';
  state.refs.forEach((r) => {
    const wrap = document.createElement('div');
    wrap.className = 'ref';

    const img = document.createElement('img');
    img.src = r.dataUrl;
    img.alt = r.name;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ref-del';
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', () => {
      state.refs = state.refs.filter((x) => x.id !== r.id);
      renderRefs();
    });

    wrap.append(img, del);
    box.appendChild(wrap);
  });
}

/* ---------------- 画廊 ---------------- */

function addItem(partial) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ...partial,
  };
  state.items.unshift(item);
  if (state.items.length > MAX_ITEMS) state.items.length = MAX_ITEMS;
  renderGallery();
  dbPut(item);
}

function renderGallery() {
  const box = $('#gallery');
  box.textContent = '';
  $('#resultCount').textContent = String(state.items.length);
  $('#emptyTip').classList.toggle('hidden', state.items.length > 0);
  state.items.forEach((item) => box.appendChild(cardEl(item)));
}

function cardEl(item) {
  const fig = document.createElement('figure');
  fig.className = 'shot';

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.src = item.dataUrl;
  img.alt = item.prompt || '';
  img.addEventListener('click', () => openLightbox(item.dataUrl));

  const cap = document.createElement('figcaption');

  const p = document.createElement('p');
  p.className = 'shot-prompt';
  p.textContent = item.prompt || '(无提示词)';

  const meta = document.createElement('p');
  meta.className = 'shot-meta';
  meta.textContent = [item.model, item.sizeText].filter(Boolean).join(' · ');

  const actions = document.createElement('div');
  actions.className = 'shot-actions';
  actions.append(
    actionBtn('下载', () => downloadItem(item)),
    actionBtn('作参考', () => useAsRef(item)),
    actionBtn('复用词', () => {
      $('#prompt').value = item.prompt || '';
      setStatus('已填入提示词');
    })
  );

  cap.append(p, meta, actions);
  fig.append(img, cap);
  return fig;
}

function actionBtn(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function openLightbox(src) {
  $('#lightboxImg').src = src;
  $('#lightbox').classList.remove('hidden');
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lightboxImg').removeAttribute('src');
}

function extOf(dataUrl) {
  const m = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl || '');
  const v = (m && m[1]) || 'png';
  return v === 'jpeg' ? 'jpg' : v;
}

function fileName(item) {
  const t = new Date(item.createdAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
  return `image-${stamp}.${extOf(item.dataUrl)}`;
}

async function downloadItem(item) {
  if (item.dataUrl.startsWith('data:')) {
    const a = document.createElement('a');
    a.href = item.dataUrl;
    a.download = fileName(item);
    a.click();
    return;
  }
  try {
    const blob = await (await fetch(item.dataUrl)).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `image-${Date.now()}.${extOf(`data:${blob.type}`)}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (_) {
    window.open(item.dataUrl, '_blank', 'noopener');
  }
}

async function useAsRef(item) {
  try {
    const blob = await (await fetch(item.dataUrl)).blob();
    state.refs.push({
      id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: 'reference.png',
      dataUrl: await blobToDataUrl(blob),
    });
    renderRefs();
    setStatus('已加入参考图', 'ok');
  } catch (_) {
    setStatus('这张图无法作为参考图（跨域限制），请先下载后手动上传', 'err');
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function downloadAll() {
  if (!state.items.length) return;
  for (const item of state.items) {
    // 顺序触发，避免浏览器拦截批量下载
    // eslint-disable-next-line no-await-in-loop
    await downloadItem(item);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 350));
  }
}

/* ---------------- IndexedDB 本地历史 ---------------- */

let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('gipw', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  return dbPromise;
}

async function dbPut(item) {
  const d = await db();
  if (!d) return;
  try {
    const tx = d.transaction('items', 'readwrite');
    tx.objectStore('items').put(item);
  } catch (_) { /* 忽略 */ }
}

async function dbAll() {
  const d = await db();
  if (!d) return [];
  return new Promise((resolve) => {
    try {
      const req = d.transaction('items', 'readonly').objectStore('items').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (_) {
      resolve([]);
    }
  });
}

async function dbClear() {
  const d = await db();
  if (!d) return;
  try {
    d.transaction('items', 'readwrite').objectStore('items').clear();
  } catch (_) { /* 忽略 */ }
}

async function loadHistory() {
  try {
    const all = await dbAll();
    all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    state.items = all.slice(0, MAX_ITEMS);
  } catch (_) {
    state.items = [];
  }
  renderGallery();
}

/* ---------------- 测试连接 ---------------- */

async function testConnection() {
  const cfg = readCfg();
  persistCfg();
  if (!cfg.apiUrl) return setStatus('请先填写 API 地址', 'err');

  setStatus('测试连接中…', 'loading');
  const ep = endpoints(cfg.apiUrl);
  try {
    const res = await fetch(ep.models, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
    });
    if (res.ok) {
      setStatus('连接成功，可以开始生成', 'ok');
    } else {
      const t = await res.text();
      setStatus(`连接失败：HTTP ${res.status} ${t.slice(0, 120)}`, 'err');
    }
  } catch (_) {
    setStatus('连接失败：可能被 CORS 拦截（部分接口不允许网页直连），可换支持跨域的中转地址', 'err');
  }
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  $('#saveCfg').addEventListener('click', () => {
    readCfg();
    persistCfg();
    setStatus('配置已保存到本机', 'ok');
  });

  $('#testCfg').addEventListener('click', testConnection);

  $('#toggleKey').addEventListener('click', () => {
    const input = $('#apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#toggleKey').textContent = show ? '隐藏' : '显示';
  });

  $('#size').addEventListener('change', (e) => {
    $('#customSizeRow').classList.toggle('hidden', e.target.value !== 'custom');
  });

  $('#generate').addEventListener('click', generate);

  $('#prompt').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      generate();
    }
  });

  $('#clearPrompt').addEventListener('click', () => {
    $('#prompt').value = '';
    state.refs = [];
    renderRefs();
    setStatus('');
  });

  const drop = $('#dropZone');
  const input = $('#fileInput');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('drag');
    })
  );
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  document.addEventListener('paste', (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (files.length) addFiles(files);
  });

  $('#lightbox').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });

  $('#downloadAll').addEventListener('click', downloadAll);

  $('#clearHistory').addEventListener('click', async () => {
    if (!state.items.length) return;
    if (!window.confirm('确定清空全部历史图片？此操作不可恢复。')) return;
    state.items = [];
    renderGallery();
    await dbClear();
    setStatus('历史已清空');
  });

  $('#toggleSettings').addEventListener('click', () => {
    $('#settings').classList.toggle('open');
  });
}

/* ---------------- 启动 ---------------- */

loadCfg();
bind();
loadHistory();
