// 全文拉取测试：判定分支、采用守卫、地址补全、提取与整体增强（注入假请求，无网络）。
const test = require('node:test');
const assert = require('node:assert');
const {
  plainTextOf, needsFullText, adopt, decodeHtml, resolveRelativeAttrs,
  extractReadable, enrichEntries, fulltextLine, SUMMARY_TEXT_THRESHOLD,
} = require('../cli/fulltext');

test('plainTextOf：剥标签与实体后计字数', () => {
  assert.strictEqual(plainTextOf('<p>你好&nbsp;世界</p>'), 5);
  assert.strictEqual(plainTextOf('<script>var a=1;</script><p>正文</p>'), 2);
  assert.strictEqual(plainTextOf(''), 0);
});

test('needsFullText：配置三分支与长度阈值', () => {
  const short = '<p>短</p>';
  const long = `<p>${'字'.repeat(SUMMARY_TEXT_THRESHOLD)}</p>`;
  assert.strictEqual(needsFullText(short, { full: true }), 'configured');
  assert.strictEqual(needsFullText(long, { full: true }), 'configured');
  assert.strictEqual(needsFullText(short, { full: false }), null);
  assert.strictEqual(needsFullText(long, { full: false }), null);
  assert.strictEqual(needsFullText(short, null), 'heuristic');
  assert.strictEqual(needsFullText(long, null), null);
  assert.strictEqual(needsFullText(long, {}), null); // 无 full 键的配置按无配置处理
});

test('adopt：提取结果须超 1.5 倍且达 500 字下限', () => {
  assert.ok(adopt(2000, 1000));
  assert.ok(!adopt(1400, 1000)); // 未到 1.5 倍
  assert.ok(!adopt(400, 3));     // 原正文极短时下限不满足（倍数不足为凭）
  assert.ok(adopt(600, 100));
});

test('decodeHtml：响应头字符集优先，其次页面声明，缺省 utf-8', () => {
  const buf = Buffer.from('<p>你好</p>', 'utf8');
  assert.strictEqual(decodeHtml(buf, 'text/html; charset=utf-8'), '<p>你好</p>');
  assert.strictEqual(decodeHtml(buf, ''), '<p>你好</p>');
  assert.strictEqual(decodeHtml(Buffer.from('<p>abc</p>'), 'text/html; charset=不存在的编码'), '<p>abc</p>');
});

test('resolveRelativeAttrs：相对地址补全，锚点与绝对地址不动', () => {
  const base = 'https://a.example/post/1';
  const out = resolveRelativeAttrs('<img src="/img/a.jpg"><a href="p2.html">x</a><a href="#top">y</a><a href="https://b.example/">z</a>', base);
  assert.ok(out.includes('src="https://a.example/img/a.jpg"'));
  assert.ok(out.includes('href="https://a.example/post/p2.html"'));
  assert.ok(out.includes('href="#top"'));
  assert.ok(out.includes('href="https://b.example/"'));
});

// 构造可被 Readability 提取的文章页：标题 + 若干长段落 + 相对图片地址
function articlePage(paras, imgSrc) {
  return `<!doctype html><html><head><title>示例文章</title></head><body>
  <nav><a href="/">首页</a> <a href="/about">关于</a></nav>
  <article><h1>示例文章标题</h1><img src="${imgSrc}">${paras.map((p) => `<p>${p}</p>`).join('\n')}</article>
  <footer>版权所有</footer></body></html>`;
}
const PARAS = Array.from({ length: 4 }, (_, i) => `第${i + 1}段：${'这是一段用于验证全文提取的正文内容。'.repeat(40)}`);

test('extractReadable：提取正文并补全相对图片地址', () => {
  const html = articlePage(PARAS, '/img/a.jpg');
  const r = extractReadable(html, 'https://a.example/post/1');
  assert.ok(r, '应提取成功');
  assert.ok(r.textLength >= 500, `提取文本应足够长，实际 ${r.textLength}`);
  assert.ok(r.html.includes('src="https://a.example/img/a.jpg"'));
  assert.ok(!r.html.includes('版权所有'), '页脚杂讯不应进入正文');
});

test('extractReadable：无正文的页面返回 null', () => {
  assert.strictEqual(extractReadable('<html><body></body></html>', 'https://a.example/'), null);
});

// 假请求实现：按 URL 返回预设响应
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const hit = responses.find((r) => r.url === url);
    if (!hit) return { ok: false, status: 404, headers: { get: () => '' }, arrayBuffer: async () => Buffer.alloc(0) };
    if (hit.throw) throw new Error('network');
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'content-type' ? hit.contentType || 'text/html; charset=utf-8' : '') },
      arrayBuffer: async () => Buffer.from(hit.body || '', 'utf8'),
    };
  };
  impl.calls = calls;
  return impl;
}

test('enrichEntries：启发式拉取成功替换正文并记入 persistable；失败保留原正文', async () => {
  const page = articlePage(PARAS, '/img/a.jpg');
  const fetchImpl = fakeFetch([{ url: 'https://a.example/post/1', body: page }]);
  const entry = {
    id: 1, title: '摘要文', url: 'https://a.example/post/1', content: '<p>只有一小段摘要。</p>',
    feed: { id: 7, title: '示例源' },
  };
  const stats = await enrichEntries([entry], {}, { fetchImpl });
  assert.strictEqual(stats.heuristic, 1);
  assert.strictEqual(stats.failed, 0);
  assert.deepStrictEqual(stats.persistable, [{ id: 7, title: '示例源' }]);
  assert.ok(entry.content.includes('src="https://a.example/img/a.jpg"'), '正文应替换为提取结果');
  assert.strictEqual(entry._imgReferer, ''); // 无防盗链配置 → 下载模块按文章地址分级

  // 拉取失败（网络错误）：保留原正文，计失败
  const bad = fakeFetch([{ url: 'https://a.example/post/1', throw: true }]);
  const e2 = { id: 2, title: '失败文', url: 'https://a.example/post/1', content: '<p>摘要。</p>', feed: { id: 7 } };
  const st2 = await enrichEntries([e2], {}, { fetchImpl: bad });
  assert.strictEqual(st2.failed, 1);
  assert.strictEqual(e2.content, '<p>摘要。</p>');

  // 配置 full=false：不尝试
  const none = fakeFetch([]);
  const e3 = { id: 3, title: '关闭文', url: 'https://a.example/post/1', content: '<p>短。</p>', feed: { id: 8 } };
  const st3 = await enrichEntries([e3], { 8: { full: false } }, { fetchImpl: none });
  assert.strictEqual(none.calls.length, 0, '配置关闭时不应访问原文网页');
  assert.strictEqual(st3.configured + st3.heuristic + st3.failed, 0);

  // 配置 full=true + referer：必拉且图片首选来源用配置网址
  const okFetch = fakeFetch([{ url: 'https://a.example/post/1', body: page }]);
  const e4 = { id: 4, title: '配置文', url: 'https://a.example/post/1', content: `<p>${'长'.repeat(1500)}</p>`, feed: { id: 9 } };
  const st4 = await enrichEntries([e4], { 9: { full: true, referer: true, referer_url: 'https://a.example/' } }, { fetchImpl: okFetch });
  assert.strictEqual(st4.configured, 1);
  assert.strictEqual(e4._imgReferer, 'https://a.example/');
  assert.strictEqual(st4.persistable.length, 0, '有配置的源不进待持久化清单');
});

test('fulltextLine：无入参返回空串、无动作输出「无需拉取」、有动作输出三类计数与可持久化源', () => {
  assert.strictEqual(fulltextLine(undefined), '');
  assert.strictEqual(fulltextLine({ configured: 0, heuristic: 0, failed: 0, failedTitles: [], persistable: [] }), 'ℹ 全文拉取：无需拉取（正文均已完整）');
  const line = fulltextLine({ configured: 1, heuristic: 2, failed: 1, failedTitles: ['文A'], persistable: [] });
  assert.match(line, /配置成功 1 篇 \/ 启发式成功 2 篇 \/ 失败保留原文 1 篇/);
  assert.match(line, /文A/);
  const line2 = fulltextLine({ configured: 0, heuristic: 1, failed: 0, failedTitles: [], persistable: [{ id: 7, title: '示例源' }] });
  assert.match(line2, /可保存拉取原文设置的源：7（示例源）/);
});
