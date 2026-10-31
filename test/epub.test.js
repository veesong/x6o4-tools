// epub 生成测试：XML 工具、图片管线（本地生成图，无网络）、打包结构与分册。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const sharp = require('sharp');
const { buildEpub, processImageBuffer, escapeXml, xhtmlSelfClose, volumeTitle, defaultSubtitle, replaceImages } = require('../cli/epub');

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

test('defaultSubtitle：首篇标题 + 等N篇，过长截断并去掉截断处标点', () => {
  const mk = (title) => ({ title });
  assert.strictEqual(defaultSubtitle([]), '精选');
  assert.strictEqual(defaultSubtitle([mk('单篇标题')]), '单篇标题', '只有一篇时不加「等N篇」');
  assert.strictEqual(defaultSubtitle([mk('首篇'), mk('次篇'), mk('末篇')]), '首篇 等3篇');
  const long = '全面电动化的任务依然很艰巨，动力多元化仍然是全球汽车市场的发展趋势'; // 33 字
  assert.strictEqual(defaultSubtitle([mk(long), mk('b')]), '全面电动化的任务依然很艰巨，动力多元化仍然是全球… 等2篇', '24 字后截断并加省略号');
  const punct = '一二三四五六七八九十一二三四五六七八九十一二三，后面还有很多字';
  assert.strictEqual(defaultSubtitle([mk(punct), mk('b')]), '一二三四五六七八九十一二三四五六七八九十一二三… 等2篇', '截断处的标点去掉');
  assert.strictEqual(defaultSubtitle([mk('a/b:c?d'), mk('b')]), 'a b c d 等2篇', '文件名非法字符按净化规则处理');
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
  const { volumes: results } = await buildEpub([mk(1), mk(2), mk(3)], { title: '测试书', out: path.join(dir, 'book'), cfg });
  assert.strictEqual(results.length, 2);
  assert.deepStrictEqual(results.map((r) => r.count), [2, 1]);
  assert.strictEqual(results[0].title, '测试书（一）');
  assert.deepStrictEqual(results[0].ids, [1, 2], '每册应带条目 id 清单');
  assert.deepStrictEqual(results[1].ids, [3]);
  assert.ok(results[0].size > 0 && results[1].size > 0, '每册应带文件大小');

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

test('buildEpub：不传 out 时文件名为 RSS 阅读-当天日期-首篇标题（单篇不加等N篇）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-epub-'));
  const entry = {
    id: 1, title: '某篇很精彩的文章', url: 'https://e.example/1', author: '作者',
    published_at: '2026-10-18T00:00:00Z', reading_time: 5, feed: { title: '源' },
    content: '<p>正文。</p>',
  };
  const { volumes: results } = await buildEpub([entry], { cfg: { epub: {} } }); // 故意不传 out
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const name = path.basename(results[0].file);
  assert.strictEqual(name, `RSS 阅读-${dateStr}-某篇很精彩的文章.epub`);
  assert.strictEqual(results[0].title, name.replace(/\.epub$/, ''), '书内书名与文件名一致');
  fs.rmSync(dir, { recursive: true, force: true });
  // 文件生成在当前工作目录，测试后清掉
  try { fs.rmSync(path.resolve(name), { force: true }); } catch { /* 已随目录删除 */ }
});

test('buildEpub：默认书名首篇标题 等N篇——同批重跑同名覆盖、多册带（一）（二）', async () => {
  const mk = (i) => ({
    id: i, title: `确定性标题${i}`, url: `https://e.example/${i}`, author: '作者',
    published_at: '2026-10-18T00:00:00Z', reading_time: 5, feed: { title: '源' },
    content: `<p>正文 ${i}。这是一段用于验证分册与命名的正文内容。</p>`,
  });
  const opts = { cfg: { epub: { max_articles_per_book: 2 } } };
  const batch = [mk(1), mk(2), mk(3), mk(4)];
  const r1 = await buildEpub(batch, opts);
  assert.strictEqual(r1.volumes.length, 2);
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  assert.strictEqual(path.basename(r1.volumes[0].file), `RSS 阅读-${dateStr}-确定性标题1 等2篇（一）.epub`, '第一册：本册首篇 + 本册篇数 + 册号');
  assert.strictEqual(path.basename(r1.volumes[1].file), `RSS 阅读-${dateStr}-确定性标题3 等2篇（二）.epub`, '第二册：首篇换成本册第一篇');
  assert.strictEqual(r1.volumes[0].title, path.basename(r1.volumes[0].file).replace(/\.epub$/, ''), '书内书名与文件名一致');
  const r2 = await buildEpub(batch, opts);
  assert.deepStrictEqual(r2.volumes.map((r) => r.file), r1.volumes.map((r) => r.file), '同一批文章两次生成应得到相同文件名');
  for (const r of r1.volumes) {
    try { fs.rmSync(path.resolve(r.file), { force: true }); } catch { /* 已不存在 */ }
  }
});

test('buildEpub：整封邮件体积上限——下一篇触顶即整体停止装篇（截断砍尾）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-epub-'));
  const small = (i) => ({
    id: i, title: `短文${i}`, url: `https://e.example/${i}`, author: '', published_at: '', reading_time: 1,
    feed: { title: '源' }, content: `<p>${'内容'.repeat(200)}</p>`, // ≈1.2KB
  });
  const big = (i) => ({
    id: i, title: `长文${i}`, url: `https://e.example/${i}`, author: '', published_at: '', reading_time: 9,
    feed: { title: '源' }, content: `<p>${'内容'.repeat(500)}</p>`, // ≈3KB
  });
  // 上限 4KB：第 1 篇（≈1.2KB）入选，第 2 篇（≈3KB）会触顶 → 2/3/4 全部未入选
  const r = await buildEpub([small(1), big(2), big(3), big(4)], {
    title: '截断书', out: path.join(dir, 'cut'), cfg: { epub: {} }, maxMailBytes: 4 * 1024,
  });
  assert.deepStrictEqual(r.volumes.map((v) => v.ids), [[1]], '只装得下第 1 篇');
  assert.deepStrictEqual(r.excluded.map((e) => e.id), [2, 3, 4], '触顶后剩余篇目全部未入选');
  assert.strictEqual(r.excluded[0].title, '长文2');
  assert.strictEqual(r.lastIncludedId, 1);
  // 入选体积不超上限（估算口径 = 图片 0 + 正文 HTML 字节）
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildEpub：体积上限宽裕时全量入选，未入选为空、末篇为最后一篇', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-epub-'));
  const mk = (i) => ({
    id: i, title: `全收${i}`, url: `https://e.example/${i}`, author: '', published_at: '', reading_time: 1,
    feed: { title: '源' }, content: `<p>${'内容'.repeat(100)}</p>`,
  });
  const r = await buildEpub([mk(1), mk(2), mk(3), mk(4)], {
    title: '全收书', out: path.join(dir, 'full'), cfg: { epub: {} }, maxMailBytes: 10 * 1024 * 1024,
  });
  assert.deepStrictEqual(r.excluded, []);
  assert.deepStrictEqual(r.volumes.map((v) => v.ids), [[1, 2, 3, 4]]);
  assert.strictEqual(r.lastIncludedId, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildEpub：不传 maxMailBytes 不限制（收藏线零影响）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-epub-'));
  const mk = (i) => ({
    id: i, title: `不限${i}`, url: `https://e.example/${i}`, author: '', published_at: '', reading_time: 1,
    feed: { title: '源' }, content: `<p>${'内容'.repeat(500)}</p>`,
  });
  const r = await buildEpub([mk(1), mk(2), mk(3)], { title: '不限书', out: path.join(dir, 'any'), cfg: { epub: {} } });
  assert.deepStrictEqual(r.excluded, []);
  assert.strictEqual(r.lastIncludedId, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});
