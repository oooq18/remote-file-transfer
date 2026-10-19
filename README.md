# 📤 远程文件传送站

一个极简的远程文件传送网页：在任何设备（手机/电脑）打开网页，拖拽或点击选择文件，文件就会**直接保存到服务器的工作目录**里，方便你远程把文件传给服务器（云电脑）。

## ✨ 功能

- 网页端上传文件，支持多文件、拖拽上传
- 上传过程显示实时进度条
- 上传成功后展示已上传文件列表（文件名、大小、时间）
- 文件持久化保存到服务器磁盘，可直接被服务器端程序读取处理
- 适配手机端，界面极简
- 超过 15MB 的文件自动分片上传、服务端自动合并，支持**断点续传**（重新选择同一文件即可从断点继续）
- 单片失败自动重试（最多尝试 10 次）
- **访问密钥保护**：没有密钥的人无法上传或查看文件列表

## 📁 目录结构

```
remote-file-transfer/
├── upload-server/          # 上传服务
│   ├── server.js           # 服务端代码（Node.js 原生 HTTP + busboy）
│   ├── package.json
│   └── package-lock.json
├── start.sh                # 一键启动脚本（含隧道、自动生成访问密钥）
├── stop.sh                 # 停止脚本
└── README.md               # 本教程
```

## 🔧 环境要求

- **Node.js 18+**（推荐 20+）
- 能访问外网（用于下载 cloudflared 隧道工具和建立公网连接）

## 🚀 快速开始

### 1. 下载项目

```bash
git clone https://github.com/oooq18/remote-file-transfer.git
cd remote-file-transfer
```

### 2. 一键启动

```bash
chmod +x start.sh
./start.sh
```

脚本会自动完成这几步：
1. 生成访问密钥（首次自动生成并保存到 `.upload_key`，之后重启保持不变；该文件已被 git 忽略）
2. 安装依赖（首次自动 `npm install`）
3. 启动本地上传服务（监听 `8765` 端口）
4. 下载并启动 Cloudflare 隧道，生成一个公网地址

启动成功后，终端会显示类似这样的公网地址（**已带上访问密钥**）：

```
✅ 远程传送站已上线！
访问地址: https://xxx-xxx.trycloudflare.com/?key=xxxxxxxxxxxxxxxx
```

> ⚠️ 带 `?key=` 的完整地址就是"钥匙"，只发给需要上传文件的人。打开一次后浏览器会记住密钥；如果直接打开不带密钥的地址，页面会提示输入密钥。

#### 启动参数（环境变量，均可选）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8765` | 本地服务端口 |
| `UPLOAD_KEY` | 自动生成 | 指定访问密钥；不设置则读取/生成 `.upload_key` |
| `MAX_FILE_MB` | `2048` | 单文件大小上限（MB） |
| `CF_PROTOCOL` | `http2` | 隧道协议，`http2`（走 TCP，兼容性最好）/ `quic` / `auto` |
| `CF_EDGE` | `auto` | 手动指定 Cloudflare 边缘节点（空格分隔的 `IP:7844`）。`auto` 时若检测到 DNS 被代理改写成假 IP（`198.18.x.x`），会自动改用边缘节点直连 IP |

例如：`UPLOAD_KEY=我的密钥 PORT=9000 ./start.sh`

### 3. 开始上传

- 在**任意设备**（手机/电脑）的浏览器打开上面的公网地址
- 把文件拖进页面，或点击「选择文件」
- 等待进度条走完，出现「上传成功」提示即可

### 4. 查看收到的文件

文件保存在项目的 `uploads/` 目录下（自动创建）：

```bash
ls -la uploads/
```

每个文件会以「时间戳_原文件名」命名，不会覆盖同名文件。

## 🛑 停止服务

```bash
./stop.sh
```

## ⚙️ 手动启动（不用脚本）

```bash
# 1. 安装依赖
cd upload-server && npm install

# 2. 启动上传服务（设置访问密钥）
UPLOAD_KEY=换成你的密钥 node server.js &
# 上传服务运行在 http://localhost:8765/?key=换成你的密钥

# 3. 启动公网隧道（单独终端）
cloudflared tunnel --protocol http2 --url http://localhost:8765
# 日志里会出现 https://xxx.trycloudflare.com 公网地址，访问时在后面加上 /?key=你的密钥
```

## ❓ 常见问题

**Q：公网地址会变吗？**
A：会。每次重启隧道都会生成一个新的 trycloudflare.com 地址（临时隧道）。想要固定域名，可在 Cloudflare 控制台配置命名隧道（named tunnel）。

**Q：单文件大小有限制吗？**
A：有，默认单文件上限 2GB，单次最多 20 个文件。可用环境变量 `MAX_FILE_MB` 修改（例如 `MAX_FILE_MB=4096 ./start.sh`）。超过上限的文件会被拒绝并删除，不会留下半截文件。

**Q：忘记密钥 / 想换密钥怎么办？**
A：密钥保存在项目根目录的 `.upload_key` 文件里，`cat .upload_key` 即可查看。想换新密钥就删掉这个文件再运行 `./start.sh`。不设密钥（不推荐）：直接 `node server.js` 启动且不设置 `UPLOAD_KEY`。

**Q：大文件传到一半断了怎么办？**
A：重新打开页面、选择同一个文件即可，已上传的分片会自动跳过，从断点继续。

**Q：隧道一直连不上（日志里有 `7844: i/o timeout` 或 QUIC 失败）？**
A：脚本默认已使用 `--protocol http2`。如果所在网络的代理把域名解析成了假 IP（`198.18.x.x`），脚本会自动改用边缘节点 IP 直连；也可以手动指定：`CF_EDGE="198.41.192.7:7844 198.41.200.13:7844" ./start.sh`。

**Q：上传的文件会保存多久？**
A：会一直保存在 `uploads/` 目录，直到手动删除。

**Q：端口被占用怎么办？**
A：设置环境变量换端口：`PORT=9000 ./start.sh`（脚本会自动同步隧道端口）。

## 📝 技术说明

- 后端：Node.js 原生 HTTP 模块 + `busboy`（multipart 解析）
- 前端：原生 HTML/CSS/JS 单页，无框架
- 公网通道：Cloudflare Quick Tunnel（trycloudflare，默认 HTTP/2 协议）
- 安全：访问密钥（请求头 `X-Upload-Key` 或参数 `?key=`），除首页和 `/auth` 外所有接口都需要密钥
- 存储：文件直接落盘到服务器 `uploads/` 目录
