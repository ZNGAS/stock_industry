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
const { execFileSync } = require('child_process');

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

const log = (m) => console.log(`  ${m}`);
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

(async () => {
  if (process.platform === 'win32') { try { execFileSync('chcp', ['65001'], { stdio: 'ignore', shell: true }); } catch { /* 維持預設編碼 */ } }
  process.stdout.write(`\x1b]0;${NAME}\x07`);
  console.log(`\n  ${NAME}\n`);
  fs.mkdirSync(DATA, { recursive: true });
  await update();
  if (!fs.existsSync(path.join(APP, 'server.js'))) {
    log('找不到程式檔(app 資料夾是空的)。請連上網路後重新開啟,或重新下載完整的資料夾。');
    await pause(15000); process.exit(1);
  }
  ensureShortcut();
  log('啟動中…\n');
  process.env.STOCK_DATA_DIR = DATA;
  const mod = require(path.join(APP, 'server.js'));
  if (!process.pkg && mod.startServer) {
    // 開發測試(node launcher.js):server.js 不會自己啟動
    mod.startServer({ port: Number(process.env.PORT) || 3000 }).then(({ port }) => console.log(`\n  已啟動 → http://localhost:${port}\n`));
  }
})().catch(async (e) => { console.error(`\n  發生錯誤:${e.stack || e.message}`); await pause(20000); process.exit(1); });

process.on('uncaughtException', async (e) => { console.error(`\n  發生錯誤:${e.stack || e.message}`); await pause(20000); process.exit(1); });
