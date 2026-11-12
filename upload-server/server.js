const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');

const PORT = process.env.PORT || 8765;
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const PARTS_DIR = path.join(UPLOAD_DIR, '.parts');
const MAX_FILE_SIZE = (parseInt(process.env.MAX_FILE_MB, 10) || 2048) * 1024 * 1024; // 单文件上限，默认 2GB（分片上传时为合并后的总大小）
const MAX_CHUNK_SIZE = 100 * 1024 * 1024;     // 单个分片上限 100MB（前端默认 15MB 一片）
const MAX_CHUNKS = 10000;
const UPLOAD_KEY = process.env.UPLOAD_KEY || ''; // 访问密钥，为空则不校验

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(PARTS_DIR)) fs.mkdirSync(PARTS_DIR, { recursive: true });

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || 'unnamed';
}

// 统一的分片 ID 清洗规则（/check、/upload、/merge 共用）
function sanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
}

function chunkName(i) {
  return 'chunk_' + String(i).padStart(6, '0');
}

function tmpSuffix() {
  return '.tmp-' + crypto.randomBytes(6).toString('hex');
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (e) {}
}

function listFiles() {
  return fs.readdirSync(UPLOAD_DIR).filter((name) => {
    try { return fs.statSync(path.join(UPLOAD_DIR, name)).isFile(); } catch (e) { return false; }
  }).map((name) => {
    const st = fs.statSync(path.join(UPLOAD_DIR, name));
    return { name, size: st.size, mtime: st.mtime.toISOString() };
  }).sort((a, b) => b.mtime.localeCompare(a.mtime));
}

// 列出某个分片目录中已完整写入的分片 { index: size }
function listChunks(partDir) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(partDir); } catch (e) { return out; }
  for (const n of names) {
    const m = /^chunk_(\d{6})$/.exec(n);
    if (!m) continue;
    try { out[parseInt(m[1], 10)] = fs.statSync(path.join(partDir, n)).size; } catch (e) {}
  }
  return out;
}

function writeJson(res, code, obj) {
  if (res.writableEnded || res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function checkKey(req, url) {
  if (!UPLOAD_KEY) return true;
  const given = String(req.headers['x-upload-key'] || url.searchParams.get('key') || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(UPLOAD_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<title>远程传送</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
         background:#0f1222; color:#e8eaf6; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
  .card { width:100%; max-width:560px; background:#1a1f3a; border-radius:20px; padding:28px; box-shadow:0 12px 40px rgba(0,0,0,.45); }
  h1 { font-size:22px; text-align:center; margin-bottom:6px; }
  .sub { text-align:center; color:#8b93b5; font-size:13px; margin-bottom:20px; }
  .drop { border:2px dashed #3d4773; border-radius:14px; padding:34px 16px; text-align:center; cursor:pointer;
          transition:all .2s; background:#141934; }
  .drop:hover, .drop.over { border-color:#5b8cff; background:#182042; }
  .drop .icon { font-size:38px; margin-bottom:8px; }
  .drop p { color:#aab2d8; font-size:14px; }
  .drop .btn { display:inline-block; margin-top:12px; background:#3d5afe; color:#fff; border:none; border-radius:8px;
               padding:10px 22px; font-size:14px; cursor:pointer; }
  input[type=file] { display:none; }
  #taskList { margin:16px 0 4px; }
  .task { background:#141934; border-radius:10px; padding:10px 14px; margin-bottom:8px; }
  .task .t-head { display:flex; justify-content:space-between; align-items:center; font-size:12px; color:#aab2d8; margin-bottom:6px; gap:10px; }
  .task .t-name { word-break:break-all; }
  .task .t-chunk { flex-shrink:0; color:#8f9bd8; font-size:11px; }
  .task .t-pct { flex-shrink:0; }
  .task .t-info { font-size:11px; color:#7c86ad; margin-top:5px; }
  .task .bar { height:6px; background:#262c4d; border-radius:6px; overflow:hidden; }
  .task .bar > div { height:100%; width:0%; background:linear-gradient(90deg,#3d5afe,#00c6ff); border-radius:6px; transition:width .2s; }
  .task.done .bar > div { background:#0f9d58; }
  .task.err .bar > div { background:#e53935; }
  #listTitle { margin:22px 0 10px; font-size:14px; color:#8b93b5; }
  #fileList { list-style:none; }
  #fileList li { display:flex; justify-content:space-between; align-items:center; background:#141934; border-radius:10px;
                 padding:10px 14px; margin-bottom:8px; font-size:13px; word-break:break-all; }
  #fileList li .meta { color:#8b93b5; font-size:12px; white-space:nowrap; margin-left:12px; flex-shrink:0; }
  #fileList li .dl-btn { flex-shrink:0; margin-left:10px; background:#2a3566; color:#aab2d8; border:1px solid #3d4773;
                         border-radius:7px; padding:5px 12px; font-size:12px; cursor:pointer; transition:all .15s; }
  #fileList li .dl-btn:hover { background:#3d5afe; color:#fff; border-color:#3d5afe; }
  #fileList li .dl-btn:disabled { opacity:.5; cursor:not-allowed; }
  .dl-task { background:#141934; border-radius:10px; padding:10px 14px; margin-bottom:8px; }
  .dl-task .t-head { display:flex; justify-content:space-between; align-items:center; font-size:12px; color:#aab2d8; margin-bottom:6px; gap:10px; }
  .dl-task .t-name { word-break:break-all; }
  .dl-task .t-pct { flex-shrink:0; }
  .dl-task .bar { height:6px; background:#262c4d; border-radius:6px; overflow:hidden; }
  .dl-task .bar > div { height:100%; width:0%; background:linear-gradient(90deg,#00c6ff,#3d5afe); border-radius:6px; transition:width .2s; }
  .dl-task.done .bar > div { background:#0f9d58; }
  .dl-task.err .bar > div { background:#e53935; }
  .dl-task .t-info { font-size:11px; color:#7c86ad; margin-top:5px; }
  .divider { text-align:center; color:#5a6287; font-size:12px; margin:22px 0 14px; position:relative; }
  .divider::before, .divider::after { content:''; position:absolute; top:50%; width:30%; height:1px; background:#2a3055; }
  .divider::before { left:0; } .divider::after { right:0; }
  .split-tool { background:#141934; border-radius:14px; padding:18px; }
  .split-title { font-size:16px; text-align:center; margin-bottom:14px; color:#c5cae9; }
  .split-tabs { display:flex; gap:8px; margin-bottom:14px; }
  .split-tab { flex:1; background:#1a1f3a; color:#8b93b5; border:1px solid #2a3055; border-radius:8px; padding:8px; font-size:13px; cursor:pointer; transition:all .15s; }
  .split-tab.active { background:#3d5afe; color:#fff; border-color:#3d5afe; }
  .split-drop { border:2px dashed #3d4773; border-radius:12px; padding:24px 12px; text-align:center; cursor:pointer; transition:all .2s; background:#0f1222; }
  .split-drop:hover, .split-drop.over { border-color:#5b8cff; background:#182042; }
  .split-drop .icon { font-size:32px; margin-bottom:6px; }
  .split-drop p { color:#aab2d8; font-size:13px; margin-bottom:10px; }
  .split-config { margin-top:14px; }
  .split-file-info, .merge-file-info { background:#1a1f3a; border-radius:8px; padding:10px 12px; font-size:13px; color:#aab2d8; margin-bottom:12px; word-break:break-all; }
  .split-size-row { display:flex; align-items:center; gap:8px; margin-bottom:12px; font-size:13px; color:#aab2d8; flex-wrap:wrap; }
  .split-size-row select, .split-size-row input { background:#0f1222; color:#e8eaf6; border:1px solid #3d4773; border-radius:6px; padding:6px 10px; font-size:13px; }
  .split-size-row input { width:80px; }
  .split-start, .dl-all-btn { width:100%; background:#3d5afe; color:#fff; border:none; border-radius:8px; padding:10px; font-size:14px; cursor:pointer; margin-top:8px; }
  .split-start:disabled { opacity:.5; cursor:not-allowed; }
  .split-result-title { font-size:13px; color:#aab2d8; margin:14px 0 8px; }
  .split-list { list-style:none; max-height:220px; overflow-y:auto; }
  .split-list li { display:flex; justify-content:space-between; align-items:center; background:#1a1f3a; border-radius:8px; padding:8px 12px; margin-bottom:6px; font-size:12px; }
  .split-list li .meta { color:#8b93b5; flex-shrink:0; margin-left:8px; }
  .split-list li button { background:#2a3566; color:#aab2d8; border:1px solid #3d4773; border-radius:6px; padding:4px 10px; font-size:11px; cursor:pointer; flex-shrink:0; margin-left:8px; }
  .split-list li button:hover { background:#3d5afe; color:#fff; }
  .split-list li .sname { word-break:break-all; flex:1; }
  #toast { position:fixed; top:18px; left:50%; transform:translateX(-50%); background:#0f9d58; color:#fff; padding:10px 20px;
           border-radius:10px; font-size:14px; display:none; z-index:99; box-shadow:0 6px 20px rgba(0,0,0,.3); }
  #toast.err { background:#e53935; }
  .tip { text-align:center; color:#5a6287; font-size:12px; margin-top:18px; }
  #keyBox { display:none; background:#141934; border-radius:12px; padding:16px; margin-bottom:16px; text-align:center; }
  #keyBox p { color:#aab2d8; font-size:13px; margin-bottom:10px; }
  #keyBox input { width:65%; padding:9px 12px; border-radius:8px; border:1px solid #3d4773; background:#0f1222; color:#e8eaf6; font-size:14px; }
  #keyBox button { margin-left:6px; background:#3d5afe; color:#fff; border:none; border-radius:8px; padding:9px 16px; font-size:14px; cursor:pointer; }
</style>
</head>
<body>
<div class="card">
  <h1>📤 远程传送</h1>
  <div class="sub">上传文件，直接送达云端工作空间（大文件自动分片）</div>
  <div id="keyBox">
    <p id="keyMsg">🔒 请输入访问密钥</p>
    <input id="keyInput" type="password" placeholder="访问密钥" autocomplete="off"><button id="keyBtn">确定</button>
  </div>
  <div class="drop" id="drop">
    <div class="icon">⬆️</div>
    <p>把文件拖到这里，或点击选择</p>
    <button class="btn" id="pickBtn">选择文件</button>
    <input type="file" id="fileInput" multiple>
  </div>
  <div id="taskList"></div>
  <div id="dlTaskList"></div>
  <div id="listTitle">已上传文件</div>
  <ul id="fileList"></ul>
  <div class="tip">超过 15MB 的文件将自动分片上传并自动合并，支持断点续传；单片失败自动重试，最多尝试 10 次</div>
  <div class="divider">本地文件分割 / 合并工具</div>
  <div class="split-tool">
    <div class="split-title">✂️ 文件分割与合并</div>
    <div class="split-tabs">
      <button class="split-tab active" data-tab="split">分割文件</button>
      <button class="split-tab" data-tab="merge">合并分片</button>
    </div>
    <div class="split-panel" id="splitPanel">
      <div class="split-drop" id="splitDrop">
        <div class="icon">✂️</div>
        <p>选择要分割的本地文件（纯本地处理，不上传）</p>
        <button class="btn" id="splitPickBtn">选择文件</button>
        <input type="file" id="splitInput">
      </div>
      <div class="split-config" id="splitConfig" style="display:none">
        <div class="split-file-info" id="splitFileInfo"></div>
        <div class="split-size-row">
          <span>每片大小：</span>
          <select id="splitSize">
            <option value="5242880">5 MB</option>
            <option value="10485760" selected>10 MB</option>
            <option value="52428800">50 MB</option>
            <option value="104857600">100 MB</option>
            <option value="custom">自定义</option>
          </select>
          <input type="number" id="splitCustomSize" style="display:none" placeholder="MB" min="1">
          <span style="color:#5a6287;font-size:12px" id="splitPreview"></span>
        </div>
        <button class="split-start" id="splitStartBtn">开始分割</button>
      </div>
      <div id="splitProgress" style="display:none;margin-top:14px">
        <div class="dl-task"><div class="t-head"><span class="t-name" id="splitTaskName"></span><span class="t-pct" id="splitTaskPct">0%</span></div><div class="bar"><div></div></div><div class="t-info" id="splitTaskInfo">准备中...</div></div>
      </div>
      <div id="splitResult" style="display:none">
        <div class="split-result-title">分割完成，共 <span id="splitCount"></span> 片：</div>
        <button class="dl-all-btn" id="dlAllBtn">⬇️ 全部下载</button>
        <ul class="split-list" id="splitList"></ul>
      </div>
    </div>
    <div class="split-panel" id="mergePanel" style="display:none">
      <div class="split-drop" id="mergeDrop">
        <div class="icon">🔗</div>
        <p>选择要合并的分片文件（可多选，按文件名排序）</p>
        <button class="btn" id="mergePickBtn">选择分片</button>
        <input type="file" id="mergeInput" multiple>
      </div>
      <div class="split-config" id="mergeConfig" style="display:none">
        <div class="merge-file-info" id="mergeFileInfo"></div>
        <button class="split-start" id="mergeStartBtn">开始合并</button>
      </div>
      <div id="mergeResult" style="display:none;margin-top:14px">
        <button class="dl-all-btn" id="mergeDlBtn">⬇️ 下载合并后的文件</button>
      </div>
    </div>
  </div>
</div>
<div id="toast"></div>
<script>
  const CHUNK_LIMIT = 15 * 1024 * 1024; // 单片 15MB
  const MAX_ATTEMPTS = 10;              // 单片最多尝试 10 次（与页面提示一致）
  const drop = document.getElementById('drop');
  const input = document.getElementById('fileInput');
  const pickBtn = document.getElementById('pickBtn');
  const taskList = document.getElementById('taskList');
  const fileList = document.getElementById('fileList');
  const toast = document.getElementById('toast');
  const keyBox = document.getElementById('keyBox');
  const keyInput = document.getElementById('keyInput');
  const keyMsg = document.getElementById('keyMsg');

  // 访问密钥：优先取地址栏 ?key=，其次取本地保存的
  let accessKey = '';
  (function initKey() {
    const q = new URLSearchParams(location.search).get('key');
    if (q) {
      accessKey = q;
      try { localStorage.setItem('rft_key', q); } catch (e) {}
    } else {
      try { accessKey = localStorage.getItem('rft_key') || ''; } catch (e) {}
    }
  })();

  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    if (accessKey) h['X-Upload-Key'] = accessKey;
    return h;
  }

  function api(url, opts) {
    opts = opts || {};
    opts.headers = authHeaders(opts.headers);
    return fetch(url, opts).then((r) => {
      if (r.status === 401) { askKey('密钥错误或已失效，请重新输入'); throw new Error('访问密钥无效'); }
      return r;
    });
  }

  function askKey(msg) {
    keyMsg.textContent = '🔒 ' + (msg || '请输入访问密钥');
    keyBox.style.display = 'block';
  }

  document.getElementById('keyBtn').onclick = () => {
    accessKey = keyInput.value.trim();
    try { localStorage.setItem('rft_key', accessKey); } catch (e) {}
    verifyKey();
  };
  keyInput.onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('keyBtn').click(); };

  function verifyKey() {
    fetch('/auth', { headers: authHeaders() }).then(r => r.json()).then((r) => {
      if (r && r.ok) { keyBox.style.display = 'none'; refresh(); }
      else askKey(accessKey ? '密钥错误，请重新输入' : '请输入访问密钥');
    }).catch(() => askKey('无法连接服务器'));
  }

  pickBtn.onclick = (e) => { e.stopPropagation(); input.click(); };
  drop.onclick = () => input.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files); };
  input.onchange = () => { upload(input.files); input.value = ''; };

  function showToast(msg, err) {
    toast.textContent = msg;
    toast.className = err ? 'err' : '';
    toast.style.display = 'block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.style.display = 'none', 3000);
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n/1048576).toFixed(1) + ' MB';
    return (n/1073741824).toFixed(2) + ' GB';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function fmtSpeed(bps) {
    if (!isFinite(bps) || bps <= 0) return '-- MB/s';
    const mbps = bps / 1048576;
    if (mbps >= 1) return mbps.toFixed(1) + ' MB/s';
    const kbps = bps / 1024;
    if (kbps >= 1) return kbps.toFixed(0) + ' KB/s';
    return bps.toFixed(0) + ' B/s';
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0 || sec > 86400) return '--';
    if (sec < 60) return Math.ceil(sec) + ' 秒';
    const m = Math.floor(sec / 60);
    const s = Math.ceil(sec % 60);
    return m + ' 分 ' + s + ' 秒';
  }

  // 根据 文件名+大小+修改时间+分片大小 生成稳定的文件 ID（只含 a-z0-9 和 -）
  // 同一个文件重新选择后 ID 不变，可断点续传；不同文件互不干扰
  function hash53(str, seed) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
  function makeFileId(file) {
    const s = file.name + '|' + file.size + '|' + file.lastModified + '|' + CHUNK_LIMIT;
    return 'f-' + hash53(s, 1) + hash53(s, 2) + '-' + file.size.toString(36);
  }

  function makeTask(file) {
    const task = document.createElement('div');
    task.className = 'task';
    task.innerHTML = '<div class="t-head"><span class="t-name">📄 ' + escapeHtml(file.name) + '</span><span class="t-chunk"></span><span class="t-pct">0%</span></div><div class="bar"><div></div></div><div class="t-info">准备中...</div>';
    taskList.prepend(task);
    return task;
  }

  function upload(files) {
    if (!files || !files.length) return;
    [...files].forEach((file) => {
      const task = makeTask(file);
      if (file.size <= CHUNK_LIMIT) uploadSingle(task, file, file.name);
      else uploadChunked(task, file);
    });
  }

  function uploadSingle(task, file, name) {
    const bar = task.querySelector('.bar > div');
    const pct = task.querySelector('.t-pct');
    const info = task.querySelector('.t-info');
    const fd = new FormData();
    fd.append('file', file, name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    if (accessKey) xhr.setRequestHeader('X-Upload-Key', accessKey);
    let lastLoaded = 0, lastTime = 0, speed = 0;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = Math.round(e.loaded / e.total * 100);
      bar.style.width = p + '%';
      pct.textContent = p + '%';
      const now = Date.now();
      if (lastTime) {
        const dt = (now - lastTime) / 1000;
        if (dt > 0.15) {
          const inst = (e.loaded - lastLoaded) / dt;
          speed = speed ? speed * 0.6 + inst * 0.4 : inst;
          lastLoaded = e.loaded;
          lastTime = now;
        }
      } else { lastLoaded = e.loaded; lastTime = now; }
      if (speed > 0) info.textContent = fmtSpeed(speed) + ' · 预计还需 ' + fmtTime((e.total - e.loaded) / speed);
    };
    xhr.onload = () => {
      bar.style.width = '100%';
      let r = null;
      try { r = JSON.parse(xhr.responseText); } catch (e) { r = null; }
      if (r && r.ok) {
        task.classList.add('done'); pct.textContent = '✅ 完成'; info.textContent = '已上传 ' + fmtSize(file.size); showToast('✅ ' + name + ' 上传成功'); refresh();
      } else {
        task.classList.add('err'); pct.textContent = '❌ 失败';
        let msg = '';
        if (xhr.status === 401) { msg = '访问密钥无效'; askKey('密钥错误或已失效，请重新输入'); }
        else if (r && r.error) msg = r.error;
        else if (xhr.status === 413) msg = '文件过大，超过通道限制';
        else if (xhr.status === 502 || xhr.status === 504) msg = '网关超时：通道限速，建议稍后重试';
        else if (xhr.status) msg = 'HTTP ' + xhr.status + ' 服务器拒绝';
        else msg = '连接中断';
        info.textContent = msg;
        showToast('上传失败: ' + msg, true);
      }
    };
    xhr.onerror = () => { task.classList.add('err'); pct.textContent = '❌ 失败'; info.textContent = '网络错误'; showToast('网络错误，上传失败', true); };
    xhr.send(fd);
  }

  function uploadChunked(task, file) {
    const bar = task.querySelector('.bar > div');
    const pct = task.querySelector('.t-pct');
    const chunkTag = task.querySelector('.t-chunk');
    const info = task.querySelector('.t-info');
    const fileId = makeFileId(file);
    const total = Math.ceil(file.size / CHUNK_LIMIT);
    const chunkSize = (i) => Math.min(CHUNK_LIMIT, file.size - i * CHUNK_LIMIT);
    let doneBytes = 0;   // 已完成分片的字节数
    let activeBytes = 0; // 当前分片已发送的字节数
    let lastDone = 0, lastTime = 0, speed = 0;

    function updateProgress() {
      const done = doneBytes + activeBytes;
      const p = Math.round(done / file.size * 100);
      bar.style.width = p + '%';
      pct.textContent = p + '%';
      const now = Date.now();
      if (lastTime) {
        const dt = (now - lastTime) / 1000;
        if (dt > 0.2) {
          const inst = (done - lastDone) / dt;
          speed = speed ? speed * 0.6 + inst * 0.4 : inst;
          lastDone = done;
          lastTime = now;
        }
      } else { lastDone = done; lastTime = now; }
      if (speed > 0) info.textContent = fmtSpeed(speed) + ' · 预计还需 ' + fmtTime((file.size - done) / speed);
    }

    function uploadOne(i) {
      return new Promise((resolve, reject) => {
        const start = i * CHUNK_LIMIT;
        const blob = file.slice(start, start + chunkSize(i));
        const attempt = (n) => {
          const fd = new FormData();
          fd.append('chunkIndex', i);
          fd.append('totalChunks', total);
          fd.append('fileId', fileId);
          fd.append('file', blob, file.name);
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/upload');
          if (accessKey) xhr.setRequestHeader('X-Upload-Key', accessKey);
          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            activeBytes = Math.min(e.loaded, blob.size);
            updateProgress();
          };
          const fail = (msg, fatal) => {
            activeBytes = 0;
            if (!fatal && n < MAX_ATTEMPTS) {
              info.textContent = '分片 ' + (i + 1) + ' 失败(' + msg + ')，第 ' + (n + 1) + '/' + MAX_ATTEMPTS + ' 次尝试...';
              setTimeout(() => attempt(n + 1), 1200);
            } else {
              reject(new Error('分片 ' + (i + 1) + ' 失败: ' + msg));
            }
          };
          xhr.onload = () => {
            let r = null;
            try { r = JSON.parse(xhr.responseText); } catch (e) { r = null; }
            if (r && r.ok) {
              doneBytes += blob.size;
              activeBytes = 0;
              updateProgress();
              resolve();
            } else if (xhr.status === 401) {
              askKey('密钥错误或已失效，请重新输入');
              fail('访问密钥无效', true);
            } else {
              fail((r && r.error) ? r.error : ('HTTP ' + (xhr.status || '?')));
            }
          };
          xhr.onerror = () => fail('网络错误');
          xhr.send(fd);
        };
        attempt(1);
      });
    }

    (async () => {
      // 先查询服务器上已完成的分片（大小必须与本地一致才算完成）
      info.textContent = '检查已上传的分片...';
      const checkRes = await api('/check?fileId=' + encodeURIComponent(fileId));
      const checkData = await checkRes.json();
      const sizes = (checkData && checkData.chunks) || {};
      const doneSet = new Set();
      for (let i = 0; i < total; i++) {
        if (sizes[i] === chunkSize(i)) { doneSet.add(i); doneBytes += chunkSize(i); }
      }
      if (doneSet.size > 0) info.textContent = '发现已上传 ' + doneSet.size + ' 片，从断点继续...';
      updateProgress();
      // 逐片顺序上传（单线程，避免通道超时）
      for (let i = 0; i < total; i++) {
        if (doneSet.has(i)) continue;
        chunkTag.textContent = '分片 ' + (i + 1) + '/' + total;
        await uploadOne(i);
        doneSet.add(i);
      }

      // 所有分片完成，请求服务端合并
      chunkTag.textContent = '';
      info.textContent = '分片全部上传完成，正在合并...';
      const mres = await api('/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'fileId=' + encodeURIComponent(fileId) + '&totalChunks=' + total + '&filename=' + encodeURIComponent(file.name)
      });
      let mr = null;
      try { mr = await mres.json(); } catch (e) { mr = null; }
      if (mr && mr.ok) {
        task.classList.add('done'); pct.textContent = '✅ 完成'; info.textContent = '已合并上传 ' + fmtSize(file.size) + '（共 ' + total + ' 片）'; showToast('✅ ' + file.name + ' 上传成功'); refresh();
      } else {
        throw new Error('合并失败: ' + ((mr && mr.error) || '未知错误'));
      }
    })().catch((err) => {
      task.classList.add('err'); pct.textContent = '❌ 失败'; info.textContent = (err.message || '上传失败') + '（重新选择同一文件可断点续传）';
      showToast('上传失败: ' + (err.message || ''), true);
    });
  }

  function refresh() {
    api('/files').then(r => r.json()).then(list => {
      if (!Array.isArray(list)) return;
      fileList.innerHTML = '';
      if (!list.length) { fileList.innerHTML = '<li style="color:#5a6287">暂无文件</li>'; return; }
      list.forEach(f => {
        const li = document.createElement('li');
        li.innerHTML = '<span>📄 ' + escapeHtml(f.name) + '</span>' +
          '<span style="display:flex;align-items:center;flex-shrink:0">' +
          '<span class="meta">' + fmtSize(f.size) + '</span>' +
          '<button class="dl-btn" data-name="' + encodeURIComponent(f.name) + '">下载</button>' +
          '</span>';
        li.querySelector('.dl-btn').onclick = () => downloadFile(f.name, f.size);
        fileList.appendChild(li);
      });
    }).catch(() => {});
  }
  const dlTaskList = document.getElementById('dlTaskList');
  const DL_CHUNK = 10 * 1024 * 1024; // 下载每片 10MB
  const DL_MAX_ATTEMPTS = 10;

  function makeDlTask(name) {
    const task = document.createElement('div');
    task.className = 'dl-task';
    task.innerHTML = '<div class="t-head"><span class="t-name">⬇️ ' + escapeHtml(name) + '</span><span class="t-pct">0%</span></div>' +
      '<div class="bar"><div></div></div><div class="t-info">准备下载...</div>';
    dlTaskList.prepend(task);
    return task;
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // 分段下载大文件，支持断点续传
  function downloadFile(name, totalSize) {
    const task = makeDlTask(name);
    const bar = task.querySelector('.bar > div');
    const pct = task.querySelector('.t-pct');
    const info = task.querySelector('.t-info');
    const parts = [];
    let downloaded = 0;
    let lastBytes = 0, lastTime = 0, speed = 0;

    function updateDlProgress() {
      const p = Math.round(downloaded / totalSize * 100);
      bar.style.width = p + '%';
      pct.textContent = p + '%';
      const now = Date.now();
      if (lastTime) {
        const dt = (now - lastTime) / 1000;
        if (dt > 0.2) {
          const inst = (downloaded - lastBytes) / dt;
          speed = speed ? speed * 0.6 + inst * 0.4 : inst;
          lastBytes = downloaded;
          lastTime = now;
        }
      } else { lastBytes = downloaded; lastTime = now; }
      if (speed > 0) info.textContent = fmtSpeed(speed) + ' · 预计还需 ' + fmtTime((totalSize - downloaded) / speed);
    }

    function dlRange(start, end, attempt) {
      return new Promise((resolve, reject) => {
        fetch('/download?name=' + encodeURIComponent(name), {
          headers: Object.assign(authHeaders(), { 'Range': 'bytes=' + start + '-' + end })
        }).then(r => {
          if (r.status === 401) { askKey('密钥错误或已失效，请重新输入'); reject(new Error('访问密钥无效')); return; }
          if (r.status !== 206 && r.status !== 200) { reject(new Error('HTTP ' + r.status)); return; }
          return r.arrayBuffer();
        }).then(buf => {
          if (buf) resolve(buf);
        }).catch(err => {
          if (attempt < DL_MAX_ATTEMPTS) {
            info.textContent = '分片下载失败(' + (err.message || '网络错误') + ')，第 ' + (attempt + 1) + '/' + DL_MAX_ATTEMPTS + ' 次重试...';
            setTimeout(() => dlRange(start, end, attempt + 1).then(resolve).catch(reject), 1200);
          } else {
            reject(new Error('分片下载失败: ' + (err.message || '网络错误')));
          }
        });
      });
    }

    (async () => {
      info.textContent = '开始下载...';
      if (totalSize <= DL_CHUNK) {
        const buf = await dlRange(0, totalSize - 1, 1);
        downloaded = totalSize;
        updateDlProgress();
        saveBlob(new Blob([buf]), name);
        task.classList.add('done');
        pct.textContent = '✅ 完成';
        info.textContent = '已保存 ' + fmtSize(totalSize);
        showToast('✅ ' + name + ' 下载完成');
        return;
      }
      const total = Math.ceil(totalSize / DL_CHUNK);
      for (let i = 0; i < total; i++) {
        const start = i * DL_CHUNK;
        const end = Math.min(start + DL_CHUNK - 1, totalSize - 1);
        info.textContent = '下载分片 ' + (i + 1) + '/' + total + '...';
        const buf = await dlRange(start, end, 1);
        parts.push(buf);
        downloaded += buf.byteLength;
        updateDlProgress();
      }
      saveBlob(new Blob(parts), name);
      task.classList.add('done');
      pct.textContent = '✅ 完成';
      info.textContent = '已保存 ' + fmtSize(totalSize) + '（共 ' + total + ' 片）';
      showToast('✅ ' + name + ' 下载完成');
    })().catch(err => {
      task.classList.add('err');
      pct.textContent = '❌ 失败';
      info.textContent = (err.message || '下载失败') + '（已下载 ' + fmtSize(downloaded) + '，可重新点击下载继续）';
      showToast('下载失败: ' + (err.message || ''), true);
    });
  }

  // ========== 文件分割 / 合并工具 ==========
  let splitFile = null;
  let splitBlobs = [];
  let mergeBlob = null;

  // Tab 切换
  document.querySelectorAll('.split-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.split-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('splitPanel').style.display = tab.dataset.tab === 'split' ? 'block' : 'none';
      document.getElementById('mergePanel').style.display = tab.dataset.tab === 'merge' ? 'block' : 'none';
    };
  });

  // 分割：选择文件
  const splitDrop = document.getElementById('splitDrop');
  const splitInput = document.getElementById('splitInput');
  document.getElementById('splitPickBtn').onclick = (e) => { e.stopPropagation(); splitInput.click(); };
  splitDrop.onclick = () => splitInput.click();
  splitDrop.ondragover = (e) => { e.preventDefault(); splitDrop.classList.add('over'); };
  splitDrop.ondragleave = () => splitDrop.classList.remove('over');
  splitDrop.ondrop = (e) => { e.preventDefault(); splitDrop.classList.remove('over'); if (e.dataTransfer.files[0]) pickSplitFile(e.dataTransfer.files[0]); };
  splitInput.onchange = () => { if (splitInput.files[0]) pickSplitFile(splitInput.files[0]); splitInput.value = ''; };

  function pickSplitFile(file) {
    splitFile = file;
    splitBlobs = [];
    document.getElementById('splitConfig').style.display = 'block';
    document.getElementById('splitProgress').style.display = 'none';
    document.getElementById('splitResult').style.display = 'none';
    document.getElementById('splitFileInfo').textContent = '📄 ' + file.name + '（' + fmtSize(file.size) + '）';
    updateSplitPreview();
  }

  const splitSizeSel = document.getElementById('splitSize');
  const splitCustomInput = document.getElementById('splitCustomSize');
  splitSizeSel.onchange = () => {
    splitCustomInput.style.display = splitSizeSel.value === 'custom' ? 'inline-block' : 'none';
    updateSplitPreview();
  };
  splitCustomInput.oninput = updateSplitPreview;

  function getSplitSize() {
    if (splitSizeSel.value === 'custom') {
      const mb = parseFloat(splitCustomInput.value);
      return isNaN(mb) || mb <= 0 ? 0 : mb * 1024 * 1024;
    }
    return parseInt(splitSizeSel.value, 10);
  }

  function updateSplitPreview() {
    const sz = getSplitSize();
    const el = document.getElementById('splitPreview');
    if (!sz || !splitFile) { el.textContent = ''; return; }
    const n = Math.ceil(splitFile.size / sz);
    el.textContent = '→ 共 ' + n + ' 片';
  }

  // 开始分割
  document.getElementById('splitStartBtn').onclick = () => {
    if (!splitFile) return;
    const sz = getSplitSize();
    if (!sz) { showToast('请设置有效的分片大小', true); return; }
    const total = Math.ceil(splitFile.size / sz);
    const progress = document.getElementById('splitProgress');
    const bar = progress.querySelector('.bar > div');
    const pct = progress.querySelector('.t-pct');
    const info = progress.querySelector('.t-info');
    document.getElementById('splitTaskName').textContent = '✂️ ' + splitFile.name;
    progress.style.display = 'block';
    document.getElementById('splitResult').style.display = 'none';
    splitBlobs = [];

    (async () => {
      for (let i = 0; i < total; i++) {
        const start = i * sz;
        const end = Math.min(start + sz, splitFile.size);
        const blob = splitFile.slice(start, end);
        splitBlobs.push(blob);
        const done = end;
        const p = Math.round(done / splitFile.size * 100);
        bar.style.width = p + '%';
        pct.textContent = p + '%';
        info.textContent = '分割中 ' + (i + 1) + '/' + total + '（' + fmtSize(blob.size) + '）';
        await new Promise(r => setTimeout(r, 10));
      }
      // 生成分片列表
      const list = document.getElementById('splitList');
      list.innerHTML = '';
      const baseName = splitFile.name;
      const pad = String(total).length;
      splitBlobs.forEach((blob, i) => {
        const partName = baseName + '.part' + String(i + 1).padStart(pad, '0') + '-' + total;
        const li = document.createElement('li');
        li.innerHTML = '<span class="sname">' + escapeHtml(partName) + '</span><span class="meta">' + fmtSize(blob.size) + '</span>';
        const btn = document.createElement('button');
        btn.textContent = '下载';
        btn.onclick = () => saveBlob(blob, partName);
        li.appendChild(btn);
        list.appendChild(li);
      });
      document.getElementById('splitCount').textContent = total;
      document.getElementById('splitResult').style.display = 'block';
      progress.querySelector('.dl-task').classList.add('done');
      pct.textContent = '✅ 完成';
      info.textContent = '分割完成，共 ' + total + ' 片';
      showToast('✅ 分割完成');
    })().catch(err => {
      showToast('分割失败: ' + (err.message || ''), true);
    });
  };

  // 全部下载
  document.getElementById('dlAllBtn').onclick = () => {
    splitBlobs.forEach((blob, i) => {
      const total = splitBlobs.length;
      const pad = String(total).length;
      const partName = splitFile.name + '.part' + String(i + 1).padStart(pad, '0') + '-' + total;
      setTimeout(() => saveBlob(blob, partName), i * 300);
    });
  };

  // 合并：选择分片
  let mergeFiles = [];
  const mergeDrop = document.getElementById('mergeDrop');
  const mergeInput = document.getElementById('mergeInput');
  document.getElementById('mergePickBtn').onclick = (e) => { e.stopPropagation(); mergeInput.click(); };
  mergeDrop.onclick = () => mergeInput.click();
  mergeDrop.ondragover = (e) => { e.preventDefault(); mergeDrop.classList.add('over'); };
  mergeDrop.ondragleave = () => mergeDrop.classList.remove('over');
  mergeDrop.ondrop = (e) => { e.preventDefault(); mergeDrop.classList.remove('over'); if (e.dataTransfer.files.length) pickMergeFiles(e.dataTransfer.files); };
  mergeInput.onchange = () => { if (mergeInput.files.length) pickMergeFiles(mergeInput.files); mergeInput.value = ''; };

  function pickMergeFiles(files) {
    mergeFiles = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    let total = 0;
    mergeFiles.forEach(f => total += f.size);
    document.getElementById('mergeConfig').style.display = 'block';
    document.getElementById('mergeResult').style.display = 'none';
    document.getElementById('mergeFileInfo').innerHTML = '已选择 ' + mergeFiles.length + ' 个分片，总计 ' + fmtSize(total) + '<br>' +
      mergeFiles.map(f => '• ' + escapeHtml(f.name)).join('<br>');
  }

  // 开始合并
  document.getElementById('mergeStartBtn').onclick = () => {
    if (!mergeFiles.length) return;
    const btn = document.getElementById('mergeStartBtn');
    btn.disabled = true;
    btn.textContent = '合并中...';
    (async () => {
      const parts = [];
      for (let i = 0; i < mergeFiles.length; i++) {
        const buf = await mergeFiles[i].arrayBuffer();
        parts.push(buf);
      }
      mergeBlob = new Blob(parts);
      // 尝试从第一个分片名还原原始文件名
      let origName = mergeFiles[0].name.replace(/\.part\d+-\d+$/, '');
      if (origName === mergeFiles[0].name) origName = 'merged_' + origName;
      const dlBtn = document.getElementById('mergeDlBtn');
      dlBtn.onclick = () => saveBlob(mergeBlob, origName);
      document.getElementById('mergeResult').style.display = 'block';
      btn.disabled = false;
      btn.textContent = '开始合并';
      showToast('✅ 合并完成（' + fmtSize(mergeBlob.size) + '）');
    })().catch(err => {
      btn.disabled = false;
      btn.textContent = '开始合并';
      showToast('合并失败: ' + (err.message || ''), true);
    });
  };

  verifyKey();
  setInterval(() => { if (keyBox.style.display !== 'block') refresh(); }, 8000);
</script>
</body>
</html>`;

let nameSeq = 0;
function uniqueDestName(origName) {
  const base = Date.now() + '_';
  let name = base + origName;
  while (fs.existsSync(path.join(UPLOAD_DIR, name))) name = base + (++nameSeq) + '_' + origName;
  return name;
}

const merging = new Set(); // 正在合并的 fileId，防止重复合并

// 删除上传失败的临时文件；分片目录若因此变空也一并删除
function removeTmp(job) {
  safeUnlink(job.tmpPath);
  if (job.partDir) { try { fs.rmdirSync(job.partDir); } catch (e) {} }
}

function handleUpload(req, res) {
  let bb;
  try {
    bb = busboy({ headers: req.headers, limits: { files: 20, fields: 20, fieldSize: 1024 } });
  } catch (e) {
    writeJson(res, 400, { ok: false, error: 'bad request' });
    return;
  }
  const fields = {};
  const jobs = [];
  let badMsg = '';
  let finished = false;

  const cleanupAll = () => {
    for (const j of jobs) {
      try { j.file.unpipe(j.ws); } catch (e) {}
      j.file.resume();
      j.ws.destroy();
    }
    Promise.all(jobs.map((j) => j.done)).then(() => jobs.forEach(removeTmp));
  };

  bb.on('field', (name, val) => { fields[name] = val; });

  bb.on('file', (fieldname, file, info) => {
    const fileId = sanitizeId(fields.fileId);
    const chunkIndex = parseInt(fields.chunkIndex, 10);
    const totalChunks = parseInt(fields.totalChunks, 10);
    const isChunk = !!(fileId && Number.isInteger(chunkIndex) && Number.isInteger(totalChunks) && totalChunks > 1);
    if (isChunk && (chunkIndex < 0 || chunkIndex >= totalChunks || totalChunks > MAX_CHUNKS)) {
      badMsg = '分片参数无效';
      file.resume();
      return;
    }

    let finalPath, tmpPath, limit;
    if (isChunk) {
      const partDir = path.join(PARTS_DIR, fileId);
      fs.mkdirSync(partDir, { recursive: true });
      finalPath = path.join(partDir, chunkName(chunkIndex));
      tmpPath = finalPath + tmpSuffix();   // 先写临时文件，写完再改名，避免半截分片被当成已完成
      limit = MAX_CHUNK_SIZE;
    } else {
      finalPath = null;                     // 写完后再决定最终文件名
      tmpPath = path.join(PARTS_DIR, 'single' + tmpSuffix());
      limit = MAX_FILE_SIZE;
    }

    const ws = fs.createWriteStream(tmpPath);
    const job = { file, ws, tmpPath, finalPath, partDir: isChunk ? path.dirname(finalPath) : null, origName: safeName(info.filename), failed: false, tooBig: false, reason: '' };
    job.done = new Promise((resolve) => {
      ws.on('finish', resolve);
      ws.on('close', resolve);
      ws.on('error', (err) => {
        job.failed = true;
        job.reason = job.reason || ('写入磁盘失败: ' + (err.code || err.message));
        resolve();
      });
    });
    jobs.push(job);

    let bytes = 0;
    file.on('data', (d) => {
      bytes += d.length;
      if (bytes > limit && !job.tooBig) {
        job.tooBig = true;
        job.failed = true;
        job.reason = isChunk ? '分片超过大小上限' : '文件超过大小上限 (' + Math.round(MAX_FILE_SIZE / 1048576) + 'MB)';
        file.unpipe(ws);
        ws.destroy();
        file.resume(); // 继续读完请求体，丢弃剩余数据
      }
    });
    file.on('error', () => { job.failed = true; job.reason = job.reason || '上传中断'; ws.destroy(); });
    file.pipe(ws);
  });

  bb.on('error', () => {
    if (finished) return;
    finished = true;
    cleanupAll();
    writeJson(res, 400, { ok: false, error: '上传中断' });
  });

  bb.on('close', async () => {
    if (finished) return;
    await Promise.all(jobs.map((j) => j.done)); // 等所有文件真正写完盘
    if (finished) return;
    finished = true;
    const failed = jobs.filter((j) => j.failed);
    if (badMsg || failed.length || !jobs.length) {
      jobs.forEach(removeTmp);
      const tooBig = failed.some((j) => j.tooBig);
      const msg = badMsg || (failed[0] && failed[0].reason) || '未收到文件';
      writeJson(res, tooBig ? 413 : (badMsg || !jobs.length ? 400 : 500), { ok: false, error: msg });
      return;
    }
    const saved = [];
    try {
      for (const j of jobs) {
        const dest = j.finalPath || path.join(UPLOAD_DIR, uniqueDestName(j.origName));
        fs.renameSync(j.tmpPath, dest);
        saved.push(path.basename(dest));
      }
    } catch (e) {
      jobs.forEach((j) => safeUnlink(j.tmpPath));
      writeJson(res, 500, { ok: false, error: '保存文件失败: ' + (e.code || e.message) });
      return;
    }
    writeJson(res, 200, { ok: true, uploaded: saved.length, files: saved });
  });

  // 客户端中途断开：删除半截文件
  res.on('close', () => {
    if (res.writableFinished) return;
    finished = true;
    try { req.unpipe(bb); } catch (e) {}
    cleanupAll();
  });

  req.pipe(bb);
}

function handleMerge(req, res) {
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 64 * 1024) { writeJson(res, 413, { ok: false, error: 'params too large' }); req.destroy(); } });
  req.on('end', () => {
    if (res.writableEnded) return;
    const params = new URLSearchParams(body);
    const fileId = sanitizeId(params.get('fileId'));
    const total = parseInt(params.get('totalChunks'), 10);
    const origName = safeName(params.get('filename') || 'merged.bin');
    if (!fileId || !Number.isInteger(total) || total < 2 || total > MAX_CHUNKS) {
      writeJson(res, 400, { ok: false, error: 'invalid merge params' });
      return;
    }
    if (merging.has(fileId)) {
      writeJson(res, 409, { ok: false, error: '该文件正在合并中，请稍候' });
      return;
    }
    const partDir = path.join(PARTS_DIR, fileId);
    const chunks = listChunks(partDir);
    const missing = [];
    for (let i = 0; i < total; i++) if (!(i in chunks)) missing.push(i);
    const extra = Object.keys(chunks).map(Number).filter((i) => i >= total);
    if (missing.length || extra.length) {
      const have = Object.keys(chunks).length;
      writeJson(res, 400, {
        ok: false,
        error: extra.length ? ('分片数量不匹配（服务器上有 ' + have + ' 片，期望 ' + total + ' 片），请重新上传')
          : have ? ('分片不完整 (' + (total - missing.length) + '/' + total + ')，请重新选择同一文件继续上传') : '分片不存在，请重新上传',
        missing: missing.slice(0, 50)
      });
      return;
    }
    let expected = 0;
    for (let i = 0; i < total; i++) expected += chunks[i];
    if (expected > MAX_FILE_SIZE) {
      writeJson(res, 413, { ok: false, error: '文件超过大小上限' });
      return;
    }

    merging.add(fileId);
    const tmpPath = path.join(PARTS_DIR, 'merge' + tmpSuffix());
    const ws = fs.createWriteStream(tmpPath);
    let failed = false;
    const fail = (msg) => {
      if (failed) return;
      failed = true;
      ws.destroy();
      ws.once('close', () => safeUnlink(tmpPath));
      safeUnlink(tmpPath);
      merging.delete(fileId);
      writeJson(res, 500, { ok: false, error: msg }); // 分片保留，可重试合并
    };
    const appendNext = (i) => {
      if (failed) return;
      if (i >= total) { ws.end(); return; }
      const rs = fs.createReadStream(path.join(partDir, chunkName(i)));
      rs.on('error', (err) => { rs.unpipe(ws); fail('读取分片 ' + (i + 1) + ' 失败: ' + (err.code || err.message)); });
      rs.on('end', () => appendNext(i + 1));
      rs.pipe(ws, { end: false });
    };
    ws.on('error', (err) => fail('合并写入失败: ' + (err.code || err.message)));
    ws.on('finish', () => {
      if (failed) return;
      try {
        const size = fs.statSync(tmpPath).size;
        if (size !== expected) throw new Error('合并后大小不一致 (' + size + '/' + expected + ')');
        const destName = uniqueDestName(origName);
        fs.renameSync(tmpPath, path.join(UPLOAD_DIR, destName));
        fs.rmSync(partDir, { recursive: true, force: true }); // 合并成功后才删除分片
        merging.delete(fileId);
        writeJson(res, 200, { ok: true, name: destName, size });
      } catch (e) {
        fail(e.message);
      }
    });
    appendNext(0);
  });
}

// 分段下载文件（支持 HTTP Range，支持断点续传）
function handleDownload(req, res, url) {
  const name = safeName(url.searchParams.get('name') || '');
  if (!name) { writeJson(res, 400, { ok: false, error: '缺少文件名' }); return; }
  const filePath = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    writeJson(res, 404, { ok: false, error: '文件不存在' }); return;
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch (e) { writeJson(res, 500, { ok: false, error: '读取文件失败' }); return; }
  const total = stat.size;
  const range = req.headers.range;
  const encodedName = encodeURIComponent(name);
  const baseHeaders = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="' + encodedName + '"; filename*=UTF-8\'\'' + encodedName,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return; }
    let start = m[1] === '' ? null : parseInt(m[1], 10);
    let end = m[2] === '' ? null : parseInt(m[2], 10);
    if (start === null && end === null) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return; }
    if (start === null) { start = Math.max(0, total - end); end = total - 1; }
    if (end === null || end >= total) end = total - 1;
    if (start > end || start >= total) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return; }
    const length = end - start + 1;
    res.writeHead(206, Object.assign(baseHeaders, {
      'Content-Length': length,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
    }));
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => { try { res.destroy(); } catch (e) {} });
    stream.pipe(res);
  } else {
    res.writeHead(200, Object.assign(baseHeaders, { 'Content-Length': total }));
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { try { res.destroy(); } catch (e) {} });
    stream.pipe(res);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // 首页（页面本身不含任何数据，密钥在页面内校验）
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  // 校验访问密钥（唯一无需密钥的接口）
  if (req.method === 'GET' && url.pathname === '/auth') {
    writeJson(res, 200, { ok: checkKey(req, url), keyRequired: !!UPLOAD_KEY });
    return;
  }

  // 其余接口一律需要密钥
  if (!checkKey(req, url)) {
    req.resume();
    writeJson(res, 401, { ok: false, error: '访问密钥无效' });
    return;
  }

  // 查询已上传的分片
  if (req.method === 'GET' && url.pathname === '/check') {
    const fileId = sanitizeId(url.searchParams.get('fileId'));
    if (!fileId) { writeJson(res, 400, { ok: false, error: 'invalid fileId' }); return; }
    const chunks = listChunks(path.join(PARTS_DIR, fileId));
    writeJson(res, 200, { ok: true, doneChunks: Object.keys(chunks).map(Number).sort((a, b) => a - b), chunks });
    return;
  }

  // 文件列表
  if (req.method === 'GET' && url.pathname === '/files') {
    writeJson(res, 200, listFiles());
    return;
  }

  // 分段下载文件（支持 Range / 断点续传）
  if (req.method === 'GET' && url.pathname === '/download') {
    handleDownload(req, res, url);
    return;
  }

  // 合并分片
  if (req.method === 'POST' && url.pathname === '/merge') {
    handleMerge(req, res);
    return;
  }

  // 上传（普通文件或分片）
  if (req.method === 'POST' && url.pathname === '/upload') {
    handleUpload(req, res);
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Not Found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('upload server listening on http://0.0.0.0:' + PORT);
  console.log('save dir: ' + UPLOAD_DIR);
  console.log('access key: ' + (UPLOAD_KEY ? '已启用' : '未设置（任何人都可上传）'));
});
