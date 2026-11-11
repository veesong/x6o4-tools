// 终端交互登录（借鉴 agently-cli 的交互式长命令约定）：
// 用户亲自在终端输入邮箱与密码（密码回显屏蔽，不经过 AI 对话）→ 换 15 分钟
// 登录令牌 → 创建个人访问令牌存本地 → 密码与短效令牌即弃 → agent/me 自校验。
// 遇 409 令牌数上限时列出既有令牌引导吊销，腾出名额后重试一次（不静默吊销）。
// 界面语言：配置里没有 ui.language 时，登录第一步用双语提问让用户选一次
// （回车 = 按系统检测默认），选择结果随令牌一起保存；已设置过或本次带了
// --lang 时不问。
const os = require('os');
const readline = require('readline');
const { Writable } = require('stream');
const { Api, ApiError } = require('./api');
const config = require('./config');
const { detectSystemLang } = require('./i18n');
const { setUiLang, ui, parseUiLangChoice, LOGIN_LANG_QUESTION, LOGIN_LANG_RETRY } = require('./uitext');

// 管道输入耗尽标记：stdin 的 end 事件只发一次，晚于它创建的行读取实例收
// 不到 close 事件。提问入口先查这个标记，已耗尽就直接以空串返回，避免
// Promise 悬空导致进程静默退出（真实终端不受影响——键盘输入不会关掉流）。
let stdinEnded = false;
process.stdin.on('end', () => { stdinEnded = true; });

// 每次提问用独立的行读取实例，避免两个实例同时读键盘导致输入错乱。
// 流在回调前就结束时（管道输入耗尽等非交互场景）以空串完成 Promise：
// 流程继续走、由后续步骤正常报错，而不是让 Promise 悬空导致进程静默退出
// （两种结束只取先到的一个，settled 防止 close 事件重复收尾）。
function question(prompt) {
  if (stdinEnded) return Promise.resolve('');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let settled = false;
    rl.question(prompt, (answer) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    });
    rl.on('close', () => {
      if (settled) return;
      settled = true;
      resolve('');
    });
  });
}

// 密码输入：行读取组件接管按键处理，但输出接到「哑输出流」——提示语照常
// 显示，之后的按键回显全部丢弃，屏幕上什么都不出现（含退格擦除码）。
function questionHidden(prompt) {
  if (stdinEnded) return Promise.resolve('');
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
    const finish = (answer) => {
      if (finish.done) return;
      finish.done = true;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    };
    rl.question(prompt, finish);
    rl.on('close', () => finish(''));
    muted.muted = true;
  });
}

function printTokenTable(tokens) {
  const t = ui();
  console.log(t.loginTokenHead);
  console.log(t.loginTokenColumns);
  for (const tok of tokens) {
    const last = tok.last_used_at ? String(tok.last_used_at).slice(0, 16).replace('T', ' ') : t.loginNeverUsed;
    console.log(`  ${String(tok.id).padEnd(5)}  ${(tok.name || '').slice(0, 18).padEnd(18)}  ${(tok.scope || '').padEnd(10)}  ${String(tok.created_at).slice(0, 16).replace('T', ' ')}  ${last}`);
  }
}

// 登录前的界面语言提问。返回 'zh' / 'en'（本次登录全程使用）；配置已设置或
// skipLangPrompt（--lang 显式给定）时直接沿用当前语言并返回空串（空串表示
// 「没有新选择」）。选定即写入配置：语言偏好不是凭据，登录中途失败（密码
// 输错等）重试时不必再选一遍。
async function askUiLang(skip) {
  const cfg = config.load();
  const configured = ((cfg.ui || {}).language === 'en' || (cfg.ui || {}).language === 'zh') ? cfg.ui.language : '';
  if (skip || configured) return '';
  const detected = detectSystemLang();
  let picked = null;
  for (let attempt = 0; attempt < 3 && picked === null; attempt++) {
    // 第一次用正常提问，重问时用「无法识别」提示（同样双语，语言此时未定）。
    const answer = await question(attempt === 0 ? LOGIN_LANG_QUESTION : LOGIN_LANG_RETRY);
    picked = parseUiLangChoice(answer, detected);
  }
  const choice = picked === null ? detected : picked;
  config.save({ ...cfg, ui: { ...(cfg.ui || {}), language: choice } });
  return choice;
}

async function runLogin({ name, scope = 'readwrite', skipLangPrompt = false } = {}) {
  // 服务地址固定为 RSS Cloud 官方（config.js 默认值），无需询问
  const uiLangChoice = await askUiLang(skipLangPrompt);
  if (uiLangChoice) setUiLang(uiLangChoice);
  const t = ui();
  const base = config.load().base_url;
  const email = (await question(t.loginEmail)).trim();
  const password = await questionHidden(t.loginPassword);

    const api = new Api(base);
    let loginResp;
    try {
      loginResp = await api.login(email, password);
    } catch (e) {
      console.error(ui().loginFail(e.friendly || e.message));
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
          console.log(ui().loginTokenLimit);
          try {
            const { tokens } = await api.listTokens(jwt);
            printTokenTable(tokens);
            const pick = (await question(ui().loginRevokePrompt)).trim();
            if (!pick) { console.error(ui().loginAborted); process.exitCode = 1; return; }
            await api.revokeToken(Number(pick)); // 个人令牌尚未持有，仍用登录令牌吊销
            continue;
          } catch (e2) {
            console.error(ui().loginListRevokeFail(e2.friendly || e2.message));
            process.exitCode = 1;
            return;
          }
        }
        console.error(ui().loginCreateFail(e.friendly || e.message));
        process.exitCode = 1;
        return;
      }
    }
    if (!created) { process.exitCode = 1; return; }

    // 保存（密码与 15 分钟登录令牌至此即弃，不落盘）；界面语言已在提问时
    // 单独保存，这里不再处理。
    const cfg = config.load();
    cfg.base_url = base.replace(/\/+$/, '');
    cfg.token = created.token;
    config.save(cfg);

    // 自校验：确认令牌真实可用后才报告成功
    const verify = new Api(cfg.base_url, cfg.token);
    try {
      const me = await verify.me();
      console.log(ui().loginAuthorized(me.user.email));
      console.log(ui().loginTokenSaved(created.name, created.scope, config.CONFIG_PATH));
      console.log(ui().loginNextHint);
    } catch (e) {
      console.error(ui().loginVerifyFail(e.friendly || e.message));
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
  const t = ui();
  const cfg = config.load();
  if (!cfg.token) {
    console.log(t.logoutNoToken);
    return;
  }
  const api = new Api(cfg.base_url, cfg.token);
  try {
    const { tokens } = await api.listTokens();
    const own = findOwnToken(tokens, cfg.token);
    if (own) {
      await api.revokeToken(own.id);
      config.save({ ...cfg, token: '' });
      console.log(t.logoutDone(own.name));
      console.log(t.logoutOtherNote);
    } else {
      config.save({ ...cfg, token: '' });
      console.log(t.logoutClearedNoMatch);
    }
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'TOKEN_INVALID' || e.status === 401)) {
      config.save({ ...cfg, token: '' });
      console.log(t.logoutClearedInvalid);
      return;
    }
    console.error(t.logoutFail(e.friendly || e.message));
    process.exitCode = 1;
  }
}

module.exports = { runLogin, runLogout, findOwnToken, question, questionHidden, printTokenTable, askUiLang };
