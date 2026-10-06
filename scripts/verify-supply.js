'use strict';
/**
 * 驗證「整理的供應鏈題材」裡每家公司是否真的有公開報導把它列入該供應鏈,結果寫到 assets/supply/evidence.json。
 *
 * 做法:對每家公司查 Google 新聞近 365 天,「標題」必須同時出現
 *   1. 公司名稱  2. 題材關鍵字(例如 輝達、NVIDIA、GB200…)  3. 供應鏈字眼(打入、供貨、訂單、認證…)
 * 才算一則「證據」(strong);只有 1+2 沒有 3 的算 weak。結果保存證據標題與連結,畫面上可以點開自己看。
 *
 * 用法:node scripts/verify-supply.js [題材 id ...]   (不帶參數就跑全部題材;約 1~2 分鐘,可定期重跑更新)
 * 注意:這是「有沒有公開報導」的證據,不是官方認證名單。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const THEMES = path.join(ROOT, 'assets', 'supply', 'themes.json');
const OUT = path.join(ROOT, 'assets', 'supply', 'evidence.json');
const SUPPLY_WORDS = /供應鏈|供應商|供貨|供應|打入|入列|入選|獲選|認證|拿下|取得|訂單|出貨|導入|採用|合作|夥伴|受惠|生態系|獨家|指定|搶進|卡位|切入/;
// 論壇、部落格、社群、投顧推廣文不算證據(和網站新聞頁用同一套過濾)
const NOT_NEWS_SOURCE = /CMoney|股市爆料|Mobile01|痞客邦|pixnet|Medium|方格子|vocus|Threads|Facebook|Instagram|PTT|Dcard|YouTube|Podcast|KOL|同學會|旺得富|財經M平方|網誌|pocket\.tw|sinotrade/i;
const NOT_NEWS_TITLE = /股市爆料同學會|爆料同學會|【即時新聞】.*概念股/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
/** 容易和一般用詞或別家公司混淆的名稱:用比較精確的寫法查詢與比對(q 是查詢字串,re 是標題必須符合的樣式) */
const OVERRIDE = {
  1303: { q: '南亞', re: /南亞(?![科電塑])/ },
  5347: { q: '世界先進', re: /世界先進/ },
  2455: { q: '全新光電', re: /全新光電/ },
  3234: { q: '光環科技', re: /光環科技|光環\s*[((]?3234/ },
  3443: { q: '創意電子', re: /創意電子|創意\s*[((]?3443/ },
  3081: { q: '聯亞光電', re: /聯亞光電|聯亞(?!生技|藥)/ },
  6531: { q: '愛普', re: /愛普(?!生)/ },
  3374: { q: '精材科技', re: /精材/ },
  4977: { q: '眾達', re: /眾達/ },
  3030: { q: '德律', re: /德律/ },
};
/** 公司簡稱轉成報導裡常用的寫法:去掉 *、-KY、控股 等尾巴 */
const shortName = (n) => String(n).replace(/\*+$/, '').replace(/-KY$/i, '').replace(/投控$|控股$/, '');

async function news(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (TWStockSupplyVerify/1.0)' }, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const xml = await r.text();
      const items = [];
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const tag = (t) => { const x = m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return x ? decode(x[1]) : ''; };
        let title = tag('title'); const source = tag('source');
        if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
        const t = new Date(tag('pubDate'));
        items.push({ title, link: tag('link'), source, time: isNaN(t) ? null : t.toISOString() });
      }
      return items;
    } catch (e) { if (i === 2) throw e; await sleep(1500 * (i + 1)); }
  }
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(THEMES, 'utf8'));
  let old = {};
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* 第一次 */ }
  const only = process.argv.slice(2);
  const out = { updated: new Date().toISOString().slice(0, 10), themes: { ...(old.themes || {}) } };
  for (const t of cfg.themes) {
    if (only.length && !only.includes(t.id)) continue;
    const ev = t.evidence;
    if (!ev || !ev.query || !ev.anchor) { console.log(`略過 ${t.id}:themes.json 沒有 evidence 設定`); continue; }
    const anchor = new RegExp(ev.anchor, 'i');
    const companies = [...new Map(t.branches.flatMap((b) => b.companies).map((c) => [c.code, c])).values()];
    console.log(`\n== ${t.name}:驗證 ${companies.length} 家(關鍵字 ${ev.anchor})`);
    const res = {};
    let fail = 0;
    for (let i = 0; i < companies.length; i += 3) {
      await Promise.all(companies.slice(i, i + 3).map(async (c) => {
        const o = OVERRIDE[c.code], nm = o ? o.q : shortName(c.name);
        const nameRe = o ? o.re : new RegExp(nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        try {
          const items = await news(`"${nm}" (${ev.query}) when:365d`);
          const hit = items.filter((x) => !NOT_NEWS_SOURCE.test(x.source) && !NOT_NEWS_TITLE.test(x.title) && nameRe.test(x.title) && anchor.test(x.title));
          const strong = hit.filter((x) => SUPPLY_WORDS.test(x.title));
          const seen = new Set();
          const uniq = (arr) => arr.filter((x) => { const k = x.title.slice(0, 22); if (seen.has(k)) return false; seen.add(k); return true; });
          res[c.code] = { name: c.name, strong: strong.length, weak: hit.length - strong.length, items: uniq(strong).slice(0, 3).concat(uniq(hit.filter((x) => !strong.includes(x))).slice(0, 1)).map((x) => ({ title: x.title, link: x.link, source: x.source, time: x.time })) };
        } catch (e) { fail++; console.log(`  失敗 ${c.code} ${c.name}: ${e.message}`); }
      }));
      await sleep(400);
    }
    out.themes[t.id] = { query: ev.query, anchor: ev.anchor, companies: res };
    const conf = Object.values(res).filter((x) => x.strong >= 2).length, some = Object.values(res).filter((x) => x.strong === 1 || (x.strong === 0 && x.weak >= 3)).length;
    console.log(`  已證實(≥2 則供應鏈報導) ${conf} 家;有提到 ${some} 家;沒找到 ${Object.keys(res).length - conf - some} 家;查詢失敗 ${fail} 家`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`\n已寫入 ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
