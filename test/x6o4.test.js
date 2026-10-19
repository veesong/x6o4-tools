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
