@echo off
chcp 65001 >nul
title 抖音视频提取工具
cd /d "%~dp0"

rem 需要先安装 Node.js LTS，并确保 node 在 PATH 中
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js LTS：https://nodejs.org/
  pause
  exit /b 1
)

rem 检测服务是否已在运行（占用 3000 端口）
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if not errorlevel 1 goto open

rem 启动服务（最小化窗口）
start "抖音视频提取工具 - 本地服务" /min "%NODE%" "%~dp0server.js"
timeout /t 2 /nobreak >nul

:open
start "" "http://127.0.0.1:3000/index.html"
exit /b
