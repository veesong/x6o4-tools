// 终端交互登录（借鉴 agently-cli 的交互式长命令约定）：
// 用户亲自在终端输入邮箱与密码（密码回显屏蔽，不经过 AI 对话）→ 换 15 分钟
// 登录令牌 → 创建个人访问令牌存本地 → 密码与短效令牌即弃 → agent/me 自校验。
// 遇 409 令牌数上限时列出既有令牌引导吊销，腾出名额后重试一次（不静默吊销）。
const os = require('os');
const readline = require('readline');
const { Writable } = require('stream');
const { Api, ApiError } = require('./api');
const config = require('./config');

// 每次提问用独立的行读取实例，避免两个实例同时读键盘导致输入错乱。
function question(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
  });
}

// 密码输入：行读取组件接管按键处理，但输出接到「哑输出流」——提示语照常
// 显示，之后的按键回显全部丢弃，屏幕上什么都不出现（含退格擦除码）。
function questionHidden(prompt) {
  return new Promise((resolve) => {
    const muted = new Writable({
      write(chunk, enc, cb) {
        if (!muted.muted) process.stdout.write(chunk, enc);
        cb();
      },
    });
    muted.muted = false;
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    rl.on('SIGINT', () => { process.stdout.write('\n'); process.exit(130); });
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted.muted = true;
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
  // 服务地址固定为 RSS Cloud 官方（config.js 默认值），无需询问
  const base = config.load().base_url;
  const email = (await question('邮箱：')).trim();
  const password = await questionHidden('密码（输入不回显）：');

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
            const pick = (await question('输入要吊销的令牌编号（回车放弃登录）：')).trim();
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
}

// 在服务端令牌列表里找出本机保存的那一枚：服务端列表只返回 12 位展示前缀
// （不含敏感部分），与本地令牌的前 12 位比对即可定位编号。
function findOwnToken(tokens, localToken) {
  const prefix = String(localToken || '').slice(0, 12);
  if (!prefix) return null;
  return (tokens || []).find((t) => t.token_prefix === prefix) || null;
}

// 退出登录：吊销本机令牌在服务端的授权，再清除本地保存。令牌在服务端已
// 失效（改过密码、早已吊销）时不需要再吊销，直接清除本地保存即可。
async function runLogout() {
  const cfg = config.load();
  if (!cfg.token) {
    console.log('本机没有保存 RSS Cloud 令牌，无需退出。');
    return;
  }
  const api = new Api(cfg.base_url, cfg.token);
  try {
    const { tokens } = await api.listTokens();
    const own = findOwnToken(tokens, cfg.token);
    if (own) {
      await api.revokeToken(own.id);
      config.save({ ...cfg, token: '' });
      console.log(`✔ 已退出：令牌「${own.name}」已在服务端吊销，本机保存的令牌也已清除。`);
      console.log('其他电脑上的令牌不受影响；要全部吊销，可运行 x6o4 tokens list 逐个吊销，或修改 RSS Cloud 密码（会立即吊销全部令牌）。');
    } else {
      config.save({ ...cfg, token: '' });
      console.log('✔ 本机保存的令牌已清除（服务端列表里没有匹配的令牌，可能早已吊销）。');
    }
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'TOKEN_INVALID' || e.status === 401)) {
      config.save({ ...cfg, token: '' });
      console.log('✔ 服务端已不认这个令牌（可能已被吊销），本机保存已清除。');
      return;
    }
    console.error('✘ 退出失败：' + (e.friendly || e.message));
    process.exitCode = 1;
  }
}

module.exports = { runLogin, runLogout, findOwnToken, question, questionHidden, printTokenTable };
