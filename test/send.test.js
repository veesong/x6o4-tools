// 发送模块纯函数测试：附件分组与 agently 发信命令参数组装。
// 不联网、不依赖真实邮箱；文件用本地临时小文件。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planGroups, agentlyArgs, sendKindle, sendViaAgently, agentlyTimeoutMs, findSentMessageId, deleteSentMessage } = require('../cli/send');
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

test('agentlyTimeoutMs：发送时限随附件体积增长并封顶', () => {
  assert.strictEqual(agentlyTimeoutMs(0), 120000, '起步 2 分钟');
  assert.strictEqual(agentlyTimeoutMs(19 * 1024 * 1024), 120000 + 19 * 30000, '19MB 起每 MB 追加 30 秒');
  assert.strictEqual(agentlyTimeoutMs(1000 * 1024 * 1024), 15 * 60 * 1000, '最长 15 分钟');
});

// 构造单组一个附件的分组，供 sendViaAgently 的注入测试使用
async function oneGroup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-send-'));
  const f = path.join(dir, 'a.epub');
  fs.writeFileSync(f, 'x');
  const groups = await planGroups([f]);
  return { dir, groups };
}

test('sendViaAgently：发送命令异常但「已发送」命中 → 按成功处理并清理副本', async () => {
  const { dir, groups } = await oneGroup();
  const now = Date.now();
  const calls = [];
  const run = async (args) => {
    const line = args.join(' ');
    calls.push(line);
    if (line.includes('+send')) {
      // 模拟大附件上传超过时限：子进程被强制结束、退出码为空
      return { err: new Error('超过 690 秒未完成，命令被强制结束'), stderr: '', stdout: '' };
    }
    if (line.includes('+list')) {
      return { err: null, stderr: '', stdout: JSON.stringify({ ok: true, data: { data: [
        { message_id: 'msg_9', subject: '书', created_at: new Date(now - 1000).toISOString() },
      ] } }) };
    }
    if ((line.includes('+trash') || line.includes('+delete')) && !line.includes('--confirmation-token')) {
      return { err: null, stderr: '', stdout: JSON.stringify({ ok: true, data: { confirmation_token: 'ctk_9' } }) };
    }
    return { err: null, stderr: '', stdout: JSON.stringify({ ok: true }) };
  };
  const r = await sendViaAgently(groups, { kindle_email: 'k@kindle.com' }, { subject: '书' }, { run, verifyAttempts: 2, verifyIntervalMs: 1 });
  assert.strictEqual(r.emails, 1, '核对命中按成功计');
  assert.deepStrictEqual(r.attachments, ['a.epub']);
  assert.ok(r.warnings.some((w) => /按成功处理/.test(w)), '应有一行确认提醒');
  assert.ok(r.warnings.every((w) => !/未清理/.test(w)), '副本应清理干净');
  assert.strictEqual(calls.filter((l) => l.includes('+send')).length, 1, '未自动重发');
  assert.ok(calls.some((l) => l.includes('+trash --id msg_9')), '确认命中后应清理副本');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sendViaAgently：发送命令异常且「已发送」未命中 → 报失败并提示可安全重试', async () => {
  const { dir, groups } = await oneGroup();
  const run = async (args) => {
    const line = args.join(' ');
    if (line.includes('+send')) {
      return { err: new Error('超过 690 秒未完成，命令被强制结束'), stderr: '', stdout: '' };
    }
    return { err: null, stderr: '', stdout: JSON.stringify({ ok: true, data: { data: [] } }) };
  };
  await assert.rejects(
    () => sendViaAgently(groups, { kindle_email: 'k@kindle.com' }, { subject: '书' }, { run, verifyAttempts: 2, verifyIntervalMs: 1 }),
    /可以安全重试/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sendViaAgently：发送异常且列表查询失败 → 提示重发前先人工核对', async () => {
  const { dir, groups } = await oneGroup();
  const run = async (args) => {
    const line = args.join(' ');
    if (line.includes('+send')) {
      return { err: new Error('超过 690 秒未完成，命令被强制结束'), stderr: '', stdout: '' };
    }
    return { err: new Error('退出码 1'), stderr: 'boom', stdout: '' };
  };
  await assert.rejects(
    () => sendViaAgently(groups, { kindle_email: 'k@kindle.com' }, { subject: '书' }, { run, verifyAttempts: 2, verifyIntervalMs: 1 }),
    /重发前请先在邮箱的「已发送」里确认/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sendViaAgently：未安装/未登录类失败立即报错，不核对列表', async () => {
  const { dir, groups } = await oneGroup();
  let listCalls = 0;
  const enoentRun = async (args) => {
    if (args.join(' ').includes('+send')) {
      const e = new Error('spawn agently-cli ENOENT');
      e.code = 'ENOENT';
      return { err: e, stderr: '', stdout: '' };
    }
    listCalls++;
    return { err: null, stderr: '', stdout: '{}' };
  };
  await assert.rejects(
    () => sendViaAgently(groups, { kindle_email: 'k@kindle.com' }, { subject: '书' }, { run: enoentRun }),
    /npm install -g @tencent-qqmail\/agently-cli/,
  );
  assert.strictEqual(listCalls, 0, '未安装类失败不应核对列表');

  const authRun = async (args) => {
    if (args.join(' ').includes('+send')) {
      return { err: new Error('退出码 1'), stderr: '尚未登录或登录已过期', stdout: '' };
    }
    listCalls++;
    return { err: null, stderr: '', stdout: '{}' };
  };
  await assert.rejects(
    () => sendViaAgently(groups, { kindle_email: 'k@kindle.com' }, { subject: '书' }, { run: authRun }),
    /agently-cli auth login/,
  );
  assert.strictEqual(listCalls, 0, '未登录类失败不应核对列表');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 本机已装 agently-cli 时跳过真实调用，避免测试发出邮件。探测必须用
// cross-spawn：Windows 上 npm 全局命令是 .cmd 批处理，child_process 的
// execFile 系列无法直接启动，会把「已安装」误判成「未安装」，该测试就会
// 真实发送邮件。cross-spawn 与 cli/send.js 的发送走同一条启动路径。
function cliAvailable() {
  const r = require('cross-spawn').sync('agently-cli', ['--version'], { timeout: 10000, windowsHide: true });
  return !(r.error && /ENOENT/i.test(String(r.error.code || r.error.message)));
}
