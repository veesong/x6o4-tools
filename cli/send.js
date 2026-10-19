// SMTP 发送到 Kindle：全部分册合并为**一封邮件**（官方单封最多
// 25 个附件）；附件合计超 45MB 打成一个 zip（亚马逊官方支持、转换服务自动解压）；
// zip 仍超 50MB 才按 50MB 装袋拆多封（分册机制正常工作时走不到这一步）。
// 人工兜底：邮件失败或内容超大时，epub 已在本地，可改用亚马逊 Send to Kindle
// 网页版上传（单个文档最大 200MB）或数据线拷贝。
const fsp = require('fs/promises');
const path = require('path');
const JSZip = require('jszip');
const nodemailer = require('nodemailer');

const MB = 1024 * 1024;
const ZIP_THRESHOLD = 45 * MB;  // 附件合计超过此值 → 打包 zip
const MAIL_HARD_LIMIT = 50 * MB; // 亚马逊个人文档邮件每封附件总量上限
const MAX_ATTACHMENTS = 25;      // 亚马逊单封邮件附件数上限
const TIMEOUT_MS = 60000;

async function sendKindle(files, cfg, { subject } = {}) {
  const smtp = cfg.smtp || {};
  if (!cfg.kindle_email) throw new Error('缺少 kindle_email（Kindle 接收邮箱）');
  if (!smtp.host || !smtp.user || !smtp.pass) throw new Error('缺少 SMTP 配置（host/user/pass）');

  let attachments = [];
  for (const f of files) {
    const buf = await fsp.readFile(f);
    attachments.push({ filename: path.basename(f), content: buf, contentType: 'application/epub+zip' });
  }

  // 合并超 45MB → 打成一个 zip（收益有限但官方支持，属兜底工序）
  const total = attachments.reduce((s, a) => s + a.content.length, 0);
  if (total > ZIP_THRESHOLD) {
    const zip = new JSZip();
    for (const a of attachments) zip.file(a.filename, a.content);
    const zbuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    if (zbuf.length > MAIL_HARD_LIMIT) {
      throw new Error(`分册打包 zip 后仍为 ${(zbuf.length / MB).toFixed(1)}MB，超过亚马逊每封邮件 50MB 上限；` +
        '请减少单次篇数（调低 unread.max_articles_per_run 或 epub.max_articles_per_book）后重试，' +
        '或改用亚马逊 Send to Kindle 网页版手动上传（支持单个文档最大 200MB）');
    }
    attachments = [{ filename: attachments[0].filename.replace(/\.epub$/i, '') + '-bundle.zip', content: zbuf, contentType: 'application/zip' }];
  }

  if (attachments.some((a) => a.content.length > MAIL_HARD_LIMIT)) {
    throw new Error(`单个附件超过 50MB（亚马逊个人文档邮件上限），请减少单册篇数后重试`);
  }

  // 按 50MB 与 25 个附件装袋拆多封（理论上分册正常时不触发）
  const groups = [];
  let curGroup = [];
  let curBytes = 0;
  for (const a of attachments) {
    if (curGroup.length > 0 && (curBytes + a.content.length > MAIL_HARD_LIMIT || curGroup.length >= MAX_ATTACHMENTS)) {
      groups.push(curGroup);
      curGroup = [];
      curBytes = 0;
    }
    curGroup.push(a);
    curBytes += a.content.length;
  }
  if (curGroup.length) groups.push(curGroup);

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port) || 465,
    secure: !!smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });

  const bookTitle = subject || files[0].replace(/\.epub$/i, '').split(/[\\/]/).pop() || 'x6o4 文章精选';
  const sent = [];
  for (let i = 0; i < groups.length; i++) {
    const mail = {
      from: smtp.user,
      to: cfg.kindle_email,
      subject: groups.length > 1 ? `${bookTitle}（${i + 1}/${groups.length}）` : bookTitle,
      text: `x6o4-tools 推送：${groups[i].length} 个附件（epub 电子书）。发件箱 ${smtp.user} 需已加入亚马逊认可的发件人列表。`,
      attachments: groups[i],
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
    sent.push(...groups[i].map((a) => a.filename));
  }
  return { emails: groups.length, attachments: sent };
}

module.exports = { sendKindle };
