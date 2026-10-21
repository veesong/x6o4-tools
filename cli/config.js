// 配置读写：~/.x6o4-tools/config.json（写入后尽量收紧为仅当前用户可读）。
// 服务地址固定为 RSS Cloud 官方 https://rss-cloud.x6o4.com（闭源云服务，无自部署
// 场景），用户无需填写；配置文件保留该字段仅供极少数进阶用户覆盖。
// 令牌与 SMTP 授权码只存在此文件——不进仓库、不进日志、不进 AI 对话。
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.x6o4-tools');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const EXPORT_STATE_PATH = path.join(CONFIG_DIR, 'export-state.json'); // 收藏转 Markdown 幂等状态：来源链接 → 文件
const SKIP_STATE_PATH = path.join(CONFIG_DIR, 'skip-state.json');     // 未读技能本地跳过记录：条目编号 → 判断时间

// RSS Cloud 官方服务地址（固定，消费者无需配置）。
const OFFICIAL_BASE_URL = 'https://rss-cloud.x6o4.com';

const DEFAULTS = {
  base_url: OFFICIAL_BASE_URL,
  token: '',
  kindle_email: '',
  // 发信方式：smtp（默认，配授权码）或 agently（agent mail 产品的命令行工具，先 agently-cli auth login）
  mail_transport: 'smtp',
  smtp: { preset: '', host: '', port: 465, secure: true, user: '', pass: '' },
  // 一封邮件附件总体积上限（MB）：未读推送生成电子书时按它截断装篇，默认 45
  // 留在亚马逊/常见邮箱 50MB 硬限制之下。
  mail: { max_attachment_mb: 45 },
  obsidian: { vault_dir: '', subdir: 'RSS', assets_subdir: 'RSS/assets', download_images: true },
  epub: {
    image_max_width: 1200,
    image_jpeg_quality: 70,
    image_grayscale: true,
    max_total_mb: 20,
    max_articles_per_book: 50,
  },
  unread: { max_articles_per_run: 30 },
};

// 常见邮箱 SMTP 预设：端口与开关位置可能调整，以各家官方文档为准。
const SMTP_PRESETS = {
  qq: { host: 'smtp.qq.com', port: 465, secure: true },
  '163': { host: 'smtp.163.com', port: 465, secure: true },
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  icloud: { host: 'smtp.mail.me.com', port: 587, secure: false },
};

function applySmtpPreset(smtp, preset) {
  const p = SMTP_PRESETS[preset];
  if (!p) return smtp;
  return Object.assign({}, smtp, p, { preset });
}

function load() {
  let cfg = JSON.parse(JSON.stringify(DEFAULTS));
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cfg = { ...cfg, ...raw };
    for (const k of ['smtp', 'mail', 'obsidian', 'epub', 'unread']) {
      cfg[k] = { ...DEFAULTS[k], ...(raw[k] || {}) };
    }
  }
  if (!cfg.base_url) {
    cfg.base_url = OFFICIAL_BASE_URL; // 固定官方地址；缺省时归一
  }
  return cfg;
}

function save(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  try {
    fs.chmodSync(CONFIG_PATH, 0o600); // Windows 下多为空操作，不阻断
  } catch { /* 尽力而为 */ }
}

function isLoopback(u) {
  try {
    const host = new URL(u).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

// 校验：http 非回环拒绝（安全底线）、令牌缺失、按用途需要的字段。
// 返回 { ok, missing: [...], base_url_invalid }，由调用方决定怎么呈现。
function check(cfg, { needKindle = false, needObsidian = false } = {}) {
  const missing = [];
  let base_url_invalid = '';
  try {
    const u = new URL(cfg.base_url || OFFICIAL_BASE_URL);
    if (u.protocol === 'http:' && !isLoopback(u.href)) {
      base_url_invalid = '服务地址为 http 且非本机回环，必须使用 https';
    }
  } catch {
    base_url_invalid = '服务地址格式无效';
  }
  if (!cfg.token || !cfg.token.startsWith('xpat_')) missing.push('token（先运行 x6o4 login）');
  const smtp = cfg.smtp || {};
  const obsidian = cfg.obsidian || {};
  if (needKindle) {
    if (!cfg.kindle_email) missing.push('kindle_email（Kindle 接收邮箱）');
    if (cfg.mail_transport === 'agently') {
      // 发信走本机 agently-cli，无需 SMTP 配置；是否已安装登录由发送时校验。
    } else if (!smtp.host || !smtp.user || !smtp.pass) {
      missing.push('smtp（host/user/pass，常见邮箱可用 --preset 一键填）');
    }
  }
  if (needObsidian && !obsidian.vault_dir) missing.push('obsidian.vault_dir（笔记库目录）');
  return { ok: !base_url_invalid && missing.length === 0, missing, base_url_invalid };
}

// ---- 小状态文件（JSON）----
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ---- 增量同步游标（未读拉取只取编号比游标大的文章）----
// 状态文件里存两样：unread_cursor 是全局游标（拉全部未读时用）；
// filter_cursors 是各筛选条件（分类/订阅源）自己的游标——按筛选拉取只
// 推进自己的游标、不动全局的，这样全局游标不会越过其他分类里还没取过的
// 未读文章。读写函数接受路径参数，便于测试；调用方默认用 SYNC_STATE_PATH。
const SYNC_STATE_PATH = path.join(CONFIG_DIR, 'sync-state.json');

function readCursor(p) {
  return Number(readJson(p, {}).unread_cursor) || 0;
}
function writeCursor(p, v) {
  writeJson(p, { ...readJson(p, {}), unread_cursor: Number(v) || 0, updated_at: new Date().toISOString() });
}

function readFilterCursor(p, key) {
  return Number((readJson(p, {}).filter_cursors || {})[key]) || 0;
}
function writeFilterCursor(p, key, v) {
  const state = readJson(p, {});
  const filters = { ...(state.filter_cursors || {}) };
  filters[key] = Number(v) || 0;
  writeJson(p, { ...state, filter_cursors: filters, updated_at: new Date().toISOString() });
}
// 清零：不带 key 清全部游标；带 key 只清那一个筛选的。
function clearCursors(p, key) {
  if (!key) { writeJson(p, {}); return; }
  const state = readJson(p, {});
  const filters = { ...(state.filter_cursors || {}) };
  delete filters[key];
  writeJson(p, { ...state, filter_cursors: filters, updated_at: new Date().toISOString() });
}

module.exports = {
  CONFIG_DIR, CONFIG_PATH, EXPORT_STATE_PATH, SKIP_STATE_PATH, SYNC_STATE_PATH,
  OFFICIAL_BASE_URL,
  DEFAULTS, SMTP_PRESETS, applySmtpPreset, load, save, check, isLoopback,
  readJson, writeJson, readCursor, writeCursor,
  readFilterCursor, writeFilterCursor, clearCursors,
};
