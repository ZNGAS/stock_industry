'use strict';
/**
 * 台股產業分析 — 本機伺服器(零相依,Node 18+)
 *
 * 資料來源
 *   官方:證交所 OpenAPI / 證交所 rwd / 櫃買中心 OpenAPI(行情、本益比、月營收、法人、融資券、重大訊息、財報 EPS、除權息)
 *   歷史:FinMind(股價、月營收、季財報、股利、法人、融資券、外資持股)— 整理自交易所與公開資訊觀測站
 *   新聞:Google News RSS
 * 官方資料為準;歷史序列若比官方舊,會以官方當日資料補上最新一筆,並標示核對結果。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const FINMIND_TOKEN = process.env.FINMIND_TOKEN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
// 打包成執行檔時,程式內部是唯讀的,快取改放在執行檔旁邊
const PACKED = !!process.pkg;
const BASE_DIR = PACKED ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = process.env.STOCK_DATA_DIR || BASE_DIR;
const CACHE_DIR = path.join(DATA_DIR, '.cache');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const MIN = 60 * 1000, HOUR = 60 * MIN;
const UA = 'Mozilla/5.0 (TWStockWatchlist/1.0)';

/* ───────── 工具 ───────── */
const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, '').replace(/\+/g, '').trim();
  if (s === '' || s === '-' || s === '--' || s === '---' || s === 'X') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const rocToIso = (s) => {
  s = String(s || '').replace(/[^\d]/g, '');
  if (s.length === 7) return `${+s.slice(0, 3) + 1911}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
  if (s.length === 6) return `${+s.slice(0, 2) + 1911}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return null;
};
const isoToCompact = (iso) => iso.replace(/-/g, '');
const ymFromRoc = (s) => { // '11508' -> {y:2026,m:8}
  s = String(s || '').replace(/[^\d]/g, '');
  if (s.length < 5) return null;
  return { y: +s.slice(0, s.length - 2) + 1911, m: +s.slice(-2) };
};
const median = (arr) => {
  const a = arr.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const isoDate = (d) => d.toISOString().slice(0, 10);
const norm = (s) => String(s || '').replace(/[\s　]/g, '').replace(/臺/g, '台').toLowerCase();
const toHalf = (s) => String(s || '')
  .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/　/g, ' ');

const INDUSTRY = {
  '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維', '05': '電機機械', '06': '電器電纜',
  '07': '化學生技醫療', '08': '玻璃陶瓷', '09': '造紙工業', '10': '鋼鐵工業', '11': '橡膠工業', '12': '汽車工業',
  '13': '電子工業', '14': '建材營造業', '15': '航運業', '16': '觀光餐旅', '17': '金融保險業', '18': '貿易百貨業',
  '19': '綜合', '20': '其他', '21': '化學工業', '22': '生技醫療業', '23': '油電燃氣業', '24': '半導體業',
  '25': '電腦及週邊設備業', '26': '光電業', '27': '通信網路業', '28': '電子零組件業', '29': '電子通路業',
  '30': '資訊服務業', '31': '其他電子業', '32': '文化創意業', '33': '農業科技業', '34': '電子商務',
  '35': '綠能環保', '36': '數位雲端', '37': '運動休閒', '38': '居家生活', '80': '管理股票', '91': '存託憑證',
};

/* ───────── 抓取 + 快取 ───────── */
const mem = new Map(); // key -> {t, data}
const inflight = new Map();

async function fetchText(url, { timeout = 30000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, ...headers } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}
async function fetchJson(url, opts) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(await fetchText(url, opts)); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 500 * (i + 1))); }
  }
  throw new Error(`${url} → ${lastErr.message}`);
}

/** 記憶體快取;同一 key 同時間只抓一次;失敗時回傳舊資料 */
async function cached(key, ttl, loader) {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.data;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const data = await loader();
      mem.set(key, { t: Date.now(), data });
      return data;
    } catch (e) {
      if (hit) { console.warn(`[stale] ${key}: ${e.message}`); return hit.data; }
      throw e;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

/** 磁碟快取(FinMind 等較慢、有額度限制的來源);抓不到時回傳過期資料並標示 stale */
async function diskCached(key, ttl, loader) {
  const file = path.join(CACHE_DIR, key.replace(/[^\w.-]/g, '_') + '.json');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none */ }
  if (saved && Date.now() - saved.t < ttl) return saved.data;
  return cached('disk:' + key, 0, async () => {
    try {
      const data = await loader();
      fs.writeFileSync(file, JSON.stringify({ t: Date.now(), data }));
      return data;
    } catch (e) {
      if (saved) { console.warn(`[stale] ${key}: ${e.message}`); return { ...saved.data, _stale: true, _staleSince: new Date(saved.t).toISOString() }; }
      throw e;
    }
  });
}

async function finmind(dataset, id, start, end) {
  let url = `https://api.finmindtrade.com/api/v4/data?dataset=${dataset}&data_id=${id}&start_date=${start}`;
  if (end) url += `&end_date=${end}`;
  if (FINMIND_TOKEN) url += `&token=${FINMIND_TOKEN}`;
  const j = await fetchJson(url, { timeout: 30000 });
  if (j.status !== 200) throw new Error(`FinMind ${dataset}: ${j.msg || j.status}`);
  return j.data || [];
}

/* ───────── 官方整批資料 ───────── */
const TW = 'https://openapi.twse.com.tw/v1';
const OT = 'https://www.tpex.org.tw/openapi/v1';
const isEtf = (code) => /^00\d{2,4}[A-Z]?$/.test(code);
/** 沒有公司基本資料的證券,依代號/名稱分類 */
function kindOf(code, name) {
  if (/^02\d{3}[0-9L]$/.test(code)) return 'ETN';
  if (/^00\d{2,4}[A-Z]?$/.test(code)) return 'ETF';
  if (/^01\d{3}T$/.test(code)) return '受益證券';
  if (/-DR$/.test(name) || /^91\d{4}$/.test(code)) return '存託憑證';
  if (/^\d{4}[A-Z]\d?$/.test(code)) return '特別股';
  return '其他';
}
// 台股升降單位;回傳漲停、跌停價
const tickOf = (p, fund) => (fund ? (p < 50 ? 0.01 : 0.05) : p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
function limitPrices(prev, fund) {
  const up = prev * 1.1, dn = prev * 0.9, tu = tickOf(up, fund), td = tickOf(dn, fund);
  return { up: Math.round(Math.floor(up / tu + 1e-9) * tu * 100) / 100, down: Math.round(Math.ceil(dn / td - 1e-9) * td * 100) / 100 };
}
const limitOf = (close, prev, market, fund) => {
  if (market === 'ESB' || !prev || close === null) return null;
  const l = limitPrices(prev, fund);
  if (Math.abs(close - l.up) < 0.004 && close > prev) return 'up';
  if (Math.abs(close - l.down) < 0.004 && close < prev) return 'down';
  return null;
};
const isStockCode = (code) => /^\d{4}$/.test(code);

/** 全市場個股:基本資料 + 收盤行情 + 本益比/淨值比/殖利率 */
function loadUniverse() {
  return cached('universe', 5 * MIN, async () => {
    const [b1, b2, q1, q2, v1, v2, b3, q3] = await Promise.all([
      fetchJson(`${TW}/opendata/t187ap03_L`),
      fetchJson(`${OT}/mopsfin_t187ap03_O`),
      fetchJson(`${TW}/exchangeReport/STOCK_DAY_ALL`),
      fetchJson(`${OT}/tpex_mainboard_daily_close_quotes`),
      fetchJson(`${TW}/exchangeReport/BWIBBU_ALL`),
      fetchJson(`${OT}/tpex_mainboard_peratio_analysis`),
      fetchJson(`${OT}/mopsfin_t187ap03_R`).catch(() => []),
      fetchJson(`${OT}/tpex_esb_latest_statistics`).catch(() => []),
    ]);
    const stocks = new Map();
    const basic = new Map();
    for (const r of b1) basic.set(r['公司代號'], {
      market: 'TWSE', full: r['公司名稱'], name: r['公司簡稱'], indCode: r['產業別'], chairman: r['董事長'], gm: r['總經理'],
      founded: rocToIso(r['成立日期']), listed: rocToIso(r['上市日期']), capital: num(r['實收資本額']),
      shares: num(r['已發行普通股數或TDR原股發行股數']), web: String(r['網址'] || '').trim(), address: r['住址'], english: r['英文簡稱'],
    });
    for (const r of b2) basic.set(r['SecuritiesCompanyCode'], {
      market: 'TPEx', full: r['CompanyName'], name: r['CompanyAbbreviation'], indCode: r['SecuritiesIndustryCode'], chairman: r['Chairman'], gm: r['GeneralManager'],
      founded: rocToIso(r['DateOfIncorporation']), listed: rocToIso(r['DateOfListing']), capital: num(r['Paidin.Capital.NTDollars']),
      shares: num(r['IssueShares']), web: String(r['WebAddress'] || '').trim(), address: r['Address'], english: String(r['Symbol'] || '').trim(),
    });

    for (const r of b3) basic.set(r['SecuritiesCompanyCode'], {
      market: 'ESB', full: r['CompanyName'], name: r['CompanyAbbreviation'], indCode: r['SecuritiesIndustryCode'], chairman: r['Chairman'], gm: r['GeneralManager'],
      founded: rocToIso(r['DateOfIncorporation']), listed: rocToIso(r['DateOfListing']), capital: num(r['Paidin.Capital.NTDollars']),
      shares: num(r['IssueShares']), web: String(r['WebAddress'] || '').trim(), address: r['Address'], english: String(r['Symbol'] || '').trim(),
    });

    let quoteDate = null;
    const put = (code, name, market, q) => {
      const b = basic.get(code);
      const prev = q.close !== null && q.change !== null ? Math.round((q.close - q.change) * 100) / 100 : null;
      const s = {
        code, name: (b && b.name) || name, market, full: b ? b.full : name, etf: !b, kindLabel: b ? '' : kindOf(code, name),
        industry: b ? (INDUSTRY[b.indCode] || b.indCode || '其他') : kindOf(code, name),
        indCode: b ? b.indCode : null,
        close: q.close, change: q.change, prevClose: prev,
        pct: prev ? (q.change / prev) * 100 : null,
        open: q.open, high: q.high, low: q.low,
        volume: q.volume, value: q.value, trades: q.trades, date: q.date,
        pe: null, pb: null, yield: null,
        profile: b || null,
      };
      s.limit = limitOf(q.close, prev, market, !b);
      s.mcap = b && b.shares && q.close ? b.shares * q.close : null;
      stocks.set(code, s);
    };
    for (const r of q1) {
      const date = rocToIso(r.Date); if (!quoteDate || date > quoteDate) quoteDate = date;
      put(r.Code, r.Name, 'TWSE', {
        close: num(r.ClosingPrice), change: num(r.Change), open: num(r.OpeningPrice), high: num(r.HighestPrice), low: num(r.LowestPrice),
        volume: num(r.TradeVolume), value: num(r.TradeValue), trades: num(r.Transaction), date,
      });
    }
    let otcDate = null;
    for (const r of q2) {
      const code = r.SecuritiesCompanyCode;
      // 排除權證、可轉債等:只收一般股、特別股、ETF、ETN
      if (!(basic.has(code) || /^(\d{4}[A-Z]?|00\d{2,4}[A-Z]?|020\d{3})$/.test(code))) continue;
      const date = rocToIso(r.Date); if (!otcDate || date > otcDate) otcDate = date;
      put(code, r.CompanyName, 'TPEx', {
        close: num(r.Close), change: num(r.Change), open: num(r.Open), high: num(r.High), low: num(r.Low),
        volume: num(r.TradingShares), value: num(r.TransactionAmount), trades: num(r.TransactionNumber), date,
      });
    }
    for (const r of q3) {
      const code = r.SecuritiesCompanyCode;
      if (stocks.has(code)) continue;
      const latest = num(r.LatestPrice), ref = num(r.PreviousAveragePrice);
      const date = rocToIso(r.Date);
      const vol = num(r.TransactionVolume), avg = num(r.Average);
      put(code, r.CompanyName, 'ESB', {
        close: latest, change: latest !== null && ref !== null ? Math.round((latest - ref) * 100) / 100 : null, open: null, high: num(r.Highest), low: num(r.Lowest),
        volume: vol, value: vol && avg ? vol * avg : null, trades: null, date,
      });
    }
    for (const r of v1) { const s = stocks.get(r.Code); if (s) { s.pe = num(r.PEratio); s.pb = num(r.PBratio); s.yield = num(r.DividendYield); s.valDate = rocToIso(r.Date); } }
    for (const r of v2) { const s = stocks.get(r.SecuritiesCompanyCode); if (s) { s.pe = num(r.PriceEarningRatio); s.pb = num(r.PriceBookRatio); s.yield = num(r.YieldRatio); s.valDate = rocToIso(r.Date); } }
    // 停牌/無成交的股票也要能搜尋到:補上沒有行情的上市櫃公司
    for (const [code, b] of basic) {
      if (!stocks.has(code)) stocks.set(code, {
        code, name: b.name, market: b.market, full: b.full, etf: false, industry: INDUSTRY[b.indCode] || '其他', indCode: b.indCode,
        close: null, change: null, prevClose: null, pct: null, open: null, high: null, low: null, volume: null, value: null, trades: null,
        date: null, pe: null, pb: null, yield: null, profile: b, mcap: null,
      });
    }
    return { stocks, quoteDate: quoteDate || otcDate, otcDate, fetchedAt: Date.now() };
  });
}

/** 最新月營收(官方,單位:千元) */
function loadRevenue() {
  return cached('revenue', 30 * MIN, async () => {
    const [a, b, c] = await Promise.all([fetchJson(`${TW}/opendata/t187ap05_L`), fetchJson(`${OT}/mopsfin_t187ap05_O`), fetchJson(`${OT}/t187ap05_R`).catch(() => [])]);
    const map = new Map();
    for (const r of [...a, ...b, ...c]) {
      map.set(r['公司代號'], {
        ym: ymFromRoc(r['資料年月']), industry: r['產業別'],
        rev: num(r['營業收入-當月營收']), prev: num(r['營業收入-上月營收']), ly: num(r['營業收入-去年當月營收']),
        mom: num(r['營業收入-上月比較增減(%)']), yoy: num(r['營業收入-去年同月增減(%)']),
        cum: num(r['累計營業收入-當月累計營收']), cumLy: num(r['累計營業收入-去年累計營收']), cumYoy: num(r['累計營業收入-前期比較增減(%)']),
        note: String(r['備註'] || '').trim().replace(/^-$/, ''), published: rocToIso(r['出表日期']),
      });
    }
    return map;
  });
}

/** 融資融券(官方,單位:張) */
function loadMargin() {
  return cached('margin', 10 * MIN, async () => {
    const [a, b] = await Promise.all([fetchJson(`${TW}/exchangeReport/MI_MARGN`), fetchJson(`${OT}/tpex_mainboard_margin_balance`)]);
    const map = new Map();
    for (const r of a) {
      const mb = num(r['融資今日餘額']), mp = num(r['融資前日餘額']), sb = num(r['融券今日餘額']), sp = num(r['融券前日餘額']);
      map.set(r['股票代號'], { margin: mb, marginChg: mb !== null && mp !== null ? mb - mp : null, short: sb, shortChg: sb !== null && sp !== null ? sb - sp : null, marginLimit: num(r['融資限額']) });
    }
    let date = null;
    for (const r of b) {
      date = rocToIso(r.Date) || date;
      const mb = num(r.MarginPurchaseBalance), mp = num(r.MarginPurchaseBalancePreviousDay), sb = num(r.ShortSaleBalance), sp = num(r.ShortSaleBalancePreviousDay);
      map.set(r.SecuritiesCompanyCode, { margin: mb, marginChg: mb !== null && mp !== null ? mb - mp : null, short: sb, shortChg: sb !== null && sp !== null ? sb - sp : null, marginLimit: num(r.MarginPurchaseQuota) });
    }
    return { map, date };
  });
}

/** 三大法人買賣超(官方;上市取證交所 T86,上櫃取櫃買;單位換算為張) */
function loadInsti() {
  return cached('insti', 10 * MIN, async () => {
    const { quoteDate } = await loadUniverse();
    const map = new Map();
    let twseDate = null;
    // 從最新交易日往前找,最多回推 6 天(T86 約 16:00 後才公布)
    for (let i = 0; i < 7 && quoteDate; i++) {
      const d = isoDate(addDays(new Date(quoteDate + 'T00:00:00Z'), -i));
      try {
        const j = await fetchJson(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${isoToCompact(d)}&selectType=ALL&response=json`);
        if (j.stat !== 'OK' || !j.data || !j.data.length) continue;
        const f = j.fields;
        const idx = (kw, not) => f.findIndex((x) => x.includes(kw) && (!not || !x.includes(not)));
        const iF = idx('外陸資買賣超股數'), iFD = idx('外資自營商買賣超股數'), iT = idx('投信買賣超股數'), iD = f.findIndex((x) => x === '自營商買賣超股數'), iAll = idx('三大法人買賣超股數');
        for (const row of j.data) {
          const k = (n) => (n >= 0 ? (num(row[n]) ?? 0) / 1000 : 0);
          map.set(String(row[0]).trim(), { foreign: k(iF) + k(iFD), trust: k(iT), dealer: k(iD), total: k(iAll) });
        }
        twseDate = d; break;
      } catch { /* try previous day */ }
    }
    let otcDate = null;
    try {
      const b = await fetchJson(`${OT}/tpex_3insti_daily_trading`);
      for (const r of b) {
        otcDate = rocToIso(r.Date) || otcDate;
        const g = (want) => { const key = Object.keys(r).find((k) => norm(k) === want); return key ? (num(r[key]) ?? 0) / 1000 : 0; };
        map.set(r.SecuritiesCompanyCode, {
          foreign: g('foreigninvestorsincludemainlandareainvestors-difference') + g('foreigndealers-difference'),
          trust: g('securitiesinvestmenttrustcompanies-difference'), dealer: g('dealers-difference'), total: g('totaldifference'),
        });
      }
    } catch (e) { console.warn('[insti] tpex failed', e.message); }
    return { map, twseDate, otcDate };
  });
}

/** 今日重大訊息(官方) */
function loadAnnouncements() {
  return cached('ann', 10 * MIN, async () => {
    const [a, b] = await Promise.all([
      fetchJson(`${TW}/opendata/t187ap04_L`).catch(() => []),
      fetchJson(`${OT}/mopsfin_t187ap04_O`).catch(() => []),
    ]);
    const list = [];
    const pad = (t) => { t = String(t || '').padStart(6, '0'); return `${t.slice(0, 2)}:${t.slice(2, 4)}`; };
    for (const r of a) list.push({ code: r['公司代號'], name: r['公司名稱'], date: rocToIso(r['發言日期']), time: pad(r['發言時間']), title: String(r['主旨 '] ?? r['主旨'] ?? '').replace(/\s+/g, ' ').trim(), clause: r['符合條款'], detail: String(r['說明'] || '').trim() });
    for (const r of b) list.push({ code: r.SecuritiesCompanyCode, name: r.CompanyName, date: rocToIso(r['發言日期']), time: pad(r['發言時間']), title: String(r['主旨'] || '').replace(/\s+/g, ' ').trim(), clause: r['符合條款'], detail: String(r['說明'] || '').trim() });
    return list;
  });
}

/** 官方累計 EPS(用來核對 FinMind 的季 EPS) */
function loadOfficialEps() {
  return cached('officialEps', 6 * HOUR, async () => {
    const [a, b] = await Promise.all([
      fetchJson(`${TW}/opendata/t187ap14_L`).catch(() => []),
      fetchJson(`${OT}/mopsfin_t187ap06_O_ciA`).catch(() => []),
    ]);
    const map = new Map();
    for (const r of a) map.set(r['公司代號'], { year: +r['年度'] + 1911, season: +r['季別'], eps: num(r['基本每股盈餘(元)']) });
    for (const r of b) map.set(r['公司代號'], { year: +r['年度'] + 1911, season: +r['季別'], eps: num(r['基本每股盈餘（元）']) });
    return map;
  });
}

/** 除權息預告(官方) */
function loadExDiv() {
  return cached('exdiv', 2 * HOUR, async () => {
    const [a, b] = await Promise.all([
      fetchJson(`${TW}/exchangeReport/TWT48U_ALL`).catch(() => []),
      fetchJson(`${OT}/tpex_exright_prepost`).catch(() => []),
    ]);
    const map = new Map();
    for (const r of a) map.set(r.Code, { date: rocToIso(r.Date), type: r.Exdividend, cash: num(r.CashDividend), stockRatio: num(r.StockDividendRatio) });
    for (const r of b) map.set(r.SecuritiesCompanyCode, { date: rocToIso(r.ExRrightsExDividendDate), type: r.ExRrightsExDividend, cash: num(r.CashDividend), stockRatio: num(r.StockDividendRatio) });
    return map;
  });
}

/* ───────── 搜尋 / 解析清單 ───────── */
async function searchStocks(q, limit = 8) {
  const { stocks } = await loadUniverse();
  q = toHalf(q).trim().toUpperCase();
  if (!q) return [];
  const nq = norm(q);
  const scored = [];
  for (const s of stocks.values()) {
    let score = 0;
    if (s.code === q) score = 100;
    else if (s.code.startsWith(q)) score = 80 - s.code.length + q.length;
    else if (norm(s.name) === nq) score = 95;
    else if (norm(s.name).startsWith(nq)) score = 70;
    else if (norm(s.name).includes(nq)) score = 50;
    else if (norm(s.full).includes(nq)) score = 30;
    else if (s.profile && norm(s.profile.english).includes(nq)) score = 25;
    if (score) scored.push([score + (s.etf ? -3 : 0) + (s.market === 'ESB' ? -2 : 0) + (s.mcap ? Math.min(5, Math.log10(s.mcap) / 3) : 0), s]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].code.localeCompare(b[1].code));
  return scored.slice(0, limit).map(([, s]) => brief(s));
}
const brief = (s) => ({ code: s.code, name: s.name, market: s.market, industry: s.industry, close: s.close, pct: s.pct, etf: s.etf, kind: s.kindLabel || '', limit: s.limit || null });

/** 一行一檔:代號或名稱;容許「2330 台積電」「2330.TW」「台積電,2330」等格式 */
async function resolveLines(lines) {
  const { stocks } = await loadUniverse();
  const byName = new Map(), byFull = new Map();
  for (const s of stocks.values()) { byName.set(norm(s.name), s); byFull.set(norm(s.full), s); }
  const out = [];
  for (const raw of lines) {
    const line = toHalf(raw).replace(/^﻿/, '').trim();
    if (!line || /^[#/;]/.test(line)) continue;
    const tokens = line.split(/[,\t;|、，\s]+/).filter(Boolean);
    const hits = [];
    const addHit = (st, how) => { if (st && !hits.some((h) => h.s.code === st.code)) hits.push({ s: st, how }); };
    // 1) 代號(含 .TW、TPE: 等寫法);2) 完整名稱
    for (const t of tokens) {
      const code = t.toUpperCase().replace(/^(TPE|TWSE|TPEX|TW|TWO)[:：]/, '').replace(/\.(TW|TWO)$/, '');
      if (/^[0-9]{4,6}[A-Z]?\d?$/.test(code) && stocks.has(code)) { addHit(stocks.get(code), 'code'); continue; }
      const n = norm(t);
      addHit(byName.get(n) || byFull.get(n), 'name');
    }
    // 3) 都沒有 → 唯一的部分比對;多個候選就請使用者選
    let ambiguous = null;
    if (!hits.length) for (const t of tokens) {
      const n = norm(t); if (n.length < 2) continue;
      const c = [...stocks.values()].filter((st) => norm(st.name).includes(n) || norm(st.full).includes(n));
      if (c.length === 1) { addHit(c[0], 'fuzzy'); break; }
      if (c.length > 1) { ambiguous = c.sort((x, y) => (y.mcap || 0) - (x.mcap || 0)).slice(0, 6).map(brief); break; }
    }
    if (hits.length) { for (const h of hits) out.push({ line: raw.trim(), ok: true, how: h.how, stock: brief(h.s) }); }
    else out.push({ line: raw.trim(), ok: false, candidates: ambiguous || [] });
  }
  return out;
}


/* ───────── 總覽 ───────── */
function stockRow(s, rev, margin, insti, annCount, exdiv) {
  return {
    ...brief(s), prevClose: s.prevClose, change: s.change, open: s.open, high: s.high, low: s.low,
    volume: s.volume !== null ? Math.round(s.volume / 1000) : null, value: s.value, date: s.date,
    pe: s.pe, pb: s.pb, yield: s.yield, mcap: s.mcap,
    rev: rev ? { ym: rev.ym, yoy: rev.yoy, mom: rev.mom, cumYoy: rev.cumYoy, amount: rev.rev !== null ? rev.rev * 1000 : null, note: rev.note } : null,
    insti: insti || null,
    margin: margin ? { margin: margin.margin, marginChg: margin.marginChg, short: margin.short, shortChg: margin.shortChg } : null,
    announcements: annCount, exdiv: exdiv || null,
  };
}

async function overview(codes) {
  const [{ stocks, quoteDate }, revenue, mg, ins, ann, ex] = await Promise.all([loadUniverse(), loadRevenue(), loadMargin(), loadInsti(), loadAnnouncements(), loadExDiv()]);
  const annCount = new Map();
  for (const a of ann) annCount.set(a.code, (annCount.get(a.code) || 0) + 1);
  const rows = [];
  for (const c of codes) {
    const s = stocks.get(c); if (!s) continue;
    rows.push(stockRow(s, revenue.get(c), mg.map.get(c), ins.map.get(c), annCount.get(c) || 0, ex.get(c)));
  }
  await applyYahooVolume(rows);
  return { quoteDate, instiDate: ins.twseDate, otcInstiDate: ins.otcDate, marginDate: mg.date, rows, fetchedAt: Date.now() };
}

/* ───────── 個股:概況 ───────── */
async function stockSummary(code) {
  const [{ stocks, quoteDate }, revenue, mg, ins, ann, ex, eps] = await Promise.all([loadUniverse(), loadRevenue(), loadMargin(), loadInsti(), loadAnnouncements(), loadExDiv(), loadOfficialEps()]);
  const s = stocks.get(code);
  if (!s) return null;
  const myAnn = ann.filter((a) => a.code === code);
  const row = stockRow(s, revenue.get(code), mg.map.get(code), ins.map.get(code), myAnn.length, ex.get(code));
  await applyYahooVolume([row]);
  return {
    ...row, full: s.full, profile: s.profile, announcementList: myAnn, quoteDate, instiDate: s.market === 'TWSE' ? ins.twseDate : ins.otcDate,
    marginDate: mg.date, valDate: s.valDate || null, officialEps: eps.get(code) || null, chains: await loadChains().then((c) => c.memberOf.get(code) || []).catch(() => []),
    stats: { shares: s.profile ? s.profile.shares : null },
  };
}

/* ───────── 個股:股價 ───────── */
async function stockPrice(code) {
  const start = isoDate(addDays(new Date(), -560));
  const data = await diskCached(`price_${code}`, 20 * MIN, async () => ({
    rows: (await finmind('TaiwanStockPrice', code, start)).map((r) => ({ d: r.date, o: r.open, h: r.max, l: r.min, c: r.close, v: Math.round(r.Trading_Volume / 1000) })),
  }));
  const rows = data.rows.filter((r) => r.c);
  const { stocks } = await loadUniverse();
  const s = stocks.get(code);
  // 官方行情比 FinMind 新 → 補上最新一根
  if (s && s.date && s.close !== null && rows.length && s.date > rows[rows.length - 1].d)
    rows.push({ d: s.date, o: s.open, h: s.high, l: s.low, c: s.close, v: s.volume !== null ? Math.round(s.volume / 1000) : null, official: true });
  const last = rows[rows.length - 1];
  const ret = (days) => {
    if (!last) return null;
    const cut = isoDate(addDays(new Date(last.d + 'T00:00:00Z'), -days));
    const base = [...rows].reverse().find((r) => r.d <= cut);
    return base ? ((last.c - base.c) / base.c) * 100 : null;
  };
  const year = rows.filter((r) => last && r.d >= isoDate(addDays(new Date(last.d + 'T00:00:00Z'), -365)));
  const ytdBase = last ? [...rows].reverse().find((r) => r.d < `${last.d.slice(0, 4)}-01-01`) : null;
  return {
    rows: rows.slice(-300), stale: !!data._stale,
    returns: { w1: ret(7), m1: ret(30), m3: ret(91), m6: ret(182), y1: ret(365), ytd: ytdBase && last ? ((last.c - ytdBase.c) / ytdBase.c) * 100 : null },
    high52: year.length ? Math.max(...year.map((r) => r.h ?? r.c)) : null,
    low52: year.length ? Math.min(...year.map((r) => r.l ?? r.c)) : null,
  };
}

/* ───────── 個股:營收 ───────── */
async function stockRevenue(code) {
  const start = isoDate(addDays(new Date(), -365 * 5));
  const data = await diskCached(`rev_${code}`, 3 * HOUR, async () => ({ rows: await finmind('TaiwanStockMonthRevenue', code, start) }));
  const m = new Map(); // 'YYYY-MM' -> 元
  for (const r of data.rows) m.set(`${r.revenue_year}-${String(r.revenue_month).padStart(2, '0')}`, r.revenue);
  const official = (await loadRevenue()).get(code) || null;
  let check = null;
  if (official && official.ym) {
    const key = `${official.ym.y}-${String(official.ym.m).padStart(2, '0')}`;
    const officialVal = official.rev !== null ? official.rev * 1000 : null;
    if (officialVal !== null) {
      const fm = m.get(key);
      check = { month: key, official: officialVal, finmind: fm ?? null, match: fm === undefined ? null : Math.abs(fm - officialVal) <= 1000 };
      m.set(key, officialVal); // 以官方為準
    }
  }
  const keys = [...m.keys()].sort();
  const rows = keys.map((k) => {
    const [y, mo] = k.split('-').map(Number);
    const ly = m.get(`${y - 1}-${String(mo).padStart(2, '0')}`);
    const pk = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
    const pv = m.get(pk);
    let cum = 0, cumLy = 0, full = true;
    for (let i = 1; i <= mo; i++) {
      const a = m.get(`${y}-${String(i).padStart(2, '0')}`), b = m.get(`${y - 1}-${String(i).padStart(2, '0')}`);
      if (a === undefined) { full = false; break; }
      cum += a; if (b === undefined) cumLy = null; else if (cumLy !== null) cumLy += b;
    }
    return {
      ym: k, rev: m.get(k), yoy: ly ? ((m.get(k) - ly) / ly) * 100 : null, mom: pv ? ((m.get(k) - pv) / pv) * 100 : null,
      cum: full ? cum : null, cumYoy: full && cumLy ? ((cum - cumLy) / cumLy) * 100 : null,
    };
  });
  const latest12 = rows.slice(-12);
  const last = rows[rows.length - 1];
  const highs = {
    in12: last ? last.rev >= Math.max(...latest12.map((r) => r.rev)) : false,
    in36: last ? last.rev >= Math.max(...rows.slice(-36).map((r) => r.rev)) : false,
    historic: last ? last.rev >= Math.max(...rows.map((r) => r.rev)) : false,
  };
  return { rows: rows.slice(-48), official, check, highs, stale: !!data._stale };
}

/* ───────── 個股:財報 ───────── */
const pick = (map, ...types) => { for (const t of types) if (map[t] !== undefined) return map[t]; return null; };
async function stockFinancials(code) {
  const start = isoDate(addDays(new Date(), -365 * 4));
  const data = await diskCached(`fin_${code}`, 6 * HOUR, async () => {
    const [fs_, bs, cf, dv] = await Promise.all([
      finmind('TaiwanStockFinancialStatements', code, start),
      finmind('TaiwanStockBalanceSheet', code, start),
      finmind('TaiwanStockCashFlowsStatement', code, start).catch(() => []),
      finmind('TaiwanStockDividend', code, isoDate(addDays(new Date(), -365 * 8))).catch(() => []),
    ]);
    return { fs: fs_, bs, cf, dv };
  });
  const byDate = (rows) => {
    const o = {};
    for (const r of rows) { if (/_per$/.test(r.type)) continue; (o[r.date] ||= {})[r.type] = r.value; }
    return o;
  };
  const F = byDate(data.fs), B = byDate(data.bs), C = byDate(data.cf);
  const dates = Object.keys(F).sort();
  const q = dates.map((d) => {
    const f = F[d], b = B[d] || {};
    const rev = pick(f, 'Revenue'), gp = pick(f, 'GrossProfit'), op = pick(f, 'OperatingIncome');
    const ni = pick(f, 'IncomeAfterTaxes', 'IncomeAfterTax', 'IncomeFromContinuingOperations');
    const niP = pick(f, 'EquityAttributableToOwnersOfParent');
    return {
      date: d, label: `${d.slice(0, 4)}Q${Math.ceil(+d.slice(5, 7) / 3)}`,
      rev, gp, op, ni, niParent: niP ?? ni, pretax: pick(f, 'PreTaxIncome'), eps: pick(f, 'EPS'),
      gm: rev && gp !== null ? (gp / rev) * 100 : null, om: rev && op !== null ? (op / rev) * 100 : null, nm: rev && ni !== null ? (ni / rev) * 100 : null,
      assets: pick(b, 'TotalAssets'), liab: pick(b, 'Liabilities'), curA: pick(b, 'CurrentAssets'), curL: pick(b, 'CurrentLiabilities'),
      equity: pick(b, 'EquityAttributableToOwnersOfParent', 'Equity'), cash: pick(b, 'CashAndCashEquivalents'), inv: pick(b, 'Inventories'),
      shares: (() => { const c = pick(b, 'OrdinaryShare', 'CapitalStock'); return c ? c / 10 : null; })(),
    };
  });
  // FinMind 對部分公司(多為金融股)新一季 EPS 尚未更新 → 以「歸屬母公司淨利 ÷ 股數」估算,並標示
  for (const r of q) {
    if (r.eps === null && r.niParent !== null && r.shares) { r.eps = Math.round((r.niParent / r.shares) * 100) / 100; r.epsDerived = true; }
  }
  // 現金流量表為年度累計 → 還原為單季
  const cdates = Object.keys(C).sort();
  const cfQ = {};
  for (const d of cdates) {
    const ocf = pick(C[d], 'CashFlowsFromOperatingActivities', 'NetCashInflowFromOperatingActivities');
    const capex = pick(C[d], 'PropertyAndPlantAndEquipment');
    const prevD = cdates.find((x) => x.slice(0, 4) === d.slice(0, 4) && +x.slice(5, 7) === +d.slice(5, 7) - 3);
    const p = prevD ? C[prevD] : null;
    const pOcf = p ? pick(p, 'CashFlowsFromOperatingActivities', 'NetCashInflowFromOperatingActivities') : 0;
    const pCap = p ? pick(p, 'PropertyAndPlantAndEquipment') : 0;
    if (+d.slice(5, 7) !== 3 && !prevD) { cfQ[d] = null; continue; }
    cfQ[d] = { ocf: ocf !== null ? ocf - (pOcf || 0) : null, capex: capex !== null ? capex - (pCap || 0) : null };
  }
  for (const r of q) {
    const c = cfQ[r.date];
    r.ocf = c ? c.ocf : null; r.capex = c ? c.capex : null;
    r.fcf = c && c.ocf !== null && c.capex !== null ? c.ocf + c.capex : null; // capex 為負數
  }
  // 衍生:TTM
  const n = q.length;
  const sum4 = (key, i) => { const w = q.slice(i - 3, i + 1); return w.length === 4 && w.every((x) => x[key] !== null) ? w.reduce((a, x) => a + x[key], 0) : null; };
  for (let i = 0; i < n; i++) {
    const r = q[i];
    r.epsTtm = sum4('eps', i);
    const ni4 = sum4('niParent', i);
    const e0 = r.equity, e4 = i >= 4 ? q[i - 4].equity : null, eP = i >= 1 ? q[i - 1].equity : null;
    const avgEq = e0 !== null && e4 !== null ? (e0 + e4) / 2 : (e0 !== null && eP !== null ? (e0 + eP) / 2 : null);
    r.roe = ni4 !== null && avgEq ? (ni4 / avgEq) * 100 : null;
    const rv4 = sum4('rev', i); r.revTtm = rv4;
    r.debtRatio = r.assets && r.liab !== null ? (r.liab / r.assets) * 100 : null;
    r.currentRatio = r.curL && r.curA !== null ? (r.curA / r.curL) * 100 : null;
    const prev = i >= 4 ? q[i - 4] : null;
    r.revYoy = prev && prev.rev ? ((r.rev - prev.rev) / Math.abs(prev.rev)) * 100 : null;
    r.epsYoy = prev && prev.eps !== null && r.eps !== null && prev.eps !== 0 ? ((r.eps - prev.eps) / Math.abs(prev.eps)) * 100 : null;
  }
  // 官方累計 EPS 核對
  const officialEps = (await loadOfficialEps()).get(code) || null;
  let epsCheck = null;
  if (officialEps && officialEps.eps !== null) {
    const parts = q.filter((r) => +r.date.slice(0, 4) === officialEps.year && Math.ceil(+r.date.slice(5, 7) / 3) <= officialEps.season);
    if (parts.length === officialEps.season && parts.every((r) => r.eps !== null)) {
      const s = parts.reduce((a, r) => a + r.eps, 0);
      epsCheck = { year: officialEps.year, season: officialEps.season, official: officialEps.eps, finmind: +s.toFixed(2), match: Math.abs(s - officialEps.eps) < (parts.some((r) => r.epsDerived) ? 0.1 : 0.06), derived: parts.some((r) => r.epsDerived) };
    } else epsCheck = { year: officialEps.year, season: officialEps.season, official: officialEps.eps, finmind: null, match: null };
  }
  // 股利:以除息日分組
  const div = data.dv.map((r) => ({
    period: r.year, announce: r.date, cash: (r.CashEarningsDistribution || 0) + (r.CashStatutorySurplus || 0),
    stock: (r.StockEarningsDistribution || 0) + (r.StockStatutorySurplus || 0),
    exCash: r.CashExDividendTradingDate || null, exStock: r.StockExDividendTradingDate || null, pay: r.CashDividendPaymentDate || null,
  })).filter((r) => r.cash || r.stock).sort((a, b) => String(b.exCash || b.exStock || b.announce).localeCompare(String(a.exCash || a.exStock || a.announce)));
  const byYear = {};
  for (const r of div) { const d = r.exCash || r.exStock; if (!d) continue; const y = d.slice(0, 4); byYear[y] = (byYear[y] || 0) + r.cash; }
  const { stocks } = await loadUniverse();
  const s = stocks.get(code);
  const lastYearCash = (() => {
    const cut = isoDate(addDays(new Date(), -365));
    return div.filter((r) => r.exCash && r.exCash >= cut && r.exCash <= isoDate(new Date())).reduce((a, r) => a + r.cash, 0);
  })();
  return {
    quarters: q.slice(-12), dividends: div.slice(0, 16), dividendByYear: byYear,
    ttmCashDividend: lastYearCash, ttmYield: s && s.close && lastYearCash ? (lastYearCash / s.close) * 100 : null,
    epsCheck, officialEps, stale: !!data._stale,
    kind: q.length && q[q.length - 1].gp === null ? 'financial' : 'general',
  };
}

/* ───────── 個股:籌碼 ───────── */
async function stockChips(code) {
  const start = isoDate(addDays(new Date(), -75));
  const data = await diskCached(`chips_${code}`, 20 * MIN, async () => {
    const [ii, mg, sh] = await Promise.all([
      finmind('TaiwanStockInstitutionalInvestorsBuySell', code, start),
      finmind('TaiwanStockMarginPurchaseShortSale', code, start).catch(() => []),
      finmind('TaiwanStockShareholding', code, start).catch(() => []),
    ]);
    return { ii, mg, sh };
  });
  const days = {};
  for (const r of data.ii) {
    const d = (days[r.date] ||= { date: r.date, foreign: 0, trust: 0, dealer: 0 });
    const net = (r.buy - r.sell) / 1000;
    if (r.name === 'Foreign_Investor' || r.name === 'Foreign_Dealer_Self') d.foreign += net;
    else if (r.name === 'Investment_Trust') d.trust += net;
    else d.dealer += net; // Dealer_self + Dealer_Hedging
  }
  const insti = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
  // 官方最新一日若比 FinMind 新,補上
  const [ins, { stocks }] = await Promise.all([loadInsti(), loadUniverse()]);
  const s = stocks.get(code);
  const offDate = s && (s.market === 'TWSE' ? ins.twseDate : ins.otcDate);
  const off = ins.map.get(code);
  if (off && offDate && (!insti.length || offDate > insti[insti.length - 1].date))
    insti.push({ date: offDate, foreign: off.foreign, trust: off.trust, dealer: off.dealer, official: true });
  for (const d of insti) d.total = d.foreign + d.trust + d.dealer;
  const margin = data.mg.map((r) => ({
    date: r.date, margin: r.MarginPurchaseTodayBalance, short: r.ShortSaleTodayBalance,
    marginLimit: r.MarginPurchaseLimit, offset: r.OffsetLoanAndShort,
  })).sort((a, b) => a.date.localeCompare(b.date));
  const mgOff = (await loadMargin());
  const mo = mgOff.map.get(code);
  if (mo && mgOff.date && margin.length && mgOff.date > margin[margin.length - 1].date) margin.push({ date: mgOff.date, margin: mo.margin, short: mo.short, official: true });
  const holding = data.sh.map((r) => ({ date: r.date, ratio: r.ForeignInvestmentSharesRatio, remain: r.ForeignInvestmentRemainRatio })).sort((a, b) => a.date.localeCompare(b.date));
  const sumLast = (k, n) => insti.slice(-n).reduce((a, x) => a + x[k], 0);
  return {
    insti: insti.slice(-40), margin: margin.slice(-40), holding: holding.slice(-40),
    sums: Object.fromEntries([5, 10, 20].map((n) => [n, { foreign: sumLast('foreign', n), trust: sumLast('trust', n), dealer: sumLast('dealer', n), total: sumLast('total', n) }])),
    stale: !!data._stale,
  };
}

/* ───────── 個股:產業 ───────── */
async function stockIndustry(code) {
  const [{ stocks }, revenue, ins, mg] = await Promise.all([loadUniverse(), loadRevenue(), loadInsti(), loadMargin()]);
  const me = stocks.get(code);
  if (!me) return null;
  const members = [...stocks.values()].filter((s) => s.industry === me.industry && s.close !== null && s.market !== 'ESB' && !s.etf);
  const withRev = members.map((s) => ({ s, r: revenue.get(s.code) }));
  const rows = members.map((s) => ({ ...brief(s), mcap: s.mcap, pe: s.pe, pb: s.pb, yield: s.yield, volume: s.volume !== null ? Math.round(s.volume / 1000) : null, revYoy: revenue.get(s.code)?.yoy ?? null, foreign: ins.map.get(s.code)?.foreign ?? null }));
  rows.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
  const rank = (key, desc = true) => {
    const mine = rows.find((r) => r.code === code); if (!mine || mine[key] === null || mine[key] === undefined) return null;
    const list = rows.filter((r) => r[key] !== null && r[key] !== undefined);
    const pos = list.filter((r) => (desc ? r[key] > mine[key] : r[key] < mine[key])).length + 1;
    return { pos, of: list.length };
  };
  const revCur = withRev.filter((x) => x.r && x.r.rev !== null && x.r.ly).reduce((a, x) => a + x.r.rev, 0);
  const revLy = withRev.filter((x) => x.r && x.r.rev !== null && x.r.ly).reduce((a, x) => a + x.r.ly, 0);
  const pcts = members.map((s) => s.pct).filter((x) => x !== null);
  const peList = members.map((s) => s.pe).filter((x) => x && x > 0);
  const pbList = members.map((s) => s.pb).filter((x) => x && x > 0);
  const yoyList = withRev.map((x) => x.r && x.r.yoy).filter((x) => x !== null && x !== undefined);
  const foreignSum = members.reduce((a, s) => a + (ins.map.get(s.code)?.foreign || 0), 0);
  const topN = rows.slice(0, 12);
  if (!topN.find((r) => r.code === code)) { const mine = rows.find((r) => r.code === code); if (mine) topN.push(mine); }
  return {
    industry: me.industry, count: members.length,
    up: pcts.filter((x) => x > 0).length, down: pcts.filter((x) => x < 0).length, flat: pcts.filter((x) => x === 0).length,
    medianPct: median(pcts), medianPe: median(peList), medianPb: median(pbList), medianYield: median(members.map((s) => s.yield).filter((x) => x)),
    medianRevYoy: median(yoyList), revYoyPositive: yoyList.filter((x) => x > 0).length, revYoyCount: yoyList.length,
    aggRevYoy: revLy ? ((revCur - revLy) / revLy) * 100 : null, foreignNet: foreignSum,
    ranks: { mcap: rank('mcap'), pe: rank('pe', false), yield: rank('yield'), revYoy: rank('revYoy') },
    peers: topN, me: code,
  };
}

/* ───────── 新聞 ───────── */
const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, '').trim();
// 論壇/部落格/社群貼文不算新聞,過濾掉
const NOT_NEWS_SOURCE = /CMoney|股市爆料|Mobile01|痞客邦|pixnet|Medium|方格子|vocus|Threads|Facebook|Instagram|PTT|Dcard|YouTube|Podcast|KOL/i;
const NOT_NEWS_TITLE = /股市爆料同學會|爆料同學會/;
async function googleNews(query, limit = 25) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const xml = await fetchText(url, { timeout: 20000 });
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const tag = (t) => { const x = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return x ? decode(x[1]) : ''; };
    let title = tag('title'); const source = tag('source');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    const pub = new Date(tag('pubDate'));
    items.push({ title, link: tag('link'), source, time: isNaN(pub) ? null : pub.toISOString() });
  }
  const seen = new Set();
  return items.filter((i) => !NOT_NEWS_SOURCE.test(i.source) && !NOT_NEWS_TITLE.test(i.title)).filter((i) => { const k = norm(i.title).slice(0, 24); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, limit);
}
async function stockNews(code) {
  const { stocks } = await loadUniverse();
  const s = stocks.get(code);
  if (!s) return null;
  const data = await diskCached(`news_${code}`, 15 * MIN, async () => ({ items: await googleNews(`${s.name} ${code} when:30d`) }));
  return { items: data.items, stale: !!data._stale, query: `${s.name} ${code}` };
}
async function industryNews(code) {
  const { stocks } = await loadUniverse();
  const s = stocks.get(code);
  if (!s) return null;
  const term = s.industry.replace(/(工業|業)$/, '');
  const data = await diskCached(`indnews_${norm(s.industry)}`, 30 * MIN, async () => ({ items: await googleNews(`${term} 產業 台股 -ETF when:14d`, 15) }));
  return { items: data.items, industry: s.industry, stale: !!data._stale };
}

/* ───────── 台股總覽 / 熱力圖 / 產業 ───────── */
const isCompany = (s) => !!s.profile && !s.etf && s.market !== 'ESB';

/** 各產業彙總:平均漲跌(成分股漲跌幅的簡單平均)、家數、成交值、法人買賣超… */
async function industryTable() {
  const [{ stocks }, revenue, ins] = await Promise.all([loadUniverse(), loadRevenue(), loadInsti()]);
  const map = new Map();
  for (const s of stocks.values()) {
    if (!isCompany(s)) continue;
    const g = map.get(s.industry) || { name: s.industry, count: 0, traded: 0, mcap: 0, prevMcap: 0, wsum: 0, value: 0, up: 0, down: 0, flat: 0, pcts: [], foreign: 0, trust: 0, dealer: 0, revCur: 0, revLy: 0, list: [] };
    g.count++;
    if (s.close !== null && s.pct !== null) {
      g.traded++; g.pcts.push(s.pct);
      if (s.pct > 0) g.up++; else if (s.pct < 0) g.down++; else g.flat++;
      const w = s.profile.shares && s.prevClose ? s.profile.shares * s.prevClose : 0;
      g.prevMcap += w; g.wsum += w * s.pct;
      if (s.mcap) g.mcap += s.mcap;
      g.value += s.value || 0;
      g.list.push(s);
    }
    const i = ins.map.get(s.code); if (i) { g.foreign += i.foreign; g.trust += i.trust; g.dealer += i.dealer; }
    const r = revenue.get(s.code); if (r && r.rev !== null && r.ly) { g.revCur += r.rev; g.revLy += r.ly; }
    map.set(s.industry, g);
  }
  return [...map.values()].map((g) => {
    const top = g.list.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
    return {
      name: g.name, count: g.count, traded: g.traded, mcap: g.mcap, value: g.value,
      pct: g.pcts.length ? g.pcts.reduce((a, b) => a + b, 0) / g.pcts.length : null, pctCap: g.prevMcap ? g.wsum / g.prevMcap : null, medianPct: median(g.pcts), up: g.up, down: g.down, flat: g.flat,
      foreign: Math.round(g.foreign), trust: Math.round(g.trust), dealer: Math.round(g.dealer),
      revYoy: g.revLy ? ((g.revCur - g.revLy) / g.revLy) * 100 : null,
      top: top.slice(0, 3).map((s) => ({ code: s.code, name: s.name, pct: s.pct })),
    };
  }).sort((a, b) => b.mcap - a.mcap);
}

async function heatmap(scope, n, by) {
  const { stocks, quoteDate } = await loadUniverse();
  let list = [...stocks.values()].filter((s) => isCompany(s) && s.close !== null && s.pct !== null && s.mcap);
  if (scope === 'twse') list = list.filter((s) => s.market === 'TWSE');
  else if (scope === 'tpex') list = list.filter((s) => s.market === 'TPEx');
  const key = by === 'value' ? (s) => s.value || 0 : (s) => s.mcap;
  list.sort((a, b) => key(b) - key(a));
  const total = list.length;
  list = list.slice(0, Math.max(20, Math.min(n || 200, 1200)));
  return {
    date: quoteDate, total, by,
    stocks: list.map((s) => ({ c: s.code, n: s.name, i: s.industry, m: s.mcap, v: s.value, p: s.pct, x: s.close, k: s.market })),
  };
}

async function industryDetail(name) {
  const [{ stocks, quoteDate }, revenue, ins, table, ex] = await Promise.all([loadUniverse(), loadRevenue(), loadInsti(), industryTable(), loadExDiv()]);
  const agg = table.find((g) => g.name === name);
  if (!agg) return null;
  const rows = [...stocks.values()].filter((s) => isCompany(s) && s.industry === name).map((s) => {
    const r = revenue.get(s.code), i = ins.map.get(s.code);
    return {
      ...brief(s), date: s.date, mcap: s.mcap, value: s.value, volume: s.volume !== null ? Math.round(s.volume / 1000) : null, pe: s.pe, pb: s.pb, yield: s.yield,
      revYoy: r ? r.yoy : null, revYm: r ? r.ym : null, foreign: i ? i.foreign : null, trust: i ? i.trust : null,
      exdiv: ex.get(s.code) ? ex.get(s.code).date : null, listed: s.profile.listed,
    };
  }).sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
  await applyYahooVolume(rows);
  let chainsHere = [];
  try {
    const { chains } = await loadChains();
    const codes = new Set(rows.map((r) => r.code));
    chainsHere = chains.filter((c) => c.kind === 'chain' || c.kind === 'ey').map((c) => {
      const all = chainCodes(c), inHere = all.filter((x) => codes.has(x));
      return { ic: c.ic, name: c.name, kind: c.kind, src: c.kind === 'ey' ? 'Yahoo電子產業' : '櫃買產業鏈', inIndustry: inHere.length, total: all.length, main: inHere.length / all.length >= 0.25 };
    }).filter((c) => c.inIndustry >= 3 && (c.main || c.inIndustry / c.total >= 0.15 || c.inIndustry / rows.length >= 0.1)).sort((a, b) => Number(b.main) - Number(a.main) || b.inIndustry - a.inIndustry);
  } catch (e) { console.warn('[chains]', e.message); }
  return { date: quoteDate, industry: agg, stocks: rows, chains: chainsHere, rank: { byMcap: table.findIndex((g) => g.name === name) + 1, of: table.length } };
}

async function twseHistory() {
  const now = new Date();
  const months = [0, 1, 2].map((k) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1)); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}01`; });
  const out = new Map();
  await Promise.all(months.map(async (m) => {
    try {
      const j = await fetchJson(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${m}&response=json`);
      if (j.stat !== 'OK') return;
      for (const r of j.data) {
        const [y, mo, d] = r[0].split('/').map(Number);
        const date = `${y + 1911}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        out.set(date, { date, volume: num(r[1]), value: num(r[2]), trades: num(r[3]), index: num(r[4]), change: num(r[5]) });
      }
    } catch { /* skip month */ }
  }));
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function loadMarket() {
  return cached('market', 10 * MIN, async () => {
    const [twHist, otcIdx, otcTrade, { stocks, quoteDate }, , table] = await Promise.all([
      twseHistory().catch(() => []),
      fetchJson(`${OT}/tpex_index`).catch(() => []),
      fetchJson(`${OT}/tpex_daily_trading_index`).catch(() => []),
      loadUniverse(), loadInsti(), industryTable(),
    ]);
    const otcVal = new Map(otcTrade.map((r) => [rocToIso(r.Date), { value: num(r.TradeAmount), volume: num(r.TradeVolume) }]));
    const otc = otcIdx.map((r) => ({ date: rocToIso(r.Date), index: num(r.Close), change: num(r.Change), ...(otcVal.get(rocToIso(r.Date)) || {}) })).filter((r) => r.date && r.index !== null).sort((a, b) => a.date.localeCompare(b.date)).slice(-70);
    // 三大法人買賣金額(元)
    let twseInst = null, otcInst = null;
    for (let i = 0; i < 7 && quoteDate && !twseInst; i++) {
      const d = isoDate(addDays(new Date(quoteDate + 'T00:00:00Z'), -i));
      try {
        const j = await fetchJson(`https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${isoToCompact(d)}&response=json`);
        if (j.stat !== 'OK' || !j.data) continue;
        const get = (kw) => { const r = j.data.find((x) => x[0] === kw); return r ? num(r[3]) : null; };
        twseInst = { date: d, foreign: (get('外資及陸資(不含外資自營商)') || 0) + (get('外資自營商') || 0), trust: get('投信'), dealer: (get('自營商(自行買賣)') || 0) + (get('自營商(避險)') || 0), total: get('合計') };
      } catch { /* retry earlier day */ }
    }
    try {
      const j = await fetchJson(`${OT}/tpex_3insti_summary`);
      const clean = (x) => String(x.Investor).replace(/[\s　*]/g, '');
      const net = (name) => { const r = j.find((x) => clean(x) === name); return r ? num(r.Net) : null; }; // 櫃買的合計列才不會重複計算
      otcInst = { date: rocToIso(j[0] && j[0].Date), foreign: net('外資及陸資合計'), trust: net('投信'), dealer: net('自營商合計'), total: net('三大法人合計') };
    } catch { /* ignore */ }
    // 漲跌家數、排行(僅個股)
    const co = [...stocks.values()].filter((s) => isCompany(s) && s.close !== null && s.pct !== null);
    const breadth = (list) => ({ up: list.filter((s) => s.pct > 0).length, down: list.filter((s) => s.pct < 0).length, flat: list.filter((s) => s.pct === 0).length, limitUp: list.filter((s) => s.limit === 'up').length, limitDown: list.filter((s) => s.limit === 'down').length });
    const rk = (s) => ({ code: s.code, name: s.name, market: s.market, date: s.date, close: s.close, limit: s.limit || null, pct: s.pct, change: s.change, volume: s.volume !== null ? Math.round(s.volume / 1000) : null, value: s.value, industry: s.industry });
    const liquid = co.filter((s) => (s.value || 0) >= 5e7);
    const allTraded = [...stocks.values()].filter((s) => s.close !== null && s.volume);
    const out = {
      date: quoteDate,
      twse: { history: twHist.slice(-70), inst: twseInst },
      tpex: { history: otc, inst: otcInst },
      breadth: { twse: breadth(co.filter((s) => s.market === 'TWSE')), tpex: breadth(co.filter((s) => s.market === 'TPEx')) },
      gainers: [...liquid].sort((a, b) => b.pct - a.pct).slice(0, 10).map(rk),
      losers: [...liquid].sort((a, b) => a.pct - b.pct).slice(0, 10).map(rk),
      byValue: [...co].sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 10).map(rk),
      byVolume: allTraded.sort((a, b) => b.volume - a.volume).slice(0, 10).map(rk),
      industries: table.map((g) => ({ name: g.name, pct: g.pct, mcap: g.mcap, value: g.value, up: g.up, down: g.down, foreign: g.foreign, count: g.count })),
    };
    await applyYahooVolume([...out.gainers, ...out.losers, ...out.byValue, ...out.byVolume]);
    return out;
  });
}

/* ───────── 產業鏈(櫃買中心「產業價值鏈資訊平台」) ─────────
 * 官方產業別只有一層(例:電子零組件業)。細分(被動元件、連接器、印刷電路板…)取自櫃買中心的產業鏈:
 * 每條產業鏈分上游/中游/下游的環節,每個環節列出相關的上市、上櫃、興櫃公司。一檔股票可能屬於多條產業鏈。 */
const IC_BASE = 'https://ic.tpex.org.tw';
async function fetchTextRetry(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) { try { return await fetchText(url, { timeout: 30000 }); } catch (e) { err = e; await new Promise((r) => setTimeout(r, 600 * (i + 1))); } }
  throw err;
}
function parseChainPage(html, ic, name) {
  const strip = (x) => decode(String(x || '').replace(/&nbsp;/g, ' ')).replace(/\s+/g, ' ').trim();
  html = html.replace(/<!--[\s\S]*?-->/g, ''); // 被註解掉的環節不算
  const start = html.indexOf('id="main_ic_panel"');
  const end = html.indexOf('id="companyList_');
  const chainHtml = start >= 0 ? html.slice(start, end > 0 ? end : undefined) : '';
  const streams = [];
  for (const part of chainHtml.split('class="chain-title-panel">').slice(1)) {
    const sname = strip(part.slice(0, part.indexOf('<')));
    const nodes = [];
    for (const m of part.matchAll(/id="ic_link_(\w+)"[^>]*>([\s\S]*?)<\/div>/g)) {
      const inner = m[2];
      const desc = (inner.match(/<span[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '';
      nodes.push({ id: m[1], name: strip(inner.split(/<br\s*\/?>/)[0]), desc: strip(desc).replace(/^[((]|[))]$/g, ''), codes: [] });
    }
    if (nodes.length) streams.push({ name: sname, nodes });
  }
  if (!streams.length) { // 沒有上中下游,只有並列的環節
    const nodes = [];
    for (const m of chainHtml.matchAll(/id="ic_link_(\w+)"[^>]*>([\s\S]*?)<\/div>/g)) nodes.push({ id: m[1], name: strip(m[2].split(/<br\s*\/?>/)[0]), desc: '', codes: [] });
    if (nodes.length) streams.push({ name: '產業環節', nodes });
  }
  const byId = new Map(streams.flatMap((st) => st.nodes).map((n) => [n.id, n]));
  const re = /<div id="companyList_(\w+)"[^>]*class="x-hidden">([\s\S]*?)(?=<div id="companyList_|<\/center>|$)/g;
  for (const m of html.matchAll(re)) {
    const node = byId.get(m[1]);
    if (!node) continue;
    node.codes = [...new Set([...m[2].matchAll(/company_basic\.php\?stk_code=([0-9A-Za-z]+)/g)].map((x) => x[1]))];
  }
  return { ic, name, streams };
}
/* ───────── Yahoo 奇摩股市「類股報價」的細分類 ─────────
 * 電子產業(LED、太陽能、PCB、面板業、光學元件、被動元件…)、概念股(AI、蘋果供應鏈、低軌衛星…)、集團股(鴻海、台塑…)。
 * 這些分類與看盤軟體的「產業類股/概念類股/集團類股」相近;官方只有一層產業別,細分只能靠這類網站整理。 */
const YH_BASE = 'https://tw.stock.yahoo.com';
const YH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' };
const YH_KINDS = { '電子產業': 'ey', '概念股': 'concept', '集團股': 'group' };
const KIND_NAME = { chain: '產業鏈', ey: '電子產業細分', concept: '概念股', group: '集團股' };
async function yahooList(resource) {
  const codes = [];
  for (let off = 0; off < 1500; off += 30) {
    const url = `${YH_BASE}/_td-stock/api/resource/StockServices.getClassQuotes;${resource};offset=${off}?device=desktop&intl=tw&lang=zh-Hant-TW&region=TW&site=finance&tz=Asia/Taipei&returnMeta=true`;
    const txt = await fetchText(url, { timeout: 25000, headers: YH_HEADERS });
    const page = [...new Set([...txt.matchAll(/"symbol":"(\d{4,6}[A-Z]?)\.(TW|TWO)"/g)].map((m) => m[1]))];
    codes.push(...page);
    if (page.length < 30) break;
  }
  return [...new Set(codes)];
}
/* ───────── 成交量口徑 ─────────
 * 證交所/櫃買的「成交股數」含一般整股、盤中與盤後零股、盤後定價、鉅額(含股票組合),且組合鉅額沒有逐檔公布。
 * Yahoo 奇摩股市與盤中即時行情顯示的是一般整股成交量。顯示個股時改用 Yahoo 的數字讓兩邊一致;抓不到才退回官方總量。 */
const YH_Q = '?device=desktop&intl=tw&lang=zh-Hant-TW&region=TW&site=finance&tz=Asia/Taipei&returnMeta=true';
const yahooQuoteCache = new Map();
async function yahooQuotes(items) {
  const out = new Map(), need = [];
  for (const it of items) {
    if (!it || it.market === 'ESB') continue;
    const hit = yahooQuoteCache.get(it.code);
    if (hit && Date.now() - hit.t < 5 * MIN) out.set(it.code, hit); else if (!need.some((n) => n.code === it.code)) need.push(it);
  }
  const chunks = [];
  for (let i = 0; i < need.length; i += 50) chunks.push(need.slice(i, i + 50));
  await Promise.all(chunks.map(async (ch) => {
    try {
      const syms = ch.map((x) => `${x.code}.${x.market === 'TWSE' ? 'TW' : 'TWO'}`).join(',');
      const j = await fetchJson(`${YH_BASE}/_td-stock/api/resource/StockServices.stockList;symbols=${syms}${YH_Q}`, { timeout: 20000, headers: YH_HEADERS });
      for (const x of j.data || []) {
        const code = String(x.symbol || '').split('.')[0];
        const vol = Number(x.volume), turn = Number(x.turnoverM) * 1e6;
        const date = x.regularMarketTime ? new Date(new Date(x.regularMarketTime).getTime() + 8 * 3600e3).toISOString().slice(0, 10) : null;
        const e = { t: Date.now(), date, vol: Number.isFinite(vol) && vol > 0 ? vol : null, turn: Number.isFinite(turn) && turn > 0 ? turn : null };
        yahooQuoteCache.set(code, e); out.set(code, e);
      }
    } catch (e) { console.warn('[yahoo quotes]', e.message); }
  }));
  return out;
}
/** rows 需有 code、market、date、volume(張);成交值(value)若存在也一併換成同口徑 */
async function applyYahooVolume(rows) {
  const list = rows.filter(Boolean);
  const ys = await yahooQuotes(list.map((r) => ({ code: r.code, market: r.market })));
  for (const r of list) {
    const y = ys.get(r.code);
    if (!y || y.date !== r.date || y.vol === null) continue;
    r.volumeAll = r.volume; r.volume = Math.round(y.vol / 1000);
    if ('value' in r && y.turn !== null) { r.valueAll = r.value; r.value = y.turn; }
    r.volSrc = 'yahoo';
  }
  return rows;
}

function loadYahooGroups() {
  return cached('yahooGroups', 6 * HOUR, async () => {
    const d = await diskCached('yahoo_groups_v1', 24 * HOUR, async () => {
      const html = await fetchText(`${YH_BASE}/class/`, { timeout: 30000, headers: YH_HEADERS });
      const cats = [];
      const seen = new Set();
      for (const m of html.matchAll(/href="\/class-quote\?category=([^&"]+)&amp;categoryLabel=([^"]+)"[^>]*>([^<]*)</g)) {
        let name, label;
        try { name = decodeURIComponent(m[1]); label = decodeURIComponent(m[2]); } catch { continue; }
        const kind = YH_KINDS[label];
        if (!kind || seen.has(label + '|' + name)) continue;
        seen.add(label + '|' + name);
        cats.push({ kind, label, name });
      }
      if (!cats.length) throw new Error('yahoo: no categories');
      const counters = { ey: 0, concept: 0, group: 0 };
      cats.forEach((c) => { c.id = `Y${{ ey: 'E', concept: 'C', group: 'G' }[c.kind]}${String(++counters[c.kind]).padStart(2, '0')}`; });
      let i = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (i < cats.length) {
          const c = cats[i++];
          try {
            c.codes = await yahooList(`category=${encodeURIComponent(c.name)};categoryLabel=${encodeURIComponent(c.label)};categoryName=${encodeURIComponent(c.name)}`);
          } catch (e) { c.codes = []; console.warn('[yahoo] fail', c.name, e.message); }
        }
      }));
      return { groups: cats.filter((c) => c.codes.length) };
    });
    return d.groups;
  });
}

function loadChains() {
  return cached('chains', 6 * HOUR, async () => {
    const d = await diskCached('chains_v1', 24 * HOUR, async () => {
      const first = await fetchTextRetry(`${IC_BASE}/introduce.php?ic=D000`);
      const opts = [...first.matchAll(/<option value='([^']+)'[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], decode(m[2])]);
      const out = [];
      let i = 0;
      await Promise.all(Array.from({ length: 5 }, async () => {
        while (i < opts.length) {
          const [ic, name] = opts[i++];
          try { out.push(parseChainPage(await fetchTextRetry(`${IC_BASE}/introduce.php?ic=${ic}`), ic, name)); }
          catch (e) { console.warn('[chain] fail', ic, e.message); }
        }
      }));
      if (!out.length) throw new Error('no chains');
      const order = new Map(opts.map((o, k) => [o[0], k]));
      out.sort((a, b) => order.get(a.ic) - order.get(b.ic));
      return { chains: out };
    });
    const memberOf = new Map(); // code -> [{ic,name,stream,node}]
    for (const c of d.chains) for (const st of c.streams) for (const n of st.nodes) for (const code of n.codes) {
      const arr = memberOf.get(code) || [];
      arr.push({ ic: c.ic, name: c.name, stream: st.name, node: n.name, nodeId: n.id, kind: 'chain' });
      memberOf.set(code, arr);
    }
    // 櫃買中心沒有單一的「光電」分類:顯示器、觸控、LED、太陽能都屬於光電,這裡合併成一條方便查看
    const chains = [...d.chains];
    const opto = ['G000', 'H000', 'A200', 'A100'].map((ic) => d.chains.find((c) => c.ic === ic)).filter(Boolean);
    if (opto.length) {
      const virtual = {
        ic: 'OPTO', name: '光電',
        streams: opto.map((c) => ({ name: c.name, nodes: c.streams.flatMap((st) => st.nodes.map((n) => ({ ...n, id: `OPTO_${n.id}`, name: `${st.name}・${n.name}` }))) })),
      };
      const at = Math.max(0, chains.findIndex((c) => c.ic === 'D000')) + 1;
      chains.splice(at, 0, virtual);
    }
    for (const c of chains) c.kind = 'chain';
    try {
      for (const g of await loadYahooGroups()) {
        chains.push({ ic: g.id, name: g.name, kind: g.kind, source: 'Yahoo奇摩股市', streams: [{ name: g.label, nodes: [{ id: g.id, name: g.name, desc: '', codes: g.codes }] }] });
        for (const code of g.codes) {
          const arr = memberOf.get(code) || [];
          arr.push({ ic: g.id, name: g.name, stream: g.label, node: g.name, nodeId: g.id, kind: g.kind });
          memberOf.set(code, arr);
        }
      }
    } catch (e) { console.warn('[yahoo groups]', e.message); }
    return { chains, memberOf, stale: !!d._stale };
  });
}
const chainCodes = (c) => [...new Set(c.streams.flatMap((st) => st.nodes.flatMap((n) => n.codes)))];

async function chainTable() {
  const [{ chains }, { stocks }, revenue, ins] = await Promise.all([loadChains(), loadUniverse(), loadRevenue(), loadInsti()]);
  return chains.map((c) => {
    const list = chainCodes(c).map((code) => stocks.get(code)).filter(Boolean);
    const co = list.filter((s) => isCompany(s) && s.close !== null && s.pct !== null);
    let w = 0, ws = 0, mcap = 0, value = 0, foreign = 0, revCur = 0, revLy = 0;
    for (const s of co) {
      const pw = s.profile.shares && s.prevClose ? s.profile.shares * s.prevClose : 0;
      w += pw; ws += pw * s.pct; mcap += s.mcap || 0; value += s.value || 0;
      const i = ins.map.get(s.code); if (i) foreign += i.foreign;
      const r = revenue.get(s.code); if (r && r.rev !== null && r.ly) { revCur += r.rev; revLy += r.ly; }
    }
    const top = [...co].sort((a, b) => (b.mcap || 0) - (a.mcap || 0)).slice(0, 3);
    return {
      ic: c.ic, name: c.name, kind: c.kind || 'chain', kindName: KIND_NAME[c.kind || 'chain'], count: list.length, traded: co.length, mcap, value, pct: co.length ? co.reduce((a, s) => a + s.pct, 0) / co.length : null, pctCap: w ? ws / w : null,
      up: co.filter((s) => s.pct > 0).length, down: co.filter((s) => s.pct < 0).length, flat: co.filter((s) => s.pct === 0).length,
      foreign: Math.round(foreign), revYoy: revLy ? ((revCur - revLy) / revLy) * 100 : null,
      top: top.map((s) => ({ code: s.code, name: s.name, pct: s.pct })),
    };
  }).filter((c) => c.count > 0);
}

async function chainDetail(ic) {
  const [{ chains }, { stocks, quoteDate }, revenue, ins, table] = await Promise.all([loadChains(), loadUniverse(), loadRevenue(), loadInsti(), chainTable()]);
  const c = chains.find((x) => x.ic === ic);
  if (!c) return null;
  const mini = (code) => { const s = stocks.get(code); return s ? { ...brief(s), mcap: s.mcap } : null; };
  const nodesOf = new Map();
  const streams = c.streams.map((st) => ({
    name: st.name,
    nodes: st.nodes.map((n) => {
      for (const code of n.codes) nodesOf.set(code, [...(nodesOf.get(code) || []), `${st.name}・${n.name}`]);
      return { id: n.id, name: n.name, desc: n.desc, stocks: n.codes.map(mini).filter(Boolean).sort((a, b) => (b.mcap || 0) - (a.mcap || 0)) };
    }),
  }));
  const rows = [...nodesOf.keys()].map((code) => {
    const s = stocks.get(code); if (!s) return null;
    const r = revenue.get(code), i = ins.map.get(code);
    return {
      ...brief(s), date: s.date, mcap: s.mcap, value: s.value, volume: s.volume !== null ? Math.round(s.volume / 1000) : null, pe: s.pe, pb: s.pb, yield: s.yield,
      revYoy: r ? r.yoy : null, foreign: i ? i.foreign : null, nodes: nodesOf.get(code),
    };
  }).filter(Boolean).sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
  await applyYahooVolume(rows);
  return { date: quoteDate, chain: { ic: c.ic, name: c.name, kind: c.kind || 'chain', kindName: KIND_NAME[c.kind || 'chain'], source: c.source || (c.ic === 'OPTO' ? '櫃買中心產業價值鏈資訊平台(合併)' : '櫃買中心產業價值鏈資訊平台') }, agg: table.find((x) => x.ic === ic) || null, streams, stocks: rows };
}

/** 公司「主要經營業務」「所屬集團」(Yahoo 奇摩股市公司資料,來源為公開資訊觀測站申報) */
async function stockAbout(code) {
  const { stocks } = await loadUniverse();
  const st = stocks.get(code);
  if (!st) return null;
  const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  return diskCached(`about_${code}`, 7 * 24 * HOUR, async () => {
    for (const suf of st.market === 'TWSE' ? ['TW', 'TWO'] : ['TWO', 'TW']) {
      try {
        const t = strip(await fetchText(`${YH_BASE}/quote/${code}.${suf}/profile`, { timeout: 25000, headers: YH_HEADERS }));
        const m = t.match(/主要經營業務\s*(.+?)\s*(?:配股資訊|財務資訊|股利|$)/);
        if (m && m[1] && m[1].length > 1) {
          const g = t.match(/所屬集團\s*([^\s]+)/);
          return { business: m[1].trim(), group: g && g[1] !== '主要經營業務' ? g[1] : null, source: 'Yahoo奇摩股市(公開資訊觀測站申報)' };
        }
      } catch { /* try other suffix */ }
    }
    return { business: null, group: null };
  });
}

/* ───────── HTTP ───────── */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
/* ───────── 使用者偏好(自選股清單、主題、熱力圖設定)存在本機檔案,瀏覽器版與桌面版共用 ───────── */
const readPrefs = () => { try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; } };
function writePrefs(input) {
  const cur = readPrefs();
  if (Array.isArray(input.watch)) cur.watch = [...new Set(input.watch.map(String).filter((c) => /^[0-9A-Za-z]{4,6}$/.test(c)))].slice(0, 500);
  if (input.theme === 'light' || input.theme === 'dark') cur.theme = input.theme;
  for (const k of ['hm', 'sc']) if (input[k] && typeof input[k] === 'object' && JSON.stringify(input[k]).length < 2000) cur[k] = input[k];
  const tmp = PREFS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cur));
  fs.renameSync(tmp, PREFS_FILE);
  return cur;
}

const readBody = (req) => new Promise((resolve, reject) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 2e6) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => resolve(s)); req.on('error', reject);
});

const routes = [
  [/^\/api\/search$/, async (u) => ({ results: await searchStocks(u.searchParams.get('q') || '') })],
  [/^\/api\/overview$/, async (u) => overview((u.searchParams.get('codes') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 300))],
  [/^\/api\/stock\/([\w]+)$/, (u, m) => stockSummary(m[1].toUpperCase())],
  [/^\/api\/stock\/([\w]+)\/price$/, (u, m) => stockPrice(m[1].toUpperCase())],
  [/^\/api\/stock\/([\w]+)\/revenue$/, (u, m) => stockRevenue(m[1].toUpperCase())],
  [/^\/api\/stock\/([\w]+)\/financials$/, (u, m) => stockFinancials(m[1].toUpperCase())],
  [/^\/api\/stock\/([\w]+)\/chips$/, (u, m) => stockChips(m[1].toUpperCase())],
  [/^\/api\/stock\/([\w]+)\/about$/, (u, m) => stockAbout(m[1].toUpperCase())],
  [/^\/api\/stock\/([\w]+)\/industry$/, (u, m) => stockIndustry(m[1].toUpperCase())],
  [/^\/api\/stock\/([\w]+)\/news$/, async (u, m) => ({ stock: await stockNews(m[1].toUpperCase()), industry: await industryNews(m[1].toUpperCase()).catch(() => null) })],
  [/^\/api\/market$/, () => loadMarket()],
  [/^\/api\/heatmap$/, (u) => heatmap(u.searchParams.get('scope') || 'all', Number(u.searchParams.get('n')) || 200, u.searchParams.get('by') === 'value' ? 'value' : 'mcap')],
  [/^\/api\/chains$/, async (u) => { const kind = u.searchParams.get('kind'); const all = await chainTable(); return { chains: kind ? all.filter((c) => c.kind === kind) : all, date: (await loadUniverse()).quoteDate }; }],
  [/^\/api\/chain\/(\w+)$/, (u, m) => chainDetail(m[1])],
  [/^\/api\/industries$/, async () => ({ industries: await industryTable(), date: (await loadUniverse()).quoteDate })],
  [/^\/api\/industry\/(.+)$/, (u, m) => industryDetail(decodeURIComponent(m[1]))],
  [/^\/api\/status$/, async () => { const u = await loadUniverse(); return { quoteDate: u.quoteDate, count: u.stocks.size, finmindToken: !!FINMIND_TOKEN }; }],
];

let lastActivity = Date.now(); // 最近一次收到請求的時間(桌面版啟動器靠它判斷視窗還開著)
const handler = async (req, res) => {
  try {
    lastActivity = Date.now();
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === '/api/ping') { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
    if (u.pathname === '/api/prefs') {
      if (req.method === 'GET') return send(res, 200, readPrefs());
      if (req.method === 'POST') {
        if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'need json' });
        return send(res, 200, writePrefs(JSON.parse((await readBody(req)) || '{}')));
      }
    }
    if (req.method === 'POST' && u.pathname === '/api/resolve') {
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'need json' });
      const body = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, { results: await resolveLines(Array.isArray(body.lines) ? body.lines.slice(0, 500) : []) });
    }
    if (u.pathname.startsWith('/api/')) {
      const sm = u.pathname.match(/^\/api\/stock\/([\w]+)/);
      if (sm && !(await loadUniverse()).stocks.has(sm[1].toUpperCase())) return send(res, 404, { error: '找不到這檔股票' });
      for (const [re, fn] of routes) {
        const m = u.pathname.match(re);
        if (m) {
          const out = await fn(u, m);
          if (out === null) return send(res, 404, { error: '找不到這檔股票' });
          return send(res, 200, out);
        }
      }
      return send(res, 404, { error: 'unknown endpoint' });
    }
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
    });
  } catch (e) {
    console.error(req.url, e.message);
    send(res, 502, { error: '資料來源暫時無法連線,請稍後再試', detail: e.message });
  }
};
const server = http.createServer(handler);
const server6 = http.createServer(handler); // ::1,讓 localhost 在 IPv6 優先的環境也連得上

/** 啟動伺服器;port 傳 0 代表由系統挑一個可用的連接埠(桌面應用使用) */
function startServer(opts = {}) {
  const port = opts.port !== undefined ? opts.port : PORT;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const actual = server.address().port;
      server6.on('error', () => {});
      if (port !== 0) server6.listen(actual, '::1');
      loadUniverse().then((u) => console.log(`  行情資料日期 ${u.quoteDate},共 ${u.stocks.size} 檔`)).catch((e) => console.warn('  預載失敗:', e.message));
      loadChains().then((c) => console.log(`  產業鏈 ${c.chains.length} 條`)).catch((e) => console.warn('  產業鏈預載失敗:', e.message));
      resolve({ port: actual, server });
    });
  });
}

const openBrowser = (port) => {
  if (!PACKED || process.env.NO_OPEN === '1') return;
  const url = `http://localhost:${port}`;
  const cmd = process.platform === 'win32' ? `start "" ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
  require('child_process').exec(cmd, () => {});
};

module.exports = { startServer, lastActivity: () => lastActivity };

// 直接執行(node server.js 或打包的執行檔)才自動啟動;被桌面應用 require 時由它呼叫 startServer
if ((require.main === module || PACKED) && process.env.SI_EMBEDDED !== '1') {
  if (PACKED && process.platform === 'win32') { try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch { /* 主控台編碼維持預設 */ } }
  startServer({ port: PORT }).then(({ port }) => {
    console.log(`\n  台股產業分析已啟動 → http://localhost:${port}\n  (關閉這個視窗就會停止)\n`);
    openBrowser(port);
  }).catch((e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`\n  連接埠 ${PORT} 已被使用,可能已經有一份在執行。直接開啟 http://localhost:${PORT}\n`);
      openBrowser(PORT);
      setTimeout(() => process.exit(0), 4000);
    } else { console.error(e); setTimeout(() => process.exit(1), 8000); }
  });
}
