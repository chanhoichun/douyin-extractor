@echo off
chcp 65001 >nul
title 停止抖音视频提取服务
cd /d "%~dp0"
if not exist server.pid (
  echo 未发现运行中的服务。
  pause
  exit /b
)
set /p PID=<server.pid
taskkill /PID %PID% /F >nul 2>nul
del /q server.pid >nul 2>nul
echo 服务已停止。
timeout /t 2 /nobreak >nul
exit /b
