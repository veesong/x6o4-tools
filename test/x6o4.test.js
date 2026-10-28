// 命令行入口测试（无网络：帮助文本与未配置时的指引）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function nodeCli(args, env = {}) {
  return execFileSync(process.execPath, [path.join(__dirname, '..', 'cli', 'x6o4.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('help 输出包含全部子命令', () => {
  const out = nodeCli(['help']);
  for (const cmd of ['login', 'status', 'tokens', 'feeds', 'entries', 'mark-read', 'build-epub', 'send-kindle', 'export-md', 'skip', 'config']) {
    assert.ok(out.includes(cmd), `缺少 ${cmd}`);
  }
});

test('未配置时命令给出登录指引并以非零退出', () => {
  // 指向空白主目录，避免读到真实配置
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-home-'));
  let threw = null;
  try {
    nodeCli(['status'], { USERPROFILE: home, HOME: home });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, '应非零退出');
  const output = String(threw.stdout || '') + String(threw.stderr || '');
  assert.ok(output.includes('x6o4 login'), '应提示运行 x6o4 login');
  fs.rmSync(home, { recursive: true, force: true });
});

test('sync set：全局与筛选游标摆位、非法值报错（离线）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-home-'));
  const env = { USERPROFILE: home, HOME: home };

  nodeCli(['sync', 'set', '500'], env);
  let out = nodeCli(['sync', 'status'], env);
  assert.ok(out.includes('增量游标（全部未读）：500'), '全局游标应摆到 500');

  nodeCli(['sync', 'set', '700', '--category-id', '3'], env);
  out = nodeCli(['sync', 'status'], env);
  assert.ok(out.includes('增量游标（筛选 category:3）：700'), '筛选游标应摆到 700');
  assert.ok(out.includes('增量游标（全部未读）：500'), '写筛选游标不动全局');

  // 回拨（窗口尾 → 实际入选末篇）是合法操作
  nodeCli(['sync', 'set', '35'], env);
  out = nodeCli(['sync', 'status'], env);
  assert.ok(out.includes('增量游标（全部未读）：35'), '游标可回拨');

  let threw = null;
  try { nodeCli(['sync', 'set', 'abc'], env); } catch (e) { threw = e; }
  assert.ok(threw, '非数字应非零退出');
  threw = null;
  try { nodeCli(['sync', 'set', '-3'], env); } catch (e) { threw = e; }
  assert.ok(threw, '非正整数应非零退出');
  fs.rmSync(home, { recursive: true, force: true });
});

test('config show：显示凑篇目标与体积上限，不显示令牌（离线）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-home-'));
  const env = { USERPROFILE: home, HOME: home };
  const out = nodeCli(['config', 'show'], env);
  assert.ok(out.includes('凑篇目标'), '应显示凑篇目标');
  assert.ok(out.includes('30'), '默认凑篇目标 30');
  assert.ok(out.includes('邮件附件体积上限'), '应显示体积上限');
  assert.ok(out.includes('45'), '默认体积上限 45MB');
  assert.ok(!out.includes('xpat_'), '不得显示令牌');
  fs.rmSync(home, { recursive: true, force: true });
});

test('build-epub：多 --from 合并 + 体积截断输出未入选与末篇 id（离线）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-build-'));
  const env = { USERPROFILE: home, HOME: home };
  // 回环不可达地址：feeds 配置拉取即刻失败按无配置继续，全程不发外网请求
  fs.mkdirSync(path.join(home, '.x6o4-tools'), { recursive: true });
  fs.writeFileSync(path.join(home, '.x6o4-tools', 'config.json'), JSON.stringify({
    base_url: 'http://127.0.0.1:1', token: 'xpat_test000000000000',
  }));
  // 正文足够长（≥1000 字）避免全文拉取发起网络请求
  const mkEntry = (i) => ({
    id: i, title: `文章${i}`, url: `https://e.example/${i}`, author: '', published_at: '',
    reading_time: 5, feed: { id: 1, title: '源' }, content: `<p>${'正文'.repeat(120000)}</p>`, // ≈360KB
  });
  fs.writeFileSync(path.join(work, 'a.json'), JSON.stringify({ total: 2, entries: [mkEntry(1), mkEntry(2)] }));
  fs.writeFileSync(path.join(work, 'b.json'), JSON.stringify({ total: 2, entries: [mkEntry(3), mkEntry(4)] }));
  // --max-mail-mb 1（1MB）：第 1 篇 ≈360KB 入选，第 2 篇会触顶 → 2/3/4 未入选
  const out = nodeCli([
    'build-epub', '--ids', '1,2,3,4',
    '--from', [path.join(work, 'a.json'), path.join(work, 'b.json')].join(','),
    '--max-mail-mb', '1', '--title', '合并截断书', '--out', path.join(work, 'book'),
  ], env);
  assert.ok(out.includes('1 篇'), '应只装 1 篇');
  assert.ok(out.includes('（条目 1）'), '册行应含条目编号');
  assert.ok(out.includes('因体积未入选 3 篇'), '应输出未入选计数');
  for (const id of [2, 3, 4]) assert.ok(out.includes(`- ${id} 文章${id}`), `未入选应含 ${id}`);
  assert.ok(out.includes('最后入选条目 id：1'), '应输出末篇 id');
  assert.ok(fs.existsSync(path.join(work, 'book.epub')), '应生成 epub 文件');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

test('build-epub：--from 重复传参等价于逗号列表（离线）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-build-'));
  const env = { USERPROFILE: home, HOME: home };
  // 回环不可达地址：feeds 配置拉取即刻失败按无配置继续，全程不发外网请求
  fs.mkdirSync(path.join(home, '.x6o4-tools'), { recursive: true });
  fs.writeFileSync(path.join(home, '.x6o4-tools', 'config.json'), JSON.stringify({
    base_url: 'http://127.0.0.1:1', token: 'xpat_test000000000000',
  }));
  // 正文足够长（≥1000 字）避免全文拉取发起网络请求
  const mkEntry = (i) => ({
    id: i, title: `文章${i}`, url: `https://e.example/${i}`, author: '', published_at: '',
    reading_time: 5, feed: { id: 1, title: '源' }, content: `<p>${'正文'.repeat(120000)}</p>`,
  });
  fs.writeFileSync(path.join(work, 'a.json'), JSON.stringify({ total: 2, entries: [mkEntry(1), mkEntry(2)] }));
  fs.writeFileSync(path.join(work, 'b.json'), JSON.stringify({ total: 2, entries: [mkEntry(3), mkEntry(4)] }));
  const out = nodeCli([
    'build-epub', '--ids', '1,3',
    '--from', path.join(work, 'a.json'), '--from', path.join(work, 'b.json'),
    '--title', '重复传参书', '--out', path.join(work, 'book'),
  ], env);
  assert.ok(out.includes('2 篇'), '两个批次的文章都应入选');
  assert.ok(out.includes('（条目 1,3）'), '册行应含两个批次的条目编号');
  assert.ok(fs.existsSync(path.join(work, 'book.epub')), '应生成 epub 文件');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});
