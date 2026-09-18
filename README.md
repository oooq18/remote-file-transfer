# 📤 远程文件传送站

一个极简的远程文件传送网页：在任何设备（手机/电脑）打开网页，拖拽或点击选择文件，文件就会**直接保存到服务器的工作目录**里，方便你远程把文件传给服务器（云电脑）。

## ✨ 功能

- 网页端上传文件，支持多文件、拖拽上传
- 上传过程显示实时进度条
- 上传成功后展示已上传文件列表（文件名、大小、时间）
- 文件持久化保存到服务器磁盘，可直接被服务器端程序读取处理
- 适配手机端，界面极简

## 📁 目录结构

```
remote-file-transfer/
├── upload-server/          # 上传服务
│   ├── server.js           # 服务端代码（Node.js 原生 HTTP + busboy）
│   ├── package.json
│   └── package-lock.json
├── start.sh                # 一键启动脚本（含隧道）
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

脚本会自动完成三步：
1. 安装依赖（首次自动 `npm install`）
2. 启动本地上传服务（监听 `8765` 端口）
3. 下载并启动 Cloudflare 隧道，生成一个公网地址

启动成功后，终端会显示类似这样的公网地址：

```
✅ 远程传送站已上线！
访问地址: https://xxx-xxx.trycloudflare.com
```

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

# 2. 启动上传服务
node server.js &
# 上传服务运行在 http://localhost:8765

# 3. 启动公网隧道（单独终端）
cloudflared tunnel --url http://localhost:8765
# 日志里会出现 https://xxx.trycloudflare.com 公网地址
```

## ❓ 常见问题

**Q：公网地址会变吗？**
A：会。每次重启隧道都会生成一个新的 trycloudflare.com 地址（临时隧道）。想要固定域名，可在 Cloudflare 控制台配置命名隧道（named tunnel）。

**Q：单文件大小有限制吗？**
A：有，默认单文件上限 2GB，单次最多 20 个文件。可在 `upload-server/server.js` 中修改 `MAX_FILE_SIZE`。

**Q：上传的文件会保存多久？**
A：会一直保存在 `uploads/` 目录，直到手动删除。

**Q：端口被占用怎么办？**
A：设置环境变量换端口：`PORT=9000 node server.js`，隧道命令同步改成 `--url http://localhost:9000`。

## 📝 技术说明

- 后端：Node.js 原生 HTTP 模块 + `busboy`（multipart 解析）
- 前端：原生 HTML/CSS/JS 单页，无框架
- 公网通道：Cloudflare Quick Tunnel（trycloudflare）
- 存储：文件直接落盘到服务器 `uploads/` 目录
