// 终端交互登录（借鉴 agently-cli 的交互式长命令约定）：
// 用户亲自在终端输入邮箱与密码（密码回显屏蔽，不经过 AI 对话）→ 换 15 分钟
// 登录令牌 → 创建个人访问令牌存本地 → 密码与短效令牌即弃 → agent/me 自校验。
// 遇 409 令牌数上限时列出既有令牌引导吊销，腾出名额后重试一次（不静默吊销）。
const os = require('os');
const readline = require('readline');
const { Api, ApiError } = require('./api');
const config = require('./config');

function question(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

// 密码输入：原生 readline 不支持掩码，按字符读取并以 * 回显（需真实终端）。
function questionHidden(rl, prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    let value = '';
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    const onData = (ch) => {
      ch = Buffer.from(ch);
      if (ch[0] === 13 || ch[0] === 10) { // 回车
        stdin.removeListener('data', onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        process.stdout.write('\n');
        resolve(value);
      } else if (ch[0] === 3) { // Ctrl+C
        process.stdout.write('\n');
        process.exit(130);
      } else if (ch[0] === 8 || ch[0] === 127) { // 退格
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (ch[0] >= 32) {
        value += ch.toString('utf8');
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

function printTokenTable(tokens) {
  console.log('当前令牌（未吊销）：');
  console.log('  编号  名称                权限        创建时间            最近使用');
  for (const t of tokens) {
    const last = t.last_used_at ? String(t.last_used_at).slice(0, 16).replace('T', ' ') : '从未使用';
    console.log(`  ${String(t.id).padEnd(5)}  ${(t.name || '').slice(0, 18).padEnd(18)}  ${(t.scope || '').padEnd(10)}  ${String(t.created_at).slice(0, 16).replace('T', ' ')}  ${last}`);
  }
}

async function runLogin({ name, scope = 'readwrite' } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // 服务地址固定为 RSS Cloud 官方（config.js 默认值），无需询问
    const base = config.load().base_url;
    const email = (await question(rl, '邮箱：')).trim();
    const password = await questionHidden(rl, '密码（输入不回显）：');

    const api = new Api(base);
    let loginResp;
    try {
      loginResp = await api.login(email, password);
    } catch (e) {
      console.error('✘ 登录失败：' + (e.friendly || e.message));
      process.exitCode = 1;
      return;
    }
    const jwt = loginResp.access_token;
    const tokenName = name || `x6o4-tools@${os.hostname()}`.slice(0, 64);

    let created = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        created = await api.createToken(jwt, tokenName, scope);
        break;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'TOKEN_LIMIT_REACHED' && attempt === 0) {
          console.log('个人令牌数量已达上限。');
          try {
            const { tokens } = await api.listTokens(jwt);
            printTokenTable(tokens);
            const pick = (await question(rl, '输入要吊销的令牌编号（回车放弃登录）：')).trim();
            if (!pick) { console.error('✘ 已放弃：未吊销任何令牌。'); process.exitCode = 1; return; }
            await api.revokeToken(Number(pick)); // 个人令牌尚未持有，仍用登录令牌吊销
            continue;
          } catch (e2) {
            console.error('✘ 列出/吊销令牌失败：' + (e2.friendly || e2.message));
            process.exitCode = 1;
            return;
          }
        }
        console.error('✘ 创建令牌失败：' + (e.friendly || e.message));
        process.exitCode = 1;
        return;
      }
    }
    if (!created) { process.exitCode = 1; return; }

    // 保存（密码与 15 分钟登录令牌至此即弃，不落盘）
    const cfg = config.load();
    cfg.base_url = base.replace(/\/+$/, '');
    cfg.token = created.token;
    config.save(cfg);

    // 自校验：确认令牌真实可用后才报告成功
    const verify = new Api(cfg.base_url, cfg.token);
    try {
      const me = await verify.me();
      console.log('✔ 已授权：' + me.user.email);
      console.log(`✔ 令牌「${created.name}」（${created.scope}）已保存到 ${config.CONFIG_PATH}`);
      console.log('现在可以对 AI 说：把未读文章推到 Kindle / 把我的收藏转成 Markdown');
    } catch (e) {
      console.error('✘ 令牌自校验失败（配置已保存，可重试 x6o4 status）：' + (e.friendly || e.message));
      process.exitCode = 1;
    }
  } finally {
    rl.close();
  }
}

module.exports = { runLogin, question, questionHidden, printTokenTable };
