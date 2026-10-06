'use strict';
/* 台股產業分析 — 前端。資料全部由本機 server.js 提供(官方 OpenAPI + FinMind + Google News)。 */

/* ───────── 小工具 ───────── */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const fnum = (n, d = 2) => (isNum(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const fint = (n) => fnum(n, 0);
const fpct = (n, d = 2, sign = true) => (isNum(n) ? `${sign && n > 0 ? '+' : ''}${n.toFixed(d)}%` : '—');
const fsign = (n, d = 0) => (isNum(n) ? `${n > 0 ? '+' : ''}${fnum(n, d)}` : '—');
const dir = (n) => (!isNum(n) ? 'na' : n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const price = (n) => (isNum(n) ? fnum(n, n >= 1000 ? 0 : 2) : '—');
const yi = (v, d = 1) => (isNum(v) ? `${(v / 1e8).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}億` : '—');
const fmtLots = (v) => (v >= 10000 ? `${fnum(v / 10000, v >= 100000 ? 0 : 1)}萬` : fint(v));
const money = (v) => {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}兆`;
  if (a >= 1e8) return `${(v / 1e8).toLocaleString('en-US', { maximumFractionDigits: a >= 1e10 ? 0 : 1 })}億`;
  if (a >= 1e4) return `${Math.round(v / 1e4).toLocaleString('en-US')}萬`;
  return fint(v);
};
const WK = '日一二三四五六';
const dateLabel = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}(${WK[d.getDay()]})`;
};
const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分鐘前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小時前`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} 天前`;
  return iso.slice(0, 10);
};
const pxTag = (n, lim, d) => (lim ? `<span class="lim ${lim}" title="${lim === 'up' ? '漲停' : '跌停'}">${price(n)}</span>` : `<span class="${d}">${price(n)}</span>`);
const span = (n, text) => `<span class="${dir(n)}">${text}</span>`;
const pctSpan = (n, d = 2) => span(n, fpct(n, d));
const mktName = (m) => (m === 'TWSE' ? '上市' : m === 'ESB' ? '興櫃' : '上櫃');

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2800);
}

/* ───────── API(5 分鐘記憶體快取) ───────── */
const apiCache = new Map();
function api(url, { fresh = false } = {}) {
  const hit = apiCache.get(url);
  if (!fresh && hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.p;
  const p = fetch(url).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  });
  apiCache.set(url, { t: Date.now(), p });
  p.catch(() => apiCache.delete(url));
  return p;
}

/* ───────── 狀態 ───────── */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } syncPrefs(); },
};
// 自選股清單與偏好同時存在本機檔案(由伺服器保管),換瀏覽器、換網址或用桌面版都讀得到
const PREF_KEYS = [['watch', 'tw.watch.v1'], ['hm', 'tw.hm'], ['sc', 'tw.sc']];
let syncTimer;
function syncPrefs() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const body = {};
    for (const [k, lk] of PREF_KEYS) { try { const v = localStorage.getItem(lk); if (v) body[k] = JSON.parse(v); } catch { /* ignore */ } }
    try { const t = localStorage.getItem('tw.theme'); if (t) body.theme = t; } catch { /* ignore */ }
    fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  }, 400);
}
async function loadPrefs() {
  let srv;
  try { srv = await fetch('/api/prefs').then((r) => r.json()); } catch { return; }
  let push = false;
  for (const [k, lk] of PREF_KEYS) {
    if (srv[k] !== undefined) { try { localStorage.setItem(lk, JSON.stringify(srv[k])); } catch { /* ignore */ } }
    else if (localStorage.getItem(lk)) push = true;
  }
  if (srv.theme) { try { localStorage.setItem('tw.theme', srv.theme); } catch { /* ignore */ } document.documentElement.dataset.theme = srv.theme; }
  else if (localStorage.getItem('tw.theme')) push = true;
  S.watch = store.get('tw.watch.v1', []);
  S.hm = undefined; S.sc = undefined;
  if (push) syncPrefs();
}
const S = {
  watch: store.get('tw.watch.v1', []),
  rows: new Map(),
  meta: {},
  sort: { key: null, dir: -1 },
  renderId: 0,
};
const saveWatch = () => store.set('tw.watch.v1', S.watch);

async function loadRows(codes, fresh = false) {
  if (!codes.length) return;
  const j = await api(`/api/overview?codes=${codes.join(',')}`, { fresh });
  for (const r of j.rows) S.rows.set(r.code, r);
  S.meta = { quoteDate: j.quoteDate, instiDate: j.instiDate, otcInstiDate: j.otcInstiDate, marginDate: j.marginDate };
}

async function addCodes(codes) {
  const fresh = codes.filter((c) => !S.watch.includes(c));
  if (!fresh.length) return 0;
  S.watch.push(...fresh); saveWatch();
  try { await loadRows(fresh); } catch (e) { toast('載入資料失敗:' + e.message); }
  renderRail(); route();
  return fresh.length;
}
function removeCode(code) {
  S.watch = S.watch.filter((c) => c !== code); saveWatch();
  renderRail();
  if (S.route.code === code) location.hash = '#/'; else route();
}

/* ───────── 圖表引擎(無外部相依) ───────── */
function niceScale(min, max, n = 4) {
  if (min === max) { max = min + 1; min = min - 1; }
  const step0 = (max - min) / n, mag = 10 ** Math.floor(Math.log10(step0)), norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks };
}
const tipEl = () => $('#tip');
function showTip(html, x, y) {
  const t = tipEl(); t.innerHTML = html; t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  let left = x + 16; if (left + w > innerWidth - 8) left = x - w - 16;
  let top = Math.min(Math.max(8, y - h / 2), innerHeight - h - 8);
  t.style.left = `${Math.max(8, left)}px`; t.style.top = `${top}px`;
}
const hideTip = () => { tipEl().hidden = true; };
// 提示框只在方塊或圖表上才顯示;滑鼠快速移走、換頁、捲動、視窗失焦都要收起來
document.addEventListener('pointerover', (e) => { if (!(e.target.closest && e.target.closest('.tm-tile, .hit'))) hideTip(); });
document.addEventListener('pointerleave', hideTip);
window.addEventListener('scroll', hideTip, { passive: true });
window.addEventListener('blur', hideTip);
window.addEventListener('hashchange', hideTip);

/**
 * series: [{type:'bar'|'line'|'area'|'vbar', data, color:str|fn, axis:'l'|'r', name, fmt, width, dash, noTip}]
 */
function drawChart(host, cfg) {
  const { labels, series, height = 240, xFmt = (l) => l, fmtL = (v) => fnum(v, 0), fmtR = (v) => fnum(v, 0), tip, xTicks = 6, label = '' } = cfg;
  host.classList.add('chart'); // 圖表文字顏色、tooltip 定位都靠這個 class
  const W = Math.max(300, host.clientWidth || 600), H = height, n = labels.length;
  if (!n) { host.innerHTML = '<div class="note">沒有資料</div>'; return; }
  const hasR = series.some((s) => s.axis === 'r');
  const hasL = series.some((s) => (s.axis || 'l') === 'l' && s.type !== 'vbar');
  const m = { t: 10, r: hasR ? 54 : 12, b: cfg.noX ? 6 : 30, l: hasL || !hasR ? 58 : 12 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b, step = pw / n;
  const X = (i) => m.l + step * (i + 0.5);
  const vol = series.find((s) => s.type === 'vbar');
  const volH = vol ? ph * 0.2 : 0, phMain = ph - (vol ? volH + 8 : 0);
  const scaleFor = (axis) => {
    const vals = []; let zero = false;
    for (const s of series) {
      if ((s.axis || 'l') !== axis || s.type === 'vbar') continue;
      if (s.type === 'bar') zero = true;
      for (const v of s.data) if (isNum(v)) vals.push(v);
    }
    if (!vals.length) return null;
    let mn = Math.min(...vals), mx = Math.max(...vals);
    if (zero) { mn = Math.min(mn, 0); mx = Math.max(mx, 0); }
    else { const p = (mx - mn) * 0.06 || 1; mn -= p; mx += p; }
    const ns = niceScale(mn, mx, Math.max(2, Math.min(4, Math.floor(phMain / 42))));
    return { ...ns, y: (v) => m.t + phMain * (1 - (v - ns.lo) / (ns.hi - ns.lo)) };
  };
  const sc = { l: scaleFor('l'), r: scaleFor('r') };
  const grid = sc.l || sc.r;
  let g = '';
  if (grid) for (const t of grid.ticks) {
    const y = grid.y(t).toFixed(1);
    g += `<line class="${t === 0 ? 'zero-line' : 'grid-line'}" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/>`;
    if (sc.l) g += `<text x="${m.l - 8}" y="${+y + 4}" text-anchor="end">${esc(fmtL(t))}</text>`;
  }
  if (sc.r) for (const t of sc.r.ticks) g += `<text x="${W - m.r + 8}" y="${sc.r.y(t) + 4}">${esc(fmtR(t))}</text>`;
  const every = Math.max(1, Math.ceil(n / xTicks));
  for (let i = 0; i < n && !cfg.noX; i += every) g += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${esc(xFmt(labels[i], i))}</text>`;

  let body = '';
  const colorOf = (s, v, i) => (typeof s.color === 'function' ? s.color(v, i) : s.color);
  for (const s of series) {
    const sc1 = sc[s.axis || 'l'];
    if (s.type === 'vbar') {
      const mx = Math.max(...s.data.filter(isNum), 1), base = m.t + ph;
      s.data.forEach((v, i) => { if (!isNum(v)) return; const h = Math.max(1, (v / mx) * volH), bw = Math.min(Math.max(1, step * 0.7), 14); body += `<rect x="${X(i) - bw / 2}" y="${base - h}" width="${bw}" height="${h}" fill="${colorOf(s, v, i)}" opacity=".45"/>`; });
    } else if (s.type === 'bar' && sc1) {
      const y0 = sc1.y(Math.min(Math.max(0, sc1.lo), sc1.hi)), bw = Math.min(Math.max(2, step * 0.62), 30);
      s.data.forEach((v, i) => { if (!isNum(v)) return; const y1 = sc1.y(v); body += `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}" rx="2" fill="${colorOf(s, v, i)}" ${s.dim && s.dim(v, i) ? 'opacity=".55"' : ''}/>`; });
    } else if ((s.type === 'line' || s.type === 'area') && sc1) {
      let d = '', started = false, first = null, last = null;
      s.data.forEach((v, i) => { if (!isNum(v)) { started = false; return; } const x = X(i).toFixed(1), y = sc1.y(v).toFixed(1); d += `${started ? 'L' : 'M'}${x} ${y}`; started = true; if (first === null) first = x; last = x; });
      if (s.type === 'area' && first !== null) body += `<path d="${d}L${last} ${m.t + phMain}L${first} ${m.t + phMain}Z" fill="${s.color}" opacity=".12"/>`;
      body += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>`;
      if (n <= 36 && !s.noDots) s.data.forEach((v, i) => { if (isNum(v)) body += `<circle cx="${X(i).toFixed(1)}" cy="${sc1.y(v).toFixed(1)}" r="${i === n - 1 ? 3.6 : 2.4}" fill="var(--panel)" stroke="${s.color}" stroke-width="1.6"/>`; });
    }
  }
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" preserveAspectRatio="none" style="height:${H}px">${g}${body}<line class="guide" y1="${m.t}" y2="${m.t + ph}"/><rect class="hit" x="${m.l}" y="0" width="${pw}" height="${H}" fill="transparent"/></svg>`;
  const svg = $('svg', host), guide = $('.guide', svg), hit = $('.hit', svg);
  const idxAt = (clientX) => { const r = svg.getBoundingClientRect(); const x = ((clientX - r.left) / r.width) * W; return Math.min(n - 1, Math.max(0, Math.floor((x - m.l) / step))); };
  const move = (e) => {
    const i = idxAt(e.clientX);
    guide.setAttribute('x1', X(i)); guide.setAttribute('x2', X(i)); guide.style.opacity = 1;
    let html;
    if (tip) html = tip(i);
    else {
      html = `<b>${esc(xFmt(labels[i], i, true))}</b>`;
      for (const s of series) {
        if (s.noTip || !s.name) continue;
        const v = s.data[i], c = colorOf(s, v, i);
        html += `<div class="r"><span><i class="sw" style="background:${c}"></i>${esc(s.name)}</span><span>${isNum(v) ? esc((s.fmt || ((x) => fnum(x, 2)))(v)) : '—'}</span></div>`;
      }
    }
    showTip(html, e.clientX, e.clientY);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { guide.style.opacity = 0; hideTip(); });
}
function mountChart(host, cfg) {
  drawChart(host, cfg);
  if (window.ResizeObserver) {
    let w = host.clientWidth;
    const ro = new ResizeObserver(() => { if (!host.isConnected) { ro.disconnect(); return; } if (Math.abs(host.clientWidth - w) > 2) { w = host.clientWidth; drawChart(host, cfg); } });
    ro.observe(host);
  }
}
const legend = (items) => `<div class="legend">${items.map(([c, t, ln]) => `<span><i class="${ln ? 'ln' : ''}" style="background:${c}"></i>${esc(t)}</span>`).join('')}</div>`;
const UPC = 'var(--up)', DNC = 'var(--down)', ACC = 'var(--accent)', WARN = 'var(--warn)';
const signColor = (v) => (v >= 0 ? UPC : DNC);

/* ───────── 左側清單 ───────── */
function renderRail() {
  $('#rail-count').textContent = S.watch.length ? `${S.watch.length} 檔` : '';
  const list = $('#rail-list');
  if (!S.watch.length) { list.innerHTML = '<div class="rail-empty">還沒有股票。用上方搜尋框輸入代號或名稱,或匯入文字檔。</div>'; return; }
  const cur = S.route && S.route.code;
  list.innerHTML = S.watch.map((c) => {
    const r = S.rows.get(c);
    if (!r) return `<a class="wl-item" href="#/${c}"><span class="nm"><b>${esc(c)}</b><i>載入中…</i></span></a>`;
    return `<a class="wl-item ${dir(r.pct)} ${cur === c ? 'on' : ''}" href="#/${c}" data-code="${c}">
      <span class="nm"><b>${esc(r.name)}</b><i>${esc(c)}</i></span>
      <span class="px"><b>${r.limit ? `<span class="lim ${r.limit}">${price(r.close)}</span>` : price(r.close)}</b><small class="${dir(r.pct)}">${fpct(r.pct)}</small></span>
      <button class="rm" type="button" data-rm="${c}" aria-label="移除 ${esc(r.name)}">✕</button></a>`;
  }).join('');
  $('#rail-all').classList.toggle('on', !cur);
}
$('#rail-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (b) { e.preventDefault(); e.stopPropagation(); removeCode(b.dataset.rm); }
});

/* ───────── 路由 ───────── */
const TABS = [['summary', '概況'], ['revenue', '營收'], ['financials', '財報'], ['chips', '籌碼'], ['industry', '產業'], ['news', '新聞']];
function parseHash() {
  let h = location.hash.replace(/^#\/?/, '');
  try { h = decodeURIComponent(h); } catch { /* keep raw */ }
  const [a, b] = h.split('/');
  if (['market', 'heatmap', 'sectors'].includes(a)) return { page: a, code: null };
  if (a === 'industry' && b) return { page: 'industry', code: null, name: b };
  if (a === 'chain' && b) return { page: 'chain', code: null, name: b, node: h.split('/')[2] || null };
  if (a === 'supply') return { page: 'supply', code: null, name: b || null, focus: h.split('/')[2] || null };
  if (!a) return { page: 'watch', code: null };
  return { page: 'stock', code: a.toUpperCase(), tab: b || 'summary' };
}
const indHref = (name) => `#/industry/${encodeURIComponent(name)}`;
function route() {
  hideTip();
  S.route = parseHash();
  const pg = S.route.page;
  $('.app').classList.toggle('no-rail', !['watch', 'stock'].includes(pg));
  $$('.mainnav a').forEach((a) => a.classList.toggle('on', a.dataset.page === (pg === 'stock' ? 'watch' : pg === 'industry' || pg === 'chain' ? 'sectors' : pg)));
  renderRail();
  S.renderId++;
  const id = S.renderId;
  const main = $('#main');
  if (pg === 'watch') renderOverview(main, id);
  else if (pg === 'stock') renderDetail(main, S.route.code, S.route.tab, id);
  else if (pg === 'market') renderMarket(main, id);
  else if (pg === 'heatmap') renderHeatmap(main, id);
  else if (pg === 'sectors') renderSectors(main, id);
  else if (pg === 'chain') renderChainPage(main, S.route.name, id);
  else if (pg === 'supply') renderSupply(main, S.route.name, id);
  else renderIndustryPage(main, S.route.name, id);
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);

const errBox = (msg, retry) => `<div class="err"><span>${esc(msg)}</span>${retry ? `<button class="btn sm" data-retry>重試</button>` : ''}</div>`;
const skeleton = (rows = 6) => Array.from({ length: rows }, (_, i) => `<div class="skel" style="width:${90 - (i % 3) * 18}%"></div>`).join('');

/* ───────── 總覽 ───────── */
const COLS = [
  { k: 'name', label: '股票', cls: 'l stk sticky-col', get: (r) => r.code, html: (r) => `<b>${esc(r.name)}</b><small>${esc(r.code)}<span class="mkt">${mktName(r.market)}</span></small>` },
  { k: 'close', label: '收盤', get: (r) => r.close, html: (r) => `${pxTag(r.close, r.limit, dir(r.pct))}` },
  { k: 'pct', label: '漲跌幅', get: (r) => r.pct, html: (r) => pctSpan(r.pct) },
  { k: 'volume', label: '成交量(張)', get: (r) => r.volume, html: (r) => fint(r.volume) },
  { k: 'value', label: '成交值', get: (r) => r.value, html: (r) => money(r.value) },
  { k: 'pe', label: '本益比', get: (r) => r.pe, html: (r) => fnum(r.pe, 1) },
  { k: 'pb', label: '淨值比', get: (r) => r.pb, html: (r) => fnum(r.pb, 2) },
  { k: 'yield', label: '殖利率', get: (r) => r.yield, html: (r) => (isNum(r.yield) ? `${fnum(r.yield, 2)}%` : '—') },
  { k: 'revYoy', label: '月營收年增', get: (r) => r.rev && r.rev.yoy, html: (r) => (r.rev ? `${pctSpan(r.rev.yoy, 1)} <small class="muted">${r.rev.ym.m}月</small>` : '—') },
  { k: 'cumYoy', label: '累計營收年增', get: (r) => r.rev && r.rev.cumYoy, html: (r) => (r.rev ? pctSpan(r.rev.cumYoy, 1) : '—') },
  { k: 'foreign', label: '外資(張)', get: (r) => r.insti && r.insti.foreign, html: (r) => (r.insti ? span(r.insti.foreign, fsign(r.insti.foreign)) : '—') },
  { k: 'trust', label: '投信(張)', get: (r) => r.insti && r.insti.trust, html: (r) => (r.insti ? span(r.insti.trust, fsign(r.insti.trust)) : '—') },
  { k: 'dealer', label: '自營商(張)', get: (r) => r.insti && r.insti.dealer, html: (r) => (r.insti ? span(r.insti.dealer, fsign(r.insti.dealer)) : '—') },
  { k: 'marginChg', label: '融資增減(張)', get: (r) => r.margin && r.margin.marginChg, html: (r) => (r.margin ? span(r.margin.marginChg, fsign(r.margin.marginChg)) : '—') },
  { k: 'ann', label: '重大訊息', get: (r) => r.announcements, html: (r) => (r.announcements ? `<span class="chip warn">${r.announcements} 則</span>` : '<span class="muted">—</span>') },
];

function highlights(rows) {
  const ok = rows.filter((r) => isNum(r.pct));
  const up = ok.filter((r) => r.pct > 0).length, down = ok.filter((r) => r.pct < 0).length, flat = ok.length - up - down;
  const link = (r, extra = '') => `<a href="#/${r.code}">${esc(r.name)}</a> ${extra}`;
  const by = (get, desc = true) => rows.filter((r) => isNum(get(r))).sort((a, b) => (desc ? get(b) - get(a) : get(a) - get(b)))[0];
  const best = by((r) => r.pct), worst = by((r) => r.pct, false);
  const fBuy = by((r) => r.insti && r.insti.foreign), fSell = by((r) => r.insti && r.insti.foreign, false);
  const yoy = by((r) => r.rev && r.rev.yoy);
  const withAnn = rows.filter((r) => r.announcements);
  const exd = rows.filter((r) => r.exdiv && r.exdiv.date).sort((a, b) => a.exdiv.date.localeCompare(b.exdiv.date));
  const avg = ok.length ? ok.reduce((a, r) => a + r.pct, 0) / ok.length : null;
  const items = [];
  items.push(`<li><span class="k">今日漲跌</span><span class="v"><span class="up">${up} 漲</span> · <span class="down">${down} 跌</span> · ${flat} 平 <small class="muted">平均 ${pctSpan(avg)}</small></span><div class="breadth" aria-hidden="true"><i class="u" style="width:${ok.length ? (up / ok.length) * 100 : 0}%"></i><i class="f" style="width:${ok.length ? (flat / ok.length) * 100 : 0}%"></i><i class="d" style="width:${ok.length ? (down / ok.length) * 100 : 0}%"></i></div></li>`);
  if (best) items.push(`<li><span class="k">最強 / 最弱</span><span class="v">${link(best, pctSpan(best.pct))}<br>${link(worst, pctSpan(worst.pct))}</span></li>`);
  if (fBuy && fBuy.insti.foreign > 0 || fSell && fSell.insti.foreign < 0) items.push(`<li><span class="k">外資買超 / 賣超最多</span><span class="v">${fBuy && fBuy.insti.foreign > 0 ? link(fBuy, span(1, fsign(fBuy.insti.foreign) + ' 張')) : '—'}<br>${fSell && fSell.insti.foreign < 0 ? link(fSell, span(-1, fsign(fSell.insti.foreign) + ' 張')) : '—'}</span></li>`);
  if (yoy) items.push(`<li><span class="k">月營收年增最高</span><span class="v">${link(yoy, pctSpan(yoy.rev.yoy, 1))} <small class="muted">${yoy.rev.ym.m} 月</small></span></li>`);
  items.push(`<li><span class="k">今日重大訊息</span><span class="v">${withAnn.length ? withAnn.map((r) => link(r)).join('、') : '<span class="muted">清單內無</span>'}</span></li>`);
  if (exd.length) items.push(`<li><span class="k">即將除權息</span><span class="v">${exd.slice(0, 4).map((r) => link(r, `<small class="muted">${r.exdiv.date.slice(5).replace('-', '/')}${isNum(r.exdiv.cash) ? ` · 現金 ${r.exdiv.cash}` : ''}</small>`)).join('<br>')}</span></li>`);
  return `<ul class="hl">${items.join('')}</ul>`;
}

function renderOverview(main, id) {
  if (!S.watch.length) {
    main.innerHTML = `<div class="empty"><h2>建立你的自選股</h2><p>在上方輸入股票代號或名稱就能加入。也可以匯入一份文字檔,一行一檔。</p>
      <div class="row"><button class="btn primary" id="e-import">匯入清單</button><button class="btn" id="e-sample">先用範例看看</button></div></div>`;
    $('#e-import').onclick = openImport;
    $('#e-sample').onclick = () => addCodes(['2330', '2317', '2454', '2881', '2603', '0050']);
    return;
  }
  const rows = S.watch.map((c) => S.rows.get(c)).filter(Boolean);
  if (!rows.length) { main.innerHTML = `<div class="panel">${skeleton(8)}</div>`; return; }
  const meta = S.meta;
  const key = S.sort.key, col = COLS.find((c) => c.k === key);
  let list = [...S.watch].map((c) => S.rows.get(c) || { code: c, name: c, missing: true });
  if (col) list.sort((a, b) => { const x = col.get(a), y = col.get(b); if (!isNum(x) && col.k !== 'name') return 1; if (!isNum(y) && col.k !== 'name') return -1; return (col.k === 'name' ? String(x).localeCompare(String(y)) : x - y) * S.sort.dir; });
  main.innerHTML = `
    <div class="page-head"><div><h1>盤後總覽</h1><div class="sub">${rows.length} 檔自選股 · 點任一列看基本面、營收、籌碼、產業與新聞</div></div>
      <div class="asof">收盤資料 <b>${esc(dateLabel(meta.quoteDate))}</b><br>三大法人 <b>${esc(dateLabel(meta.instiDate))}</b> · 融資券 <b>${esc(dateLabel(meta.marginDate))}</b>
      <br><button class="btn sm" id="refresh" type="button">重新整理</button></div></div>
    <section class="panel" aria-label="今日重點">${highlights(rows)}</section>
    <section class="panel" style="padding:6px 6px 2px"><div class="tbl-wrap"><table id="ov-table">
      <thead><tr>${COLS.map((c) => `<th class="sort ${c.cls || ''}" data-k="${c.k}" tabindex="0" ${key === c.k ? `aria-sort="${S.sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${list.map((r) => r.missing ? `<tr><td class="l stk sticky-col"><b>${esc(r.code)}</b></td><td colspan="${COLS.length - 1}" class="l muted">查無這檔股票的資料(可能已下市)<button class="btn sm" data-rm="${esc(r.code)}" style="margin-left:12px">移除</button></td></tr>` : `<tr class="row" data-code="${r.code}" tabindex="0">${COLS.map((c) => `<td class="${c.cls || ''}">${c.html(r)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div></section>
    <p class="note">收盤、法人、融資券、月營收、重大訊息皆為證交所與櫃買中心公布的官方資料,約在收盤後 1~2 小時內更新;月營收為各公司最近一次申報的月份。ETF 沒有營收與財報。</p>`;
  $('#refresh').onclick = async () => { apiCache.clear(); $('#refresh').textContent = '更新中…'; try { await loadRows(S.watch, true); } catch (e) { toast(e.message); } renderRail(); route(); };
  const table = $('#ov-table');
  const sortBy = (k) => { S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: k === 'name' ? 1 : -1 }; renderOverview(main, id); };
  $$('th.sort', table).forEach((th) => { th.onclick = () => sortBy(th.dataset.k); th.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(th.dataset.k); } }; });
  table.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]'); if (rm) return removeCode(rm.dataset.rm);
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr.row'); if (tr) location.hash = `#/${tr.dataset.code}`;
  });
  table.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const tr = e.target.closest('tr.row'); if (tr) location.hash = `#/${tr.dataset.code}`; } });
}

/* ───────── 個股 ───────── */
async function renderDetail(main, code, tab, id) {
  main.innerHTML = `<div class="panel">${skeleton(7)}</div>`;
  let sum;
  try { sum = await api(`/api/stock/${code}`); }
  catch (e) { if (id !== S.renderId) return; main.innerHTML = errBox(`找不到「${code}」或資料暫時無法取得:${e.message}`, true); main.querySelector('[data-retry]').onclick = () => route(); return; }
  if (id !== S.renderId) return;
  if (S.watch.includes(code)) S.rows.set(code, { ...S.rows.get(code), ...sum });
  const tabs = sum.etf ? TABS.filter(([k]) => ['summary', 'chips', 'news'].includes(k)) : TABS;
  if (!tabs.find(([k]) => k === tab)) tab = 'summary';
  const inList = S.watch.includes(code);
  const p = sum.profile;
  main.innerHTML = `
    <section class="panel quote">
      <div>
        <div class="name"><h1>${esc(sum.name)}</h1><span class="code">${esc(code)}</span><span class="chip">${mktName(sum.market)}</span>${sum.etf ? `<span class="chip accent">${esc(sum.kind || 'ETF')}</span>` : `<a class="chip accent" href="${indHref(sum.industry)}" title="查看這個產業的所有股票">${esc(sum.industry)}</a>`}${sum.announcements ? `<a class="chip warn" href="#/${code}/news">今日重大訊息 ${sum.announcements}</a>` : ''}</div>
        <div class="px-row"><span class="big ${dir(sum.change)}">${sum.limit ? `<span class="lim ${sum.limit}">${price(sum.close)}</span>` : price(sum.close)}</span><span class="chg ${dir(sum.change)}">${isNum(sum.change) ? (sum.change > 0 ? '▲' : sum.change < 0 ? '▼' : '') + ' ' + fnum(Math.abs(sum.change), 2) : ''} (${fpct(sum.pct)})</span></div>
        <div class="head-actions">
          <button class="btn sm" id="toggle-watch" type="button">${inList ? '已在自選 · 移除' : '加入自選股'}</button>
          <span class="muted" style="font-size:12.5px">${esc(dateLabel(sum.date))} 收盤</span>
        </div>
      </div>
      <div class="facts">
        <div class="fact"><span class="k">開盤</span><span class="v">${price(sum.open)}</span></div>
        <div class="fact"><span class="k">最高</span><span class="v up">${price(sum.high)}</span></div>
        <div class="fact"><span class="k">最低</span><span class="v down">${price(sum.low)}</span></div>
        <div class="fact"><span class="k">昨收</span><span class="v">${price(sum.prevClose)}</span></div>
        <div class="fact" ${sum.volumeAll && sum.volumeAll !== sum.volume ? `title="一般整股成交量(與 Yahoo 同口徑)。證交所統計含零股、盤後定價、鉅額,合計 ${fint(sum.volumeAll)} 張"` : ''}><span class="k">成交量</span><span class="v">${fint(sum.volume)} 張</span></div>
        <div class="fact"><span class="k">成交值</span><span class="v">${money(sum.value)}</span></div>
        <div class="fact"><span class="k">本益比</span><span class="v">${fnum(sum.pe, 2)}</span></div>
        <div class="fact"><span class="k">股價淨值比</span><span class="v">${fnum(sum.pb, 2)}</span></div>
      </div>
      ${classPanel(sum)}
    </section>
    <nav class="tabs" aria-label="資料分頁">${tabs.map(([k, t]) => `<a href="#/${code}/${k}" class="${k === tab ? 'on' : ''}" ${k === tab ? 'aria-current="page"' : ''}>${t}</a>`).join('')}</nav>
    <div id="tab-body"></div>`;
  main.addEventListener('click', (e) => {
    const b = e.target.closest('.more-btn'); if (!b) return;
    const w = b.previousElementSibling; if (w) w.hidden = false; b.remove();
  });
  api(`/api/stock/${code}/about`).then((a) => {
    if (id !== S.renderId) return;
    const el = $('#about-biz'); if (!el) return;
    if (a && a.business) {
      el.className = ''; el.textContent = a.business;
    } else $('#about-biz-wrap') && $('#about-biz-wrap').remove();
  }).catch(() => { const w = $('#about-biz-wrap'); if (w) w.remove(); });
  $('#toggle-watch').onclick = async () => { if (inList) removeCode(code); else { await addCodes([code]); toast(`已加入 ${sum.name}`); } };
  const host = $('#tab-body');
  host.innerHTML = `<div class="panel">${skeleton(6)}</div>`;
  const fn = { summary: tabSummary, revenue: tabRevenue, financials: tabFinancials, chips: tabChips, industry: tabIndustry, news: tabNews }[tab];
  try { await fn(code, sum, host, id); }
  catch (e) { if (id !== S.renderId) return; host.innerHTML = errBox(`載入失敗:${e.message}`, true); host.querySelector('[data-retry]').onclick = () => { apiCache.clear(); route(); }; }
}
const staleNote = (d, name = 'FinMind') => (d && d.stale ? `<p class="note warn">${name} 暫時無法連線,以下是先前儲存的資料。</p>` : '');

/* ── 概況 ── */
async function tabSummary(code, sum, host, id) {
  const p = sum.profile;
  host.innerHTML = `
    <div class="grid two">
      <div class="stack">
        <section class="panel"><h3>股價走勢<small>未還原股價</small><span class="seg" id="range-seg"><button data-n="22" aria-pressed="false">1月</button><button data-n="66" aria-pressed="true">3月</button><button data-n="130" aria-pressed="false">6月</button><button data-n="252" aria-pressed="false">1年</button></span></h3>
          <div id="price-chart" style="height:250px">${skeleton(5)}</div>
          <div class="vol-cap">成交量<small>張(證交所口徑,含零股、盤後定價、鉅額)</small></div>
          <div id="vol-chart" style="height:96px"></div>
          <div id="price-extra"></div></section>
        <section class="panel" id="div-panel"><h3>股利</h3>${skeleton(3)}</section>
        ${sum.announcementList.length ? `<section class="panel"><h3>今日重大訊息<small>${sum.announcementList.length} 則</small></h3>${sum.announcementList.map(annHtml).join('')}</section>` : ''}
      </div>
      <div class="stack">
        <section class="panel"><h3>估值與規模</h3>
          <dl class="kv">
            <dt>本益比</dt><dd>${fnum(sum.pe, 2)}</dd>
            <dt>股價淨值比</dt><dd>${fnum(sum.pb, 2)}</dd>
            <dt>殖利率<small class="muted"> 官方</small></dt><dd>${isNum(sum.yield) ? fnum(sum.yield, 2) + '%' : '—'}</dd>
            <dt>近 12 個月現金股利</dt><dd id="kv-div">…</dd>
            <dt>市值</dt><dd>${money(sum.mcap)}</dd>
            <dt>已發行股數</dt><dd>${p && p.shares ? money(p.shares) + ' 股' : '—'}</dd>
            ${sum.etf ? '' : `<dt>最近月營收年增</dt><dd>${sum.rev ? `${pctSpan(sum.rev.yoy, 1)}<small>${sum.rev.ym.y}/${String(sum.rev.ym.m).padStart(2, '0')}</small>` : '—'}</dd>
            <dt>最近一季 EPS</dt><dd id="kv-eps">…</dd>
            <dt>近四季 EPS</dt><dd id="kv-ttm">…</dd>
            <dt>ROE<small class="muted"> 近四季</small></dt><dd id="kv-roe">…</dd>`}
          </dl></section>
        ${sum.exdiv ? `<section class="panel"><h3>除權息預告</h3><dl class="kv"><dt>日期</dt><dd>${esc(dateLabel(sum.exdiv.date))}</dd><dt>類別</dt><dd>${esc(sum.exdiv.type || '—')}</dd><dt>現金股利</dt><dd>${isNum(sum.exdiv.cash) ? sum.exdiv.cash + ' 元' : '—'}</dd></dl></section>` : ''}
        <section class="panel"><h3>公司資料</h3>
          ${p ? `<dl class="kv"><dt>公司全名</dt><dd>${esc(p.full)}</dd><dt>產業別</dt><dd>${esc(sum.industry)}</dd><dt>董事長</dt><dd>${esc(p.chairman || '—')}</dd><dt>總經理</dt><dd>${esc(p.gm || '—')}</dd>
            <dt>成立</dt><dd>${esc(p.founded || '—')}</dd><dt>上市(櫃)</dt><dd>${esc(p.listed || '—')}</dd><dt>實收資本額</dt><dd>${money(p.capital)}</dd>
            <dt>網站</dt><dd>${/^https?:\/\//.test(p.web) ? `<a class="up-none" style="color:var(--accent)" href="${esc(p.web)}" target="_blank" rel="noopener">${esc(p.web.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : '—'}</dd></dl>${chainChips(sum)}`
            : `<p class="note">${esc(sum.full || sum.name)}。${esc(sum.kind || 'ETF')} 沒有公司資料、營收與財報,可看股價、法人買賣超與新聞。</p>`}
        </section>
      </div>
    </div>`;
  // 股價
  api(`/api/stock/${code}/price`).then((pr) => {
    if (id !== S.renderId) return;
    const rows = pr.rows;
    if (!rows.length) { $('#price-chart').innerHTML = '<div class="note">沒有股價資料</div>'; return; }
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const ma = (nn) => rows.map((_, i) => (i >= nn - 1 ? avg(rows.slice(i - nn + 1, i + 1).map((r) => r.c)) : null));
    const ma20 = ma(20), ma60 = ma(60);
    const vma20 = rows.map((_, i) => (i >= 19 ? avg(rows.slice(i - 19, i + 1).map((r) => r.v || 0)) : null));
    let range = 66;
    const draw = () => {
      const st = Math.max(0, rows.length - range), sl = rows.slice(st);
      const up = sl[sl.length - 1].c >= sl[0].c;
      const dayTip = (i) => { const r = sl[i], prev = i ? sl[i - 1].c : (rows[st - 1] || {}).c; const ch = prev ? r.c - prev : null; const va = vma20[st + i];
        return `<b>${esc(r.d)}</b><div class="r"><span>收盤</span><span class="${dir(ch)}">${price(r.c)}${ch !== null ? ` (${fsign(ch, 2)}, ${fpct((ch / prev) * 100)})` : ''}</span></div><div class="r"><span>開 / 高 / 低</span><span>${price(r.o)} / ${price(r.h)} / ${price(r.l)}</span></div><div class="r"><span>成交量</span><span>${fint(r.v)} 張</span></div>${isNum(va) ? `<div class="r"><span>20日均量</span><span>${fint(va)} 張 · 量比 ${fnum(r.v / va, 2)}</span></div>` : ''}${isNum(ma20[st + i]) ? `<div class="r"><span>20日均價</span><span>${fnum(ma20[st + i], 1)}</span></div>` : ''}${isNum(ma60[st + i]) ? `<div class="r"><span>60日均價</span><span>${fnum(ma60[st + i], 1)}</span></div>` : ''}`; };
      const common = { labels: sl.map((r) => r.d), xTicks: 6, tip: dayTip, xFmt: (d, i, full) => (full ? d : range <= 66 ? d.slice(5).replace('-', '/') : d.slice(2, 7).replace('-', '/')) };
      mountChart($('#price-chart'), { ...common, label: `${sum.name} 近 ${range} 個交易日股價`, height: 250, noX: true,
        fmtL: (v) => (v >= 1000 ? fint(v) : fnum(v, v >= 100 ? 0 : 1)),
        series: [
          { type: 'area', data: sl.map((r) => r.c), color: up ? UPC : DNC, width: 2, noDots: true, noTip: true },
          { type: 'line', data: ma20.slice(st), color: WARN, width: 1.2, dash: '4 3', noDots: true, noTip: true },
          { type: 'line', data: ma60.slice(st), color: ACC, width: 1.2, dash: '4 3', noDots: true, noTip: true },
        ] });
      mountChart($('#vol-chart'), { ...common, label: `${sum.name} 成交量`, height: 96, fmtL: fmtLots,
        series: [
          { type: 'bar', data: sl.map((r) => r.v), color: (v, i) => (i && sl[i].c < sl[i - 1].c ? DNC : i && sl[i].c > sl[i - 1].c ? UPC : 'var(--text3)'), noTip: true },
          { type: 'line', data: vma20.slice(st), color: WARN, width: 1.2, dash: '4 3', noDots: true, noTip: true },
        ] });
    };
    draw();
    $$('#range-seg button').forEach((b) => (b.onclick = () => { range = +b.dataset.n; $$('#range-seg button').forEach((x) => x.setAttribute('aria-pressed', x === b)); draw(); }));
    const r = pr.returns, last = rows[rows.length - 1].c;
    const pos = pr.high52 > pr.low52 ? ((last - pr.low52) / (pr.high52 - pr.low52)) * 100 : 50;
    $('#price-extra').innerHTML = `
      ${legend([[WARN, '20日均價(量)', 1], [ACC, '60日均價', 1]])}
      <div class="rets">${[['w1', '1 週'], ['m1', '1 個月'], ['m3', '3 個月'], ['m6', '6 個月'], ['ytd', '今年以來'], ['y1', '1 年']].map(([k, t]) => `<div><span class="k">${t}</span><span class="v ${dir(r[k])}">${fpct(r[k], 1)}</span></div>`).join('')}</div>
      <div class="range" aria-label="52週區間"><div class="fill" style="width:${pos}%"></div><div class="pin" style="left:${pos}%"><span>${price(last)}</span></div></div>
      <div class="range-lab"><span>52週低 ${price(pr.low52)}</span><span>52週高 ${price(pr.high52)}</span></div>
      ${staleNote(pr)}`;
  }).catch((e) => { if (id === S.renderId) $('#price-chart').innerHTML = errBox('股價歷史暫時無法取得:' + e.message); });
  // 股利 + 財務摘要
  api(`/api/stock/${code}/financials`).then((f) => {
    if (id !== S.renderId) return;
    const dp = $('#div-panel');
    const rows = f.dividends.slice(0, 8);
    dp.innerHTML = `<h3>股利<small>${isNum(f.ttmYield) ? `近 12 個月現金股利 ${fnum(f.ttmCashDividend, 2)} 元,以現價計殖利率 ${fnum(f.ttmYield, 2)}%` : ''}</small></h3>` + (rows.length ? `<div class="tbl-wrap"><table><thead><tr><th class="l">所屬期間</th><th>現金股利</th><th>股票股利</th><th>除息日</th><th>發放日</th></tr></thead><tbody>${rows.map((d) => `<tr><td class="l">${esc(d.period || '')}</td><td>${d.cash ? fnum(d.cash, 2) : '—'}</td><td>${d.stock ? fnum(d.stock, 2) : '—'}</td><td>${esc(d.exCash || d.exStock || '—')}</td><td>${esc(d.pay || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">查無股利資料。</p>') + staleNote(f);
    $('#kv-div') && ($('#kv-div').innerHTML = f.ttmCashDividend ? `${fnum(f.ttmCashDividend, 2)} 元` : '—');
    const q = f.quarters, l = q[q.length - 1];
    if (l && $('#kv-eps')) {
      $('#kv-eps').innerHTML = `${isNum(l.eps) ? fnum(l.eps, 2) + ' 元' : '—'}<small>${l.label}${l.epsDerived ? ' 估' : ''}</small>`;
      $('#kv-ttm').innerHTML = isNum(l.epsTtm) ? `${fnum(l.epsTtm, 2)} 元` : '—';
      $('#kv-roe').innerHTML = isNum(l.roe) ? `${fnum(l.roe, 1)}%` : '—';
    } else if ($('#kv-eps')) { ['kv-eps', 'kv-ttm', 'kv-roe'].forEach((i) => ($('#' + i).textContent = '—')); }
  }).catch((e) => { if (id === S.renderId) $('#div-panel').innerHTML = `<h3>股利</h3>${errBox('財務資料暫時無法取得:' + e.message)}`; });
}
function annHtml(a) {
  return `<details class="ann"><summary>${esc(a.title || '(無主旨)')} <small class="muted">${esc(a.date || '')} ${esc(a.time || '')}${a.clause ? ' · ' + esc(a.clause) : ''}</small></summary><pre>${esc(a.detail)}</pre></details>`;
}

/* ── 營收 ── */
async function tabRevenue(code, sum, host, id) {
  const d = await api(`/api/stock/${code}/revenue`);
  if (id !== S.renderId) return;
  const rows = d.rows;
  if (!rows.length) { host.innerHTML = '<div class="panel"><p class="note">查無月營收資料。</p></div>'; return; }
  const last = rows[rows.length - 1], o = d.official;
  const last3 = rows.slice(-3).map((r) => r.yoy).filter(isNum);
  const avg3 = last3.length ? last3.reduce((a, b) => a + b, 0) / last3.length : null;
  const badge = d.highs.historic ? '<span class="chip up">創歷史新高</span>' : d.highs.in36 ? '<span class="chip up">創近 3 年新高</span>' : d.highs.in12 ? '<span class="chip up">創近 12 個月新高</span>' : '';
  const chartRows = rows.slice(-24);
  host.innerHTML = `
    <section class="panel"><h3>${last.ym.replace('-', ' 年 ')} 月營收 ${badge}</h3>
      <div class="tiles divided">
        <div class="tile"><span class="k">當月營收</span><span class="v">${yi(last.rev)}</span></div>
        <div class="tile"><span class="k">年增率 YoY</span><span class="v ${dir(last.yoy)}">${fpct(last.yoy, 1)}</span></div>
        <div class="tile"><span class="k">月增率 MoM</span><span class="v ${dir(last.mom)}">${fpct(last.mom, 1)}</span></div>
        <div class="tile"><span class="k">累計營收</span><span class="v">${yi(last.cum)}</span><span class="s">累計年增 <span class="${dir(last.cumYoy)}">${fpct(last.cumYoy, 1)}</span></span></div>
        <div class="tile"><span class="k">近 3 個月平均年增</span><span class="v ${dir(avg3)}">${fpct(avg3, 1)}</span></div>
      </div>
      ${o && o.note ? `<blockquote class="quoteblock">${esc(o.note)}<small>公司於公開資訊觀測站申報的營收變動說明</small></blockquote>` : ''}
    </section>
    <section class="panel"><h3>近 24 個月營收與年增率</h3>
      ${legend([[ACC, '月營收(億元)'], [WARN, '年增率', 1]])}
      <div id="rev-chart" style="height:290px"></div></section>
    <section class="panel"><h3>近 12 個月明細</h3>
      <div class="tbl-wrap"><table><thead><tr><th class="l">月份</th><th>營收</th><th>月增</th><th>年增</th><th>累計營收</th><th>累計年增</th></tr></thead>
      <tbody>${rows.slice(-12).reverse().map((r) => `<tr><td class="l">${esc(r.ym)}</td><td>${yi(r.rev)}</td><td>${pctSpan(r.mom, 1)}</td><td>${pctSpan(r.yoy, 1)}</td><td>${yi(r.cum)}</td><td>${pctSpan(r.cumYoy, 1)}</td></tr>`).join('')}</tbody></table></div>
      ${d.check ? (d.check.match === false ? `<p class="note warn">${esc(d.check.month)} 官方月營收 ${yi(d.check.official, 2)} 與 FinMind ${yi(d.check.finmind, 2)} 不一致,本頁以官方數字為準。</p>` : `<p class="note ok">${esc(d.check.month)} 月營收已與證交所/櫃買官方申報資料核對${d.check.match ? '一致' : '(官方資料較新,以官方為準)'}。</p>`) : ''}
      ${staleNote(d)}</section>`;
  mountChart($('#rev-chart'), {
    label: '月營收與年增率', height: 290, labels: chartRows.map((r) => r.ym), xTicks: 8,
    xFmt: (l) => l.slice(2).replace('-', '/'), fmtL: (v) => fint(v / 1e8), fmtR: (v) => `${fnum(v, 0)}%`,
    series: [
      { type: 'bar', axis: 'l', data: chartRows.map((r) => r.rev), color: ACC, name: '營收', fmt: (v) => yi(v), dim: (v, i) => i !== chartRows.length - 1 },
      { type: 'line', axis: 'r', data: chartRows.map((r) => r.yoy), color: WARN, name: '年增率', fmt: (v) => fpct(v, 1) },
    ],
  });
}

/* ── 財報 ── */
async function tabFinancials(code, sum, host, id) {
  const mode = S.finMode || 'q';
  host.innerHTML = `<div class="controls" style="margin:0 0 12px"><span class="grp">期間 ${segHtml('fm', [['q', '季'], ['m', '月']], mode)}</span>${mode === 'm' ? '<span class="muted" style="font-size:12.5px">公司只公布月營收,獲利、EPS 等要等季報</span>' : ''}</div><div id="fin-body"><div class="panel">${skeleton(6)}</div></div>`;
  bindSeg(host, (k, v) => {
    if (k !== 'fm') return;
    S.finMode = v;
    tabFinancials(code, sum, host, id).catch((e) => { if (id === S.renderId) host.innerHTML = errBox(`載入失敗:${e.message}`); });
  });
  const body = host.querySelector('#fin-body');
  try { await (mode === 'm' ? finMonthly : finQuarter)(code, sum, body, id); }
  catch (e) { if (id !== S.renderId) return; body.innerHTML = errBox(`載入失敗:${e.message}`, true); body.querySelector('[data-retry]').onclick = () => { apiCache.clear(); route(); }; }
}

/** 財報「月」:公司只公布月營收,這裡把月營收整理成財報角度的檢視(近 12 個月合計、本季累計對上季/去年同期、逐月明細) */
async function finMonthly(code, sum, host, id) {
  const d = await api(`/api/stock/${code}/revenue`);
  if (id !== S.renderId) return;
  const rows = d.rows;
  if (!rows.length) { host.innerHTML = '<div class="panel"><p class="note">查無月營收資料。</p></div>'; return; }
  const last = rows[rows.length - 1];
  const byYm = new Map(rows.map((r) => [r.ym, r]));
  const ymAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
  const sumRange = (endYm, n) => { let t = 0; for (let i = 0; i < n; i++) { const r = byYm.get(ymAdd(endYm, -i)); if (!r || !isNum(r.rev)) return null; t += r.rev; } return t; };
  const growth = (a, b) => (isNum(a) && isNum(b) && b ? (a / b - 1) * 100 : null);
  const ttm = sumRange(last.ym, 12), ttmYoy = growth(ttm, sumRange(ymAdd(last.ym, -12), 12));
  // 本季累計:該季已公布的月數,對照上一季整季與去年同期同月數
  const [ly, lm] = last.ym.split('-').map(Number);
  const qMonth = Math.floor((lm - 1) / 3) * 3 + 1, n = lm - qMonth + 1, qNo = (qMonth - 1) / 3 + 1;
  const cur = sumRange(last.ym, n), prevQ = sumRange(ymAdd(`${ly}-${String(qMonth).padStart(2, '0')}`, -1), 3), lastYear = sumRange(ymAdd(last.ym, -12), n);
  const vsPrev = isNum(cur) && prevQ ? (cur / prevQ) * 100 : null;
  const m12 = rows.slice(-12), c24 = rows.slice(-24);
  const R = (label, get, fmt, tone) => ({ label, get, fmt, tone });
  const defs = [
    R('營收(億)', (r) => r.rev, (v) => fnum(v / 1e8, 2)),
    R('月增', (r) => r.mom, (v) => fpct(v, 1), 1),
    R('年增', (r) => r.yoy, (v) => fpct(v, 1), 1),
    R('累計營收(億)', (r) => r.cum, (v) => fnum(v / 1e8, 1)),
    R('累計年增', (r) => r.cumYoy, (v) => fpct(v, 1), 1),
  ];
  host.innerHTML = `
    <section class="panel"><h3>${last.ym.replace('-', ' 年 ')} 月營收<small>公司每月 10 日前申報</small></h3>
      <div class="tiles divided">
        <div class="tile"><span class="k">當月營收</span><span class="v">${yi(last.rev)}</span><span class="s">年增 <span class="${dir(last.yoy)}">${fpct(last.yoy, 1)}</span> · 月增 <span class="${dir(last.mom)}">${fpct(last.mom, 1)}</span></span></div>
        <div class="tile"><span class="k">本年累計營收</span><span class="v">${yi(last.cum)}</span><span class="s">累計年增 <span class="${dir(last.cumYoy)}">${fpct(last.cumYoy, 1)}</span></span></div>
        <div class="tile"><span class="k">近 12 個月營收</span><span class="v">${isNum(ttm) ? yi(ttm) : '—'}</span><span class="s">較前 12 個月 <span class="${dir(ttmYoy)}">${fpct(ttmYoy, 1)}</span></span></div>
        <div class="tile"><span class="k">${ly} Q${qNo} 累計營收${n < 3 ? `(已公布 ${n}/3 個月)` : ''}</span><span class="v">${isNum(cur) ? yi(cur) : '—'}</span><span class="s">去年同期 <span class="${dir(growth(cur, lastYear))}">${fpct(growth(cur, lastYear), 1)}</span></span></div>
        <div class="tile"><span class="k">${n < 3 ? '已達上季營收' : '較上季營收'}</span><span class="v ${n < 3 ? '' : dir(vsPrev === null ? null : vsPrev - 100)}">${vsPrev === null ? '—' : n < 3 ? `${fnum(vsPrev, 0)}%` : fpct(vsPrev - 100, 1)}</span><span class="s">上季整季 ${isNum(prevQ) ? yi(prevQ) : '—'}</span></div>
      </div>
    </section>
    <section class="panel"><h3>近 24 個月營收與年增率</h3>
      ${legend([[ACC, '月營收(億元)'], [WARN, '年增率', 1]])}
      <div id="fin-m-chart" style="height:260px"></div></section>
    <section class="panel"><h3>近 12 個月明細</h3>
      <div class="tbl-wrap"><table><thead><tr><th class="l sticky-col">項目</th>${m12.map((r) => `<th>${esc(r.ym)}</th>`).join('')}</tr></thead>
      <tbody>${defs.map((df) => `<tr><td class="l sticky-col">${df.label}</td>${m12.map((r) => { const v = df.get(r); return `<td>${isNum(v) ? (df.tone ? span(v, df.fmt(v)) : df.fmt(v)) : '—'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
      ${d.check ? (d.check.match === false ? `<p class="note warn">${esc(d.check.month)} 官方月營收 ${yi(d.check.official, 2)} 與 FinMind ${yi(d.check.finmind, 2)} 不一致,本頁以官方數字為準。</p>` : `<p class="note ok">${esc(d.check.month)} 月營收已與證交所/櫃買官方申報資料核對${d.check.match ? '一致' : '(官方資料較新,以官方為準)'}。</p>`) : ''}
      <p class="note">公司只公布月營收,沒有月份的獲利與 EPS,獲利請切回「季」看季報。「已達上季營收」是本季已公布月份的合計除以上一季整季營收。營收說明與歷史新高標示在「<a href="#/${code}/revenue">營收</a>」分頁。</p>
      ${staleNote(d)}</section>`;
  mountChart($('#fin-m-chart'), {
    label: '月營收與年增率', height: 260, labels: c24.map((r) => r.ym), xTicks: 8,
    xFmt: (l) => l.slice(2).replace('-', '/'), fmtL: (v) => fint(v / 1e8), fmtR: (v) => `${fnum(v, 0)}%`,
    series: [
      { type: 'bar', axis: 'l', data: c24.map((r) => r.rev), color: ACC, name: '營收', fmt: (v) => yi(v), dim: (v, i) => i !== c24.length - 1 },
      { type: 'line', axis: 'r', data: c24.map((r) => r.yoy), color: WARN, name: '年增率', fmt: (v) => fpct(v, 1) },
    ],
  });
}

async function finQuarter(code, sum, host, id) {
  const f = await api(`/api/stock/${code}/financials`);
  if (id !== S.renderId) return;
  const q = f.quarters;
  if (!q.length) { host.innerHTML = '<div class="panel"><p class="note">查無季財報資料。</p></div>'; return; }
  const l = q[q.length - 1], fin = f.kind === 'financial';
  const rows8 = q.slice(-8);
  const R = (label, get, fmt, tone) => ({ label, get, fmt, tone });
  const defs = [
    R('營業收入(億)', (r) => r.rev, (v) => fnum(v / 1e8, 1)),
    R('營收年增', (r) => r.revYoy, (v) => fpct(v, 1), 1),
    !fin && R('毛利率', (r) => r.gm, (v) => fnum(v, 1) + '%'),
    !fin && R('營業利益率', (r) => r.om, (v) => fnum(v, 1) + '%'),
    R('稅後淨利率', (r) => r.nm, (v) => fnum(v, 1) + '%'),
    R('稅後淨利(億)', (r) => r.niParent, (v) => fnum(v / 1e8, 1)),
    R('EPS(元)', (r) => r.eps, (v) => fnum(v, 2)),
    R('EPS 年增', (r) => r.epsYoy, (v) => fpct(v, 1), 1),
    R('ROE(近四季)', (r) => r.roe, (v) => fnum(v, 1) + '%'),
    R('負債比', (r) => r.debtRatio, (v) => fnum(v, 1) + '%'),
    !fin && R('流動比', (r) => r.currentRatio, (v) => fnum(v, 0) + '%'),
    !fin && R('營業現金流(億)', (r) => r.ocf, (v) => fnum(v / 1e8, 1)),
    !fin && R('資本支出(億)', (r) => r.capex, (v) => fnum(v / 1e8, 1)),
    !fin && R('自由現金流(億)', (r) => r.fcf, (v) => fnum(v / 1e8, 1)),
    !fin && R('存貨(億)', (r) => r.inv, (v) => fnum(v / 1e8, 1)),
  ].filter(Boolean).filter((d) => rows8.some((r) => isNum(d.get(r))));
  const ck = f.epsCheck;
  host.innerHTML = `
    <section class="panel"><h3>${l.label} 重點<small>財報截止 ${esc(l.date)}</small></h3>
      <div class="tiles divided">
        <div class="tile"><span class="k">營業收入</span><span class="v">${yi(l.rev)}</span><span class="s">年增 <span class="${dir(l.revYoy)}">${fpct(l.revYoy, 1)}</span></span></div>
        ${fin ? '' : `<div class="tile"><span class="k">毛利率</span><span class="v">${fnum(l.gm, 1)}%</span><span class="s">營益率 ${fnum(l.om, 1)}%</span></div>`}
        <div class="tile"><span class="k">稅後淨利率</span><span class="v">${fnum(l.nm, 1)}%</span></div>
        <div class="tile"><span class="k">單季 EPS${l.epsDerived ? '(估)' : ''}</span><span class="v">${fnum(l.eps, 2)}</span><span class="s">年增 <span class="${dir(l.epsYoy)}">${fpct(l.epsYoy, 1)}</span></span></div>
        <div class="tile"><span class="k">近四季 EPS</span><span class="v">${fnum(l.epsTtm, 2)}</span><span class="s">ROE ${fnum(l.roe, 1)}%</span></div>
        <div class="tile"><span class="k">負債比</span><span class="v">${fnum(l.debtRatio, 1)}%</span>${fin ? '' : `<span class="s">流動比 ${fnum(l.currentRatio, 0)}%</span>`}</div>
      </div>
    </section>
    <div class="grid even">
      <section class="panel"><h3>${fin ? '營收與淨利率' : '營收與獲利率'}</h3>
        ${legend([[ACC, '營收(億元)'], ...(fin ? [] : [['var(--up)', '毛利率', 1], [WARN, '營益率', 1]]), ['var(--down)', '淨利率', 1]])}
        <div id="fin-chart" style="height:260px"></div></section>
      <section class="panel"><h3>每股盈餘 EPS<small>單季,元</small></h3>
        ${legend([[ACC, '單季 EPS'], [WARN, '近四季累計', 1]])}
        <div id="eps-chart" style="height:260px"></div></section>
    </div>
    <section class="panel"><h3>近 8 季明細</h3>
      <div class="tbl-wrap"><table><thead><tr><th class="l sticky-col">項目</th>${rows8.map((r) => `<th>${r.label}</th>`).join('')}</tr></thead>
      <tbody>${defs.map((d) => `<tr><td class="l sticky-col">${d.label}</td>${rows8.map((r) => { const v = d.get(r); return `<td>${isNum(v) ? (d.tone ? span(v, d.fmt(v)) : d.fmt(v)) : '—'}${d.label.startsWith('EPS(') && r.epsDerived ? '<sup class="muted" title="FinMind 尚未提供,以稅後淨利÷股數估算">估</sup>' : ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
      ${ck ? (ck.match === true ? `<p class="note ok">${ck.year} 年前 ${ck.season} 季累計 EPS:官方公告 ${fnum(ck.official, 2)} 元,與本頁單季加總 ${fnum(ck.finmind, 2)} 元一致${ck.derived ? '(含估算季度)' : ''}。</p>` : ck.match === false ? `<p class="note warn">${ck.year} 年前 ${ck.season} 季累計 EPS:官方 ${fnum(ck.official, 2)} 元,本頁加總 ${fnum(ck.finmind, 2)} 元,有落差,請以官方為準。</p>` : `<p class="note">官方公告 ${ck.year} 年前 ${ck.season} 季累計 EPS ${fnum(ck.official, 2)} 元(單季資料不完整,無法加總核對)。</p>`) : ''}
      <p class="note">${fin ? '金融業財報科目不同,未顯示毛利率與現金流量。' : ''}單季數字由累計財報還原;ROE = 近四季歸屬母公司淨利 ÷ 平均權益;負債比 = 負債 ÷ 資產;自由現金流 = 營業現金流 − 資本支出。</p>
      ${staleNote(f)}</section>`;
  const c8 = rows8, lab = c8.map((r) => r.label);
  mountChart($('#fin-chart'), {
    label: '營收與獲利率', height: 260, labels: lab, xTicks: 8, xFmt: (x) => x.slice(2), fmtL: (v) => fint(v / 1e8), fmtR: (v) => `${fnum(v, 0)}%`,
    series: [
      { type: 'bar', axis: 'l', data: c8.map((r) => r.rev), color: ACC, name: '營收', fmt: (v) => yi(v), dim: (v, i) => i !== c8.length - 1 },
      ...(fin ? [] : [{ type: 'line', axis: 'r', data: c8.map((r) => r.gm), color: UPC, name: '毛利率', fmt: (v) => fnum(v, 1) + '%' }, { type: 'line', axis: 'r', data: c8.map((r) => r.om), color: WARN, name: '營益率', fmt: (v) => fnum(v, 1) + '%' }]),
      { type: 'line', axis: 'r', data: c8.map((r) => r.nm), color: DNC, name: '淨利率', fmt: (v) => fnum(v, 1) + '%' },
    ],
  });
  mountChart($('#eps-chart'), {
    label: '單季每股盈餘', height: 260, labels: lab, xTicks: 8, xFmt: (x) => x.slice(2), fmtL: (v) => fnum(v, 1), fmtR: (v) => fnum(v, 0),
    series: [
      { type: 'bar', axis: 'l', data: c8.map((r) => r.eps), color: (v) => (v >= 0 ? ACC : DNC), name: '單季 EPS', fmt: (v) => fnum(v, 2) + ' 元', dim: (v, i) => i !== c8.length - 1 },
      { type: 'line', axis: 'r', data: c8.map((r) => r.epsTtm), color: WARN, name: '近四季累計', fmt: (v) => fnum(v, 2) + ' 元' },
    ],
  });
}

/* ── 籌碼 ── */
async function tabChips(code, sum, host, id) {
  const c = await api(`/api/stock/${code}/chips`);
  if (id !== S.renderId) return;
  const ins = c.insti;
  if (!ins.length) { host.innerHTML = '<div class="panel"><p class="note">查無三大法人資料。</p></div>'; return; }
  const last = ins[ins.length - 1], day = ins.slice(-20);
  const sumRow = (label, k) => `<tr><td class="l">${label}</td>${['foreign', 'trust', 'dealer', 'total'].map((x) => `<td>${span(c.sums[k][x], fsign(c.sums[k][x]))}</td>`).join('')}</tr>`;
  const mg = c.margin, hold = c.holding;
  const lastM = mg[mg.length - 1], prevM = mg[mg.length - 2];
  host.innerHTML = `
    <section class="panel"><h3>三大法人買賣超<small>單位:張 · 最新 ${esc(dateLabel(last.date))}</small></h3>
      <div class="tbl-wrap"><table><thead><tr><th class="l">區間</th><th>外資</th><th>投信</th><th>自營商</th><th>合計</th></tr></thead>
      <tbody><tr><td class="l"><b>${esc(dateLabel(last.date))}</b></td>${['foreign', 'trust', 'dealer', 'total'].map((x) => `<td>${span(last[x], fsign(last[x]))}</td>`).join('')}</tr>${sumRow('近 5 日', 5)}${sumRow('近 10 日', 10)}${sumRow('近 20 日', 20)}</tbody></table></div>
      <p class="note">紅色為買超、綠色為賣超。外資含外資自營商;自營商含自行買賣與避險。${last.official ? '最新一日取自交易所官方公布。' : ''}</p>
    </section>
    <div class="grid even">
      ${[['foreign', '外資'], ['trust', '投信'], ['dealer', '自營商'], ['total', '三大法人合計']].map(([k, t]) => `<section class="panel"><h3>${t}<small>近 20 日每日買賣超(張)</small></h3><div id="ch-${k}" style="height:150px"></div></section>`).join('')}
    </div>
    <div class="grid even">
      <section class="panel"><h3>融資融券餘額<small>單位:張</small></h3>
        ${mg.length ? `${legend([[UPC, '融資餘額', 1], [DNC, '融券餘額', 1]])}<div id="ch-margin" style="height:200px"></div>
        <p class="note">融資 ${fint(lastM.margin)} 張${prevM ? `(較前日 ${span(lastM.margin - prevM.margin, fsign(lastM.margin - prevM.margin))})` : ''},融券 ${fint(lastM.short)} 張;券資比 ${lastM.margin ? fnum((lastM.short / lastM.margin) * 100, 2) : '—'}%。</p>` : '<p class="note">查無融資融券資料。</p>'}</section>
      <section class="panel"><h3>外資持股比率<small>%</small></h3>
        ${hold.length ? `<div id="ch-hold" style="height:200px"></div><p class="note">外資持股 ${fnum(hold[hold.length - 1].ratio, 2)}%,尚可投資比率 ${fnum(hold[hold.length - 1].remain, 2)}%。</p>` : '<p class="note">查無外資持股資料。</p>'}</section>
    </div>
    ${staleNote(c)}`;
  for (const k of ['foreign', 'trust', 'dealer', 'total']) mountChart($('#ch-' + k), {
    label: k, height: 150, labels: day.map((r) => r.date), xTicks: 5, xFmt: (d) => d.slice(5).replace('-', '/'), fmtL: (v) => fnum(v, 0),
    series: [{ type: 'bar', data: day.map((r) => r[k]), color: signColor, name: '買賣超', fmt: (v) => `${fsign(v)} 張` }],
  });
  if (mg.length) mountChart($('#ch-margin'), {
    label: '融資融券餘額', height: 200, labels: mg.map((r) => r.date), xTicks: 5, xFmt: (d) => d.slice(5).replace('-', '/'), fmtL: fint, fmtR: fint,
    series: [{ type: 'line', axis: 'l', data: mg.map((r) => r.margin), color: UPC, name: '融資餘額', fmt: (v) => fint(v) + ' 張', noDots: true }, { type: 'line', axis: 'r', data: mg.map((r) => r.short), color: DNC, name: '融券餘額', fmt: (v) => fint(v) + ' 張', noDots: true }],
  });
  if (hold.length) mountChart($('#ch-hold'), {
    label: '外資持股比率', height: 200, labels: hold.map((r) => r.date), xTicks: 5, xFmt: (d) => d.slice(5).replace('-', '/'), fmtL: (v) => fnum(v, 1) + '%',
    series: [{ type: 'area', data: hold.map((r) => r.ratio), color: ACC, name: '外資持股', fmt: (v) => fnum(v, 2) + '%', noDots: true }],
  });
}

/* ── 產業 ── */
async function tabIndustry(code, sum, host, id) {
  const [d, news] = await Promise.all([api(`/api/stock/${code}/industry`).catch(() => null), api(`/api/stock/${code}/news`).catch(() => null)]);
  if (id !== S.renderId) return;
  // 這檔股票所屬的產業鏈(櫃買)優先,其次是電子產業細分
  const pills = [], seen = new Set();
  for (const k of ['chain', 'ey']) for (const c of (sum.chains || []).filter((x) => x.kind === k)) if (!seen.has(c.ic)) { seen.add(c.ic); pills.push({ ic: c.ic, name: c.name, kind: k }); }
  const vs = (a, b, unit = '', dec = 1) => (isNum(a) && isNum(b) ? `<span class="s">產業中位數 ${fnum(b, dec)}${unit}</span>` : '');
  const mine = d && d.peers.find((r) => r.code === code);
  host.innerHTML = `
    ${pills.length ? `<section class="panel"><div class="pills" id="chain-pills" role="tablist">${pills.map((c, i) => `<button type="button" class="pill" role="tab" data-ic="${esc(c.ic)}" aria-pressed="${i === 0}">${esc(c.name)}</button>`).join('')}</div><div id="chain-body" style="margin-top:14px"></div></section>`
      : `<section class="panel"><p class="note">這檔沒有收錄在任何產業鏈或細分類裡。</p></section>`}
    ${d ? `<section class="panel"><h3>${esc(d.industry)}<small>上市櫃共 ${d.count} 檔(有行情者)</small><a class="btn sm" style="margin-left:auto" href="${indHref(d.industry)}">查看全部 ${d.count} 檔成分股</a></h3>
      <div class="tiles divided">
        <div class="tile"><span class="k">今日漲跌家數</span><span class="v"><span class="up">${d.up}</span> / <span class="down">${d.down}</span></span><span class="s">中位數漲跌 ${pctSpan(d.medianPct)}</span></div>
        <div class="tile"><span class="k">本益比</span><span class="v">${mine ? fnum(mine.pe, 1) : '—'}</span>${vs(mine && mine.pe, d.medianPe)}</div>
        <div class="tile"><span class="k">股價淨值比</span><span class="v">${mine ? fnum(mine.pb, 2) : '—'}</span>${vs(mine && mine.pb, d.medianPb, '', 2)}</div>
        <div class="tile"><span class="k">殖利率</span><span class="v">${mine && isNum(mine.yield) ? fnum(mine.yield, 2) + '%' : '—'}</span>${vs(mine && mine.yield, d.medianYield, '%', 2)}</div>
        <div class="tile"><span class="k">月營收年增</span><span class="v">${mine ? pctSpan(mine.revYoy, 1) : '—'}</span><span class="s">產業中位數 ${fpct(d.medianRevYoy, 1)}</span></div>
      </div>
      <p class="note" style="margin-top:14px">產業整體月營收年增 <b class="${dir(d.aggRevYoy)}">${fpct(d.aggRevYoy, 1)}</b>(全部公司加總);${d.revYoyCount} 檔有申報的公司中,${d.revYoyPositive} 檔年增為正。外資今日對本產業合計 ${span(d.foreignNet, fsign(Math.round(d.foreignNet)))} 張。</p></section>` : ''}
    ${news && news.industry && news.industry.items.length ? `<section class="panel"><h3>產業新聞<small>近 14 天 · ${esc(news.industry.industry)}</small></h3>${newsList(news.industry.items.slice(0, 10))}</section>` : ''}`;
  const body = $('#chain-body');
  if (!body) return;
  const avg = (stocks) => { const v = stocks.filter((s) => isNum(s.pct) && s.market !== 'ESB').map((s) => s.pct); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const show = async (ic) => {
    body.innerHTML = skeleton(4);
    let c;
    try { c = await api(`/api/chain/${encodeURIComponent(ic)}`); } catch (e) { body.innerHTML = errBox('載入失敗:' + e.message); return; }
    if (id !== S.renderId) return;
    const flat = c.streams.flatMap((st) => st.nodes);
    body.innerHTML = `
      <div class="chain-head"><h3 style="margin:0">${esc(c.chain.kind === 'chain' ? '產業鏈' : c.chain.kindName)}-${esc(c.chain.name)}</h3><a class="btn sm" href="#/chain/${esc(ic)}">完整產業鏈與成分股</a></div>
      ${c.streams.map((st) => `<div class="ntitle">${esc(st.name)}</div><div class="ntiles">${st.nodes.map((n) => { const a = avg(n.stocks), me = n.stocks.some((s) => s.code === code); return `<button type="button" class="ntile ${me ? 'mine' : ''}" data-node="${esc(n.id)}" style="background:${heatColor(a, 3)}" title="${esc(n.name)}"><b>${esc(n.name)}</b><span>${fpct(a)}</span><small>${n.stocks.length} 檔</small></button>`; }).join('')}</div>`).join('')}
      <p class="note">方塊顏色是該環節個股今日平均漲跌(紅漲綠跌);左上角藍標是這檔股票所在的環節。點方塊看該環節的股票。</p>
      <div id="node-detail" class="node-detail"></div>`;
    const detail = (nid) => {
      const n = flat.find((x) => x.id === nid), el = $('#node-detail');
      $$('.ntile', body).forEach((b) => b.classList.toggle('sel', b.dataset.node === nid));
      if (!n) { el.innerHTML = ''; return; }
      el.innerHTML = `<div class="chain-head"><b>${esc(n.name)}</b><span class="muted">${n.stocks.length} 檔 · 平均 ${pctSpan(avg(n.stocks))}</span><a class="btn sm" href="#/chain/${esc(ic)}/${esc(n.id)}">在產業鏈頁開啟</a></div>${n.desc ? `<div class="flow-desc">${esc(n.desc)}</div>` : ''}<div class="stkchips">${n.stocks.map((s) => `<a class="stkchip ${dir(s.pct)} ${s.code === code ? 'me' : ''}" href="#/${esc(s.code)}"><b>${esc(s.name)}</b>${s.market === 'ESB' ? '<small>興櫃</small>' : ''}<span>${isNum(s.pct) ? fpct(s.pct) : ''}</span></a>`).join('')}</div>`;
    };
    body.querySelectorAll('.ntile').forEach((b) => (b.onclick = () => detail(b.dataset.node)));
    const first = flat.find((n) => n.stocks.some((s) => s.code === code));
    if (first) detail(first.id);
  };
  $$('.pill', host).forEach((b) => (b.onclick = () => { $$('.pill', host).forEach((x) => x.setAttribute('aria-pressed', x === b)); show(b.dataset.ic); }));
  if (pills.length) show(pills[0].ic);
}

/* ── 新聞 ── */
const newsList = (items) => `<ul class="news">${items.map((n) => `<li><a href="${/^https?:\/\//.test(n.link) ? esc(n.link) : '#'}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a><div class="m">${esc(n.source || '')}${n.time ? ' · ' + esc(ago(n.time)) : ''}</div></li>`).join('')}</ul>`;
async function tabNews(code, sum, host, id) {
  const n = await api(`/api/stock/${code}/news`);
  if (id !== S.renderId) return;
  const items = (n.stock && n.stock.items) || [];
  host.innerHTML = `
    <div class="grid two">
      <section class="panel"><h3>${esc(sum.name)} 新聞<small>近 30 天 · Google 新聞</small></h3>${items.length ? newsList(items) : '<p class="note">近期沒有找到相關新聞。</p>'}${staleNote(n.stock, '新聞來源')}</section>
      <div class="stack">
        <section class="panel"><h3>今日重大訊息<small>公開資訊觀測站</small></h3>${sum.announcementList.length ? sum.announcementList.map(annHtml).join('') : '<p class="note">今天沒有這檔的重大訊息。</p>'}
          <p class="note">官方公開的「每日重大訊息」只提供當天;歷史訊息請至公開資訊觀測站查詢。</p></section>
        ${n.industry && n.industry.items.length ? `<section class="panel"><h3>產業新聞<small>${esc(n.industry.industry)} · 近 14 天</small></h3>${newsList(n.industry.items.slice(0, 8))}</section>` : ''}
      </div>
    </div>
    <p class="note">新聞標題與連結來自 Google 新聞,內容版權屬原媒體;其中可能包含個人部落格與看盤評論,請自行判斷。</p>`;
}

/* ───────── 樹狀圖(熱力圖)引擎 ───────── */
function squarify(items, x, y, w, h) {
  const out = [], total = items.reduce((a, i) => a + i.value, 0);
  if (!total || w <= 0 || h <= 0) return out;
  let rest = items.map((i) => ({ i, a: (i.value / total) * w * h }));
  while (rest.length) {
    const short = Math.min(w, h);
    const worst = (r, s) => { const mx = Math.max(...r.map((z) => z.a)), mn = Math.min(...r.map((z) => z.a)); return Math.max((short * short * mx) / (s * s), (s * s) / (short * short * mn)); };
    let row = [rest[0]], sum = rest[0].a, k = 1;
    while (k < rest.length) {
      const nr = row.concat(rest[k]), ns = sum + rest[k].a;
      if (worst(nr, ns) <= worst(row, sum)) { row = nr; sum = ns; k++; } else break;
    }
    const thick = sum / short;
    if (w >= h) { let cy = y; for (const r of row) { const hh = r.a / thick; out.push({ item: r.i, x, y: cy, w: thick, h: hh }); cy += hh; } x += thick; w -= thick; }
    else { let cx = x; for (const r of row) { const ww = r.a / thick; out.push({ item: r.i, x: cx, y, w: ww, h: thick }); cx += ww; } y += thick; h -= thick; }
    rest = rest.slice(k);
  }
  return out;
}
const HM_N = [74, 84, 101], HM_UP = [224, 54, 74], HM_DN = [16, 157, 104];
function heatColor(p, scale) {
  if (!isNum(p)) return 'rgb(58,66,82)';
  const t = Math.min(1, Math.abs(p) / scale) ** 0.75, c = p >= 0 ? HM_UP : HM_DN;
  return `rgb(${[0, 1, 2].map((i) => Math.round(HM_N[i] + (c[i] - HM_N[i]) * t)).join(',')})`;
}
const hmHeight = () => (innerWidth < 860 ? 560 : Math.max(500, Math.min(780, Math.round(innerHeight * 0.74))));
function tileHtml(it, r, scale, idx, href, extra) {
  const px = (n) => `${Math.max(0, n).toFixed(1)}px`;
  const fs = Math.max(9, Math.min(22, Math.sqrt(r.w * r.h) / 6));
  let inner = '';
  const nm = String(it.name);
  const fitName = Math.min(fs, (r.w - 6) / Math.max(1.2, nm.length * 0.98));
  if (r.w >= 22 && r.h >= 15 && fitName >= 8.5) {
    inner = `<b style="font-size:${fitName.toFixed(1)}px">${esc(nm)}</b>`;
    if (r.h >= fitName * 2.4) inner += `<span style="font-size:${Math.max(9, fitName * 0.9).toFixed(1)}px">${fpct(it.pct, 2)}</span>`;
    if (extra && r.h >= fitName * 4.2 && r.w >= 84) inner += `<small style="font-size:${Math.max(9, fitName * 0.8).toFixed(1)}px">${esc(extra)}</small>`;
  }
  return `<a class="tm-tile" href="${href}" data-i="${idx}" style="left:${px(r.x)};top:${px(r.y)};width:${px(r.w)};height:${px(r.h)};background:${heatColor(it.pct, scale)}">${inner}</a>`;
}
function bindTreemap(host, items, tipFn) {
  host.onpointermove = (e) => { const t = e.target.closest('.tm-tile'); if (t) showTip(tipFn(items[+t.dataset.i]), e.clientX, e.clientY); else hideTip(); };
  host.onpointerleave = hideTip;
}
function mountTree(host, draw) {
  const run = () => { host.innerHTML = ''; draw(Math.max(320, host.clientWidth)); };
  run();
  let w = host.clientWidth;
  const ro = new ResizeObserver(() => { if (!host.isConnected) { ro.disconnect(); return; } if (Math.abs(host.clientWidth - w) > 3) { w = host.clientWidth; run(); } });
  ro.observe(host);
}
/** 單層:一個方塊一個項目 */
function treemapFlat(host, items, { scale, height, href, tip, extra }) {
  host.style.height = `${height}px`;
  mountTree(host, (W) => {
    const rects = squarify([...items].sort((a, b) => b.value - a.value), 0, 0, W, height);
    const list = rects.map((r) => r.item);
    host.innerHTML = rects.map((r, i) => tileHtml(r.item, r, scale, i, href(r.item), extra && extra(r.item))).join('');
    bindTreemap(host, list, tip);
  });
}
/** 兩層:產業 → 個股 */
function treemapGrouped(host, stocks, { by, scale, height }) {
  host.style.height = `${height}px`;
  const val = (s) => (by === 'value' ? s.v : by === 'sqrt' ? Math.sqrt(s.m) : s.m);
  const groups = new Map();
  for (const s of stocks) { const v = val(s); if (!(v > 0)) continue; const g = groups.get(s.i) || { name: s.i, items: [], value: 0, sp: 0, n: 0 }; g.items.push({ ...s, name: s.n, pct: s.p, value: v }); g.value += v; g.sp += s.p; g.n++; groups.set(s.i, g); }
  const glist = [...groups.values()].sort((a, b) => b.value - a.value);
  mountTree(host, (W) => {
    let html = '';
    const all = [];
    for (const r of squarify(glist, 0, 0, W, height)) {
      const g = r.item, strip = r.h >= 44 && r.w >= 64 ? 18 : 0, gp = g.n ? g.sp / g.n : null;
      const inner = squarify(g.items.sort((a, b) => b.value - a.value), r.x, r.y + strip, r.w, r.h - strip);
      for (const t of inner) { const idx = all.length; all.push(t.item); html += tileHtml(t.item, t, scale, idx, `#/${t.item.c}`, t.item.x ? `${price(t.item.x)}` : ''); }
      if (strip) html += `<a class="tm-group" href="${indHref(g.name)}" title="查看 ${esc(g.name)} 的全部股票" style="left:${r.x.toFixed(1)}px;top:${r.y.toFixed(1)}px;width:${r.w.toFixed(1)}px;height:${strip}px">${esc(g.name)}<em style="color:${gp >= 0 ? '#ff9aa4' : '#7fe3b5'}">${fpct(gp, 2)}</em></a>`;
    }
    host.innerHTML = html;
    bindTreemap(host, all, (s) => `<b>${esc(s.n)} <span class="muted">${esc(s.c)}</span></b><div class="r"><span>收盤</span><span class="${dir(s.p)}">${price(s.x)} (${fpct(s.p)})</span></div><div class="r"><span>市值</span><span>${money(s.m)}</span></div><div class="r"><span>成交值</span><span>${money(s.v)}</span></div><div class="r"><span>產業</span><span>${esc(s.i)}</span></div>`);
  });
}
const segHtml = (name, opts, cur) => `<span class="seg" data-seg="${name}">${opts.map(([v, t]) => `<button type="button" data-v="${v}" aria-pressed="${String(v) === String(cur)}">${t}</button>`).join('')}</span>`;
function bindSeg(root, onChange) {
  $$('.seg[data-seg]', root).forEach((sg) => sg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', sg).forEach((x) => x.setAttribute('aria-pressed', x === b));
    onChange(sg.dataset.seg, b.dataset.v);
  }));
}
const scaleLegend = (scale) => `<span class="scale">−${scale}%<i></i>+${scale}%<span style="margin-left:6px">綠跌 · 紅漲</span></span>`;
const yiSign = (v, d = 1) => (isNum(v) ? span(v, `${v > 0 ? '+' : ''}${yi(v, d)}`) : '—');

/* ───────── 通用資料表 ───────── */
function dataTable(host, cols, rows, { href, sort } = {}) {
  let st = sort || { key: null, dir: -1 };
  const draw = () => {
    const col = cols.find((c) => c.k === st.key);
    const list = [...rows];
    if (col) list.sort((a, b) => { const x = col.get(a), y = col.get(b); const nx = col.text ? x == null : !isNum(x), ny = col.text ? y == null : !isNum(y); if (nx) return 1; if (ny) return -1; return (col.text ? String(x).localeCompare(String(y)) : x - y) * st.dir; });
    host.innerHTML = `<div class="tbl-wrap"><table><thead><tr>${cols.map((c) => `<th class="sort ${c.cls || ''}" data-k="${c.k}" tabindex="0" ${st.key === c.k ? `aria-sort="${st.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${list.map((r) => `<tr class="row" data-href="${href ? esc(href(r)) : ''}">${cols.map((c) => `<td class="${c.cls || ''}">${c.html(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    const sortBy = (k) => { const c = cols.find((x) => x.k === k); st = st.key === k ? { key: k, dir: -st.dir } : { key: k, dir: c.text ? 1 : -1 }; draw(); };
    $$('th.sort', host).forEach((th) => { th.onclick = () => sortBy(th.dataset.k); th.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(th.dataset.k); } }; });
  };
  draw();
  host.onclick = async (e) => {
    const add = e.target.closest('[data-add]');
    if (add) { e.stopPropagation(); await addCodes([add.dataset.add]); toast('已加入自選股'); add.replaceWith(Object.assign(document.createElement('span'), { className: 'muted', textContent: '已加入' })); return; }
    if (e.target.closest('a,button')) return;
    const tr = e.target.closest('tr.row'); if (tr && tr.dataset.href) location.hash = tr.dataset.href;
  };
}
const stockCell = (r) => `<b>${esc(r.name)}</b><small>${esc(r.code)}<span class="mkt">${mktName(r.market)}</span></small>`;
const addCell = (r) => (S.watch.includes(r.code) ? '<span class="muted">已加入</span>' : `<button class="btn sm" data-add="${r.code}">加入</button>`);

/* ───────── 供應鏈 ───────── */
async function renderSupply(main, tid, id) {
  if (tid) return renderSupplyTheme(main, tid, id);
  main.innerHTML = `<div class="panel">${skeleton(8)}</div>`;
  let d;
  try { d = await api('/api/supply'); }
  catch (e) { if (id !== S.renderId) return; main.innerHTML = errBox('供應鏈資料暫時無法取得:' + e.message, true); main.querySelector('[data-retry]').onclick = () => { apiCache.clear(); route(); }; return; }
  if (id !== S.renderId) return;
  const nz = (v) => String(v || '').replace(/[\s　]/g, '').replace(/臺/g, '台').toLowerCase();
  const TABS = [['theme', '整理的題材'], ['chain', '產業鏈(官方)'], ['ey', '電子產業細分'], ['concept', '概念股'], ['group', '集團股']];
  const LISTS = { chain: d.chains, ey: d.ey, concept: d.concepts, group: d.groups };
  const HINT = {
    chain: '櫃買中心產業價值鏈資訊平台(官方),每一條都分上游、中游、下游的環節,例如被動元件、印刷電路板(含銅箔、銅箔基板)。',
    ey: 'Yahoo 奇摩股市的電子產業細分,依各公司所屬產業鏈自動分組。',
    concept: 'Yahoo 奇摩股市的概念股(AI、蘋果供應鏈、低軌衛星…),Yahoo 新增題材時會自動出現並標示「新」。',
    group: 'Yahoo 奇摩股市的集團股(鴻海、台塑、國巨…)。',
  };
  const chip = (c, sub) => `<a class="sc-chip" href="#/supply/${esc(c.id)}"><span class="n">${esc(c.name)}</span><small>${sub || c.count}</small>${c.isNew ? '<span class="new" title="Yahoo 近期新增的題材">新</span>' : ''}${isNum(c.pct) ? `<span class="p ${dir(c.pct)}">${fpct(c.pct, 1)}</span>` : ''}</a>`;
  const card = (c) => `<a class="sc-card" href="#/supply/${esc(c.id)}"><b>${esc(c.name)}</b><span class="d">${esc(c.desc)}</span><span class="m">${c.branches} 個環節 · ${c.count} 家 · 平均 ${pctSpan(c.pct)}</span></a>`;
  const none = d.uncategorized ? `<p class="note">另外有 ${d.uncategorized} 檔上市櫃公司沒有出現在任何產業鏈、細分、概念股或集團股,<a href="#/supply/none">查看這些公司</a>。</p>` : '';
  const draw = () => {
    const q = nz($('#sc-filter').value), body = $('#sc-body');
    if (q) {
      const hit = (arr) => arr.filter((c) => nz(c.name).includes(q));
      const th = d.curated.filter((c) => nz(c.name + c.desc).includes(q));
      const nodes = d.nodes.filter((n) => nz(n.name).includes(q) || nz(n.chainName).includes(q) && q.length >= 2).slice(0, 80);
      const sec = (title, html) => (html ? `<section class="panel"><h3>${title}</h3>${html}</section>` : '');
      const chipsOf = (arr) => (arr.length ? `<div class="sc-chips">${arr.map((c) => chip(c)).join('')}</div>` : '');
      const html = sec('整理的題材', th.length ? `<div class="sc-cards">${th.map(card).join('')}</div>` : '')
        + sec(`產業鏈的環節(${nodes.length})`, nodes.length ? `<div class="sc-chips">${nodes.map((n) => `<a class="sc-chip" href="#/supply/${esc(n.chain)}/${esc(n.id)}"><span class="n">${esc(n.name)}</span><small>${esc(n.chainName)}・${esc(n.stream)}・${n.count} 家</small></a>`).join('')}</div>` : '')
        + sec('產業鏈', chipsOf(hit(d.chains))) + sec('電子產業細分', chipsOf(hit(d.ey))) + sec('概念股', chipsOf(hit(d.concepts))) + sec('集團股', chipsOf(hit(d.groups)));
      body.innerHTML = html || `<section class="panel"><p class="note">找不到「${esc($('#sc-filter').value)}」。試試別的關鍵字,例如 銅箔、電容、AI、衛星。</p></section>`;
      return;
    }
    const tab = S.supTab || 'theme';
    if (tab === 'theme') {
      body.innerHTML = `<section class="panel"><h3>整理的題材<small>有環節與角色說明 · 整理資料、僅供參考(${esc(d.updated || '')})</small></h3>
        <div class="sc-cards">${d.curated.map(card).join('') || '<p class="note">沒有整理的題材。</p>'}</div></section>${none}
        <p class="note">${esc(d.note || '')}</p>`;
    } else {
      const list = LISTS[tab] || [];
      body.innerHTML = `<section class="panel"><h3>${TABS.find((t) => t[0] === tab)[1]}<small>共 ${list.length} 個 · ${HINT[tab]}</small></h3>
        <div class="sc-chips">${list.map((c) => chip(c, tab === 'chain' ? `${c.nodes} 環節・${c.count} 家` : c.count)).join('') || '<p class="note">暫時取不到清單。</p>'}</div></section>${tab === 'chain' ? none : ''}`;
    }
  };
  main.innerHTML = `
    <div class="page-head"><div><h1>供應鏈</h1><div class="sub">看哪些公司打進哪條供應鏈、在哪個環節、做什麼。點題材看樹狀圖,點公司看角色說明和最新新聞。</div></div></div>
    <div class="controls" style="margin:0 0 12px"><span class="grp">${segHtml('sv', TABS, S.supTab || 'theme')}</span>
      <input id="sc-filter" class="sc-filter" type="search" placeholder="搜尋題材或環節,例如 銅箔、電容、AI、衛星" aria-label="搜尋題材或環節" autocomplete="off"></div>
    <div id="sc-body"></div>`;
  bindSeg(main, (k, v) => { if (k === 'sv') { S.supTab = v; $('#sc-filter').value = ''; draw(); } });
  $('#sc-filter').oninput = draw;
  draw();
}

async function renderSupplyTheme(main, tid, id) {
  main.innerHTML = `<div class="panel">${skeleton(10)}</div>`;
  let d;
  try { d = await api(`/api/supply/${encodeURIComponent(tid)}`); }
  catch (e) { if (id !== S.renderId) return; main.innerHTML = `<div class="crumb"><a href="#/supply">供應鏈</a></div>${errBox(`找不到這個題材「${tid}」:${e.message}`)}`; return; }
  if (id !== S.renderId) return;
  if (S.scRO) { S.scRO.disconnect(); S.scRO = null; }
  const focus = S.route.focus || null;
  const branches = d.branches.map((b) => ({ ...b }));
  for (const ob of d.otherBranches || []) branches.push(ob);
  const main7 = d.branches.flatMap((b) => b.companies).filter((c) => d.kind !== 'curated' || (!c.official && !c.auto && !c.unverified));
  const uniq = [...new Map(main7.map((c) => [c.code, c])).values()];
  const traded = uniq.filter((c) => isNum(c.pct));
  const avg = traded.length ? traded.reduce((a, c) => a + c.pct, 0) / traded.length : null;
  const upN = traded.filter((c) => c.pct > 0).length, dnN = traded.filter((c) => c.pct < 0).length;
  const tint = (p) => (isNum(p) && p !== 0 ? `background:color-mix(in srgb, var(${p > 0 ? '--up' : '--down'}) ${Math.round(6 + Math.min(1, Math.abs(p) / 6) * 20)}%, var(--panel2))` : '');
  const hid = (c) => c.official || c.unverified;
  const evTip = (c) => (c.ev ? (c.evStatus === 'confirmed' ? `近一年有 ${c.ev.strong} 則報導把它列為這條供應鏈(標題同時有公司名稱、題材字眼與供貨、打入、認證等字眼)` : `有報導把它和這個題材一起提(供應鏈報導 ${c.ev.strong} 則、題材報導 ${c.ev.weak} 則),但沒有足夠明確的供應商報導`) : '');
  const coHtml = (c) => `<div class="sc-co${hid(c) ? ' extra' : ''} ${isNum(c.pct) && c.pct > 0 ? 'sc-up' : isNum(c.pct) && c.pct < 0 ? 'sc-down' : ''}" data-code="${esc(c.code)}" style="${tint(c.pct)}"${hid(c) ? ' hidden' : ''} title="${esc(`${c.name} ${c.code}・${c.role || ''}・收盤 ${isNum(c.close) ? c.close : '—'}・市值 ${isNum(c.mcap) ? (c.mcap / 1e8).toFixed(0) + ' 億' : '—'}`)}">
      <div class="cotop"><a class="nm" href="#/${esc(c.code)}"><b>${esc(c.name)}</b><small>${esc(c.code)}</small></a>${c.auto ? '<em class="auto" title="依 Yahoo 概念股與產業細分自動歸類,說明是它所屬的產業細分,不是人工整理的角色">自動</em>' : ''}${c.official ? '<em class="auto" title="櫃買中心官方產業鏈同一個環節的公司,說明是它在產業鏈的位置;不代表已證實屬於這個題材">官方</em>' : ''}${c.unverified ? '<em class="auto" title="近一年沒有找到報導把它列入這個題材,先收合">未證實</em>' : ''}${c.evStatus === 'confirmed' ? `<em class="ev ok" title="${esc(evTip(c))}">供應鏈</em>` : c.evStatus === 'theme' ? `<em class="ev th" title="${esc(evTip(c))}">題材</em>` : ''}<span class="pc">${pctSpan(c.pct)}</span></div>
      <div class="role">${esc(c.role || '')}</div>
      <button type="button" class="sc-nb" aria-expanded="false" title="看這家公司跟這個題材有關的新聞">新聞</button>
      <div class="sc-co-b" hidden></div></div>`;
  const brHtml = (b, i) => {
    const t = b.companies.filter((c) => isNum(c.pct)); const a = t.length ? t.reduce((s, c) => s + c.pct, 0) / t.length : null;
    const open = !b.others;
    return `<section class="sc-branch${b.others ? ' others' : ''}" data-i="${i}" data-bid="${esc(b.id || '')}">
      <button type="button" class="sc-node branch" aria-expanded="${open}"><span class="bn">${b.stream ? `<em class="stp">${esc(b.stream)}</em>` : ''}<b>${esc(b.name)}</b>${b.desc ? `<small>${esc(b.desc)}</small>` : ''}</span><span class="bm">${b.companies.length} 家 · 平均 ${pctSpan(a)}</span><i class="chev" aria-hidden="true"></i></button>
      <div class="sc-leaves"${open ? '' : ' hidden'}>${b.companies.map(coHtml).join('')}${b.companies.some(hid) ? `<button type="button" class="sc-more" data-n="${b.companies.filter(hid).length}">＋ 另外 ${b.companies.filter(hid).length} 家(官方產業鏈同環節、未找到報導)</button>` : ''}</div></section>`;
  };
  main.innerHTML = `
    <div class="crumb"><a href="#/supply">供應鏈</a><span>›</span><span>${esc(d.name)}</span></div>
    <div class="page-head"><div><h1>${esc(d.name)}</h1><div class="sub">${esc(d.desc)}</div></div><div class="asof">收盤資料 <b>${esc(dateLabel(d.date))}</b>${d.kind === 'chain' || d.kind === 'auto' ? `<br><a href="#/chain/${esc(d.id)}" class="chip accent">看熱力圖與明細</a>` : ''}</div></div>
    <section class="panel"><div class="tiles divided">
      <div class="tile"><span class="k">${{ curated: '整理的公司', chain: '產業鏈公司', none: '公司' }[d.kind] || '分類成員'}</span><span class="v">${uniq.length}<small> 家</small></span><span class="s">${d.kind === 'curated' && d.evidenceDate ? (() => { const all = [...new Map(d.branches.flatMap((b) => b.companies).filter((c) => !c.official && !c.auto).map((c) => [c.code, c])).values()]; return `供應鏈 ${all.filter((c) => c.evStatus === 'confirmed').length} · 題材 ${all.filter((c) => c.evStatus === 'theme').length} · 未證實 ${all.filter((c) => c.unverified).length}`; })() : `${d.branches.length} 個${d.kind === 'curated' || d.kind === 'chain' ? '環節' : '分類'}`}</span></div>
      <div class="tile"><span class="k">平均漲跌</span><span class="v ${dir(avg)}">${fpct(avg)}</span><span class="s">每檔權重相同</span></div>
      <div class="tile"><span class="k">漲 / 跌家數</span><span class="v"><span class="up">${upN}</span> / <span class="down">${dnN}</span></span><span class="s">共 ${traded.length} 檔有行情</span></div>
      ${d.coverage ? `<div class="tile"><span class="k">Yahoo 概念股也列入</span><span class="v">${d.coverage.inYahoo}<small> / ${d.coverage.total}</small></span><span class="s">${esc((d.crossCheck || []).join('、'))} · 另有 ${d.coverage.auto} 家自動歸類</span></div>` : ''}
    </div>
    ${d.kind === 'curated' ? `<p class="note" style="margin-top:12px"><b>怎麼驗證的</b>:整理的每家公司都查了近一年的新聞標題(${esc(d.evidenceDate || '尚未驗證')})。「供應鏈」= 至少 2 則報導的標題同時有公司名稱、題材字眼和供貨 / 打入 / 認證 / 訂單等字眼;「題材」= 有報導把它和這個題材一起提,但沒有明確說是供應商;找不到報導的標「未證實」並收合。這是公開報導的證據(滑過標記看說明、點「新聞」看證據標題),不是官方認證名單;角色說明是我的概括描述。「自動」是 Yahoo 概念股列入再依產業細分歸類,「官方」是櫃買中心官方產業鏈同環節的其他公司,都不代表已證實,預設收合。整理日期 ${esc(d.updated || '')}。</p>` : `<p class="note" style="margin-top:12px">${esc(d.desc)} 公司旁的說明是它在櫃買中心產業鏈裡的位置。</p>`}</section>
    <div class="controls" style="margin:14px 0 6px"><button class="btn sm" id="sc-all">全部展開</button><button class="btn sm" id="sc-none">全部收合</button>${branches.some((b) => b.companies.some(hid)) ? '<button class="btn sm" id="sc-extra">顯示收合的公司</button>' : ''}<span class="muted" style="font-size:12.5px">點環節收合 / 展開;點公司名稱到個股頁,點「新聞」看相關新聞;依公司市值由大到小排</span></div>
    <div class="sc" id="sc"><svg class="sc-lines" id="sc-lines" aria-hidden="true"></svg>
      <div class="sc-rootcol"><div class="sc-node root"><b>${esc(d.anchor)}</b><small>${esc(d.name)}</small></div></div>
      <div class="sc-branches">${branches.map((b, i) => `${b.stream && (i === 0 || branches[i - 1].stream !== b.stream) ? `<div class="sc-stream"><span>${esc(b.stream)}</span></div>` : ''}${brHtml(b, i)}`).join('')}</div></div>
    <p class="note">新聞取自 Google 新聞,以「公司名稱 + 題材關鍵字」搜尋近 90 天,僅供參考;顏色紅漲綠跌,漲跌幅為最近一個交易日。</p>`;

  const sc = $('#sc'), svg = $('#sc-lines');
  const draw = () => {
    if (!sc.isConnected) return;
    const wide = innerWidth >= 860;
    svg.style.display = wide ? '' : 'none';
    if (!wide) return;
    const box = sc.getBoundingClientRect();
    svg.setAttribute('width', box.width); svg.setAttribute('height', box.height);
    const rel = (el) => { const r = el.getBoundingClientRect(); return { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, m: r.top + r.height / 2 - box.top, b: r.bottom - box.top }; };
    const root = rel(sc.querySelector('.sc-node.root'));
    const nodes = [...sc.querySelectorAll('.sc-branch')].map((br) => ({ br, n: rel(br.querySelector('.sc-node.branch')) }));
    if (!nodes.length) { svg.innerHTML = ''; return; }
    let k = '', l = '', dots = '';
    // 根 → 主幹 → 每個環節(骨幹加樹枝)
    const trunkX = Math.round((root.r + nodes[0].n.l) / 2);
    k += `M${root.r} ${root.m}H${trunkX}`;
    k += `M${trunkX} ${root.m}V${nodes[nodes.length - 1].n.m}`;
    for (const { n } of nodes) { k += `M${trunkX} ${n.m}H${n.l - 1}`; dots += `<circle cx="${n.l - 1}" cy="${n.m}" r="3.5" class="k"/>`; }
    dots += `<circle cx="${root.r}" cy="${root.m}" r="3.5" class="k"/>`;
    // 環節 → 自己的小主幹 → 每一家公司
    for (const { br, n } of nodes) {
      const lv = br.querySelector('.sc-leaves');
      if (lv.hidden) continue;
      const all = [...lv.querySelectorAll(':scope > .sc-co:not([hidden])')].map(rel);
      if (!all.length) continue;
      // 一排放很多張卡片:每一排最左邊那張接一條樹枝(同一排的用上緣判斷)
      const minL = Math.min(...all.map((c) => c.l));
      const cos = all.filter((c) => c.l - minL < 4);
      const spineX = Math.round(rel(lv).l - 14);
      const top = Math.min(n.m, cos[0].t + 18), bot = Math.max(n.m, cos[cos.length - 1].t + 18);
      l += `M${n.r + 1} ${n.m}H${spineX}M${spineX} ${top}V${bot}`;
      for (const c of cos) { const y = c.t + 18; l += `M${spineX} ${y}H${c.l - 1}`; dots += `<circle cx="${c.l - 1}" cy="${y}" r="2.6" class="l"/>`; }
      dots += `<circle cx="${n.r + 1}" cy="${n.m}" r="3.2" class="l"/>`;
    }
    svg.innerHTML = `<path class="k" d="${k}"/><path class="l" d="${l}"/>${dots}`;
  };
  draw();
  if (window.ResizeObserver) { S.scRO = new ResizeObserver(draw); S.scRO.observe(sc); }

  const toggleCo = async (co) => {
    const h = co.querySelector('.sc-nb'), body = co.querySelector('.sc-co-b');
    const open = h.getAttribute('aria-expanded') !== 'true';
    h.setAttribute('aria-expanded', open); body.hidden = !open; co.classList.toggle('open', open);
    if (!open || body.dataset.ready) { draw(); return; }
    body.dataset.ready = '1';
    const code = co.dataset.code;
    const c = branches.flatMap((b) => b.companies).find((x) => x.code === code);
    body.innerHTML = `<div class="sc-co-i">
      <div class="r"><span class="k">行情</span><span>收盤 ${pxTag(c.close, c.limit, dir(c.pct))} ${pctSpan(c.pct)} · 成交值 ${money(c.value)} · 市值 ${money(c.mcap)} · ${esc(c.industry)}</span></div>
      ${c.ev && c.ev.items && c.ev.items.length ? `<div class="r"><span class="k">報導證據</span><span>${newsList(c.ev.items)}<span class="muted" style="font-size:12px">${esc(evTip(c) || '近一年的報導')}</span></span></div>` : (c.ev ? '<div class="r"><span class="k">報導證據</span><span class="muted">近一年沒有找到把它列入這個題材的報導</span></div>' : '')}
      <div class="r"><span class="k">近期新聞</span><span class="sc-news muted">載入中…</span></div>
      <div class="acts"><a class="btn sm" href="#/${esc(code)}">看個股頁</a>${S.watch.includes(code) ? '<span class="muted">已在自選股</span>' : `<button class="btn sm" data-add="${esc(code)}">加入自選股</button>`}</div></div>`;
    draw();
    try {
      const n = await api(`/api/supply/${encodeURIComponent(tid)}/news/${encodeURIComponent(code)}`);
      if (id !== S.renderId) return;
      const el = body.querySelector('.sc-news');
      el.className = 'sc-news';
      el.innerHTML = n.items.length ? newsList(n.items) : '<span class="muted">近 90 天沒有找到相關新聞</span>';
    } catch (e) { const el = body.querySelector('.sc-news'); if (el) el.textContent = '新聞暫時無法取得'; }
    draw();
  };
  const setAll = (open) => {
    $$('#sc .sc-branch').forEach((br) => { br.querySelector('.sc-node.branch').setAttribute('aria-expanded', open); br.querySelector('.sc-leaves').hidden = !open; });
    draw();
  };
  $('#sc-all').onclick = () => setAll(true);
  $('#sc-none').onclick = () => setAll(false);
  const setExtra = (lv, show) => { lv.querySelectorAll(':scope > .sc-co.extra').forEach((x) => { x.hidden = !show; }); const m = lv.querySelector(':scope > .sc-more'); if (m) m.textContent = show ? '－ 收合' : `＋ 另外 ${m.dataset.n} 家(官方產業鏈同環節、未找到報導)`; };
  const ex = $('#sc-extra');
  if (ex) ex.onclick = () => { const show = ex.dataset.on !== '1'; ex.dataset.on = show ? '1' : ''; ex.textContent = show ? '隱藏收合的公司' : '顯示收合的公司'; $$('#sc .sc-leaves').forEach((lv) => { if (!lv.hidden) setExtra(lv, show); }); draw(); };
  sc.addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add]');
    if (add) { await addCodes([add.dataset.add]); toast('已加入自選股'); add.replaceWith(Object.assign(document.createElement('span'), { className: 'muted', textContent: '已在自選股' })); return; }
    if (e.target.closest('a')) return;
    const more = e.target.closest('.sc-more');
    if (more) { const lv = more.parentElement; setExtra(lv, !!lv.querySelector(':scope > .sc-co.extra[hidden]')); draw(); return; }
    const bn = e.target.closest('.sc-node.branch');
    if (bn) { const open = bn.getAttribute('aria-expanded') !== 'true'; bn.setAttribute('aria-expanded', open); bn.parentElement.querySelector('.sc-leaves').hidden = !open; draw(); return; }
    const hd = e.target.closest('.sc-nb');
    if (hd) toggleCo(hd.closest('.sc-co'));
  });
  if (focus) {
    const br = [...sc.querySelectorAll('.sc-branch')].find((x) => x.dataset.bid && x.dataset.bid === focus);
    if (br) { br.classList.add('flash'); br.scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); setTimeout(() => br.classList.remove('flash'), 2400); }
    const co = sc.querySelector(`.sc-co[data-code="${CSS.escape(focus)}"]`);
    if (co && co.hidden) co.hidden = false;
    if (co) { const lv = co.closest('.sc-leaves'); if (lv.hidden) { lv.hidden = false; lv.parentElement.querySelector('.sc-node.branch').setAttribute('aria-expanded', 'true'); } toggleCo(co); co.scrollIntoView({ block: 'center' }); }
  }
}

/* ───────── 展開看全部(彈出視窗) ───────── */
const EXPAND_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';
const expandBtn = (what) => `<button class="expand-btn" data-expand="${what}" title="展開看全部" aria-label="展開看全部">${EXPAND_SVG}</button>`;
function closeModal() { const m = document.getElementById('modal'); if (m) m.remove(); document.body.classList.remove('modal-open'); }
function openModal(title, sub, html) {
  closeModal();
  const el = document.createElement('div');
  el.className = 'modal-back'; el.id = 'modal';
  el.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h3>${esc(title)}<small>${esc(sub)}</small></h3><button class="modal-x" aria-label="關閉">✕</button></div><div class="modal-body">${html}</div></div>`;
  document.body.appendChild(el);
  document.body.classList.add('modal-open');
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('.modal-x')) closeModal(); });
  el.querySelector('.modal-x').focus();
  return el.querySelector('.modal-body');
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
window.addEventListener('hashchange', closeModal);

/** 漲幅榜 / 跌幅榜:列出全部個股;預設只算成交值 5 千萬以上(跟榜單一致),可勾選包含全部 */
async function openMovers(kind) {
  const up = kind === 'gainers';
  const body = openModal(up ? '漲幅榜' : '跌幅榜', '全部個股,不含 ETF', skeleton(8));
  let d;
  try { d = await api('/api/movers'); } catch (e) { body.innerHTML = errBox('資料暫時無法取得:' + e.message); return; }
  let all = false;
  const draw = () => {
    const rows = d.rows.filter((r) => (up ? r.pct > 0 : r.pct < 0) && (all || (r.value || 0) >= 5e7));
    const list = up ? rows : rows.reverse();
    body.innerHTML = `<div class="modal-tools"><label class="chk"><input type="checkbox" id="mv-all" ${all ? 'checked' : ''}> 包含成交值不足 5 千萬的股票</label><span class="muted">共 ${list.length} 檔 · 收盤 ${esc(dateLabel(d.date))}</span></div>
      <ol class="rank-list">${list.map((r, i) => `<li data-code="${esc(r.code)}"><span class="n">${i + 1}</span><span><b>${esc(r.name)}</b><small>${esc(r.code)} · ${esc(r.industry)} · 成交值 ${money(r.value)}</small></span>${pxTag(r.close, r.limit, dir(r.pct))}<span>${pctSpan(r.pct)}</span></li>`).join('') || '<li class="muted">沒有符合的股票</li>'}</ol>`;
    body.querySelector('#mv-all').onchange = (e) => { all = e.target.checked; draw(); };
  };
  draw();
  body.addEventListener('click', (e) => { const li = e.target.closest('.rank-list li[data-code]'); if (li) location.hash = `#/${li.dataset.code}`; });
}
/** 強勢 / 弱勢類股:列出全部分類 */
function openStrength(up) {
  const f = S.rankFull;
  if (!f) return;
  const list = up ? f.sorted : [...f.sorted].reverse();
  openModal(`${up ? '強勢' : '弱勢'}${f.label}`, `共 ${list.length} 個,成分股平均漲跌`, f.bars(list, up));
}

/* ───────── 台股總覽 ───────── */
async function renderMarket(main, id) {
  main.innerHTML = `<div class="panel">${skeleton(9)}</div>`;
  let d;
  try { d = await api('/api/market'); }
  catch (e) { if (id !== S.renderId) return; main.innerHTML = errBox('大盤資料暫時無法取得:' + e.message, true); main.querySelector('[data-retry]').onclick = () => route(); return; }
  if (id !== S.renderId) return;
  const tw = d.twse.history, tl = tw[tw.length - 1], tp = tw[tw.length - 2];
  const ot = d.tpex.history, ol = ot[ot.length - 1];
  if (!tl) { main.innerHTML = errBox('目前取不到加權指數資料,請稍後再試。', true); main.querySelector('[data-retry]').onclick = () => { apiCache.clear(); route(); }; return; }
  const twPct = tl.change !== null ? (tl.change / (tl.index - tl.change)) * 100 : null;
  const otPct = ol && ol.change !== null ? (ol.change / (ol.index - ol.change)) * 100 : null;
  const valChg = tp && tp.value ? (tl.value / tp.value - 1) * 100 : null;
  const br = (b) => { const t = b.up + b.down + b.flat || 1; return `<div class="fact"><span class="v"><span class="up">${b.up} 漲</span> · <span class="down">${b.down} 跌</span> · ${b.flat} 平</span><div class="breadth" aria-hidden="true"><i class="u" style="width:${(b.up / t) * 100}%"></i><i class="f" style="width:${(b.flat / t) * 100}%"></i><i class="d" style="width:${(b.down / t) * 100}%"></i></div><span class="k" style="margin-top:4px">漲停 ${b.limitUp} · 跌停 ${b.limitDown}</span></div>`; };
  const inst = (x) => (x ? `<tr><td class="l">${x.label}</td><td>${yiSign(x.foreign)}</td><td>${yiSign(x.trust)}</td><td>${yiSign(x.dealer)}</td><td>${yiSign(x.total)}</td></tr>` : '');
  const inds = d.industries.filter((g) => isNum(g.pct)).sort((a, b) => b.pct - a.pct);
  const maxAbs = Math.max(1, ...inds.map((g) => Math.abs(g.pct)));
  const indBars = (list, up) => `<div class="bars">${list.map((g) => `<a class="bar-row" href="${indHref(g.name)}"><span class="nm">${esc(g.name)}</span><span class="track"><i class="fillb" style="left:0;width:${(Math.abs(g.pct) / maxAbs) * 100}%;background:${up ? 'var(--up)' : 'var(--down)'};opacity:.8"></i></span><span class="val ${dir(g.pct)}">${fpct(g.pct)}</span></a>`).join('')}</div>`;
  const rank = (list, kind) => `<ol class="rank-list">${list.map((r, i) => `<li data-code="${r.code}"><span class="n">${i + 1}</span><span><b>${esc(r.name)}</b><small>${esc(r.code)} · ${esc(r.industry)}</small></span>${pxTag(r.close, r.limit, dir(r.pct))}<span>${kind === 'value' ? money(r.value) : kind === 'volume' ? `${fint(r.volume)} 張` : pctSpan(r.pct)}</span></li>`).join('')}</ol>`;
  main.innerHTML = `
    <div class="page-head"><div><h1>台股總覽</h1><div class="sub">上市、上櫃的大盤、市場廣度、法人與強弱產業</div></div>
      <div class="asof">收盤資料 <b>${esc(dateLabel(d.date))}</b><br><a href="#/heatmap" class="chip accent">市值熱力圖</a> <a href="#/sectors" class="chip accent">產業熱力圖</a></div></div>
    <div class="grid two" style="margin-top:0">
      <section class="panel"><h3>加權指數<small>近 ${tw.length} 個交易日</small></h3>
        <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:6px"><span class="idx-big ${dir(tl.change)}">${fnum(tl.index, 2)}</span><span class="chg ${dir(tl.change)}">${tl.change > 0 ? '▲' : tl.change < 0 ? '▼' : ''} ${fnum(Math.abs(tl.change), 2)} (${fpct(twPct)})</span></div>
        <div class="muted" style="font-size:13px;margin-bottom:8px">上市成交值 ${yi(tl.value, 0)}${isNum(valChg) ? `,較前一日 ${span(valChg, fpct(valChg, 1))}` : ''} · 成交量 ${fnum(tl.volume / 1e8, 1)} 億股 · ${fnum(tl.trades / 1e4, 0)} 萬筆</div>
        <div id="mk-idx" style="height:230px"></div>
        <div class="vol-cap">上市成交值<small>億元</small></div>
        <div id="mk-val" style="height:90px"></div></section>
      <div class="stack">
        <section class="panel"><h3>櫃買指數</h3>${ol ? `<div style="display:flex;align-items:baseline;gap:12px"><span class="idx-big ${dir(ol.change)}">${fnum(ol.index, 2)}</span><span class="chg ${dir(ol.change)}">${ol.change > 0 ? '▲' : '▼'} ${fnum(Math.abs(ol.change), 2)} (${fpct(otPct)})</span></div><div class="muted" style="font-size:13px;margin-top:6px">上櫃成交值 ${isNum(ol.value) ? yi(ol.value, 0) : '—'}</div>` : '<p class="note">沒有資料</p>'}</section>
        <section class="panel"><h3>漲跌家數<small>個股,不含 ETF</small></h3><div class="idx-tiles"><div><div class="muted" style="font-size:12.5px;margin-bottom:4px">上市</div>${br(d.breadth.twse)}</div><div><div class="muted" style="font-size:12.5px;margin-bottom:4px">上櫃</div>${br(d.breadth.tpex)}</div></div></section>
        <section class="panel"><h3>三大法人買賣超<small>金額,億元</small></h3><div class="tbl-wrap"><table><thead><tr><th class="l">市場</th><th>外資</th><th>投信</th><th>自營商</th><th>合計</th></tr></thead><tbody>${inst(d.twse.inst && { ...d.twse.inst, label: '上市' })}${inst(d.tpex.inst && { ...d.tpex.inst, label: '上櫃' })}</tbody></table></div></section>
      </div>
    </div>
    <div class="controls" style="margin:16px 0 0">
      <span class="grp">強弱排行 ${segHtml('rk', [['sub', '產業類股'], ['industry', '產業別'], ['chain', '產業鏈'], ['concept', '概念股'], ['group', '集團股']], S.rankMode || 'sub')}</span>
      <span class="muted" style="font-size:12.5px" id="rank-hint"></span>
    </div>
    <div class="grid even" id="rank-grid" style="margin-top:12px"></div>
    <div class="grid even">
      <section class="panel has-expand">${expandBtn('gainers')}<h3>漲幅榜<small>成交值 5 千萬以上</small></h3>${rank(d.gainers, 'pct')}</section>
      <section class="panel has-expand">${expandBtn('losers')}<h3>跌幅榜<small>成交值 5 千萬以上</small></h3>${rank(d.losers, 'pct')}</section>
      <section class="panel"><h3>成交值榜<small>個股</small></h3>${rank(d.byValue, 'value')}</section>
      <section class="panel"><h3>成交量榜<small>含 ETF,單位:張</small></h3>${rank(d.byVolume, 'volume')}</section>
    </div>
    <p class="note">指數、成交值、法人金額取自證交所與櫃買中心;漲跌家數與排行由當日官方收盤行情統計;產業強弱是各產業成分股今日漲跌幅的簡單平均(每檔權重相同,不受權值股影響)。</p>`;
  main.addEventListener('click', (e) => {
    const ex = e.target.closest('[data-expand]');
    if (ex) { const w = ex.dataset.expand; if (w === 'gainers' || w === 'losers') openMovers(w); else openStrength(w === 'strong'); return; }
    const li = e.target.closest('.rank-list li'); if (li) location.hash = `#/${li.dataset.code}`;
  });
  // 強弱排行:預設是「產業類股」(被動元件、PCB、面板業這種細分類),電子相關的大產業別以細分類取代
  const ELEC_BIG = new Set(['半導體業', '電腦及週邊設備業', '光電業', '通信網路業', '電子零組件業', '電子通路業', '其他電子業', '資訊服務業']);
  const HINT = { sub: 'Yahoo 電子產業細分 + 非電子的產業別', industry: '證交所、櫃買中心官方產業別', chain: '櫃買中心產業鏈', concept: 'Yahoo 概念股', group: 'Yahoo 集團股' };
  const LABEL = { sub: '產業類股', industry: '產業', chain: '產業鏈', concept: '概念股', group: '集團' };
  const rankList = async (mode) => {
    const chainItems = (arr, min) => arr.filter((c) => c.traded >= min && isNum(c.pct)).map((c) => ({ name: c.name, count: c.traded, pct: c.pct, href: `#/chain/${c.ic}` }));
    const indItems = (arr, skip) => arr.filter((g) => g.traded >= 3 && isNum(g.pct) && !(skip && skip.has(g.name))).map((g) => ({ name: g.name, count: g.traded, pct: g.pct, href: indHref(g.name) }));
    if (mode === 'industry') return indItems((await api('/api/industries')).industries);
    if (mode === 'sub') {
      const [ey, ind] = await Promise.all([api('/api/chains?kind=ey').catch(() => null), api('/api/industries')]);
      return [...(ey ? chainItems(ey.chains, 4) : []), ...indItems(ind.industries, ey ? ELEC_BIG : null)];
    }
    const kind = mode;
    return chainItems((await api(`/api/chains?kind=${kind}`)).chains, kind === 'group' ? 3 : 4);
  };
  const drawRank = async () => {
    const mode = S.rankMode || 'sub', grid = $('#rank-grid');
    $('#rank-hint').textContent = HINT[mode];
    grid.innerHTML = `<section class="panel">${skeleton(5)}</section><section class="panel">${skeleton(5)}</section>`;
    let list;
    try { list = await rankList(mode); } catch (e) { grid.innerHTML = `<section class="panel">${errBox('分類資料暫時無法取得:' + e.message)}</section>`; return; }
    if (id !== S.renderId) return;
    const sorted = list.sort((a, b) => b.pct - a.pct);
    const mx = Math.max(1, ...sorted.map((x) => Math.abs(x.pct)));
    const bars = (arr, up) => `<div class="bars">${arr.map((g) => `<a class="bar-row" href="${g.href}"><span class="nm">${esc(g.name)}<small>${g.count}檔</small></span><span class="track"><i class="fillb" style="left:0;width:${(Math.abs(g.pct) / mx) * 100}%;background:${up ? 'var(--up)' : 'var(--down)'};opacity:.8"></i></span><span class="val ${dir(g.pct)}">${fpct(g.pct)}</span></a>`).join('')}</div>`;
    S.rankFull = { sorted, bars, label: LABEL[mode] };
    grid.innerHTML = `<section class="panel has-expand">${expandBtn('strong')}<h3>強勢${LABEL[mode]}<small>成分股平均漲跌,至少 ${mode === 'group' ? 3 : mode === 'industry' ? 3 : 4} 檔</small></h3>${bars(sorted.slice(0, 10), true)}</section>
      <section class="panel has-expand">${expandBtn('weak')}<h3>弱勢${LABEL[mode]}<small>成分股平均漲跌</small></h3>${bars(sorted.slice(-10).reverse(), false)}</section>`;
  };
  bindSeg(main, (k, v) => { if (k === 'rk') { S.rankMode = v; drawRank(); } });
  drawRank();
  const lab = tw.map((r) => r.date);
  const common = { labels: lab, xTicks: 6, xFmt: (x, i, full) => (full ? x : x.slice(5).replace('-', '/')) };
  mountChart($('#mk-idx'), { ...common, label: '加權指數', height: 230, noX: true, fmtL: (v) => fint(v),
    tip: (i) => `<b>${esc(lab[i])}</b><div class="r"><span>加權指數</span><span class="${dir(tw[i].change)}">${fnum(tw[i].index, 2)} (${fsign(tw[i].change, 2)})</span></div><div class="r"><span>成交值</span><span>${yi(tw[i].value, 0)}</span></div>`,
    series: [{ type: 'area', data: tw.map((r) => r.index), color: tl.change >= 0 ? UPC : DNC, width: 2, noDots: true, noTip: true }] });
  mountChart($('#mk-val'), { ...common, label: '上市成交值', height: 90, fmtL: (v) => fint(v / 1e8),
    tip: (i) => `<b>${esc(lab[i])}</b><div class="r"><span>成交值</span><span>${yi(tw[i].value, 0)}</span></div><div class="r"><span>加權指數</span><span class="${dir(tw[i].change)}">${fnum(tw[i].index, 2)} (${fsign(tw[i].change, 2)})</span></div>`,
    series: [{ type: 'bar', data: tw.map((r) => r.value), color: (v, i) => (tw[i].change > 0 ? UPC : tw[i].change < 0 ? DNC : 'var(--text3)'), noTip: true }] });
}

/* ───────── 市值熱力圖 ───────── */
async function renderHeatmap(main, id) {
  const hm = (S.hm ||= { scope: 'all', n: 300, by: 'mcap', scale: 3, ...store.get('tw.hm', {}) });
  main.innerHTML = `
    <div class="page-head"><div><h1>市值熱力圖</h1><div class="sub">依產業分區,方塊越大市值(或成交值)越大;紅漲綠跌。點產業名稱看該產業所有股票,點方塊看個股。</div></div><div class="asof" id="hm-asof"></div></div>
    <div class="controls">
      <span class="grp">市場 ${segHtml('scope', [['all', '全部'], ['twse', '上市'], ['tpex', '上櫃']], hm.scope)}</span>
      <span class="grp">方塊大小 ${segHtml('by', [['mcap', '市值'], ['sqrt', '市值(壓縮)'], ['value', '成交值']], hm.by)}</span>
      <span class="grp">顯示檔數 ${segHtml('n', [[100, '100'], [300, '300'], [600, '600'], [1000, '1000']], hm.n)}</span>
      <span class="grp">色階 ${segHtml('scale', [[2, '±2%'], [3, '±3%'], [5, '±5%'], [10, '±10%']], hm.scale)}</span>
      ${scaleLegend(hm.scale)}
    </div>
    <section class="panel" style="padding:8px"><div id="tm" class="tm"></div></section>
    <p class="note" id="hm-note"></p>`;
  const load = async () => {
    store.set('tw.hm', hm);
    const host = $('#tm'); host.innerHTML = `<div style="padding:30px">${skeleton(6)}</div>`;
    try {
      const d = await api(`/api/heatmap?scope=${hm.scope}&n=${hm.n}&by=${hm.by === 'value' ? 'value' : 'mcap'}`);
      if (id !== S.renderId) return;
      $('#hm-asof').innerHTML = `收盤資料 <b>${esc(dateLabel(d.date))}</b>`;
      $('#hm-note').textContent = `共 ${d.total} 檔個股,目前顯示${hm.by === 'value' ? '成交值' : '市值'}最大的 ${Math.min(hm.n, d.total)} 檔。ETF 不列入。市值 = 已發行普通股數 × 收盤價;「壓縮」是方塊面積取市值的平方根,讓權值股不要佔滿整張圖。`;
      host.innerHTML = '';
      treemapGrouped(host, d.stocks, { by: hm.by, scale: hm.scale, height: hmHeight() });
    } catch (e) { host.innerHTML = errBox('熱力圖資料暫時無法取得:' + e.message); }
  };
  bindSeg(main, (k, v) => { hm[k] = ['scope', 'by'].includes(k) ? v : +v; if (k === 'scale') $('.scale', main).outerHTML = scaleLegend(hm.scale); load(); });
  load();
}

/* ───────── 產業熱力圖 ───────── */
async function renderSectors(main, id) {
  const sc = (S.sc ||= { by: 'mcap', scale: 2, mode: 'industry', ...store.get('tw.sc', {}) });
  const mode = sc.mode || 'industry';
  const chain = mode !== 'industry';
  const MODE_NAME = { industry: '產業', chain: '產業鏈', ey: '電子產業細分', concept: '概念股', group: '集團股' };
  main.innerHTML = `<div class="panel">${skeleton(8)}</div>`;
  let d;
  try { d = await api(chain ? `/api/chains?kind=${mode}` : '/api/industries'); }
  catch (e) { if (id !== S.renderId) return; main.innerHTML = errBox('產業資料暫時無法取得:' + e.message, true); main.querySelector('[data-retry]').onclick = () => route(); return; }
  if (id !== S.renderId) return;
  const all = chain ? d.chains : d.industries;
  const keyOf = (g) => (chain ? g.ic : g.name);
  const hrefOf = (g) => (chain ? `#/chain/${encodeURIComponent(g.ic)}` : indHref(g.name));
  const inds = all.filter((g) => isNum(g.pct) && g.traded);
  main.innerHTML = `
    <div class="page-head"><div><h1>產業熱力圖</h1><div class="sub">${inds.length} 個${MODE_NAME[mode]}${{ chain: '(櫃買中心產業鏈:被動元件、連接器、印刷電路板…)', ey: '(Yahoo 電子產業分類:LED、太陽能、PCB、面板業、光學元件…)', concept: '(Yahoo 概念股:AI、蘋果供應鏈、低軌衛星…)', group: '(Yahoo 集團股:鴻海、台塑、國巨…)', industry: '' }[mode]};同一檔股票可以屬於多個分類。顏色是成分股今日漲跌幅的平均(每檔權重相同),點方塊看旗下所有股票。</div></div><div class="asof">收盤資料 <b>${esc(dateLabel(d.date))}</b></div></div>
    <div class="controls">
      <span class="grp">分類 ${segHtml('mode', [['industry', '產業別'], ['chain', '產業鏈'], ['ey', '電子細分'], ['concept', '概念股'], ['group', '集團股']], mode)}</span>
      <span class="grp">方塊大小 ${segHtml('by', [['mcap', '市值'], ['sqrt', '市值(壓縮)'], ['value', '成交值']], sc.by)}</span>
      <span class="grp">色階 ${segHtml('scale', [[1, '±1%'], [2, '±2%'], [3, '±3%'], [5, '±5%']], sc.scale)}</span>
      ${scaleLegend(sc.scale)}
    </div>
    <section class="panel" style="padding:8px"><div id="tm" class="tm"></div></section>
    <section class="panel"><h3>${MODE_NAME[mode]}一覽<small>按 ▸ 展開看成分股,點名稱進入完整頁面</small></h3><div id="ind-table"></div></section>`;
  const drawMap = () => {
    store.set('tw.sc', sc);
    const host = $('#tm'); host.innerHTML = '';
    treemapFlat(host, inds.map((g) => ({ ...g, value: sc.by === 'value' ? g.value : sc.by === 'sqrt' ? Math.sqrt(g.mcap) : g.mcap })).filter((g) => g.value > 0), {
      scale: sc.scale, height: hmHeight(), href: hrefOf,
      extra: (g) => `${g.count} 檔`,
      tip: (g) => `<b>${esc(g.name)}</b><div class="r"><span>平均漲跌</span><span class="${dir(g.pct)}">${fpct(g.pct)}</span></div><div class="r"><span>成分股</span><span>${g.count} 檔(漲 ${g.up} / 跌 ${g.down})</span></div><div class="r"><span>市值</span><span>${money(g.mcap)}</span></div><div class="r"><span>成交值</span><span>${money(g.value)}</span></div><div class="r"><span>外資買賣超</span><span class="${dir(g.foreign)}">${fsign(g.foreign)} 張</span></div><div class="r"><span>權值股</span><span>${g.top.map((t) => esc(t.name)).join('、')}</span></div>`,
    });
  };
  drawMap();
  bindSeg(main, (k, v) => {
    if (k === 'mode') { sc.mode = v; store.set('tw.sc', sc); renderSectors(main, id); return; }
    sc[k] = k === 'by' ? v : +v;
    if (k === 'scale') $('.scale', main).outerHTML = scaleLegend(sc.scale);
    drawMap();
  });
  const cols = [
    { k: 'name', label: MODE_NAME[mode], cls: 'l stk', text: true, get: (g) => g.name, html: (g) => `<button class="caret" data-ind="${esc(keyOf(g))}" aria-expanded="false" aria-label="展開 ${esc(g.name)}">▸</button><a href="${hrefOf(g)}"><b>${esc(g.name)}</b></a>` },
    { k: 'count', label: '家數', get: (g) => g.count, html: (g) => g.count },
    { k: 'mcap', label: '市值', get: (g) => g.mcap, html: (g) => money(g.mcap) },
    { k: 'value', label: '成交值', get: (g) => g.value, html: (g) => money(g.value) },
    { k: 'pct', label: '平均漲跌', get: (g) => g.pct, html: (g) => pctSpan(g.pct) },
    { k: 'ud', label: '漲 / 跌', get: (g) => g.up - g.down, html: (g) => `<span class="up">${g.up}</span> / <span class="down">${g.down}</span>` },
    { k: 'rev', label: '月營收年增', get: (g) => g.revYoy, html: (g) => pctSpan(g.revYoy, 1) },
    { k: 'foreign', label: '外資(張)', get: (g) => g.foreign, html: (g) => span(g.foreign, fsign(g.foreign)) },
    { k: 'top', label: '權值股', cls: 'l', text: true, get: (g) => (g.top[0] ? g.top[0].name : ''), html: (g) => g.top.map((t) => `<a href="#/${t.code}" class="${dir(t.pct)}">${esc(t.name)}</a>`).join('、') },
  ];
  const tbl = $('#ind-table');
  dataTable(tbl, cols, all.filter((g) => g.traded), { sort: { key: 'mcap', dir: -1 } });
  // 展開成分股(分支)
  const prevClick = tbl.onclick;
  tbl.onclick = async (e) => {
    const cb = e.target.closest('.caret');
    if (!cb) return prevClick(e);
    const tr = cb.closest('tr'), open = cb.getAttribute('aria-expanded') === 'true';
    if (open) { if (tr.nextElementSibling && tr.nextElementSibling.classList.contains('sub')) tr.nextElementSibling.remove(); cb.setAttribute('aria-expanded', 'false'); cb.textContent = '▸'; return; }
    cb.setAttribute('aria-expanded', 'true'); cb.textContent = '▾';
    const sub = document.createElement('tr'); sub.className = 'sub';
    sub.innerHTML = `<td colspan="${cols.length}" class="l"><div class="skel" style="width:60%"></div></td>`; tr.after(sub);
    try {
      const det = await api(chain ? `/api/chain/${encodeURIComponent(cb.dataset.ind)}` : `/api/industry/${encodeURIComponent(cb.dataset.ind)}`);
      const list = det.stocks.filter((s) => isNum(s.pct)).slice(0, 80);
      const link = chain ? `#/chain/${encodeURIComponent(cb.dataset.ind)}` : indHref(cb.dataset.ind);
      sub.firstChild.innerHTML = `<div class="stkchips">${list.map((s) => `<a class="stkchip ${dir(s.pct)}" href="#/${s.code}"><b>${esc(s.name)}</b><small>${esc(s.code)}</small><span>${fpct(s.pct)}</span></a>`).join('')}</div><a class="btn sm" style="margin-top:10px" href="${link}">查看全部 ${det.stocks.length} 檔與詳細數據</a>`;
    } catch (err) { sub.firstChild.innerHTML = errBox('載入失敗:' + err.message); }
  };
}

/* ───────── 單一產業(分支頁) ───────── */
async function renderIndustryPage(main, name, id) {
  main.innerHTML = `<div class="panel">${skeleton(8)}</div>`;
  let d;
  try { d = await api(`/api/industry/${encodeURIComponent(name)}`); }
  catch (e) { if (id !== S.renderId) return; main.innerHTML = errBox(`找不到產業「${name}」:${e.message}`); return; }
  if (id !== S.renderId) return;
  const g = d.industry;
  let scope = 'all';
  const ctable = await api('/api/chains').catch(() => null);
  const cmap = new Map(((ctable && ctable.chains) || []).map((c) => [c.ic, c]));
  const subInd = d.chains && d.chains.length
    ? `<section class="panel" style="margin-top:16px"><h3>次產業(產業鏈)<small>${esc(g.name)}底下的細分類,點進去看上游、中游、下游各環節有哪些公司</small></h3>
        <div class="subinds">${d.chains.filter((c) => c.main).map((c) => { const a = cmap.get(c.ic); return `<a class="subind" href="#/chain/${esc(c.ic)}"><b>${esc(c.name)}</b><span class="${dir(a && a.pct)}">${a ? fpct(a.pct) : ''}</span><small>${esc(c.src || '產業鏈')} · ${c.inIndustry} 檔屬於${esc(g.name)} / 共 ${c.total} 檔</small></a>`; }).join('')}</div>
        ${d.chains.some((c) => !c.main) ? `<div class="chainlist" style="margin-top:12px"><div class="muted" style="font-size:12.5px;margin-bottom:6px">也有部分公司屬於這些產業鏈</div>${d.chains.filter((c) => !c.main).map((c) => `<a class="stkchip" href="#/chain/${esc(c.ic)}"><b>${esc(c.name)}</b><small>${c.inIndustry} 檔</small></a>`).join('')}</div>` : ''}</section>`
    : '';
  main.innerHTML = `
    <div class="crumb"><a href="#/sectors">產業熱力圖</a><span>›</span><span>${esc(g.name)}</span></div>
    <div class="page-head"><div><h1>${esc(g.name)}</h1><div class="sub">共 ${g.count} 檔上市櫃公司,市值排名第 ${d.rank.byMcap} / ${d.rank.of} 個產業</div></div><div class="asof">收盤資料 <b>${esc(dateLabel(d.date))}</b></div></div>
    <section class="panel"><div class="tiles divided">
      <div class="tile"><span class="k">平均漲跌</span><span class="v ${dir(g.pct)}">${fpct(g.pct)}</span><span class="s">中位數 ${fpct(g.medianPct)} · 市值加權 ${fpct(g.pctCap)}</span></div>
      <div class="tile"><span class="k">漲 / 跌家數</span><span class="v"><span class="up">${g.up}</span> / <span class="down">${g.down}</span></span><span class="s">平盤 ${g.flat}</span></div>
      <div class="tile"><span class="k">市值</span><span class="v">${money(g.mcap)}</span></div>
      <div class="tile"><span class="k">成交值</span><span class="v">${money(g.value)}</span></div>
      <div class="tile"><span class="k">月營收年增</span><span class="v ${dir(g.revYoy)}">${fpct(g.revYoy, 1)}</span><span class="s">全部公司加總</span></div>
      <div class="tile"><span class="k">外資買賣超</span><span class="v ${dir(g.foreign)}">${fsign(g.foreign)}</span><span class="s">張</span></div>
    </div></section>
    ${subInd}
    <div class="controls" style="margin-top:16px">
      <span class="grp">市場 ${segHtml('scope', [['all', '全部'], ['TWSE', '上市'], ['TPEx', '上櫃']], 'all')}</span>
      ${scaleLegend(3)}
    </div>
    <section class="panel" style="padding:8px"><div id="tm" class="tm"></div></section>
    <section class="panel"><h3>成分股<small id="cnt"></small></h3><div id="stk-table"></div></section>`;
  const cols = [
    { k: 'name', label: '股票', cls: 'l stk sticky-col', text: true, get: (r) => r.code, html: stockCell },
    { k: 'close', label: '收盤', get: (r) => r.close, html: (r) => `${pxTag(r.close, r.limit, dir(r.pct))}` },
    { k: 'pct', label: '漲跌幅', get: (r) => r.pct, html: (r) => pctSpan(r.pct) },
    { k: 'mcap', label: '市值', get: (r) => r.mcap, html: (r) => money(r.mcap) },
    { k: 'value', label: '成交值', get: (r) => r.value, html: (r) => money(r.value) },
    { k: 'volume', label: '成交量(張)', get: (r) => r.volume, html: (r) => fint(r.volume) },
    { k: 'pe', label: '本益比', get: (r) => r.pe, html: (r) => fnum(r.pe, 1) },
    { k: 'pb', label: '淨值比', get: (r) => r.pb, html: (r) => fnum(r.pb, 2) },
    { k: 'yield', label: '殖利率', get: (r) => r.yield, html: (r) => (isNum(r.yield) ? fnum(r.yield, 2) + '%' : '—') },
    { k: 'rev', label: '月營收年增', get: (r) => r.revYoy, html: (r) => pctSpan(r.revYoy, 1) },
    { k: 'foreign', label: '外資(張)', get: (r) => r.foreign, html: (r) => (isNum(r.foreign) ? span(r.foreign, fsign(r.foreign)) : '—') },
    { k: 'add', label: '', get: () => null, html: addCell },
  ];
  const draw = () => {
    const list = d.stocks.filter((s) => scope === 'all' || s.market === scope);
    $('#cnt').textContent = `${list.length} 檔 · 點欄位標題排序,點列看個股`;
    dataTable($('#stk-table'), cols, list, { href: (r) => `#/${r.code}`, sort: { key: 'mcap', dir: -1 } });
    const items = list.filter((s) => s.mcap && isNum(s.pct)).map((s) => ({ ...s, value: s.mcap }));
    const host = $('#tm'); host.innerHTML = '';
    if (!items.length) { host.style.height = 'auto'; host.innerHTML = '<div class="note" style="padding:20px">沒有可顯示的股票</div>'; return; }
    treemapFlat(host, items, { scale: 3, height: Math.max(360, Math.min(560, items.length * 28 + 200)), href: (s) => `#/${s.code}`, extra: (s) => price(s.close),
      tip: (s) => `<b>${esc(s.name)} <span class="muted">${esc(s.code)}</span></b><div class="r"><span>收盤</span><span class="${dir(s.pct)}">${price(s.close)} (${fpct(s.pct)})</span></div><div class="r"><span>市值</span><span>${money(s.mcap)}</span></div><div class="r"><span>成交值</span><span>${money(s.value)}</span></div><div class="r"><span>月營收年增</span><span>${fpct(s.revYoy, 1)}</span></div>` });
  };
  bindSeg(main, (k, v) => { scope = v; draw(); });
  draw();
}

/* ───────── 產業鏈(次產業) ───────── */
const chainChips = () => '';

/** 個股頁上方:分類與題材(上市別/產業股/集團股/題材/主要業務) */
function classPanel(sum) {
  const chains = sum.chains || [];
  const by = (k) => chains.filter((c) => c.kind === k);
  const tag = (href, label, sub, cls = '') => `<a class="tag ${cls}" href="${href}">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</a>`;
  const more = (arr, n = 14) => (arr.length > n ? `${arr.slice(0, n).join('')}<span class="more-wrap" hidden>${arr.slice(n).join('')}</span><button type="button" class="btn sm more-btn">展開全部 ${arr.length} 個</button>` : arr.join(''));
  const rows = [];
  const biz = '<div class="biz" id="about-biz-wrap"><span class="muted" id="about-biz">載入中…</span></div>';
  rows.push([mktName(sum.market), (sum.etf ? `<span class="tag">${esc(sum.kind || 'ETF')}</span>` : tag(indHref(sum.industry), sum.industry, '', 'main')) + biz]);
  const ey = by('ey'), off = by('chain');
  const eyNames = new Set(ey.map((c) => c.name));
  const seenChain = new Set();
  const ind = [...ey.map((c) => tag(`#/chain/${c.ic}`, c.name, '', 'main'))];
  for (const c of off) {
    if (!seenChain.has(c.ic) && !eyNames.has(c.name)) { seenChain.add(c.ic); ind.push(tag(`#/chain/${c.ic}`, c.name, '產業鏈', 'main')); }
  }
  for (const c of off) ind.push(tag(`#/chain/${c.ic}/${c.nodeId}`, c.node, `${c.name}・${c.stream}`));
  if (ind.length) rows.push(['產業股', more(ind, 16)]);
  const grp = by('group');
  if (grp.length) rows.push(['集團股', grp.map((c) => tag(`#/chain/${c.ic}`, c.name, '', 'main')).join('')]);
  const cc = by('concept');
  if (cc.length) rows.push(['題材', more(cc.map((c) => tag(`#/chain/${c.ic}`, c.name)), 14)]);
  const sp = sum.supply || [];
  if (sp.length) rows.push(['供應鏈', sp.map((x) => tag(`#/supply/${x.id}/${sum.code}`, x.name, `${x.branch}:${x.role}`, 'main')).join('')]);
  return `<div class="classes classes-in" aria-label="分類與題材"><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`;
}

async function renderChainPage(main, ic, id) {
  main.innerHTML = `<div class="panel">${skeleton(8)}</div>`;
  let d;
  try { d = await api(`/api/chain/${encodeURIComponent(ic)}`); }
  catch (e) { if (id !== S.renderId) return; main.innerHTML = errBox(`找不到產業鏈「${ic}」:${e.message}`); return; }
  if (id !== S.renderId) return;
  const g = d.agg;
  main.innerHTML = `
    <div class="crumb"><a href="#/sectors">產業熱力圖</a><span>›</span><span>${esc(d.chain.kindName || '產業鏈')}</span><span>›</span><span>${esc(d.chain.name)}</span></div>
    <div class="page-head"><div><h1>${esc(d.chain.name)}</h1><div class="sub">${esc(d.chain.kindName || '產業鏈')}共 ${d.stocks.length} 檔台股(含上市、上櫃、興櫃);資料來源:${esc(d.chain.source || '')}。同一檔股票可能同時屬於多個分類。</div></div><div class="asof">收盤資料 <b>${esc(dateLabel(d.date))}</b></div></div>
    ${g ? `<section class="panel"><div class="tiles divided">
      <div class="tile"><span class="k">平均漲跌</span><span class="v ${dir(g.pct)}">${fpct(g.pct)}</span><span class="s">上市櫃 ${g.traded} 檔 · 市值加權 ${fpct(g.pctCap)}</span></div>
      <div class="tile"><span class="k">漲 / 跌家數</span><span class="v"><span class="up">${g.up}</span> / <span class="down">${g.down}</span></span><span class="s">平盤 ${g.flat}</span></div>
      <div class="tile"><span class="k">市值</span><span class="v">${money(g.mcap)}</span></div>
      <div class="tile"><span class="k">成交值</span><span class="v">${money(g.value)}</span></div>
      <div class="tile"><span class="k">月營收年增</span><span class="v ${dir(g.revYoy)}">${fpct(g.revYoy, 1)}</span><span class="s">全部公司加總</span></div>
      <div class="tile"><span class="k">外資買賣超</span><span class="v ${dir(g.foreign)}">${fsign(g.foreign)}</span><span class="s">張</span></div>
    </div></section>` : ''}
    <section class="panel" style="margin-top:16px"><h3>${d.chain.kind === 'chain' ? '產業鏈地圖' : '成分股'}<small>${d.chain.kind === 'chain' ? '上游 → 中游 → 下游,點股票名稱看個股' : '點股票名稱看個股'}</small></h3>
      <div class="flow">${d.streams.map((st) => `<div class="flow-col"><div class="flow-head">${esc(st.name)}</div><div class="flow-nodes">${st.nodes.map((n) => `<div class="flow-node" id="node-${esc(n.id)}"><div class="flow-title"><b>${esc(n.name)}</b><span class="muted">${n.stocks.length} 檔</span></div>${n.desc ? `<div class="flow-desc">${esc(n.desc)}</div>` : ''}<div class="stkchips">${n.stocks.length ? n.stocks.map((s) => `<a class="stkchip ${dir(s.pct)}" href="#/${esc(s.code)}"><b>${esc(s.name)}</b>${s.market === 'ESB' ? '<small>興櫃</small>' : ''}<span>${isNum(s.pct) ? fpct(s.pct) : ''}</span></a>`).join('') : '<span class="muted" style="font-size:13px">沒有台股公司</span>'}</div></div>`).join('')}</div></div>`).join('')}</div></section>
    <section class="panel" style="padding:8px"><div id="tm" class="tm"></div></section>
    <section class="panel"><h3>成分股<small id="cnt"></small></h3><div id="stk-table"></div></section>`;
  const cols = [
    { k: 'name', label: '股票', cls: 'l stk sticky-col', text: true, get: (r) => r.code, html: stockCell },
    { k: 'close', label: '收盤', get: (r) => r.close, html: (r) => pxTag(r.close, r.limit, dir(r.pct)) },
    { k: 'pct', label: '漲跌幅', get: (r) => r.pct, html: (r) => pctSpan(r.pct) },
    { k: 'mcap', label: '市值', get: (r) => r.mcap, html: (r) => money(r.mcap) },
    { k: 'value', label: '成交值', get: (r) => r.value, html: (r) => money(r.value) },
    { k: 'pe', label: '本益比', get: (r) => r.pe, html: (r) => fnum(r.pe, 1) },
    { k: 'yield', label: '殖利率', get: (r) => r.yield, html: (r) => (isNum(r.yield) ? fnum(r.yield, 2) + '%' : '—') },
    { k: 'rev', label: '月營收年增', get: (r) => r.revYoy, html: (r) => pctSpan(r.revYoy, 1) },
    { k: 'foreign', label: '外資(張)', get: (r) => r.foreign, html: (r) => (isNum(r.foreign) ? span(r.foreign, fsign(r.foreign)) : '—') },
    { k: 'nodes', label: '所屬環節', cls: 'l', text: true, get: (r) => (r.nodes || []).join(), html: (r) => `<span class="muted" style="white-space:normal;display:inline-block;min-width:160px">${esc((r.nodes || []).join('、'))}</span>` },
    { k: 'add', label: '', get: () => null, html: addCell },
  ];
  $('#cnt').textContent = `${d.stocks.length} 檔 · 點欄位標題排序,點列看個股`;
  dataTable($('#stk-table'), cols, d.stocks, { href: (r) => `#/${r.code}`, sort: { key: 'mcap', dir: -1 } });
  const nodeEl = S.route.node && document.getElementById(`node-${S.route.node}`);
  if (nodeEl) { nodeEl.classList.add('hl'); nodeEl.scrollIntoView({ block: 'center' }); }
  const items = d.stocks.filter((s) => s.mcap && isNum(s.pct) && s.market !== 'ESB').map((s) => ({ ...s, value: s.mcap }));
  const host = $('#tm');
  if (!items.length) { host.style.height = 'auto'; host.innerHTML = '<div class="note" style="padding:20px">沒有可顯示的上市櫃股票</div>'; return; }
  treemapFlat(host, items, { scale: 3, height: Math.max(340, Math.min(560, items.length * 22 + 180)), href: (s) => `#/${s.code}`, extra: (s) => price(s.close),
    tip: (s) => `<b>${esc(s.name)} <span class="muted">${esc(s.code)}</span></b><div class="r"><span>收盤</span><span class="${dir(s.pct)}">${price(s.close)} (${fpct(s.pct)})</span></div><div class="r"><span>市值</span><span>${money(s.mcap)}</span></div><div class="r"><span>所屬環節</span><span>${esc((s.nodes || []).slice(0, 3).join('、'))}</span></div>` });
}

/* ───────── 搜尋 ───────── */
(function search() {
  const q = $('#q'), box = $('#sugg');
  let items = [], sel = -1, timer, seq = 0;
  const close = () => { box.hidden = true; sel = -1; };
  const render = () => {
    if (!items.length) { box.innerHTML = '<li class="hint" role="option">找不到符合的股票。只支援台股上市、上櫃(含 ETF)。</li>'; box.hidden = false; return; }
    box.innerHTML = items.map((s, i) => `<li role="option" data-code="${s.code}" aria-selected="${i === sel}"><span class="code">${esc(s.code)}</span><span>${esc(s.name)} <span class="meta">${esc(s.industry)}</span></span><span class="${dir(s.pct)}">${fpct(s.pct)}</span><span class="st">${S.watch.includes(s.code) ? '已加入' : mktName(s.market)}</span></li>`).join('');
    box.hidden = false;
  };
  const multi = (v) => v.trim().split(/[\s,;，、]+/).filter(Boolean).length > 1;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    const v = q.value.trim();
    if (!v) return close();
    if (multi(v)) { box.innerHTML = '<li class="hint" role="option">按 Enter 一次加入多檔(以空白或逗號分隔)</li>'; box.hidden = false; items = []; return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try { const j = await api(`/api/search?q=${encodeURIComponent(v)}`); if (my !== seq) return; items = j.results; sel = items.length ? 0 : -1; render(); } catch { close(); }
    }, 120);
  });
  const pick = async (code) => { close(); q.value = ''; q.blur(); await addCodes([code]); location.hash = `#/${code}`; };
  q.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!items.length) return; e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; render(); }
    else if (e.key === 'Escape') { close(); q.blur(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const v = q.value.trim(); if (!v) return;
      if (multi(v)) {
        const r = await fetch('/api/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: v.split(/[,;，、\s]+/) }) }).then((x) => x.json());
        const ok = r.results.filter((x) => x.ok).map((x) => x.stock.code), bad = r.results.filter((x) => !x.ok).map((x) => x.line);
        const n = await addCodes([...new Set(ok)]);
        close(); q.value = ''; toast(`加入 ${n} 檔${bad.length ? `,找不到:${bad.join('、')}` : ''}`);
      } else if (items[Math.max(sel, 0)]) pick(items[Math.max(sel, 0)].code);
    }
  });
  box.addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-code]'); if (li) { e.preventDefault(); pick(li.dataset.code); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); } });
})();

/* ───────── 匯入 / 匯出 ───────── */
const dlg = $('#dlg-import');
let pending = [], resolved = [];
function openImport(text) {
  if (typeof text === 'string') $('#import-text').value = text;
  $('#import-result').hidden = true; $('#import-add').hidden = true; $('#import-replace').hidden = true;
  if (!dlg.open) dlg.showModal();
  if (typeof text === 'string' && text.trim()) parseImport();
}
async function parseImport() {
  const lines = $('#import-text').value.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^[#/;]/.test(s));
  if (!lines.length) { toast('請先貼上或選擇一份清單'); return; }
  $('#import-parse').textContent = '解析中…';
  try {
    const r = await fetch('/api/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }) }).then((x) => x.json());
    resolved = r.results; pending = [...new Set(resolved.filter((x) => x.ok).map((x) => x.stock.code))];
    renderImport();
  } catch (e) { toast('解析失敗:' + e.message); }
  $('#import-parse').textContent = '重新解析';
}
function renderImport() {
  const box = $('#import-result');
  const bad = resolved.filter((x) => !x.ok);
  const names = new Map(resolved.filter((x) => x.ok).map((x) => [x.stock.code, x.stock]));
  box.innerHTML = `<div class="import-summary">辨識 <b>${pending.length}</b> 檔${bad.length ? `,<span class="down" style="color:var(--warn)">${bad.length} 行找不到</span>` : ''}</div>` +
    resolved.map((x, i) => x.ok
      ? `<div class="it"><span class="ln">${esc(x.line)}</span><b>${esc(x.stock.code)} ${esc(x.stock.name)}</b><span class="chip">${mktName(x.stock.market)}</span>${x.how === 'fuzzy' ? '<span class="chip warn">模糊比對,請確認</span>' : ''}${S.watch.includes(x.stock.code) ? '<span class="muted">已在清單</span>' : ''}</div>`
      : `<div class="it"><span class="ln">${esc(x.line)}</span><span class="muted">找不到${x.candidates.length ? ',你是指:' : ''}</span>${x.candidates.map((c) => `<button type="button" class="btn sm" data-cand="${c.code}" data-i="${i}">${esc(c.code)} ${esc(c.name)}</button>`).join('')}</div>`).join('');
  box.hidden = false;
  $('#import-add').hidden = !pending.length; $('#import-replace').hidden = !pending.length;
  $('#import-add').textContent = `加入 ${pending.filter((c) => !S.watch.includes(c)).length} 檔新股票`;
  box.onclick = (e) => { const b = e.target.closest('[data-cand]'); if (!b) return; if (!pending.includes(b.dataset.cand)) pending.push(b.dataset.cand); resolved[+b.dataset.i] = { line: resolved[+b.dataset.i].line, ok: true, how: 'code', stock: resolved[+b.dataset.i].candidates.find((c) => c.code === b.dataset.cand) }; renderImport(); };
}
$('#import-parse').onclick = parseImport;
$('#import-add').onclick = async () => { const n = await addCodes(pending); dlg.close(); toast(n ? `已加入 ${n} 檔` : '這些股票都已在清單中'); location.hash = '#/'; };
$('#import-replace').onclick = async () => {
  if (!confirm(`用這 ${pending.length} 檔取代目前的 ${S.watch.length} 檔清單?`)) return;
  S.watch = []; saveWatch(); const n = await addCodes(pending); dlg.close(); toast(`清單已更新,共 ${n} 檔`); location.hash = '#/';
};
$('#btn-import').onclick = () => openImport();
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch { try { return new TextDecoder('big5').decode(buf); } catch { return new TextDecoder().decode(buf); } } // 記事本另存的 ANSI(Big5)檔
}
$('#import-file').onchange = async (e) => { const f = e.target.files[0]; if (f) { $('#import-text').value = await readTextFile(f); parseImport(); } e.target.value = ''; };
// 拖放(整頁皆可)
let dragDepth = 0;
addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('#drop').classList.add('over'); } });
addEventListener('dragleave', () => $('#drop').classList.remove('over'));
addEventListener('drop', async (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault(); $('#drop').classList.remove('over');
  openImport(await readTextFile(e.dataTransfer.files[0]));
});
$('#btn-export').onclick = () => {
  if (!S.watch.length) return toast('清單是空的');
  const text = S.watch.map((c) => { const r = S.rows.get(c); return r ? `${c} ${r.name}` : c; }).join('\r\n') + '\r\n';
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' })), download: '自選股.txt' });
  a.click(); URL.revokeObjectURL(a.href);
};

/* ───────── 主題 / 啟動 ───────── */
// 桌面版視窗(WebView2)的標題列要跟著主題:把目前背景色回報給視窗程式
function reportChrome() {
  try {
    if (!(window.chrome && window.chrome.webview)) return;
    const c = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    if (!c) return;
    const [r, g, b] = c.map(Number);
    window.chrome.webview.postMessage(`${r},${g},${b},${(r * 299 + g * 587 + b * 114) / 1000 < 128 ? 1 : 0}`);
  } catch { /* 不是桌面版視窗 */ }
}
const reportChromeSoon = () => { reportChrome(); setTimeout(reportChrome, 400); };
new MutationObserver(reportChromeSoon).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', reportChromeSoon); } catch { /* ignore */ }
window.addEventListener('load', reportChromeSoon);
reportChromeSoon();
$('#btn-theme').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('tw.theme', next); } catch { /* ignore */ }
  syncPrefs();
  route();
};
setInterval(() => { fetch('/api/ping', { cache: 'no-store' }).catch(() => {}); }, 10000); // 讓桌面版知道視窗還開著
(async function boot() {
  await loadPrefs();
  S.route = parseHash();
  renderRail();
  try { await loadRows(S.watch); } catch (e) { toast('載入行情失敗:' + e.message); }
  route();
})();
