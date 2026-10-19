#!/bin/bash
# 远程文件传送站 - 一键启动脚本
#
# 可选环境变量：
#   PORT          本地端口，默认 8765
#   UPLOAD_KEY    访问密钥；不设置则自动生成并保存到 .upload_key（重启不变）
#   CF_PROTOCOL   隧道协议：http2（默认，走 TCP，兼容性最好）/ quic / auto
#   CF_EDGE       手动指定 Cloudflare 边缘节点，空格分隔，如 "198.41.192.7:7844 198.41.200.13:7844"
#                 设为 auto（默认）时：若检测到 DNS 被代理改写成假 IP（198.18.x.x），自动改用直连 IP
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"
PORT="${PORT:-8765}"
CF_PROTOCOL="${CF_PROTOCOL:-http2}"
CF_EDGE="${CF_EDGE:-auto}"
KEY_FILE="$ROOT/.upload_key"

echo "================ 远程文件传送站 ================"

# 0. 访问密钥
if [ -z "$UPLOAD_KEY" ]; then
  if [ -s "$KEY_FILE" ]; then
    UPLOAD_KEY="$(tr -d ' \r\n' < "$KEY_FILE")"
  else
    UPLOAD_KEY="$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")"
    ( umask 077; echo "$UPLOAD_KEY" > "$KEY_FILE" )
    echo "[0/3] 已生成访问密钥并保存到 .upload_key"
  fi
fi
export UPLOAD_KEY PORT

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
for i in $(seq 1 20); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/auth" && break
  sleep 0.3
done
echo "[2/3] 上传服务已启动 (http://localhost:$PORT/?key=$UPLOAD_KEY)"

# 3. 准备 cloudflared 隧道工具
cd "$ROOT"
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
TUNNEL_ARGS=(tunnel --no-autoupdate --protocol "$CF_PROTOCOL")
if [ "$CF_EDGE" = "auto" ]; then
  EDGE_IP="$(getent hosts region1.v2.argotunnel.com 2>/dev/null | awk '{print $1; exit}')"
  if [[ "$EDGE_IP" == 198.18.* || "$EDGE_IP" == 198.19.* ]]; then
    echo "      检测到代理假 IP ($EDGE_IP)，改用 Cloudflare 边缘节点直连 IP"
    CF_EDGE="198.41.192.7:7844 198.41.192.27:7844 198.41.200.13:7844 198.41.200.33:7844"
  else
    CF_EDGE=""
  fi
fi
for e in $CF_EDGE; do TUNNEL_ARGS+=(--edge "$e"); done
TUNNEL_ARGS+=(--url "http://localhost:$PORT")

pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 0.5
: > cloudflared.log
nohup "$TOOL_DIR/cloudflared" "${TUNNEL_ARGS[@]}" > cloudflared.log 2>&1 &

echo ""
echo "正在获取公网地址..."
URL=""
for i in $(seq 1 40); do
  if grep -q "Registered tunnel connection" cloudflared.log; then
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' cloudflared.log | head -1)
    [ -n "$URL" ] && break
  fi
  sleep 1
done

echo ""
if [ -n "$URL" ]; then
  echo "$URL/?key=$UPLOAD_KEY" > .public_url
  echo "============================================"
  echo "✅ 远程传送站已上线！"
  echo ""
  echo "   访问地址: $URL/?key=$UPLOAD_KEY"
  echo ""
  echo "   用手机或电脑浏览器打开上面的地址即可上传文件"
  echo "   （地址里带有访问密钥，请勿公开分享）"
  echo "   收到的文件保存在 ./uploads/ 目录"
  echo "============================================"
else
  echo "⚠️  尚未连上 Cloudflare，请稍后查看 cloudflared.log"
  echo "   可尝试: CF_PROTOCOL=quic ./start.sh  或  CF_EDGE=\"IP:7844\" ./start.sh"
  echo "   本地访问: http://localhost:$PORT/?key=$UPLOAD_KEY"
fi
