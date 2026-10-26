// huangguo_auto spider —— 黄果短剧「自动寻活」版
// 站点线路域名频繁轮换(曾 wrjmtnebd→gupuoplgm→uc41p53k)，写死必坏。
// 本版运行时抓发布页解析当前可用线路，挑一个能渲染的用，域名轮换也能自动跟上。
// 发布页 https://huangguo6.com/ ｜ https://huangguoai.ai/
import 'assets://js/lib/crypto-js.js';

const KEY = 'huangguo_auto';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IMG_KEY = 'f5d965df75336270';
const IMG_IV = '97b60394abc2fbe1';
const EMPTY_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=';

// 封面图必须走 JS 代理（2026-10-18 实测纠正）。
// pic.drleao.cn 返回的**不是**普通 JPEG/PNG，而是 AES 加密后的字节：
//   无 Referer 请求 -> HTTP 200 / binary/octet-stream / 前 4 字节 DD E2 8C 47（非图片魔数）
//   本地 AES-128-CBC(key=f5d965df75336270, iv=97b60394abc2fbe1, NoPadding) 解密后
//   -> 89504E47…(PNG) / FFD8FFDB…(JPEG) 正常图片。
// 所以直连时播放器拿到的是密文 ⇒ 全部裂图。代价是每张图要走"播放器→本地代理→CDN→AES→base64"，
// 单张 7s 超时、且响应带 Cache-Control: max-age=3600，翻页时命中本地缓存就不再重复解密。
const USE_IMG_PROXY = true;

// 发布页（发布当前线路的地方）
// 2026-10-18 实测：huangguoai.com 已完全不通（>14.5s 无响应），每次冷启动白等满 15s 超时；
// 同品牌的 huangguoai.ai 1.6s 正常返回 3 条线路（hjgd/oc83/ik4wwi.ye28r31s.cc），故替换之。
// 2026-10-26 新增 hgdhy1.com/way-home（官方"最新地址 / 防迷路"页）：
//   实测 200 / 227KB / 0.94s，含 __NEXT_DATA__.sourceList(type=VID) 线路 + "直连无需代理"卡片；
//   当天 huangguo6.com 给的是 vnir.h2na6qa39.cc（200 / 337ms / hg-card-grid 可渲染），
//   huangguoai.ai 给的是 *.40ygo615.cc；新页给的 *.kuqawj.cn 是 APP 专用签名线路，直连 403。
const PUBLISH = ['https://huangguo6.com/', 'https://huangguoai.ai/', 'https://hgdhy1.com/way-home'];
// 硬编码兜底线路（发布页打不开时用；当前有效线路均为 *.nx51k64p.cc 家族）
const FALLBACK = [
  'https://xjudu.nx51k64p.cc', 'https://imgue2.nx51k64p.cc', 'https://sdyz5.nx51k64p.cc',
  'https://ukr8b9.uc41p53k.cc', 'https://p5z1.uc41p53k.cc', 'https://igqu.uc41p53k.cc'
];

let ACTIVE = null; // 当前可用线路 base
let EXT = {};      // init(ext) 存进来：{ "port": 9978 } 可覆盖本地图片代理端口

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
    'Referer': referer || 'https://huangguoai.ai/'
  };
}

// 2026-10-26：新线路 h2na6qa39.cc / 40ygo615.cc 有"连接被重置"的毛病
// （实测同一 URL 有时第一次就 ECONNRESET，隔一下再请求就 200，命中率大概一半）。
// 所以这里加"秒失败重试"：只有失败得很快（<3s，说明是重置/立即 4xx，不是真的超时）才重试，
// 最多 3 次；超时的那种不再白等第二遍。
function reqHtml(url, referer, timeout) {
  const t = timeout || 15000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = nowMs();
    try {
      const r = req(url, { method: 'get', headers: baseHeaders(referer), timeout: t });
      const c = r && typeof r.content === 'string' ? r.content : '';
      if (c) return c;
      if (nowMs() - t0 > 3000) return '';
    } catch (e) {
      if (nowMs() - t0 > 3000) return '';
    }
  }
  return '';
}

// 从发布页 HTML 抽取线路域名（兼容三种发布页格式）
function extractDomains(html) {
  const out = [];
  let re, m, u;
  // ① 旧发布页 meta："线路 01地址 ukr8b9.uc41p53k.cc"
  re = /线路\s*\d+\s*地址\s*([a-z0-9][a-z0-9.-]*\.[a-z]+)/gi;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  // ② 兜底：页面里任意 xxx.yyy.cc 线路子域
  re = /https?:\/\/([a-z0-9-]+\.[a-z0-9-]+\.cc)\b/gi;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  // ③ 新发布页（hgdhy1.com/way-home，Next.js）"直连无需代理"卡片的域名：
  //    <p class="WayHomePageView_routeDomain__T8Fgu">oqdfj.com</p>
  re = /routeDomain__[A-Za-z0-9_]+">([a-z0-9][a-z0-9.-]*\.[a-z]{2,})</gi;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  //    同页按钮 aria-label="立即进入 https://xxx"
  re = /立即进入\s*(https?:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;
  while ((m = re.exec(html)) !== null) out.push(m[1].replace(/^https?:\/\//i, ''));
  //    同页 __NEXT_DATA__.sourceList 里 type=VID 的线路；
  //    其余 type（GUIDE/IMAGE/AppStore/TELEGRAM/Mailbox…）是官网、图片床、社交，不能当线路。
  re = /"type":"VID"/g;
  while ((m = re.exec(html)) !== null) {
    const win = html.slice(Math.max(0, m.index - 700), m.index);
    const ur = /"url":"(https?:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,})"/gi;
    while ((u = ur.exec(win)) !== null) out.push(u[1].replace(/^https?:\/\//i, ''));
  }

  const seen = {}, res = [];
  // 官网 / 统计 / 社交 / 图片床都不可能是内容线路
  const ban = /(huangguo|hgdhy1|hgdj|googletag|cloudflare|cloudfront|gstatic|google|yandex|x\.com|t\.me|jsdelivr|allorigins|instagram|youtube|ahrefs|gmail|tc41p53k|ikorimlt)/i;
  for (const d of out) {
    const host = String(d).toLowerCase().replace(/\/.*$/, '');
    if (!host || seen[host]) continue;
    seen[host] = 1;
    if (ban.test(host)) continue;
    res.push('https://' + host);
  }
  return rankCands(res);
}

// 排序：a.b.cc 这类线路子域优先探活，oqdfj.com 这类两段式官网域名放最后。
// 目的：冷启动先撞上能直连的线路，别把时间花在官网落地页上。
function rankCands(list) {
  const line = [], other = [];
  for (let i = 0; i < list.length; i++) {
    const host = list[i].replace(/^https?:\/\//i, '');
    if (host.split('.').length >= 3) line.push(list[i]); else other.push(list[i]);
  }
  return line.concat(other);
}

function isContent(h) {
  return !!h && (h.indexOf('hg-card-grid') >= 0 || h.indexOf('hg-drama-card') >= 0);
}

// 逐页探活：抓一页发布页 → 立刻按顺序试它给的线路 → 都不行再抓下一页。
// 以前是"先把所有发布页抓完再试"，3 个发布页就白等 3 秒；现在第一页有活线路就只花一页的时间。
// 探活超时 8s：旧线路家族首页 TTFB 实测到过 6.9s，压到 6s 会误杀慢但能用的线路。
function getBase(force) {
  if (ACTIVE && !force) return ACTIVE;
  if (force) { HOME_HTML = ''; HOME_BASE = ''; HOME_TS = 0; }
  const seen = {};
  let first = '';
  for (let pi = 0; pi < PUBLISH.length; pi++) {
    const pageHtml = reqHtml(PUBLISH[pi]);
    if (!pageHtml) continue;
    const cands = extractDomains(pageHtml);
    for (let ci = 0; ci < cands.length; ci++) {
      const b = cands[ci];
      if (seen[b]) continue;
      seen[b] = 1;
      if (!first) first = b;
      const h = reqHtml(b + '/', PUBLISH[pi], 8000);
      if (isContent(h)) {
        ACTIVE = b;
        setHomeCache(h, b); // 探活拿到的首页留着给 homeVod 用
        return b;
      }
    }
  }
  for (let fi = 0; fi < FALLBACK.length; fi++) {
    const b = FALLBACK[fi];
    if (seen[b]) continue;
    seen[b] = 1;
    if (!first) first = b;
    const h = reqHtml(b + '/', PUBLISH[0], 8000);
    if (isContent(h)) {
      ACTIVE = b;
      setHomeCache(h, b);
      return b;
    }
  }
  ACTIVE = first || FALLBACK[0];
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

// 取观看页：当前线路失败则换线路再试一次。
// detail() 以前直接用 reqHtml，线路偶发连接重置时整部剧会退化成"标题=数字、只有 1 集"。
function fetchDetailHtml(id) {
  let base = getBase();
  let h = reqHtml(base + '/video/' + id + '/', base + '/');
  if (h && h.length > 1500) return { base: base, html: h };
  base = getBase(true);
  h = reqHtml(base + '/video/' + id + '/', base + '/');
  return { base: base, html: h || '' };
}

function fix(u) {
  if (!u) return '';
  u = String(u).replace(/&amp;/g, '&');
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (u.indexOf('/') === 0) return getBase() + u;
  return u;
}

// 本地图片代理地址（TVBox js0 约定：http://127.0.0.1:<端口>/proxy?do=js）。
// 站点封面在 CDN 上是 AES 密文，必须由本机代理取回→解密→以图片返回，播放器直连只会拿到密文。
// 端口默认 9978（TVBox 系默认值）；如果你的 App 改过端口，把站点的 ext 填成 {"port":9977} 即可。
function getProxy() {
  let port = 9978;
  try {
    const p = parseInt(EXT.port, 10);
    if (p > 0 && p < 65536) port = p;
  } catch (e) {}
  return 'http://127.0.0.1:' + port + '/proxy?do=js';
}

function coverUrl(u) {
  u = fix(u);
  if (!/^https?:\/\//i.test(u)) return '';
  if (!USE_IMG_PROXY) return u; // 直连 CDN（注意：CDN 上是密文，直连会裂图）
  return getProxy() + '&siteKey=' + KEY + '&url=' + encodeURIComponent(u);
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

function detailEpisodesFromApi(id, base) {
  try {
    const b = base || getBase();
    const r = reqHtml(b + '/api/videos/' + id, b + '/');
    const data = JSON.parse(r).data || {};
    const arr = data.episodes || [];
    let eps = arr.map(function (e) { return parseInt(e.ep_num || e.ep || e.num, 10); }).filter(function (n) { return !isNaN(n); });
    eps.sort(function (x, y) { return x - y; });
    if (!eps.length && data.video_url) eps = [1];
    return eps;
  } catch (e) { return []; }
}

export default {
  init(ext) { EXT = ext || {}; this.ext = EXT; },

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
      const got = fetchDetailHtml(id);
      const base = got.base;
      const html = got.html;
      // 集数以 /api/videos/{id} 为准：观看页内联的 epPlaySrcs 只有当前集附近的 2~3 集，
      // 拿它当总集数会让 13 集的剧只显示 2 集（2026-10-26 实测 9909/5667/9885/10268 全是这样）。
      let eps = detailEpisodesFromApi(id, base);
      if (!eps.length) eps = Object.keys(extractEpMap(html)).map(function (k) { return parseInt(k, 10); })
        .filter(function (n) { return !isNaN(n); }).sort(function (a, b) { return a - b; });
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
