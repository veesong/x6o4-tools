// 发送到 Kindle：全部分册合并为**一封邮件**（官方单封最多
// 25 个附件）；附件合计超 45MB 打成一个 zip（亚马逊官方支持、转换服务自动解压）；
// zip 仍超 50MB 才按 50MB 装袋拆多封（分册机制正常工作时走不到这一步）。
// 发信方式二选一（配置 mail_transport）：
//  - smtp（默认）：nodemailer 直连发件邮箱服务器，需要授权码；
//  - agently：调用本机 agently-cli 命令行（agent mail 产品的官方工具，
//    先 `agently-cli auth login` 登录），不需要授权码。
// 人工兜底：邮件失败或内容超大时，epub 已在本地，可改用亚马逊 Send to Kindle
// 网页版上传（单个文档最大 200MB）或数据线拷贝。
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');
const JSZip = require('jszip');
const nodemailer = require('nodemailer');

const MB = 1024 * 1024;
const ZIP_THRESHOLD = 45 * MB;  // 附件合计超过此值 → 打包 zip
const MAIL_HARD_LIMIT = 50 * MB; // 亚马逊个人文档邮件每封附件总量上限
const MAX_ATTACHMENTS = 25;      // 亚马逊单封邮件附件数上限
const TIMEOUT_MS = 60000;
const AGENTLY_TIMEOUT_MS = 120000;

// 把待发文件整理成「每封邮件一组」的结构：必要时打包 zip，再按体积与数量分组。
// 返回 [{ dir, files: [{ abs, rel, size }], bytes }]——dir 是附件所在目录，
// rel 是相对该目录的路径（agently-cli 只接受相对当前目录的附件路径）。
async function planGroups(files) {
  let items = [];
  for (const f of files) {
    const abs = path.resolve(f);
    const st = await fsp.stat(abs);
    items.push({ abs, name: path.basename(abs), size: st.size });
  }

  const total = items.reduce((s, a) => s + a.size, 0);
  if (total > ZIP_THRESHOLD) {
    const zip = new JSZip();
    for (const a of items) zip.file(a.name, await fsp.readFile(a.abs));
    const zbuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    if (zbuf.length > MAIL_HARD_LIMIT) {
      throw new Error(`分册打包 zip 后仍为 ${(zbuf.length / MB).toFixed(1)}MB，超过亚马逊每封邮件 50MB 上限；` +
        '请减少单次篇数（调低 unread.max_articles_per_run 或 epub.max_articles_per_book）后重试，' +
        '或改用亚马逊 Send to Kindle 网页版手动上传（支持单个文档最大 200MB）');
    }
    const zpath = path.join(os.tmpdir(), items[0].name.replace(/\.epub$/i, '') + '-bundle-' + Date.now() + '.zip');
    await fsp.writeFile(zpath, zbuf);
    items = [{ abs: zpath, name: path.basename(zpath), size: zbuf.length, temp: true }];
  }

  if (items.some((a) => a.size > MAIL_HARD_LIMIT)) {
    throw new Error(`单个附件超过 50MB（亚马逊个人文档邮件上限），请减少单册篇数后重试`);
  }

  // 按 50MB 与 25 个附件装袋拆多封（理论上分册正常时不触发）
  const groups = [];
  let cur = { files: [], bytes: 0 };
  for (const a of items) {
    if (cur.files.length > 0 && (cur.bytes + a.size > MAIL_HARD_LIMIT || cur.files.length >= MAX_ATTACHMENTS)) {
      groups.push(cur);
      cur = { files: [], bytes: 0 };
    }
    cur.files.push(a);
    cur.bytes += a.size;
  }
  if (cur.files.length) groups.push(cur);

  for (const g of groups) {
    g.dir = path.dirname(g.files[0].abs);
    for (const a of g.files) a.rel = path.relative(g.dir, a.abs);
  }
  return groups;
}

// 组装 agently-cli 发信命令的参数（独立成函数便于单元测试）。
function agentlyArgs(group, { to, subject, body }) {
  const args = ['message', '+send', '--to', to, '--subject', subject,
    '--body', body, '--confirmed'];
  for (const a of group.files) args.push('--attachment', a.rel);
  return args;
}

// 直接执行命令名在 Windows 上启动不了 npm 全局安装的批处理（.cmd），交给
// cross-spawn 处理跨平台启动，同时避免 shell 注入（参数含书名等用户内容）。
function runAgently(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('agently-cli', args, { cwd, timeout: AGENTLY_TIMEOUT_MS, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ err, stdout, stderr }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ err: new Error(`退出码 ${code}`), stdout, stderr });
      } else {
        resolve({ err: null, stdout, stderr });
      }
    });
  });
}

async function sendViaAgently(groups, cfg, { subject }) {
  const sent = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const subj = groups.length > 1 ? `${subject}（${i + 1}/${groups.length}）` : subject;
    const body = `x6o4-tools 推送：${g.files.length} 个附件（epub 电子书）。`;
    const r = await runAgently(agentlyArgs(g, { to: cfg.kindle_email, subject: subj, body }), g.dir);
    if (r.err) {
      const hint = /ENOENT/i.test(String(r.err.message))
        ? '未找到 agently-cli 命令，请先安装：npm install -g @tencent-qqmail/agently-cli'
        : (/登录|auth|token|401/i.test(r.stderr + r.err.message)
          ? 'agently-cli 尚未登录或登录已过期，请先在终端运行 agently-cli auth login'
          : '');
      throw new Error(`agently-cli 发送失败（${(r.stderr || r.err.message).trim().slice(0, 500)}）。${hint}` +
        '人工兜底：亚马逊 Send to Kindle 网页版上传（单个文档最大 200MB）或数据线拷贝，epub 文件已在本地');
    }
    sent.push(...g.files.map((a) => a.name));
  }
  return { emails: groups.length, attachments: sent };
}

async function sendViaSmtp(groups, cfg, { subject }) {
  const smtp = cfg.smtp || {};
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port) || 465,
    secure: !!smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });

  const sent = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const attachments = [];
    for (const a of g.files) {
      attachments.push({ filename: a.name, content: await fsp.readFile(a.abs), contentType: 'application/epub+zip' });
    }
    const mail = {
      from: smtp.user,
      to: cfg.kindle_email,
      subject: groups.length > 1 ? `${subject}（${i + 1}/${groups.length}）` : subject,
      text: `x6o4-tools 推送：${g.files.length} 个附件（epub 电子书）。发件箱 ${smtp.user} 需已加入亚马逊认可的发件人列表。`,
      attachments,
    };
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) { // 失败重试一次
      try {
        await transport.sendMail(mail);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) {
      throw new Error(`发送失败（${lastErr.message}）。常见原因：SMTP 授权码失效、发件地址未加入亚马逊认可列表。` +
        '人工兜底：亚马逊 Send to Kindle 网页版上传（单个文档最大 200MB）或数据线拷贝，epub 文件已在本地');
    }
    sent.push(...g.files.map((a) => a.name));
  }
  return { emails: groups.length, attachments: sent };
}

async function sendKindle(files, cfg, { subject } = {}) {
  if (!cfg.kindle_email) throw new Error('缺少 kindle_email（Kindle 接收邮箱）');
  const useAgently = cfg.mail_transport === 'agently';
  if (!useAgently) {
    const smtp = cfg.smtp || {};
    if (!smtp.host || !smtp.user || !smtp.pass) throw new Error('缺少 SMTP 配置（host/user/pass）');
  }
  if (!files || !files.length) throw new Error('未指定要发送的文件');

  const groups = await planGroups(files);
  const bookTitle = subject || path.basename(files[0]).replace(/\.epub$/i, '') || 'x6o4 文章精选';
  try {
    return useAgently
      ? await sendViaAgently(groups, cfg, { subject: bookTitle })
      : await sendViaSmtp(groups, cfg, { subject: bookTitle });
  } finally {
    // 打包出的临时 zip 用完即删
    for (const g of groups) {
      for (const a of g.files) {
        if (a.temp) await fsp.rm(a.abs, { force: true }).catch(() => {});
      }
    }
  }
}

module.exports = { sendKindle, planGroups, agentlyArgs };
