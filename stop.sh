#!/bin/bash
# 远程文件传送站 - 停止脚本
cd "$(dirname "$0")"

pkill -f "cloudflared tunnel" 2>/dev/null && echo "✅ 公网隧道已停止" || echo "ℹ️  隧道未在运行"
pkill -f "node server.js" 2>/dev/null && echo "✅ 上传服务已停止" || echo "ℹ️  上传服务未在运行"

echo "完成，服务已全部关闭。"
