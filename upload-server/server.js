const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');

const PORT = process.env.PORT || 8765;
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 单文件上限 2GB

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function listFiles() {
  return fs.readdirSync(UPLOAD_DIR).map((name) => {
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
  #progressWrap { display:none; margin-top:16px; }
  .prog-row { display:flex; justify-content:space-between; font-size:12px; color:#aab2d8; margin-bottom:6px; }
  .bar { height:8px; background:#262c4d; border-radius:6px; overflow:hidden; }
  .bar > div { height:100%; width:0%; background:linear-gradient(90deg,#3d5afe,#00c6ff); border-radius:6px; transition:width .2s; }
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
  <div class="sub">上传文件，直接送达云端工作空间</div>
  <div class="drop" id="drop">
    <div class="icon">⬆️</div>
    <p>把文件拖到这里，或点击选择</p>
    <button class="btn" id="pickBtn">选择文件</button>
    <input type="file" id="fileInput" multiple>
  </div>
  <div id="progressWrap">
    <div class="prog-row"><span id="progName">上传中...</span><span id="progPct">0%</span></div>
    <div class="bar"><div id="progBar"></div></div>
  </div>
  <div id="listTitle">已上传文件</div>
  <ul id="fileList"></ul>
  <div class="tip">文件将保存在云端服务器的工作目录中</div>
</div>
<div id="toast"></div>
<script>
  const drop = document.getElementById('drop');
  const input = document.getElementById('fileInput');
  const pickBtn = document.getElementById('pickBtn');
  const progressWrap = document.getElementById('progressWrap');
  const progBar = document.getElementById('progBar');
  const progPct = document.getElementById('progPct');
  const progName = document.getElementById('progName');
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

  function upload(files) {
    if (!files || !files.length) return;
    [...files].forEach((file) => {
      const fd = new FormData();
      fd.append('file', file);
      const xhr = new XMLHttpRequest();
      progressWrap.style.display = 'block';
      xhr.open('POST', '/upload');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const p = Math.round(e.loaded / e.total * 100);
          progBar.style.width = p + '%';
          progPct.textContent = p + '%';
        }
      };
      xhr.onload = () => {
        progBar.style.width = '100%'; progPct.textContent = '100%';
        try {
          const r = JSON.parse(xhr.responseText);
          if (r.ok) { showToast('✅ ' + file.name + ' 上传成功'); refresh(); }
          else showToast('上传失败: ' + (r.error || '未知错误'), true);
        } catch(err) { showToast('上传失败', true); }
        setTimeout(() => { progressWrap.style.display = 'none'; progBar.style.width = '0%'; progPct.textContent = '0%'; }, 1200);
      };
      xhr.onerror = () => { showToast('网络错误，上传失败', true); };
      xhr.send(fd);
    });
  }

  function refresh() {
    fetch('/files').then(r => r.json()).then(list => {
      fileList.innerHTML = '';
      if (!list.length) { fileList.innerHTML = '<li style="color:#5a6287">暂无文件</li>'; return; }
      list.forEach(f => {
        const li = document.createElement('li');
        li.innerHTML = '<span>📄 ' + f.name + '</span><span class="meta">' + fmtSize(f.size) + '</span>';
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
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.method === 'GET' && url.pathname === '/files') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(listFiles()));
  } else if (req.method === 'POST' && url.pathname === '/upload') {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE, files: 20, fields: 0 } });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'bad request' }));
      return;
    }
    let uploaded = 0;
    let tooBig = false;
    bb.on('file', (fieldname, file, info) => {
      const origName = path.basename(info.filename || 'unnamed');
      const safeName = origName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || 'unnamed';
      const destName = Date.now() + '_' + safeName;
      const ws = fs.createWriteStream(path.join(UPLOAD_DIR, destName));
      file.pipe(ws);
      file.on('limit', () => { tooBig = true; ws.destroy(); fs.unlink(path.join(UPLOAD_DIR, destName), () => {}); });
      file.on('end', () => { uploaded++; });
      ws.on('error', () => {});
    });
    bb.on('filesLimit', () => {});
    bb.on('error', (err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: tooBig ? '文件超过 2GB 上限' : 'upload error' }));
    });
    bb.on('close', () => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, uploaded, error: tooBig ? '部分文件超过大小限制被跳过' : undefined }));
    });
    req.pipe(bb);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('upload server listening on http://0.0.0.0:' + PORT);
  console.log('save dir: ' + UPLOAD_DIR);
});
