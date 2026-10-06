'use strict';
/**
 * 編譯視窗外殼 shell/webshell.exe(用 Windows 內建的 csc.exe,不需要安裝 SDK):
 *   1. 沒有 WebView2 元件時,從 NuGet 下載官方的 Microsoft.Web.WebView2 套件並取出需要的 3 個 DLL 放進 shell/
 *   2. 編譯 shell/WebShell.cs → shell/webshell.exe
 * 用法:npm run build:shell   (改了 WebShell.cs 才需要;產出的檔案會一起提交,使用者不用編譯)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const VERSION = '1.0.4258.31';
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'shell');
const csc = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const need = [['lib/net462/Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.Core.dll'], ['lib/net462/Microsoft.Web.WebView2.WinForms.dll', 'Microsoft.Web.WebView2.WinForms.dll'], ['runtimes/win-x64/native/WebView2Loader.dll', 'WebView2Loader.dll'], ['LICENSE.txt', 'WEBVIEW2-LICENSE.txt'], ['NOTICE.txt', 'WEBVIEW2-NOTICE.txt']];

(async () => {
  if (!fs.existsSync(csc)) throw new Error(`找不到 ${csc}(需要 Windows 內建的 .NET Framework 4)`);
  if (need.some(([, f]) => !fs.existsSync(path.join(dir, f)))) {
    console.log(`下載 Microsoft.Web.WebView2 ${VERSION}…`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wv2-'));
    const r = await fetch(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${VERSION}/microsoft.web.webview2.${VERSION}.nupkg`);
    if (!r.ok) throw new Error(`下載失敗 HTTP ${r.status}`);
    const pkg = path.join(tmp, 'wv2.nupkg');
    fs.writeFileSync(pkg, Buffer.from(await r.arrayBuffer()));
    execFileSync(tar, ['-xf', pkg, '-C', tmp], { stdio: 'inherit' });
    for (const [from, to] of need) fs.copyFileSync(path.join(tmp, from), path.join(dir, to));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const out = path.join(dir, 'webshell.exe');
  const args = ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', `/out:${out}`,
    `/reference:${path.join(dir, 'Microsoft.Web.WebView2.Core.dll')}`, `/reference:${path.join(dir, 'Microsoft.Web.WebView2.WinForms.dll')}`,
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll'];
  const ico = path.join(root, 'assets', 'icon.ico');
  if (fs.existsSync(ico)) args.push(`/win32icon:${ico}`);
  args.push(path.join(dir, 'WebShell.cs'));
  console.log('編譯 WebShell.cs…');
  execFileSync(csc, args, { stdio: 'inherit' });
  console.log(`完成:${out}(${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
