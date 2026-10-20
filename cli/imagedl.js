// 图片下载分级重试：全程真实浏览器标识；防盗链按四级 Referer 依次尝试——
// 设置里的来源网址 → 文章网址根域名 → 完全不发 Referer → 图片自身根域名。
// 前两级覆盖「要求自家来源」的图床（最常见）；第三级覆盖「禁止任何来源」的
// 图床（知乎、微博类）；第四级兜底少数只认图片自身域名的源。四级都失败
// 返回 null，降级策略由调用方决定（电子书占位 / 笔记保留远程链接），
// 与改动前一致。
const { BROWSER_UA } = require('./fulltext');

const IMAGE_TIMEOUT_MS = 30000; // 每级超时（与原单次下载一致，四级最多约 2 分钟）

function originOf(u) {
  try {
    return new URL(u).origin + '/';
  } catch {
    return '';
  }
}

// Referer 尝试序列（去重保持顺序；null 表示该级不发 Referer）
function refererLadder(url, articleUrl, cfgReferer) {
  const seq = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s && !seq.includes(s)) seq.push(s);
  };
  push(cfgReferer);
  push(originOf(articleUrl));
  seq.push(null);
  push(originOf(url));
  return seq;
}

// 下载单张图片：返回 { buffer, contentType }，全失败返回 null。
async function downloadImage(url, articleUrl, cfgReferer, fetchImpl = fetch) {
  if (!/^https?:/i.test(url)) return null;
  for (const referer of refererLadder(url, articleUrl, cfgReferer)) {
    try {
      const headers = {
        'User-Agent': BROWSER_UA,
        Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
      };
      if (referer) headers.Referer = referer;
      const res = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length) continue;
      return { buffer, contentType: String(res.headers.get('content-type') || '') };
    } catch {
      continue; // 超时/网络错误 → 下一级
    }
  }
  return null;
}

module.exports = { downloadImage, refererLadder, originOf, IMAGE_TIMEOUT_MS };
