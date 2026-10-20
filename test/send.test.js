// 发送模块纯函数测试：附件分组与 agently 发信命令参数组装。
// 不联网、不依赖真实邮箱；文件用本地临时小文件。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planGroups, agentlyArgs, sendKindle, findSentMessageId, deleteSentMessage } = require('../cli/send');
const config = require('../cli/config');

test('check：agently 发信方式不要求 SMTP 配置', () => {
  const base = { base_url: 'https://rss.example.com', token: 'xpat_aaaa' };
  let chk = config.check({ ...base, kindle_email: 'a@kindle.com', mail_transport: 'agently' }, { needKindle: true });
  assert.ok(chk.ok, 'agently 方式无需 smtp 字段');

  chk = config.check({ ...base, kindle_email: 'a@kindle.com' }, { needKindle: true });
  assert.ok(!chk.ok && chk.missing.some((m) => m.startsWith('smtp')), '默认 smtp 方式仍要求 smtp 字段');
});

test('planGroups：小文件合并为一组，相对路径基于首文件目录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-send-'));
  const f1 = path.join(dir, 'a.epub');
  const f2 = path.join(dir, 'b.epub');
  fs.writeFileSync(f1, 'x');
  fs.writeFileSync(f2, 'y');
  const groups = await planGroups([f1, f2]);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].dir, dir);
  assert.deepStrictEqual(groups[0].files.map((a) => a.rel), ['a.epub', 'b.epub']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('planGroups：超过数量上限拆多组', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-send-'));
  const files = [];
  for (let i = 0; i < 26; i++) {
    const f = path.join(dir, `v${i}.epub`);
    fs.writeFileSync(f, 'x');
    files.push(f);
  }
  const groups = await planGroups(files);
  assert.strictEqual(groups.length, 2); // 单封最多 25 个附件
  assert.strictEqual(groups[0].files.length, 25);
  assert.strictEqual(groups[1].files.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agentlyArgs：收件人/主题/正文/附件路径按命令行格式组装', () => {
  const group = { dir: '/tmp', files: [{ rel: 'a.epub' }, { rel: 'b.epub' }] };
  const args = agentlyArgs(group, { to: 'k@kindle.com', subject: '书名', body: '内容' });
  assert.deepStrictEqual(args, [
    'message', '+send', '--to', 'k@kindle.com', '--subject', '书名',
    '--body', '内容', '--confirmed',
    '--attachment', 'a.epub', '--attachment', 'b.epub',
  ]);
});

test('findSentMessageId：按主题与发信时间认邮件，同主题取最新', () => {
  const now = Date.now();
  const list = JSON.stringify({ ok: true, data: { data: [
    { message_id: 'msg_old', subject: '书', created_at: new Date(now - 3600_000).toISOString() },
    { message_id: 'msg_new', subject: '书', created_at: new Date(now - 1000).toISOString() },
    { message_id: 'msg_other', subject: '别的书', created_at: new Date(now - 1000).toISOString() },
  ] } });
  assert.strictEqual(findSentMessageId(list, '书', now - 60_000), 'msg_new', '同主题取最新、不同主题不碰');
  // 早于发信时间超过时钟余量（5 分钟）的同主题旧邮件不碰
  const oldOnly = JSON.stringify({ ok: true, data: { data: [
    { message_id: 'msg_old', subject: '书', created_at: new Date(now - 20 * 60_000).toISOString() },
  ] } });
  assert.strictEqual(findSentMessageId(oldOnly, '书', now), null, '太旧的邮件不匹配');
  // 输出前后夹带提示文字时仍能解析；完全不是 JSON 时返回空值
  assert.strictEqual(findSentMessageId(`提示文字\n${list}\n尾部文字`, '书', now - 60_000), 'msg_new');
  assert.strictEqual(findSentMessageId('not json', '书', now), null);
});

test('deleteSentMessage：查列表后自动完成两步确认，彻底清除副本', async () => {
  const now = Date.now();
  const calls = [];
  // 模拟命令行：列表返回刚发的邮件；移入已删除与彻底清除首次只给确认令牌
  const run = async (args) => {
    const line = args.join(' ');
    calls.push(line);
    if (line.includes('+list')) {
      return { err: null, stderr: '', stdout: JSON.stringify({ ok: true, data: { data: [
        { message_id: 'msg_1', subject: '书', created_at: new Date(now - 1000).toISOString() },
      ] } }) };
    }
    if ((line.includes('+trash') || line.includes('+delete')) && !line.includes('--confirmation-token')) {
      return { err: null, stderr: '', stdout: JSON.stringify({ ok: true, data: { confirmation_token: 'ctk_1' } }) };
    }
    return { err: null, stderr: '', stdout: JSON.stringify({ ok: true }) };
  };
  const warn = await deleteSentMessage(run, '.', '书', now - 60_000);
  assert.strictEqual(warn, null, '清理成功不产生提醒');
  assert.deepStrictEqual(calls, [
    'message +list --dir sent --limit 10',
    'message +trash --id msg_1',
    'message +trash --id msg_1 --confirmation-token ctk_1',
    'message +delete --id msg_1',
    'message +delete --id msg_1 --confirmation-token ctk_1',
  ]);
});

test('deleteSentMessage：清理失败只返回提醒文字，不抛错', async () => {
  // 列表里始终找不到 → 提醒未清理
  const emptyRun = async () => ({ err: null, stderr: '', stdout: JSON.stringify({ ok: true, data: { data: [] } }) });
  const warn1 = await deleteSentMessage(emptyRun, '.', '书', Date.now());
  assert.match(warn1, /没找到/);
  // 彻底清除失败 → 提醒已移入已删除
  const now = Date.now();
  const failRun = async (args) => {
    const line = args.join(' ');
    if (line.includes('+list')) {
      return { err: null, stderr: '', stdout: JSON.stringify({ ok: true, data: { data: [
        { message_id: 'msg_2', subject: '书', created_at: new Date(now - 1000).toISOString() },
      ] } }) };
    }
    if (line.includes('+trash')) return { err: null, stderr: '', stdout: JSON.stringify({ ok: true }) };
    return { err: new Error('退出码 1'), stderr: 'boom', stdout: '' };
  };
  const warn2 = await deleteSentMessage(failRun, '.', '书', now - 60_000);
  assert.match(warn2, /彻底清除失败/);
});

test('sendKindle：缺基础字段时给出明确错误', async () => {
  await assert.rejects(() => sendKindle(['a.epub'], { smtp: { host: 'h', user: 'u', pass: 'p' } }), /kindle_email/);
  await assert.rejects(() => sendKindle(['a.epub'], { kindle_email: 'k@kindle.com' }), /SMTP/);
  await assert.rejects(
    () => sendKindle([], { kindle_email: 'k@kindle.com', mail_transport: 'agently' }),
    /未指定/,
  );
});

test('sendKindle：agently 方式未装命令行时错误里含安装指引', { skip: cliAvailable() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-send-'));
  const f = path.join(dir, 'a.epub');
  fs.writeFileSync(f, 'x');
  // 本测试环境不安装 agently-cli（见下方 cliAvailable 探测），预期收到含安装指引的报错
  await assert.rejects(
    () => sendKindle([f], { kindle_email: 'k@kindle.com', mail_transport: 'agently' }, { subject: '书' }),
    /agently-cli/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// 本机已装 agently-cli 时跳过真实调用，避免测试发出邮件
function cliAvailable() {
  try {
    require('child_process').execFileSync('agently-cli', ['--version'], { timeout: 10000, windowsHide: true });
    return true;
  } catch (e) {
    return !/ENOENT/.test(String(e.message));
  }
}
