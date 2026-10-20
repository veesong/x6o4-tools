// epub3 生成：清洗正文 → 图片处理管线（下载→按宽度缩放→灰度→
// JPEG 重压缩，单张质量阶梯兜底）→ 组装 EPUB 3（mimetype 首条目且不压缩、题头页、
// 目录、每篇一章）。分册：单册篇数上限或图片预算触顶即在篇边界开新册——
// 用分册控制体积，不用跳图换体积（图片只有取不到才占位；极端单篇超大的情况
// 由发送侧的 45MB zip / 50MB 拆信校验兜住并明确报错）。
const fsp = require('fs/promises');
const crypto = require('crypto');
const JSZip = require('jszip');
const sharp = require('sharp');
const { cleanHtml } = require('./htmlclean');
const { sanitizeFilename } = require('./md');

const MB = 1024 * 1024;
const SINGLE_IMAGE_MAX = 3 * MB;     // 单张处理后仍超 3MB 时逐级降质量兜底
const DOWNLOAD_TIMEOUT_MS = 30000;   // 单张下载超时（占位只用于取不到图，不用于体积控制）

// ---- XML / XHTML 小工具 ----
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// HTML5 输出转 XHTML：空元素自闭合。
function xhtmlSelfClose(html) {
  return html.replace(/<(img|br|hr|col)\b([^>]*?)\s*\/?>/gi, (m, tag, attrs) => `<${tag}${attrs}/>`);
}

// ---- 图片处理管线 ----
async function processImageBuffer(buf, cfgEpub) {
  let quality = Math.min(100, Math.max(50, Number(cfgEpub.image_jpeg_quality) || 70));
  const width = Number(cfgEpub.image_max_width) || 1200;
  const grayscale = cfgEpub.image_grayscale !== false;
  const run = async (q) => {
    let pipe = sharp(buf, { failOn: 'none', animated: false }).rotate()
      .resize({ width, withoutEnlargement: true })
      .flatten({ background: '#ffffff' }); // 透明背景垫白
    if (grayscale) pipe = pipe.toColourspace('b-w'); // 真单通道灰度 JPEG（grayscale() 仍输出 3 通道，实测）
    return pipe.jpeg({ quality: q, mozjpeg: true }).toBuffer();
  };
  let out = await run(quality);
  while (out.length > SINGLE_IMAGE_MAX && quality > 50) { // 质量阶梯兜底（70→60→50）
    quality -= 10;
    out = await run(quality);
  }
  return out;
}

async function downloadImage(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'User-Agent': 'x6o4-tools/0.1 (+epub image fetch)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// 顺序替换正文里的 <img src>：fn(url) 返回本地路径（images/NNNN.jpg）或
// null（取不到 → 文字占位）。
async function replaceImages(html, fn) {
  const re = /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    const localPath = await fn(m[1]);
    parts.push(html.slice(last, m.index));
    parts.push(localPath ? `<img src="${localPath}" alt="图片"/>` : '<p>[图片已省略]</p>');
    last = m.index + m[0].length;
  }
  parts.push(html.slice(last));
  return parts.join('');
}

// ---- 章节与书结构 ----
function chapterXhtml(entry, bodyHtml) {
  const meta = [
    entry.feed && entry.feed.title ? `来源：${entry.feed.title}` : '',
    entry.author ? `作者：${entry.author}` : '',
    entry.published_at ? `发布：${String(entry.published_at).slice(0, 10)}` : '',
  ].filter(Boolean).join(' ｜ ');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head><title>${escapeXml(entry.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<h1>${escapeXml(entry.title)}</h1>
<p class="meta">${escapeXml(meta)}</p>
${bodyHtml}
<p class="meta">原文链接：<a href="${escapeXml(entry.url)}">${escapeXml(entry.url)}</a></p>
</body>
</html>`;
}

function titleXhtml(bookTitle, entries, volIdx, volCount) {
  const items = entries.map((e, i) => `<li><a href="chapter-${pad4(i + 1)}.xhtml">${escapeXml(e.title)}</a></li>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head><title>${escapeXml(bookTitle)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<h1>${escapeXml(bookTitle)}</h1>
<p class="meta">${new Date().toISOString().slice(0, 10)}${volCount > 1 ? `（第 ${volIdx + 1}/${volCount} 册）` : ''} · 共 ${entries.length} 篇</p>
<ol class="toc">${items}</ol>
</body>
</html>`;
}

function pad4(n) { return String(n).padStart(4, '0'); }

const STYLE_CSS = `body{font-family:serif;line-height:1.6;margin:0.5em}
h1{font-size:1.4em;margin:0.6em 0 0.3em}
h2,h3{font-size:1.15em;margin:0.9em 0 0.4em}
p{margin:0.5em 0}
p.meta{font-size:0.85em;color:#555}
blockquote{margin:0.6em 0 0.6em 1em;color:#333}
pre{background:#f4f4f4;padding:0.5em;font-size:0.85em;white-space:pre-wrap;word-break:break-word}
code{font-size:0.9em}
img{max-width:100%;margin:0.4em auto;display:block}
table{border-collapse:collapse;width:100%;font-size:0.9em}
td,th{border:1px solid #999;padding:0.3em 0.5em}
.toc li{margin:0.2em 0}`;

function containerXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
}

function navXhtml(entries) {
  const items = entries.map((e, i) => `<li><a href="chapter-${pad4(i + 1)}.xhtml">${escapeXml(e.title)}</a></li>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">
<head><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>目录</h1><ol>${items}</ol></nav>
</body>
</html>`;
}

function ncxXml(bookId, bookTitle, entries) {
  const points = entries.map((e, i) => `
    <navPoint id="np${i + 1}" playOrder="${i + 2}">
      <navLabel><text>${escapeXml(e.title)}</text></navLabel>
      <content src="chapter-${pad4(i + 1)}.xhtml"/>
    </navPoint>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${bookId}"/><meta name="dtb:depth" content="1"/></head>
<docTitle><text>${escapeXml(bookTitle)}</text></docTitle>
<navMap>
    <navPoint id="nptitle" playOrder="1"><navLabel><text>题头页</text></navLabel><content src="title.xhtml"/></navPoint>${points}
</navMap>
</ncx>`;
}

// imageIds：本册引用的图片全局编号（章节正文里的 images/NNNN.jpg 与压缩包内文件一一对应）。
function opfXml(bookId, bookTitle, entries, imageIds) {
  const chItems = entries.map((_, i) =>
    `<item id="ch${pad4(i + 1)}" href="chapter-${pad4(i + 1)}.xhtml" media-type="application/xhtml+xml"/>`).join('\n    ');
  const imItems = imageIds.map((id) =>
    `<item id="im${pad4(id)}" href="images/${pad4(id)}.jpg" media-type="image/jpeg"/>`).join('\n    ');
  const chRefs = entries.map((_, i) => `<itemref idref="ch${pad4(i + 1)}"/>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${bookId}</dc:identifier>
    <dc:title>${escapeXml(bookTitle)}</dc:title>
    <dc:language>zh</dc:language>
    <dc:date>${new Date().toISOString().slice(0, 10)}</dc:date>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
    ${chItems}
    ${imItems}
  </manifest>
  <spine toc="ncx"><itemref idref="title"/>${chRefs}</spine>
</package>`;
}

// 分册标题：单册不加后缀；多册每册追加（一）（二）…
function volumeTitle(base, idx, count) {
  if (count <= 1) return base;
  const marks = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  return `${base}（${marks[idx] || idx + 1}）`;
}

// ---- 主体：构建一本或多册 ----
// entries：[{id,title,url,author,content,published_at,reading_time,feed:{title}}]
// opts：{ title, out（文件前缀，可省扩展名）, cfg（完整配置对象，读 cfg.epub） }
// 返回 [{ file, title, count, images }]
async function buildEpub(entries, opts) {
  const epubCfg = (opts.cfg && opts.cfg.epub) || {};
  const maxArticles = Number(epubCfg.max_articles_per_book) || 50;
  const budgetBytes = (Number(epubCfg.max_total_mb) || 20) * MB;

  // 第一遍：清洗正文并处理全部图片（全局编号，正文引用 images/NNNN.jpg）
  const chapters = []; // { entry, bodyHtml, images: [{id, buf}] }
  let imgSeq = 0;
  for (const entry of entries) {
    const html = xhtmlSelfClose(cleanHtml(entry.content || ''));
    const images = [];
    const bodyHtml = await replaceImages(html, async (url) => {
      try {
        const raw = await downloadImage(url);
        const processed = await processImageBuffer(raw, epubCfg);
        imgSeq += 1;
        images.push({ id: imgSeq, buf: processed });
        return `images/${pad4(imgSeq)}.jpg`;
      } catch {
        return null; // 下载失败/超时/解码失败 → 文字占位，不中断整本书
      }
    });
    chapters.push({ entry, bodyHtml, images });
  }

  // 第二遍：分册（篇边界判定——篇数上限或本册图片累计触顶即开新册）
  const volumes = [];
  let cur = [];
  let curImages = 0;
  for (const ch of chapters) {
    const chImgBytes = ch.images.reduce((s, im) => s + im.buf.length, 0);
    if (cur.length > 0 && (cur.length >= maxArticles || curImages + chImgBytes > budgetBytes)) {
      volumes.push(cur);
      cur = [];
      curImages = 0;
    }
    cur.push(ch);
    curImages += chImgBytes;
  }
  if (cur.length) volumes.push(cur);

  // 第三遍：逐册组装打包
  // 默认名「RSS 阅读-yyyyMMdd-副标题」：副标题随机取自该册文章的标题，
  // 同一天多次生成、多册之间都不易重名，且文件名与书内书名完全一致
  // （Kindle 书库显示文件名、多数阅读器显示内部书名，统一后两边相同）。
  // 手动指定文件前缀或书名时，仍按「前缀-册号」「书名（一）（二）」。
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const outPrefix = opts.out ? String(opts.out).replace(/\.epub$/i, '') : '';
  const results = [];
  for (let v = 0; v < volumes.length; v++) {
    const vol = volumes[v];
    let file;
    let bookTitle;
    if (outPrefix || opts.title) {
      bookTitle = volumeTitle(opts.title || 'x6o4 文章精选', v, volumes.length);
      file = outPrefix
        ? (volumes.length > 1 ? `${outPrefix}-${v + 1}.epub` : `${outPrefix}.epub`)
        : `RSS 阅读-${dateStr}-${bookTitle}.epub`;
    } else {
      const pickTitle = vol.length ? vol[Math.floor(Math.random() * vol.length)].entry.title : '精选';
      bookTitle = `RSS 阅读-${dateStr}-${sanitizeFilename(pickTitle)}`;
      file = `${bookTitle}.epub`;
    }
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' }); // 必须首条目且不压缩
    zip.file('META-INF/container.xml', containerXml());
    const oebps = zip.folder('OEBPS');
    oebps.file('style.css', STYLE_CSS);
    oebps.file('title.xhtml', titleXhtml(bookTitle, vol.map((c) => c.entry), v, volumes.length));
    oebps.file('nav.xhtml', navXhtml(vol.map((c) => c.entry)));
    const volEntries = vol.map((c) => c.entry);
    const imageIds = [];
    for (const ch of vol) {
      for (const im of ch.images) {
        imageIds.push(im.id);
        oebps.file(`images/${pad4(im.id)}.jpg`, im.buf);
      }
    }
    const bookId = `urn:uuid:${crypto.randomUUID()}`;
    oebps.file('toc.ncx', ncxXml(bookId, bookTitle, volEntries));
    oebps.file('content.opf', opfXml(bookId, bookTitle, volEntries, imageIds));
    vol.forEach((ch, i) => {
      oebps.file(`chapter-${pad4(i + 1)}.xhtml`, chapterXhtml(ch.entry, ch.bodyHtml));
    });
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await fsp.writeFile(file, buf);
    results.push({ file, title: bookTitle, count: vol.length, images: imageIds.length });
  }
  return results;
}

module.exports = {
  buildEpub, processImageBuffer, downloadImage,
  escapeXml, xhtmlSelfClose, volumeTitle, replaceImages,
};
