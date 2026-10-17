// huangguo_auto spider —— 黄果短剧「自动寻活」版
// 站点线路域名频繁轮换(曾 wrjmtnebd→gupuoplgm→uc41p53k)，写死必坏。
// 本版运行时抓发布页解析当前可用线路，挑一个能渲染的用，域名轮换也能自动跟上。
// 发布页 https://huangguo6.com/ ｜ https://huangguoai.com/
import 'assets://js/lib/crypto-js.js';

const KEY = 'huangguo_auto';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IMG_KEY = 'f5d965df75336270';
const IMG_IV = '97b60394abc2fbe1';
const EMPTY_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=';

// 封面图是否走 JS 代理。
// 站点封面是 CDN 上的普通 JPEG/PNG（?auth_key= 签名，实测不带 Referer 也返回 200），
// 直连时由播放器自身并发加载；走代理则每张图都要"本地代理→外网→AES 解密→base64"，
// 首页 82 张卡、单张 7s 超时，首屏图要几十秒才出齐。
// 若将来 CDN 加了防盗链导致图片裂开，把这里改回 true 即可。
const USE_IMG_PROXY = false;

// 发布页（发布当前线路的地方）
const PUBLISH = ['https://huangguo6.com/', 'https://huangguoai.com/'];
// 硬编码兜底线路（发布页打不开时用；新旧家族都留几个）
const FALLBACK = [
  'https://ukr8b9.uc41p53k.cc', 'https://p5z1.uc41p53k.cc', 'https://igqu.uc41p53k.cc',
  'https://jzhk.gupuoplgm.cc', 'https://arwkjz.gupuoplgm.cc', 'https://x8u4o.gupuoplgm.cc',
  'https://50f2.gupuoplgm.cc', 'https://nj9ev.gupuoplgm.cc'
];

let ACTIVE = null; // 当前可用线路 base

// 探活时 getBase() 已经把首页 HTML 完整下载过一遍（只为判断 isContent），
// 以前这里直接丢掉、homeVod 再下一遍 —— 线路首页 TTFB 实测 6.9s，等于白扔 7 秒。
// 现在探活命中时顺手缓存，homeVod / category('home') 直接复用。
let HOME_HTML = '';
let HOME_BASE = '';
let HOME_TS = 0;
const HOME_TTL = 30000; // 30s 内复用；超过则重取，保证下拉刷新能拿到新内容

function nowMs() { try { return Date.now(); } catch (e) { return 0; } }

function cachedHome(base) {
  if (!HOME_HTML || !base || HOME_BASE !== base) return '';
  const t = nowMs();
  if (t && HOME_TS && t - HOME_TS > HOME_TTL) return '';
  return HOME_HTML;
}

function setHomeCache(html, base) {
  HOME_HTML = html || '';
  HOME_BASE = base || '';
  HOME_TS = nowMs();
}


function baseHeaders(referer) {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': referer || 'https://huangguoai.com/'
  };
}

function reqHtml(url, referer) {
  try {
    const r = req(url, { method: 'get', headers: baseHeaders(referer), timeout: 15000 });
    if (!r) return '';
    return typeof r.content === 'string' ? r.content : '';
  } catch (e) { return ''; }
}

// 从发布页 HTML 抽取线路域名
function extractDomains(html) {
  const out = [];
  let re, m;
  // 发布页 meta："线路 01地址 ukr8b9.uc41p53k.cc"
  re = /线路\s*\d+\s*地址\s*([a-z0-9][a-z0-9.-]*\.[a-z]+)/gi;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  // 兜底：页面里任意 xxx.yyy.cc 线路子域
  re = /https?:\/\/([a-z0-9-]+\.[a-z0-9-]+\.cc)\b/gi;
  while ((m = re.exec(html)) !== null) out.push(m[1]);

  const seen = {}, res = [];
  const ban = /(huangguo|googletag|cloudflare|gstatic|google|yandex|x\.com|t\.me|jsdelivr|allorigins|tc41p53k|ikorimlt)/i;
  for (const d of out) {
    if (seen[d]) continue;
    seen[d] = 1;
    if (ban.test(d)) continue;
    res.push('https://' + d);
  }
  return res;
}

function discoverSites() {
  const cands = [];
  for (const p of PUBLISH) {
    const h = reqHtml(p);
    if (h) for (const u of extractDomains(h)) if (cands.indexOf(u) < 0) cands.push(u);
  }
  for (const f of FALLBACK) if (cands.indexOf(f) < 0) cands.push(f);
  return cands;
}

function isContent(h) {
  return !!h && (h.indexOf('hg-card-grid') >= 0 || h.indexOf('hg-drama-card') >= 0);
}

function getBase(force) {
  if (ACTIVE && !force) return ACTIVE;
  if (force) { HOME_HTML = ''; HOME_BASE = ''; HOME_TS = 0; }
  const cands = discoverSites();
  for (const b of cands) {
    const h = reqHtml(b + '/');
    if (isContent(h)) {
      ACTIVE = b;
      setHomeCache(h, b); // 探活拿到的首页留着给 homeVod 用
      return b;
    }
  }
  ACTIVE = cands[0] || FALLBACK[0];
  return ACTIVE;
}

// 取内容页：当前线路失败则重选线路再试一次
function fetchPage(path) {
  let base = getBase();
  if (path === '/') {
    const c = cachedHome(base);
    if (c) return c;
  }
  let h = reqHtml(base + path, base + '/');
  if (h && h.length > 1500) {
    if (path === '/') setHomeCache(h, base);
    return h;
  }
  base = getBase(true);
  h = reqHtml(base + path, base + '/');
  if (h && path === '/') setHomeCache(h, base);
  return h || '';
}

function fix(u) {
  if (!u) return '';
  u = String(u).replace(/&amp;/g, '&');
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (u.indexOf('/') === 0) return getBase() + u;
  return u;
}

function coverUrl(u) {
  u = fix(u);
  if (!/^https?:\/\//i.test(u)) return '';
  if (!USE_IMG_PROXY) return u; // 直连 CDN，交给播放器并发加载
  return getProxy(true) + '&siteKey=' + KEY + '&url=' + encodeURIComponent(u);
}

function imageType(b64) {
  if (b64.indexOf('/9j/') === 0) return 'image/jpeg';
  if (b64.indexOf('iVBOR') === 0) return 'image/png';
  if (b64.indexOf('UklGR') === 0) return 'image/webp';
  if (b64.indexOf('R0lGOD') === 0) return 'image/gif';
  return '';
}

function decryptCover(b64) {
  if (imageType(b64)) return b64;
  try {
    const ciphertext = CryptoJS.enc.Base64.parse(b64);
    if (!ciphertext.sigBytes || ciphertext.sigBytes % 16) return '';
    const plaintext = CryptoJS.AES.decrypt(
      { ciphertext: ciphertext }, CryptoJS.enc.Utf8.parse(IMG_KEY),
      { iv: CryptoJS.enc.Utf8.parse(IMG_IV), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.NoPadding }
    );
    let hex = CryptoJS.enc.Hex.stringify(plaintext).toLowerCase();
    if (!/^(ffd8|89504e470d0a1a0a|52494646|47494638)/.test(hex)) return '';
    const pad = parseInt(hex.slice(-2), 16);
    if (pad > 0 && pad <= 16 && hex.slice(-2 * pad) === pad.toString(16).padStart(2, '0').repeat(pad)) {
      hex = hex.slice(0, -2 * pad);
    }
    let end = hex.lastIndexOf('ffd9');
    if (hex.indexOf('ffd8') === 0 && end >= 0) hex = hex.slice(0, end + 4);
    end = hex.lastIndexOf('49454e44ae426082');
    if (hex.indexOf('89504e47') === 0 && end >= 0) hex = hex.slice(0, end + 16);
    const o = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Hex.parse(hex));
    return imageType(o) ? o : '';
  } catch (e) { return ''; }
}

function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

const CLASSES = [
  { type_id: 'ai-duanju',  type_name: 'AI成人短剧' },
  { type_id: 'ai-manju',   type_name: 'AI成人漫剧' },
  { type_id: 'ai-huanlian', type_name: 'AI换脸' },
  { type_id: 'ai-mogai',   type_name: 'AI魔改' },
  { type_id: 'topics',     type_name: '专题' },
  { type_id: 'ranks/hot',  type_name: '排行榜' }
];

function gridSlices(html, allGrids) {
  const re = /<div\s+class="[^"]*\bhg-card-grid\b[^"]*"[^>]*>/g;
  const starts = [];
  let m;
  while ((m = re.exec(html)) !== null) starts.push(m.index + m[0].length);
  if (!starts.length) return [html];
  const slices = [];
  const n = allGrids ? starts.length : 1;
  for (let i = 0; i < n; i++) {
    const to = i + 1 < starts.length ? starts[i + 1] : html.length;
    slices.push(html.slice(starts[i], to));
  }
  return slices;
}

function cardBlocks(slice) {
  const re = /<div\s+class="[^"]*\bhg-drama-card\b[^"]*"[^>]*>/g;
  const starts = [];
  let m;
  while ((m = re.exec(slice)) !== null) starts.push(m.index + m[0].length);
  const blocks = [];
  for (let i = 0; i < starts.length; i++) {
    const to = i + 1 < starts.length ? starts[i + 1] : slice.length;
    blocks.push(slice.slice(starts[i], to));
  }
  return blocks;
}

function parseCardBlock(block) {
  const a = block.match(/href="[^"]*\/(?:detail|video)\/(\d+)\/[^"]*"/);
  if (!a) return null;
  const vid = a[1];
  const imgM = block.match(/data-src="([^"]+)"/) || block.match(/src="([^"]+)"/);
  let title = '';
  const t = block.match(/hg-drama-card__title[^>]*>([\s\S]*?)<\/a>/);
  if (t) title = stripTags(t[1]);
  if (!title) {
    const tt = block.match(/<a[^>]+href="[^"]*\/(?:detail|video)\/\d+\/[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (tt) title = stripTags(tt[1]);
  }
  if (!title) return null;
  title = title.replace(/全集在线观看\s*$/g, '').replace(/\s+/g, ' ').trim();
  const ep = block.match(/hg-drama-card__episode[^>]*>([\s\S]*?)<\/span>/);
  const score = block.match(/hg-drama-card__score[^>]*>([\s\S]*?)<\/span>/);
  const rem = ep ? stripTags(ep[1]) : '';
  const sc = score ? stripTags(score[1]) : '';
  return {
    vod_id: vid, vod_name: title,
    vod_pic: coverUrl(imgM ? imgM[1] : ''),
    vod_remarks: rem && sc ? rem + ' · ' + sc : (rem || sc)
  };
}

function parseGridCards(html, allGrids) {
  if (!html) return [];
  const list = [], seen = {};
  const slices = gridSlices(html, allGrids);
  for (let si = 0; si < slices.length; si++) {
    const blocks = cardBlocks(slices[si]);
    for (let bi = 0; bi < blocks.length; bi++) {
      try {
        const item = parseCardBlock(blocks[bi]);
        if (!item || seen[item.vod_id]) continue;
        seen[item.vod_id] = true;
        list.push(item);
      } catch (e) {}
    }
  }
  if (!list.length) {
    const re = /<a\b[^>]*href="([^"]*\/video\/(\d+)\/)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const id = m[2];
      if (seen[id]) continue;
      let name = stripTags(m[3]).replace(/全集在线观看\s*$/g, '').trim();
      if (!name || /^\d+$/.test(name)) continue;
      seen[id] = true;
      list.push({ vod_id: id, vod_name: name, vod_pic: '', vod_remarks: '' });
    }
  }
  return list;
}

function parseRanks(html) {
  if (!html) return [];
  const list = [], seen = {};
  const listM = html.match(/<div\s+class="[^"]*\bhg-rank-list\b[^"]*"[^>]*>/);
  const slice = html.slice(listM ? listM.index + listM[0].length : 0);
  const re = /<div\s+class="[^"]*\bhg-rank-item\b[^"]*"[^>]*>/g;
  const starts = [];
  let m;
  while ((m = re.exec(slice)) !== null) starts.push(m.index + m[0].length);
  for (let i = 0; i < starts.length; i++) {
    const to = i + 1 < starts.length ? starts[i + 1] : slice.length;
    const block = slice.slice(starts[i], to);
    const a = block.match(/href="[^"]*\/(?:detail|video)\/(\d+)\/[^"]*"/);
    if (!a || seen[a[1]]) continue;
    const id = a[1];
    const imgM = block.match(/data-src="([^"]+)"/) || block.match(/src="([^"]+)"/);
    let title = '';
    const t = block.match(/hg-rank-item__title[^>]*>([\s\S]*?)<\/h2>/);
    if (t) title = stripTags(t[1]);
    if (!title) {
      const tt = block.match(/<a[^>]+href="[^"]*\/(?:detail|video)\/\d+\/[^"]*"[^>]*>([\s\S]*?)<\/a>/);
      if (tt) title = stripTags(tt[1]);
    }
    if (!title) continue;
    const tags = block.match(/hg-rank-item__tags[^>]*>([\s\S]*?)<\/div>/);
    seen[id] = true;
    list.push({ vod_id: id, vod_name: title, vod_pic: coverUrl(imgM ? imgM[1] : ''), vod_remarks: tags ? stripTags(tags[1]) : '' });
  }
  return list.length ? list : parseGridCards(html, true);
}

function parseTitle(html, fallback) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripTags(h1[1]);
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title) return stripTags(title[1]).replace(/\s*[-|｜].*$/, '').trim();
  return fallback || '';
}

function parsePic(html) {
  const og = html.match(/<meta\b[^>]*(?:property|name)="og:image"[^>]*content="([^"]+)"[^>]*>/i) ||
             html.match(/<meta\b[^>]*content="([^"]+)"[^>]*(?:property|name)="og:image"[^>]*>/i);
  if (og) return coverUrl(og[1]);
  const pic = html.match(/<img\b[^>]*data-src="([^"]+)"[^>]*/i) || html.match(/<img\b[^>]*src="([^"]+)"[^>]*/i);
  return coverUrl(pic ? pic[1] : '');
}

function normPlayUrl(u) {
  return String(u || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/&amp/g, '&').trim();
}

function extractEpMap(html) {
  const map = {};
  const m = html.match(/"epPlaySrcs"\s*:\s*\{([\s\S]*?)\}/);
  if (!m) return map;
  const re = /"(\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let x;
  while ((x = re.exec(m[1])) !== null) map[x[1]] = normPlayUrl(x[2]);
  return map;
}

// 从观看页/接口解析某集的播放地址
function parsePlayUrl(html, id, ep) {
  // 1) 观看页内嵌 epPlaySrcs
  const map = extractEpMap(html);
  if (map[String(ep)]) return map[String(ep)];
  // 2) 页面里任意 m3u8（?ep=N 页渲染的当前集 source）
  const dm = html.match(/https?:\/\/[^"'<>\s]+?\.m3u8(?:\?[^"'<>\s]*)?/i);
  if (dm) return normPlayUrl(dm[0]);
  // 3) 兜底：/api/videos/{id} 的 video_url（第1集）
  try {
    const r = reqHtml(getBase() + '/api/videos/' + id, getBase() + '/');
    const d = JSON.parse(r).data || {};
    if (d.video_url) return normPlayUrl(d.video_url);
  } catch (e) {}
  return '';
}

function detailEpisodesFromApi(id) {
  try {
    const r = reqHtml(getBase() + '/api/videos/' + id, getBase() + '/');
    const data = JSON.parse(r).data || {};
    const arr = data.episodes || [];
    let eps = arr.map(function (e) { return parseInt(e.ep_num || e.ep || e.num, 10); }).filter(function (n) { return !isNaN(n); });
    if (!eps.length && data.video_url) eps = [1];
    return eps;
  } catch (e) { return []; }
}

export default {
  init(ext) { this.ext = ext || {}; },

  home(filter) { return JSON.stringify({ class: CLASSES }); },

  homeVod() {
    try {
      const base = getBase();
      let html = cachedHome(base);
      if (!html) {
        html = reqHtml(base + '/', base + '/');
        if (html) setHomeCache(html, base);
      }
      return JSON.stringify({ list: parseGridCards(html, true) });
    } catch (e) { return JSON.stringify({ list: [] }); }
  },

  category(tid, pg, filter, extend) {
    const page = Math.max(1, parseInt(pg || '1', 10) || 1);
    try {
      let path;
      if (tid === 'home') path = '/';
      else {
        const id = String(tid || '').replace(/^\/+|\/+$/g, '');
        path = '/' + id + '/' + (page > 1 ? page + '/' : '');
      }
      const html = fetchPage(path);
      const list = String(tid).indexOf('rank') !== -1 ? parseRanks(html) : parseGridCards(html, false);
      return JSON.stringify({
        list: list, page: page,
        pagecount: list.length ? page + 1 : page,
        limit: list.length || 20,
        total: list.length ? (page + 1) * (list.length || 20) : page * 20
      });
    } catch (e) { return JSON.stringify({ list: [], page: page, pagecount: page }); }
  },

  detail(id) {
    id = String(id || '').trim();
    if (!id) return JSON.stringify({ list: [] });
    try {
      const base = getBase();
      const html = reqHtml(base + '/video/' + id + '/', base + '/');
      let eps = Object.keys(extractEpMap(html)).map(function (k) { return parseInt(k, 10); })
        .filter(function (n) { return !isNaN(n); }).sort(function (a, b) { return a - b; });
      if (!eps.length) eps = detailEpisodesFromApi(id);
      if (!eps.length) eps = [1];

      const playList = [];
      for (let i = 0; i < eps.length; i++) {
        playList.push('第' + eps[i] + '集$' + base + '/video/' + id + '/?ep=' + eps[i] + '|||' + id + '|||' + eps[i]);
      }
      const vod = {
        vod_id: id, vod_name: parseTitle(html, id), vod_pic: parsePic(html),
        vod_play_from: '黄果', vod_play_url: playList.join('#')
      };
      return JSON.stringify({ list: [vod] });
    } catch (e) { return JSON.stringify({ list: [] }); }
  },

  search(wd, quick, pg) {
    const key = String(wd || '').trim();
    const page = Math.max(1, parseInt(pg || '1', 10) || 1);
    if (!key) return JSON.stringify({ list: [], page: page, pagecount: page });
    try {
      const html = fetchPage('/search/video/' + encodeURIComponent(key) + '/' + (page > 1 ? page + '/' : ''));
      const list = parseGridCards(html, false);
      return JSON.stringify({
        list: list, page: page,
        pagecount: list.length ? page + 1 : page,
        limit: list.length || 20,
        total: list.length ? (page + 1) * (list.length || 20) : page * 20
      });
    } catch (e) { return JSON.stringify({ list: [], page: page, pagecount: page }); }
  },

  play(flag, id, vipFlags) {
    try {
      const parts = String(id || '').split('|||');
      const pageUrl = fix(parts[0]);
      const vid = parts.length > 1 ? parts[1] : '';
      const ep = parts.length > 2 ? parts[2] : '1';
      if (!pageUrl) return JSON.stringify({ parse: 0, url: '' });
      const html = reqHtml(pageUrl, getBase() + '/');
      let play = parsePlayUrl(html, vid, ep);
      if (!play) {
        // 换线路重试一次
        ACTIVE = null;
        const base = getBase(true);
        const html2 = reqHtml(base + '/video/' + vid + '/?ep=' + ep, base + '/');
        play = parsePlayUrl(html2, vid, ep);
      }
      if (!play) return JSON.stringify({ parse: 0, url: '' });
      return JSON.stringify({ parse: 0, url: play, header: { 'User-Agent': UA, 'Referer': getBase() + '/' } });
    } catch (e) { return JSON.stringify({ parse: 0, url: '' }); }
  },

  proxy(params) {
    try {
      const url = String(params && params.url || '');
      if (!/^https?:\/\//i.test(url)) return [200, 'image/png', EMPTY_IMAGE, {}, 1];
      const r = req(url, { method: 'get', headers: baseHeaders(), buffer: 2, timeout: 7000 });
      if (!r || Number(r.code) !== 200 || !r.content) return [200, 'image/png', EMPTY_IMAGE, {}, 1];
      const image = decryptCover(String(r.content));
      if (!image) return [200, 'image/png', EMPTY_IMAGE, {}, 1];
      return [200, imageType(image), image, { 'Cache-Control': 'public, max-age=3600' }, 1];
    } catch (e) { return [200, 'image/png', EMPTY_IMAGE, {}, 1]; }
  }
};
