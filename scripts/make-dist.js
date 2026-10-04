'use strict';
/**
 * 組出可發佈的資料夾與壓縮檔:
 *   dist/stock-industry/
 *     stock-industry.exe   啟動器(內含 Node,不需要另外安裝)
 *     app/                 程式檔與版本標記(.version)
 *     data/                (空的)自選股清單與快取會存在這裡
 *     README.txt
 *   dist/stock-industry-win.zip
 *
 * 用法:npm run build:dist [-- --sha <commit>]   (預設用 origin/main 的 commit 當版本標記,
 * 這樣第一次開啟時不會重複下載;請先把要發佈的程式碼推上 GitHub)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const out = path.join(dist, 'stock-industry');
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
const sha = (() => {
  const i = process.argv.indexOf('--sha');
  if (i > 0) return process.argv[i + 1];
  try { return execSync('git rev-parse origin/main', { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; }
})();

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'app'), { recursive: true });
fs.mkdirSync(path.join(out, 'data'), { recursive: true });

console.log('打包啟動器…');
sh(`npx --yes @yao-pkg/pkg launcher/launcher.js --targets node20-win-x64 --output "${path.join(out, 'stock-industry.exe')}"`);

for (const it of ['server.js', 'public', 'assets', 'package.json', 'README.md']) fs.cpSync(path.join(root, it), path.join(out, 'app', it), { recursive: true });
if (sha) fs.writeFileSync(path.join(out, 'app', '.version'), sha);

fs.writeFileSync(path.join(out, 'README.txt'), `台股產業分析
============

使用方式
  1. 把整個資料夾放在任何地方(不要放在需要系統管理員權限的位置,例如 C:\\Program Files)。
  2. 雙擊 stock-industry.exe。第一次開啟會在桌面建立「台股產業分析」捷徑,之後從捷徑開啟即可。
  3. 每次開啟都會先到 GitHub 檢查有沒有新版,有的話自動下載並更新,再開啟網頁(http://localhost:3000)。
  4. 關閉黑色視窗就會停止。

資料夾內容
  stock-industry.exe   啟動器(內含執行環境,不需要另外安裝 Node.js)
  app\\                 程式檔,更新時會整個替換,請不要在裡面放自己的檔案
  data\\                你的自選股清單、設定與資料快取,更新不會動到這裡

注意
  - 沒有網路時會直接用目前的版本啟動。
  - 想略過檢查更新:在捷徑的目標後面加上 --no-update
  - 想重新建立桌面捷徑:在捷徑的目標後面加上 --shortcut,執行一次
  - Windows SmartScreen 可能顯示「Windows 已保護您的電腦」(執行檔沒有數位簽章):點「其他資訊」再點「仍要執行」。部分防毒軟體對打包的執行檔也可能誤報。
  - 啟動器本身(stock-industry.exe)不會自動更新;如果程式更新說明裡提到需要新的啟動器,請重新下載整個資料夾,並把舊的 data\\ 複製過去。

資料僅供參考,不構成投資建議。原始碼與說明:https://github.com/ZNGAS/stock_industry
`);

console.log('壓縮…');
const zip = path.join(dist, 'stock-industry-win.zip');
fs.rmSync(zip, { force: true });
const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); // Windows 內建(bsdtar),Git Bash 內的 GNU tar 不能壓 zip
if (fs.existsSync(bsdtar)) execSync(`"${bsdtar}" -a -c -f "${zip}" -C "${dist}" stock-industry`, { stdio: 'inherit' });
else execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${out}' -DestinationPath '${zip}' -Force"`, { stdio: 'inherit' });
console.log(`完成:${out}\n壓縮檔:${zip}(${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)\n版本標記:${sha || '(無)'}`);
