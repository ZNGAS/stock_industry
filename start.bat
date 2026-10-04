@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 自選股盤後
where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node.js,請先安裝 18 版以上: https://nodejs.org
  pause
  exit /b 1
)
echo 啟動自選股盤後...(關閉這個視窗就會停止)
echo 網址: http://localhost:3000
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node server.js
pause
