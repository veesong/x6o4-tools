// 全文拉取：订阅源只在 RSS 里输出摘要时，正文过短就访问原文网页，
// 用 Readability 算法提取全文。判定优先级 = 服务端按源设置（开=必拉 /
// 关=不拉），无设置时正文纯文本少于阈值即视为摘要。采用守卫防止提取失败
// 或页面杂讯替换掉本可阅读的原正文；一切失败都保留原正文（正文没有占位
// 这个终态）。铁律不变：拉取到的全文只在进程内使用，打印输出只有计数。
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');

const FETCH_TIMEOUT_MS = 20000;      // 原文网页拉取超时
const MAX_HTML_BYTES = 5 * 1024 * 1024; // 网页大小上限（防超大页面拖垮内存）
const SUMMARY_TEXT_THRESHOLD = 1000; // 无配置时：正文纯文本少于此字数视为摘要
const ADOPT_RATIO = 1.5;             // 提取结果须超过原正文的倍数
const ADOPT_MIN_TEXT = 500;          // 提取结果纯文本下限（原正文极短时倍数不足为凭）

// 真实浏览器标识：原文网页与图片下载共用（自定义程序标识会被不少站点拒绝或降级）
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// 剥标签取纯文本长度（判定摘要与采用守卫用；不做截断）
function plainTextOf(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim().length;
}

// 是否需要拉原文：配置三分支（true 必拉 / false 不拉 / 无配置看长度阈值）
function needsFullText(content, cfg) {
  if (cfg && cfg.full === true) return 'configured';
  if (cfg && cfg.full === false) return null;
  return plainTextOf(content) < SUMMARY_TEXT_THRESHOLD ? 'heuristic' : null;
}

// 采用守卫：提取结果明显更长且达到下限才替换
function adopt(extractedLen, originalLen) {
  return extractedLen >= ADOPT_MIN_TEXT && extractedLen > originalLen * ADOPT_RATIO;
}

// 按响应头或页面 meta 声明解码（老站点 gb2312/gbk 不按 utf-8 解码会乱码）
function decodeHtml(buf, contentTypeHeader) {
  let charset = '';
  const m = /charset=([\w-]+)/i.exec(contentTypeHeader || '');
  if (m) charset = m[1];
  if (!charset) {
    const head = buf.subarray(0, 2048).toString('latin1');
    const mm = /charset\s*=\s*["']?([\w-]+)/i.exec(head);
    if (mm) charset = mm[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

// 访问原文网页：浏览器标识 + 超时 + 大小上限；非网页响应或失败返回 null
async function fetchOriginal(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const ct = String(res.headers.get('content-type') || '');
    if (ct && !ct.includes('html')) return null; // 响应头明确不是网页才拦（缺头不拦）
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_HTML_BYTES) return null;
    return decodeHtml(buf, ct);
  } catch {
    return null;
  }
}

// 相对地址补全：提取结果里的 src/href 按原文链接补成绝对地址
// （锚点与带协议的地址不动；协议相对地址 //x 也交给链接补全处理）
function resolveRelativeAttrs(html, base) {
  if (!base) return html;
  return html.replace(/\b(src|href)\s*=\s*["']([^"']*)["']/gi, (m, attr, v) => {
    if (!v || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(v)) return m;
    try {
      return `${attr}="${new URL(v, base).href}"`;
    } catch {
      return m;
    }
  });
}

// Readability 提取：失败（结构特殊/需登录/无正文）返回 null
function extractReadable(html, baseUrl) {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document).parse();
    if (!article || !article.content) return null;
    const out = resolveRelativeAttrs(article.content, baseUrl);
    return { html: out, textLength: plainTextOf(out) };
  } catch {
    return null;
  }
}

// 单篇增强：按判定结果拉原文，过守卫才替换正文；同时给该篇确定图片下载的
// 首选来源（配置开启防盗链用其来源网址，否则由下载模块按文章网址分级）。
// 返回 { attempted, ok, reason }——统计与汇报用，正文与提取结果不外泄。
async function enrichOne(entry, cfg, fetchImpl = fetch) {
  if (!entry || entry._imgReferer === undefined) {
    const prefer = cfg && cfg.referer && cfg.referer_url ? cfg.referer_url : '';
    if (entry) entry._imgReferer = prefer;
  }
  const reason = needsFullText(entry ? entry.content : '', cfg);
  if (!reason || !entry.url || !/^https?:/i.test(entry.url)) {
    return { attempted: false, ok: false, reason };
  }
  const html = await fetchOriginal(entry.url, fetchImpl);
  const extracted = html ? extractReadable(html, entry.url) : null;
  if (extracted && adopt(extracted.textLength, plainTextOf(entry.content))) {
    entry.content = extracted.html;
    return { attempted: true, ok: true, reason };
  }
  return { attempted: true, ok: false, reason };
}

// 汇总统计：configured/heuristic 成功数、failed 数与失败标题；
// persistable = 启发式成功且服务端无配置的源（供技能写回 full=true 持久化）
function newStats() {
  return { configured: 0, heuristic: 0, failed: 0, failedTitles: [], persistable: [] };
}

async function enrichEntries(entries, cfgMap = {}, { fetchImpl, stats } = {}) {
  const st = stats || newStats();
  for (const entry of entries) {
    const cfg = cfgMap[entry.feed && entry.feed.id] || null;
    const r = await enrichOne(entry, cfg, fetchImpl);
    if (!r.attempted) continue;
    if (r.ok) {
      st[r.reason] += 1;
      if (r.reason === 'heuristic' && !cfg && entry.feed && entry.feed.id) {
        st.persistable.push({ id: entry.feed.id, title: (entry.feed && entry.feed.title) || `源 ${entry.feed.id}` });
      }
    } else {
      st.failed += 1;
      st.failedTitles.push(entry.title || `条目 ${entry.id}`);
    }
  }
  return st;
}

// 统计行（无拉取动作时返回空串，不打印）；行尾列出「启发式成功且服务端无配置」
// 的源，供技能或用户执行 feeds config 持久化。
function fulltextLine(st) {
  if (!st || st.configured + st.heuristic + st.failed === 0) return '';
  let line = `ℹ 全文拉取：配置成功 ${st.configured} 篇 / 启发式成功 ${st.heuristic} 篇 / 失败保留原文 ${st.failed} 篇`;
  if (st.failed && st.failedTitles.length) {
    const shown = st.failedTitles.slice(0, 3).join('、');
    line += `（${shown}${st.failedTitles.length > 3 ? ' 等' : ''}）`;
  }
  if (st.persistable && st.persistable.length) {
    const shown = st.persistable.slice(0, 5).map((p) => `${p.id}（${p.title}）`).join('、');
    line += `；可保存拉取原文设置的源：${shown}${st.persistable.length > 5 ? ' 等' : ''}`;
  }
  return line;
}

module.exports = {
  BROWSER_UA, SUMMARY_TEXT_THRESHOLD,
  plainTextOf, needsFullText, adopt, decodeHtml, fetchOriginal,
  resolveRelativeAttrs, extractReadable, enrichOne, enrichEntries, newStats, fulltextLine,
};
