// 配置与入口纯函数测试。
const test = require('node:test');
const assert = require('node:assert');
const config = require('../cli/config');

test('默认值合并：缺省字段补齐', () => {
  const cfg = config.load(); // 真实用户配置可能不存在，用 DEFAULTS 验证合并逻辑
  assert.strictEqual(cfg.epub.image_max_width, 1200);
  assert.strictEqual(cfg.epub.max_articles_per_book, 50);
  assert.strictEqual(cfg.unread.max_articles_per_run, 20);
});

test('check：服务地址默认固定为官方 https，http 非回环拒绝，回环豁免', () => {
  const base = { token: 'xpat_aaaa' };
  assert.strictEqual(config.DEFAULTS.base_url, 'https://rss-cloud.x6o4.com');

  let chk = config.check({ ...base, base_url: 'http://rss.example.com' });
  assert.ok(chk.base_url_invalid.includes('https'));

  chk = config.check({ ...base, base_url: 'http://127.0.0.1:18080' });
  assert.strictEqual(chk.base_url_invalid, '');

  chk = config.check({ ...base, base_url: 'https://rss-cloud.x6o4.com' });
  assert.strictEqual(chk.base_url_invalid, '');
  assert.ok(chk.ok); // 未要求 kindle/obsidian 时基础项即完整
});

test('check：按用途要求字段', () => {
  const base = { base_url: 'https://rss.example.com', token: 'xpat_aaaa' };
  let chk = config.check(base, { needKindle: true });
  assert.ok(!chk.ok && chk.missing.some((m) => m.startsWith('kindle_email')));

  chk = config.check({ ...base, kindle_email: 'a@kindle.com', smtp: { host: 'smtp.qq.com', port: 465, secure: true, user: 'u', pass: 'p' } }, { needKindle: true });
  assert.ok(chk.ok);

  chk = config.check(base, { needObsidian: true });
  assert.ok(!chk.ok && chk.missing.some((m) => m.startsWith('obsidian.vault_dir')));
});

test('增量游标：缺省为零，写入后可读回，清零归位', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-cursor-')), 'sync-state.json');
  assert.strictEqual(config.readCursor(p), 0, '无状态文件时游标为零');
  config.writeCursor(p, 12345);
  assert.strictEqual(config.readCursor(p), 12345);
  config.writeCursor(p, 0);
  assert.strictEqual(config.readCursor(p), 0, '清零后归位');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('筛选游标：与全局游标各自独立，clearCursors 可只清一个或全清', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-cursor-'));
  const p = path.join(dir, 'sync-state.json');

  // 旧版本写的状态文件（没有 filter_cursors 字段）能继续读
  fs.writeFileSync(p, JSON.stringify({ unread_cursor: 5, updated_at: '2026-01-01' }));
  assert.strictEqual(config.readCursor(p), 5);
  assert.strictEqual(config.readFilterCursor(p, 'category:5'), 0, '旧文件读筛选游标为零');

  config.writeCursor(p, 100);
  config.writeFilterCursor(p, 'category:5', 150);
  assert.strictEqual(config.readCursor(p), 100, '写筛选游标不动全局');
  assert.strictEqual(config.readFilterCursor(p, 'category:5'), 150);
  assert.strictEqual(config.readFilterCursor(p, 'feed:9'), 0, '没记过的筛选为零');

  config.writeCursor(p, 200); // 推进全局不清筛选游标
  assert.strictEqual(config.readFilterCursor(p, 'category:5'), 150);
  config.writeFilterCursor(p, 'feed:9', 90); // 推进一个筛选不动别的
  assert.strictEqual(config.readCursor(p), 200);
  assert.strictEqual(config.readFilterCursor(p, 'category:5'), 150);

  config.clearCursors(p, 'category:5'); // 只清一个
  assert.strictEqual(config.readFilterCursor(p, 'category:5'), 0);
  assert.strictEqual(config.readFilterCursor(p, 'feed:9'), 90);
  assert.strictEqual(config.readCursor(p), 200);

  config.clearCursors(p); // 全清
  assert.strictEqual(config.readCursor(p), 0);
  assert.strictEqual(config.readFilterCursor(p, 'feed:9'), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SMTP 预设：常见邮箱参数填充', () => {
  const smtp = config.applySmtpPreset({ host: '', port: 0, secure: false, user: '', pass: '' }, 'qq');
  assert.deepStrictEqual({ host: smtp.host, port: smtp.port, secure: smtp.secure }, { host: 'smtp.qq.com', port: 465, secure: true });
  const out = config.applySmtpPreset({}, 'outlook');
  assert.strictEqual(out.host, 'smtp-mail.outlook.com');
  assert.strictEqual(out.secure, false);
});
