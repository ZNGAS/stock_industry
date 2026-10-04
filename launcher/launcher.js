'use strict';
/**
 * 台股產業分析 啟動器
 *
 * 每次打開都會先到 GitHub 檢查有沒有新版,有就自動下載並替換程式檔,然後啟動本機網頁。
 *
 * 資料夾結構(發佈版):
 *   stock-industry.exe   這支啟動器
 *   app/                 程式檔(server.js、public/…),更新時整個替換
 *   data/                自選股清單與快取,更新不會動到
 *
 * 參數:--no-update 不檢查更新;--shortcut 重新建立桌面捷徑
 * 環境變數:SI_REPO 指定更新來源(預設 ZNGAS/stock_industry)、SI_BRANCH、NO_SHORTCUT=1、NO_OPEN=1、PORT
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync: execRaw, spawn } = require('child_process');
// 沒有主控台視窗,子程序也不要閃出黑色視窗
const execFileSync = (f, a, o = {}) => execRaw(f, a, { windowsHide: true, ...o });

const REPO = process.env.SI_REPO || 'ZNGAS/stock_industry';
const BRANCH = process.env.SI_BRANCH || 'main';
const NAME = '台股產業分析';
const UPDATE_ITEMS = ['server.js', 'public', 'assets', 'package.json', 'README.md'];

// 打包成 exe 時,資料夾就是 exe 所在位置;直接用 node 跑(開發測試)則用 dist/stock-industry
const ROOT = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, '..', 'dist', 'stock-industry');
const APP = path.join(ROOT, 'app');
const DATA = path.join(ROOT, 'data');
const STATE = path.join(DATA, 'launcher.json');
const args = process.argv.slice(2);

const LOG = path.join(DATA, 'launcher.log');
const status = { state: 'work', msg: '啟動中…', url: '' };
const log = (m) => {
  status.msg = String(m).replace(/^\(|\)$/g, '');
  try { console.log(`  ${m}`); } catch { /* 沒有主控台 */ }
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}
`); } catch { /* ignore */ }
};
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': 'stock-industry-launcher', ...(opts.headers || {}) } }); }
  finally { clearTimeout(timer); }
}

let TOKEN = null; // null=還沒找過,''=找不到
function findToken() {
  const env = process.env.SI_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env.trim();
  const file = readText(path.join(DATA, 'github-token.txt')).trim();
  if (file) return file;
  try { // 這台電腦上 git 已登入的憑證(不會跳出登入視窗)
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 6000, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    const line = out.split('\n').find((l) => l.startsWith('password='));
    return line ? line.slice(9).trim() : '';
  } catch { return ''; }
}
/** 讀 GitHub:公開倉庫直接讀;401/403/404 時(私人倉庫)改帶憑證重試 */
async function gh(url, opts = {}, ms = 10000) {
  const withAuth = () => ({ ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${TOKEN}` } });
  if (TOKEN) return fetchTimeout(url, withAuth(), ms);
  const r = await fetchTimeout(url, opts, ms);
  if ([401, 403, 404].includes(r.status)) {
    if (TOKEN === null) TOKEN = findToken();
    if (TOKEN) { log('(倉庫不是公開的,使用這台電腦上已登入的 GitHub 憑證)'); return fetchTimeout(url, withAuth(), ms); }
  }
  return r;
}

async function remoteSha() {
  try {
    const r = await gh(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { headers: { Accept: 'application/vnd.github.sha' } }, 8000);
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    return /^[0-9a-f]{40}$/.test(t) ? t : null;
  } catch { return null; }
}

function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); // Windows 10 以後內建
  if (fs.existsSync(bsdtar)) { try { execFileSync(bsdtar, ['-xf', zip, '-C', dest], { stdio: 'ignore', timeout: 120000 }); return; } catch { /* 改用 PowerShell */ } }
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath $env:SI_ZIP -DestinationPath $env:SI_DEST -Force`],
    { stdio: 'ignore', timeout: 180000, env: { ...process.env, SI_ZIP: zip, SI_DEST: dest } });
}

async function update() {
  if (args.includes('--no-update') || process.env.NO_UPDATE === '1') { log('略過檢查更新'); return; }
  const local = readText(path.join(APP, '.version')).trim();
  log('檢查更新…');
  const remote = await remoteSha();
  if (!remote) { log('無法檢查更新(沒有網路或 GitHub 暫時連不上),使用目前的版本'); return; }
  if (remote === local) { log(`已是最新版(${remote.slice(0, 7)})`); return; }
  log(`發現新版本 ${local ? local.slice(0, 7) : '(未知)'} → ${remote.slice(0, 7)},下載中…`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-industry-'));
  const next = `${APP}.new`, old = `${APP}.old`;
  try {
    // 私人倉庫要走 API 的 zipball(會轉址到帶臨時授權的下載網址);公開倉庫用 codeload
    const r = await gh(TOKEN ? `https://api.github.com/repos/${REPO}/zipball/${remote}` : `https://codeload.github.com/${REPO}/zip/${remote}`, {}, 120000);
    if (!r.ok) throw new Error(`下載失敗 HTTP ${r.status}`);
    const zip = path.join(tmp, 'src.zip');
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
    const out = path.join(tmp, 'x');
    extractZip(zip, out);
    const top = fs.readdirSync(out).map((n) => path.join(out, n)).find((p) => fs.statSync(p).isDirectory());
    if (!top || !fs.existsSync(path.join(top, 'server.js')) || !fs.existsSync(path.join(top, 'public', 'index.html'))) throw new Error('下載的檔案不完整');
    rmrf(next); fs.mkdirSync(next, { recursive: true });
    for (const it of UPDATE_ITEMS) if (fs.existsSync(path.join(top, it))) fs.cpSync(path.join(top, it), path.join(next, it), { recursive: true });
    fs.writeFileSync(path.join(next, '.version'), remote);
    // 替換:出錯就還原,不會留下半套程式
    rmrf(old);
    if (fs.existsSync(APP)) fs.renameSync(APP, old);
    try { fs.renameSync(next, APP); } catch (e) { if (fs.existsSync(old)) fs.renameSync(old, APP); throw e; }
    rmrf(old);
    log('更新完成');
  } catch (e) {
    rmrf(next);
    if (!fs.existsSync(APP) && fs.existsSync(old)) fs.renameSync(old, APP);
    log(`更新失敗,繼續使用目前的版本:${e.message}`);
  } finally { rmrf(tmp); }
}

function desktopDir() {
  if (process.env.SI_DESKTOP) return process.env.SI_DESKTOP;
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8', timeout: 15000 }).trim();
}
function makeShortcut() {
  const dir = desktopDir();
  const icon = path.join(APP, 'assets', 'icon.ico');
  const ps = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $env:SI_DIR ($env:SI_NAME + '.lnk'))); $s.TargetPath=$env:SI_EXE; $s.WorkingDirectory=$env:SI_ROOT; $s.Description=$env:SI_NAME; if (Test-Path $env:SI_ICON) { $s.IconLocation=$env:SI_ICON }; $s.Save()";
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: 'ignore', timeout: 20000,
    env: { ...process.env, SI_DIR: dir, SI_NAME: NAME, SI_EXE: process.execPath, SI_ROOT: ROOT, SI_ICON: icon },
  });
  return path.join(dir, `${NAME}.lnk`);
}
function ensureShortcut() {
  if (process.platform !== 'win32' || process.env.NO_SHORTCUT === '1' || (!process.pkg && !process.env.SI_DESKTOP)) return;
  let st = {}; try { st = JSON.parse(readText(STATE) || '{}'); } catch { /* ignore */ }
  if (st.shortcut && !args.includes('--shortcut')) return;
  try {
    const f = makeShortcut();
    st.shortcut = true; fs.writeFileSync(STATE, JSON.stringify(st));
    log(`已在桌面建立捷徑:${path.basename(f)}`);
  } catch (e) { log(`建立桌面捷徑失敗(可忽略):${e.message.split('\n')[0]}`); }
}

// ---- 視窗:用系統內建的 Edge(或 Chrome)的「應用程式模式」開一個獨立視窗,沒有網址列與分頁 ----
function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\Program Files (x86)', la = process.env.LOCALAPPDATA || '';
  return [process.env.SI_BROWSER,
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    la && path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe')].find((x) => x && fs.existsSync(x));
}
function openWindow(url) {
  const exe = findBrowser();
  if (!exe) { try { execRaw('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } return null; }
  // 獨立的設定資料夾 → 這個視窗是獨立的程序,關掉視窗它才會結束
  const child = spawn(exe, [`--app=${url}`, `--user-data-dir=${path.join(DATA, 'window')}`, '--window-size=1440,920',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-features=Translate,msEdgeWelcomePage,msEdgeSignIn'], { stdio: 'ignore' });
  child.on('error', () => {});
  child.on('exit', () => process.exit(0));
  return child;
}

const SPLASH = `<!doctype html><meta charset="utf-8"><title>台股產業分析</title><style>
html,body{height:100%;margin:0;background:#0d1117;color:#e6edf3;font:15px "Microsoft JhengHei",system-ui,sans-serif}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
h1{font-size:22px;margin:0;font-weight:600}.sp{width:30px;height:30px;border:3px solid #2d3949;border-top-color:#ff5d5d;border-radius:50%;animation:r 0.9s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}#m{color:#8b98a9;max-width:80vw;text-align:center;line-height:1.6}.err .sp{display:none}.err #m{color:#ff7b72}</style>
<h1>台股產業分析</h1><div class="sp"></div><div id="m">啟動中…</div>
<script>setInterval(async()=>{try{const s=await(await fetch('/status')).json();document.getElementById('m').textContent=s.msg;
document.body.className=s.state==='error'?'err':'';if(s.url)location.replace(s.url)}catch{}},400)</script>`;
function startSplash() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(status)); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(SPLASH);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}
const fail = (m) => { status.state = 'error'; status.msg = m; try { fs.appendFileSync(LOG, `${new Date().toISOString()} ERROR ${m}\n`); } catch { /* ignore */ } };

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  try { fs.writeFileSync(LOG, ''); } catch { /* ignore */ }
  const splashPort = await startSplash();
  openWindow(`http://127.0.0.1:${splashPort}/`); // 先開視窗,檢查更新時使用者看得到進度
  await update();
  if (!fs.existsSync(path.join(APP, 'server.js'))) { fail('第一次使用需要連上網路下載程式檔。請連上網路後重新開啟。'); return; }
  ensureShortcut();
  log('啟動中…');
  process.env.STOCK_DATA_DIR = DATA;
  process.env.SI_EMBEDDED = '1'; // 由啟動器開視窗,server.js 不要自己開瀏覽器
  const mod = require(path.join(APP, 'server.js'));
  const { port } = await mod.startServer({ port: 0 });
  status.state = 'ready'; status.url = `http://127.0.0.1:${port}/`;
  log(`已啟動 ${status.url}`);
})().catch((e) => fail(`發生錯誤:${e.message}`));

process.on('uncaughtException', (e) => fail(`發生錯誤:${e.message}`));
