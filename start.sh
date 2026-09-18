#!/bin/bash
# 远程文件传送站 - 一键启动脚本
set -e
cd "$(dirname "$0")"

echo "================ 远程文件传送站 ================"

# 1. 安装依赖
cd upload-server
if [ ! -d node_modules ]; then
  echo "[1/3] 安装依赖中..."
  npm install --no-audit --no-fund
else
  echo "[1/3] 依赖已就绪"
fi

# 2. 启动上传服务
pkill -f "node server.js" 2>/dev/null || true
sleep 0.5
nohup node server.js > server.log 2>&1 &
echo "[2/3] 上传服务已启动 (http://localhost:8765)"

# 3. 准备 cloudflared 隧道工具
cd ..
TOOL_DIR=".tools"
mkdir -p "$TOOL_DIR"
if [ ! -f "$TOOL_DIR/cloudflared" ]; then
  echo "[3/3] 下载 cloudflared 隧道工具..."
  curl -sL -m 120 -o "$TOOL_DIR/cloudflared" \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$TOOL_DIR/cloudflared"
else
  echo "[3/3] 隧道工具已就绪"
fi

# 4. 启动公网隧道
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 0.5
nohup "$TOOL_DIR/cloudflared" tunnel --url http://localhost:8765 > cloudflared.log 2>&1 &

echo ""
echo "正在获取公网地址..."
URL=""
for i in $(seq 1 25); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' cloudflared.log | head -1)
  [ -n "$URL" ] && break
  sleep 1
done

echo ""
if [ -n "$URL" ]; then
  echo "============================================"
  echo "✅ 远程传送站已上线！"
  echo ""
  echo "   访问地址: $URL"
  echo ""
  echo "   用手机或电脑浏览器打开上面的地址即可上传文件"
  echo "   收到的文件保存在 ./uploads/ 目录"
  echo "============================================"
else
  echo "⚠️  尚未获取到公网地址，请稍后查看 cloudflared.log"
  echo "   也可以手动运行: ./.tools/cloudflared tunnel --url http://localhost:8765"
fi
