@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   台股產業分析 - 修復更新
echo   會從 GitHub 重新下載最新版,覆蓋這個資料夾裡的程式檔(包含 stock-industry.exe)。
echo   你的自選股與設定放在 data 資料夾,不會被動到。
echo.
taskkill /f /im stock-industry.exe >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((Get-Content -LiteralPath '%~f0' -Raw -Encoding UTF8) -split ('#P'+'S#'))[1]"
if errorlevel 1 (
  echo.
  echo   修復失敗。請確認網路連線,或到 https://github.com/ZNGAS/stock_industry 按 Code - Download ZIP 重新下載。
) else (
  echo.
  echo   修復完成,現在可以雙擊 stock-industry.exe 開啟。
)
echo.
pause
exit /b
#PS#
$ErrorActionPreference = 'Stop'
try {
  $dest = (Get-Location).Path
  $tmp = Join-Path $env:TEMP ('si-repair-' + [guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Write-Host '  下載中…'
  Invoke-WebRequest 'https://codeload.github.com/ZNGAS/stock_industry/zip/main' -OutFile "$tmp\z.zip" -UseBasicParsing
  Expand-Archive "$tmp\z.zip" "$tmp\x" -Force
  $src = (Get-ChildItem "$tmp\x" -Directory | Select-Object -First 1).FullName
  if (-not (Test-Path "$src\server.js")) { throw '下載的檔案不完整' }
  & robocopy $src $dest /E /XD data /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw 'robocopy 失敗' }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
} catch { Write-Host ('  ' + $_.Exception.Message); exit 1 }
#PS#
