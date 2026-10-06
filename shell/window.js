'use strict';
/**
 * 用 Windows 內建的 WebView2 開「自己的視窗」(沒有網址列、分頁或 Edge 介面,標題列跟著畫面主題)。
 * 由啟動器載入(放在可更新的資料夾,改這裡不需要重新打包 exe)。
 * 條件不齊(不是 Windows、沒有 WebView2 執行環境、元件檔缺少)時回傳 null,啟動器會改用 Edge 應用程式模式。
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const FILES = ['webshell.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'];
const GUID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'; // WebView2 Runtime 的登錄位置

function hasRuntime() {
  for (const hive of ['HKLM\\SOFTWARE\\WOW6432Node', 'HKLM\\SOFTWARE', 'HKCU\\SOFTWARE']) {
    try {
      const out = execFileSync('reg', ['query', `${hive}\\Microsoft\\EdgeUpdate\\Clients\\${GUID}`, '/v', 'pv'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      const m = out.match(/pv\s+REG_SZ\s+([\d.]+)/);
      if (m && m[1] !== '0.0.0.0') return true;
    } catch { /* 這個位置沒有 */ }
  }
  return false;
}

/** 回傳視窗的子程序(帶 .profile 暫存資料夾路徑,結束時要清掉);不能用時回傳 null */
exports.open = function open(url, ctx) {
  if (process.platform !== 'win32') return null;
  if (FILES.some((f) => !fs.existsSync(path.join(__dirname, f)))) return null;
  if (!hasRuntime()) return null;
  const profile = path.join(ctx.tmpdir, `stock-industry-wv2-${process.pid}`);
  const child = spawn(path.join(__dirname, 'webshell.exe'), ['--url', url, '--title', ctx.title, '--icon', ctx.icon, '--data', profile], { stdio: 'ignore' });
  child.profile = profile;
  return child;
};
