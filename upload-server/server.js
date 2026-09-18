const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');

const PORT = process.env.PORT || 8765;
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const PARTS_DIR = path.join(UPLOAD_DIR, '.parts');
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 单文件上限 2GB

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(PARTS_DIR)) fs.mkdirSync(PARTS_DIR, { recursive: true });

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || 'unnamed';
}

function listFiles() {
  return fs.readdirSync(UPLOAD_DIR).filter((name) => {
    try { return fs.statSync(path.join(UPLOAD_DIR, name)).isFile(); } catch (e) { return false; }
  }).map((name) => {
    const st = fs.statSync(path.join(UPLOAD_DIR, name));
    return { name, size: st.size, mtime: st.mtime.toISOString() };
  }).sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function writeJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
  #toast { position:fixed; top:18px; left:50%; transform:translateX(-50%); background:#0f9d58; color:#fff; padding:10px 20px;
           border-radius:10px; font-size:14px; display:none; z-index:99; box-shadow:0 6px 20px rgba(0,0,0,.3); }
  #toast.err { background:#e53935; }
  .tip { text-align:center; color:#5a6287; font-size:12px; margin-top:18px; }
</style>
</head>
<body>
<div class="card">
  <h1>📤 远程传送</h1>
  <div class="sub">上传文件，直接送达云端工作空间（大文件自动分片）</div>
  <div class="drop" id="drop">
    <div class="icon">⬆️</div>
    <p>把文件拖到这里，或点击选择</p>
    <button class="btn" id="pickBtn">选择文件</button>
    <input type="file" id="fileInput" multiple>
  </div>
  <div id="taskList"></div>
  <div id="listTitle">已上传文件</div>
  <ul id="fileList"></ul>
  <div class="tip">超过 95MB 的文件将自动分片上传并自动合并，无需手动操作</div>
</div>
<div id="toast"></div>
<script>
  const CHUNK_LIMIT = 95 * 1024 * 1024; // 单片上限 95MB（隧道限制约100MB，留余量）
  const drop = document.getElementById('drop');
  const input = document.getElementById('fileInput');
  const pickBtn = document.getElementById('pickBtn');
  const taskList = document.getElementById('taskList');
  const fileList = document.getElementById('fileList');
  const toast = document.getElementById('toast');

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

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
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
        if (xhr.status === 413) msg = '文件过大，超过通道限制';
        else if (xhr.status === 502 || xhr.status === 504) msg = '网关超时：通道限速，建议稍后重试';
        else if (r && r.error) msg = r.error;
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
    const fileId = uuid();
    const total = Math.ceil(file.size / CHUNK_LIMIT);
    const CONCURRENCY = 3; // 同时传输的路数
    const activeLoaded = {};
    let doneBytes = 0;      // 已完成的字节数
    let nextIdx = 0;
    let lastDone = 0, lastTime = 0, speed = 0;

    function updateProgress() {
      let activeSum = 0;
      for (const k in activeLoaded) activeSum += activeLoaded[k];
      const done = doneBytes + activeSum;
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
        const end = Math.min(file.size, start + CHUNK_LIMIT);
        const blob = file.slice(start, end);
        const fd = new FormData();
        fd.append('chunkIndex', i);
        fd.append('totalChunks', total);
        fd.append('fileId', fileId);
        fd.append('file', blob, file.name);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/upload');
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          activeLoaded[i] = e.loaded;
          updateProgress();
        };
        xhr.onload = () => {
          let r = null;
          try { r = JSON.parse(xhr.responseText); } catch (e) { r = null; }
          if (r && r.ok) {
            doneBytes += blob.size;
            delete activeLoaded[i];
            updateProgress();
            resolve();
          } else {
            let msg = (r && r.error) ? r.error : ('HTTP ' + (xhr.status || '?'));
            reject(new Error('分片 ' + (i + 1) + ' 失败: ' + msg));
          }
        };
        xhr.onerror = () => reject(new Error('分片 ' + (i + 1) + ' 网络错误'));
        xhr.send(fd);
      });
    }

    (async () => {
      chunkTag.textContent = '并发 ' + Math.min(CONCURRENCY, total) + ' 路分片传输中';
      const workers = [];
      const run = async () => {
        while (true) {
          const i = nextIdx++;
          if (i >= total) return;
          await uploadOne(i);
        }
      };
      const n = Math.min(CONCURRENCY, total);
      for (let k = 0; k < n; k++) workers.push(run());
      await Promise.all(workers);

      // 所有分片完成，请求服务端合并
      chunkTag.textContent = '';
      info.textContent = '分片全部上传完成，正在合并...';
      const mres = await fetch('/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'fileId=' + encodeURIComponent(fileId) + '&totalChunks=' + total + '&filename=' + encodeURIComponent(file.name)
      });
      let mr = null;
      try { mr = await mres.json(); } catch (e) { mr = null; }
      if (mr && mr.ok) {
        task.classList.add('done'); pct.textContent = '✅ 完成'; info.textContent = '已合并上传 ' + fmtSize(file.size) + '（' + total + ' 片并发）'; showToast('✅ ' + file.name + ' 上传成功'); refresh();
      } else {
        throw new Error('合并失败: ' + ((mr && mr.error) || '未知错误'));
      }
    })().catch((err) => {
      task.classList.add('err'); pct.textContent = '❌ 失败'; info.textContent = err.message || '上传失败';
      showToast('上传失败: ' + (err.message || ''), true);
    });
  }

  function refresh() {
    fetch('/files').then(r => r.json()).then(list => {
      fileList.innerHTML = '';
      if (!list.length) { fileList.innerHTML = '<li style="color:#5a6287">暂无文件</li>'; return; }
      list.forEach(f => {
        const li = document.createElement('li');
        li.innerHTML = '<span>📄 ' + escapeHtml(f.name) + '</span><span class="meta">' + fmtSize(f.size) + '</span>';
        fileList.appendChild(li);
      });
    }).catch(() => {});
  }
  refresh();
  setInterval(refresh, 8000);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // 首页
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 文件列表
  if (req.method === 'GET' && url.pathname === '/files') {
    writeJson(res, 200, listFiles());
    return;
  }

  // 合并分片
  if (req.method === 'POST' && url.pathname === '/merge') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let params;
      try { params = new URLSearchParams(body); } catch (e) { writeJson(res, 400, { ok: false, error: 'bad params' }); return; }
      const fileId = String(params.get('fileId') || '').replace(/[^a-zA-Z0-9-]/g, '');
      const totalChunks = parseInt(params.get('totalChunks'), 10);
      const origName = safeName(params.get('filename') || 'merged.bin');
      if (!fileId || !Number.isInteger(totalChunks) || totalChunks < 2) {
        writeJson(res, 400, { ok: false, error: 'invalid merge params' });
        return;
      }
      const partDir = path.join(PARTS_DIR, fileId);
      let chunks;
      try {
        chunks = fs.readdirSync(partDir).filter((n) => n.startsWith('chunk_')).sort();
      } catch (e) {
        writeJson(res, 400, { ok: false, error: '分片不存在，请重新上传' });
        return;
      }
      if (chunks.length !== totalChunks) {
        writeJson(res, 400, { ok: false, error: '分片不完整 (' + chunks.length + '/' + totalChunks + ')，请重新上传' });
        return;
      }
      const destName = Date.now() + '_' + origName;
      const destPath = path.join(UPLOAD_DIR, destName);
      const ws = fs.createWriteStream(destPath);
      const appendNext = (i) => {
        if (i >= chunks.length) { ws.end(); return; }
        const rs = fs.createReadStream(path.join(partDir, chunks[i]));
        rs.pipe(ws, { end: false });
        rs.on('error', () => { try { ws.destroy(); } catch (e) {} });
        rs.on('end', () => appendNext(i + 1));
      };
      ws.on('finish', () => {
        fs.rmSync(partDir, { recursive: true, force: true });
        writeJson(res, 200, { ok: true, name: destName, size: fs.statSync(destPath).size });
      });
      ws.on('error', (err) => {
        try { fs.unlinkSync(destPath); } catch (e) {}
        writeJson(res, 500, { ok: false, error: '合并写入失败' });
      });
      appendNext(0);
    });
    return;
  }

  // 上传（普通文件或分片）
  if (req.method === 'POST' && url.pathname === '/upload') {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE, files: 20 } });
    } catch (e) {
      writeJson(res, 400, { ok: false, error: 'bad request' });
      return;
    }
    const fields = {};
    let uploaded = 0;
    let tooBig = false;
    let errorMsg = '';

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('file', (fieldname, file, info) => {
      const fileId = String(fields.fileId || '').replace(/[^a-zA-Z0-9-]/g, '');
      const chunkIndex = parseInt(fields.chunkIndex, 10);
      const totalChunks = parseInt(fields.totalChunks, 10);
      const isChunk = !!(fileId && Number.isInteger(chunkIndex) && Number.isInteger(totalChunks) && totalChunks > 1);

      let ws;
      if (isChunk) {
        const partDir = path.join(PARTS_DIR, fileId);
        fs.mkdirSync(partDir, { recursive: true });
        const chunkName = 'chunk_' + String(chunkIndex).padStart(6, '0');
        ws = fs.createWriteStream(path.join(partDir, chunkName));
      } else {
        const origName = safeName(info.filename);
        const destName = Date.now() + '_' + origName;
        ws = fs.createWriteStream(path.join(UPLOAD_DIR, destName));
      }
      file.pipe(ws);
      file.on('limit', () => {
        tooBig = true;
        ws.destroy();
        try { ws.close(); } catch (e) {}
      });
      file.on('end', () => { uploaded++; });
      ws.on('error', () => {});
    });

    bb.on('error', (err) => {
      if (!res.writableEnded) {
        errorMsg = tooBig ? '文件超过大小上限' : '上传中断';
        writeJson(res, 400, { ok: false, error: errorMsg });
      }
    });

    bb.on('close', () => {
      if (res.writableEnded) return;
      writeJson(res, 200, { ok: true, uploaded, error: tooBig ? '部分文件超过大小限制被跳过' : undefined });
    });
    req.pipe(bb);
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Not Found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('upload server listening on http://0.0.0.0:' + PORT);
  console.log('save dir: ' + UPLOAD_DIR);
});
