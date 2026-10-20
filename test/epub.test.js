// epub 生成测试：XML 工具、图片管线（本地生成图，无网络）、打包结构与分册。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const sharp = require('sharp');
const { buildEpub, processImageBuffer, escapeXml, xhtmlSelfClose, volumeTitle, replaceImages } = require('../cli/epub');

test('escapeXml：裸 & 转义，既有实体保留', () => {
  assert.strictEqual(escapeXml('a & b &amp; c &#65; &#x41;'), 'a &amp; b &amp; c &#65; &#x41;');
  assert.strictEqual(escapeXml('<"">'), '&lt;&quot;&quot;&gt;');
});

test('xhtmlSelfClose：空元素自闭合', () => {
  assert.strictEqual(xhtmlSelfClose('<img src="a.png"><br><hr/>'), '<img src="a.png"/><br/><hr/>');
});

test('volumeTitle：单册无后缀，多册加（一）（二）', () => {
  assert.strictEqual(volumeTitle('书', 0, 1), '书');
  assert.strictEqual(volumeTitle('书', 0, 2), '书（一）');
  assert.strictEqual(volumeTitle('书', 1, 2), '书（二）');
});

test('图片管线：按宽度缩放、灰度、JPEG 输出且体积显著缩小', async () => {
  // 4000×3000 的噪声图（模拟手机照片，原始体积大）
  const raw = await sharp({ create: { width: 4000, height: 3000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .jpeg({ quality: 95 }).toBuffer();
  const out = await processImageBuffer(raw, { image_max_width: 1200, image_jpeg_quality: 70, image_grayscale: true });
  const meta = await sharp(out).metadata();
  assert.strictEqual(meta.width, 1200);
  assert.strictEqual(meta.channels, 1); // 灰度
  assert.ok(out.length < raw.length / 3, `处理后 ${out.length} 应显著小于原始 ${raw.length}`);
});

test('replaceImages：本地路径替换与占位', async () => {
  const html = '<p>a</p><img src="http://x/1.png"><p>b</p><img src="http://x/2.png">';
  const out = await replaceImages(html, async (url) => (url.endsWith('1.png') ? 'images/0001.jpg' : null));
  assert.ok(out.includes('<img src="images/0001.jpg"'));
  assert.ok(out.includes('[图片已省略]'));
  assert.ok(!out.includes('http://x/'));
});

test('buildEpub：结构（mimetype 首条且不压缩/清单/章节/引用一致）与分册', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-epub-'));
  const mk = (i) => ({
    id: i, title: `文章${i}`, url: `https://e.example/${i}`, author: '作者',
    published_at: '2026-10-18T00:00:00Z', reading_time: 5, feed: { title: '源' },
    content: `<h2>小节</h2><p>正文 ${i}。这是一段足够长的正文内容，用于验证章节生成。</p><pre><code>code ${i}</code></pre>`,
  });
  const cfg = { epub: { image_max_width: 1200, image_jpeg_quality: 70, image_grayscale: true, max_total_mb: 20, max_articles_per_book: 2 } };
  // 3 篇、单册上限 2 → 2 册
  const results = await buildEpub([mk(1), mk(2), mk(3)], { title: '测试书', out: path.join(dir, 'book'), cfg });
  assert.strictEqual(results.length, 2);
  assert.deepStrictEqual(results.map((r) => r.count), [2, 1]);
  assert.strictEqual(results[0].title, '测试书（一）');

  const buf = fs.readFileSync(results[0].file);
  // 解析 zip 首条目本地文件头：必须是 mimetype 且压缩方式为 0（STORE，epub 规范）
  assert.deepStrictEqual(buf.slice(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'zip 魔数');
  assert.strictEqual(buf.readUInt16LE(8), 0, '首条目压缩方式必须为 STORE');
  const nameLen = buf.readUInt16LE(26);
  assert.strictEqual(buf.slice(30, 30 + nameLen).toString('utf8'), 'mimetype', '首条目必须是 mimetype');

  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);
  assert.ok(names.includes('META-INF/container.xml'));
  assert.ok(names.includes('OEBPS/content.opf'));
  assert.ok(names.includes('OEBPS/nav.xhtml'));
  assert.ok(names.includes('OEBPS/toc.ncx'));
  assert.ok(names.includes('OEBPS/title.xhtml'));
  assert.ok(names.includes('OEBPS/chapter-0001.xhtml'));
  assert.ok(names.includes('OEBPS/chapter-0002.xhtml'));
  const ch = await zip.files['OEBPS/chapter-0001.xhtml'].async('string');
  assert.match(ch, /<h1>文章1<\/h1>/);
  assert.match(ch, /原文链接/);
  assert.match(ch, /来源：源/);
  const opf = await zip.files['OEBPS/content.opf'].async('string');
  assert.match(opf, /urn:uuid:/);
  assert.match(opf, /测试书（一）/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildEpub：不传 out 时文件名为 RSS 阅读-当天日期-文章标题', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-epub-'));
  const entry = {
    id: 1, title: '某篇很精彩的文章', url: 'https://e.example/1', author: '作者',
    published_at: '2026-10-18T00:00:00Z', reading_time: 5, feed: { title: '源' },
    content: '<p>正文。</p>',
  };
  const results = await buildEpub([entry], { cfg: { epub: {} } }); // 故意不传 out
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const name = path.basename(results[0].file);
  assert.match(name, new RegExp(`^RSS 阅读-${dateStr}-.+\\.epub$`));
  assert.ok(name.includes('某篇很精彩的文章'));
  fs.rmSync(dir, { recursive: true, force: true });
  // 文件生成在当前工作目录，测试后清掉
  try { fs.rmSync(path.resolve(name), { force: true }); } catch { /* 已随目录删除 */ }
});
