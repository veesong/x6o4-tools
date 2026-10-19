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

test('SMTP 预设：常见邮箱参数填充', () => {
  const smtp = config.applySmtpPreset({ host: '', port: 0, secure: false, user: '', pass: '' }, 'qq');
  assert.deepStrictEqual({ host: smtp.host, port: smtp.port, secure: smtp.secure }, { host: 'smtp.qq.com', port: 465, secure: true });
  const out = config.applySmtpPreset({}, 'outlook');
  assert.strictEqual(out.host, 'smtp-mail.outlook.com');
  assert.strictEqual(out.secure, false);
});
