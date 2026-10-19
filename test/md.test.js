// Markdown 导出纯函数与幂等行为测试（无网络：download_images=false）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exportMd, sanitizeFilename, frontmatter, yamlStr, slugTag } = require('../cli/md');
const config = require('../cli/config');

test('文件名净化：非法字符、超长、空标题', () => {
  assert.strictEqual(sanitizeFilename('abc/def:ghi?'), 'abc def ghi');
  assert.strictEqual(sanitizeFilename('  多  个   空 格  '), '多 个 空 格');
  assert.strictEqual(sanitizeFilename('x'.repeat(200)).length, 80);
  assert.strictEqual(sanitizeFilename(''), 'untitled');
  assert.ok(!/[\\/:*?"<>|]/.test(sanitizeFilename('a<b>c|d')));
});

test('frontmatter：YAML 转义与字段齐全', () => {
  const fm = frontmatter(
    { title: '带"引号"与\\反斜杠', url: 'https://e/a?b=1', feed: { title: '源' }, author: '', published_at: '2026-10-19T00:00:00Z' },
    '2026-10-19T01:00:00Z',
  );
  assert.match(fm, /^---\n/);
  assert.match(fm, /title: "带\\"引号\\"与\\\\反斜杠"/);
  assert.match(fm, /source: "https:\/\/e\/a\?b=1"/);
  assert.match(fm, /tags: \["rss", "源"\]/);
  assert.ok(yamlStr('a"b\\c').includes('\\"'));
});

test('导出：懒加载回填、表格/代码块转换、幂等（第二次零新增）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-md-'));
  const vault = path.join(dir, 'vault');
  // 状态文件也指向临时目录（隔离用户主目录的真实状态）
  const realStatePath = config.EXPORT_STATE_PATH;
  const statePath = path.join(dir, 'export-state.json');
  config.EXPORT_STATE_PATH = statePath;

  const entry = {
    id: 1,
    title: '测试文章',
    url: 'https://example.com/a/1',
    author: '张三',
    published_at: '2026-10-18T08:00:00Z',
    reading_time: 5,
    feed: { title: '某博客' },
    content: '<p>第一段</p><img data-src="https://example.com/i/1.png"><table><tr><td>a1</td><td>b1</td></tr></table><pre><code>let x = 1</code></pre>',
  };
  const cfg = { obsidian: { vault_dir: vault, subdir: 'RSS', assets_subdir: 'RSS/assets', download_images: false } };
  const r1 = await exportMd([entry], cfg, {});
  assert.strictEqual(r1.added.length, 1);
  assert.strictEqual(r1.failed.length, 0);
  const file = path.join(vault, 'RSS', r1.added[0].file);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /source: "https:\/\/example\.com\/a\/1"/);
  assert.match(text, /\| a1 *\| *b1 *\|/);           // 表格转 GFM
  assert.match(text, /```[\s\S]*let x = 1[\s\S]*```/); // 代码块围栏
  assert.match(text, /!\[[^\]]*\]\(https:\/\/example\.com\/i\/1\.png\)/); // 懒加载回填为可读图链
  assert.doesNotMatch(text, /data-src/);

  // 幂等：同一条目再导出 → 跳过、零新增
  const r2 = await exportMd([entry], cfg, {});
  assert.strictEqual(r2.added.length, 0);
  assert.strictEqual(r2.skipped.length, 1);

  // since 过滤：起点晚于发布时间 → 跳过
  const r3 = await exportMd([entry], cfg, { since: '2026-10-19' });
  assert.strictEqual(r3.added.length, 0);

  // 状态文件丢失 → 从目录 frontmatter 重建，仍然幂等
  fs.unlinkSync(statePath);
  const r4 = await exportMd([entry], cfg, {});
  assert.strictEqual(r4.added.length, 0);
  assert.strictEqual(r4.skipped.length, 1);

  config.EXPORT_STATE_PATH = realStatePath;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('slugTag：来源名转标签', () => {
  assert.strictEqual(slugTag('Hello World!'), 'Hello-World');
  assert.strictEqual(slugTag('中文源'), '中文源');
  assert.strictEqual(slugTag('a///b'), 'a-b');
});
