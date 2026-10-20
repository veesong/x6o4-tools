// 收藏转 Markdown：纯程序确定性转换（幂等、零成本、长文无截断），
// 程序预处理（懒加载回填，与 epub 线共用）→ node-html-markdown（GFM）→ frontmatter
// + 文件名净化 → 图片按配置下载并相对化（下载走 imagedl 分级重试）。幂等：
// 状态文件记录 来源链接 → 文件路径，状态缺失/文件丢失时扫描目标目录
// frontmatter 重建。AI 润色为可选档（默认关，用户要求时由宿主 AI 直接编辑
// 生成好的文件，不经本模块）。
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NodeHtmlMarkdown, NodeHtmlMarkdownTransformer } = require('node-html-markdown');
const { backfillLazyImages } = require('./htmlclean');
const { downloadImage } = require('./imagedl');
const config = require('./config');

const nhm = new NodeHtmlMarkdown({}, {}, { codeBlockStyle: 'fenced' });

function yamlStr(v) {
  const s = String(v == null ? '' : v);
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// 文件名净化：去非法字符与首尾空白，长度截 80 字符，重名加 -2/-3。
function sanitizeFilename(title) {
  let s = String(title || 'untitled')
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return s || 'untitled';
}

function slugTag(s) {
  return String(s || '').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'feed';
}

function frontmatter(entry, importedAt) {
  const tags = ['rss', slugTag(entry.feed && entry.feed.title)];
  return [
    '---',
    `title: ${yamlStr(entry.title)}`,
    `source: ${yamlStr(entry.url)}`,
    `feed: ${yamlStr(entry.feed && entry.feed.title)}`,
    `author: ${yamlStr(entry.author)}`,
    `published_at: ${yamlStr(entry.published_at)}`,
    `imported_at: ${yamlStr(importedAt)}`,
    `tags: [${tags.map((t) => yamlStr(t)).join(', ')}]`,
    '---',
  ].join('\n');
}

function hash8(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 8);
}

// 下载图片到 assets 目录并把正文里的远程链接改写为相对路径（download_images 开关）。
// 下载走 imagedl 分级重试（文章地址作为 Referer 首选，全失败保留远程链接）。
async function localizeImages(md, assetsDir, entryUrl, imgReferer) {
  const out = [];
  const re = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
  let last = 0;
  let m;
  let seq = 0;
  while ((m = re.exec(md)) !== null) {
    const alt = m[1];
    const url = m[2];
    out.push(md.slice(last, m.index));
    const res = await downloadImage(url, entryUrl, imgReferer);
    if (res) {
      let ext = 'jpg';
      const ct = res.contentType;
      if (ct.includes('png')) ext = 'png';
      else if (ct.includes('gif')) ext = 'gif';
      else if (ct.includes('webp')) ext = 'webp';
      seq += 1;
      const name = `${new Date().toISOString().slice(0, 10)}-${hash8(url)}-${seq}.${ext}`;
      await fsp.mkdir(assetsDir, { recursive: true });
      await fsp.writeFile(path.join(assetsDir, name), res.buffer);
      out.push(`![${alt}](assets/${name})`);
    } else {
      out.push(`![${alt}](${url})`); // 下载失败保留远程链接
    }
    last = m.index + m[0].length;
  }
  out.push(md.slice(last));
  return out.join('');
}

// 幂等状态：来源链接 → 相对文件路径；状态文件缺失或指向的文件不存在时扫描目录重建。
function loadState(dir, statePath) {
  const state = config.readJson(statePath, {});
  const rebuilt = {};
  let dirty = false;
  for (const [url, rel] of Object.entries(state)) {
    if (fs.existsSync(path.join(dir, rel))) rebuilt[url] = rel;
    else dirty = true;
  }
  // 状态为空或丢项时，从目标目录 frontmatter 的 source 字段重建
  const needRebuild = Object.keys(rebuilt).length === 0;
  if (needRebuild) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.md')) continue;
      const text = fs.readFileSync(path.join(dir, f.name), 'utf8');
      const m = text.match(/^source:\s*"([^"]+)"/m);
      if (m) rebuilt[m[1]] = f.name;
    }
    dirty = true;
  }
  return { state: rebuilt, dirty };
}

// entries：[{id,title,url,author,content,published_at,feed}]（来自 entries 命令写出的全文 JSON）
// opts.enrich：可选的单篇正文增强钩子（全文拉取，构建命令传入；在跳过判定
// 之后调用，避免为不会导出的条目访问原文网页）。
// 返回 { added: [{file,title}], skipped: n, failed: [{title,reason}] }
async function exportMd(entries, cfg, { since, enrich } = {}) {
  const ob = cfg.obsidian || {};
  if (!ob.vault_dir) throw new Error('缺少 obsidian.vault_dir（笔记库目录）');
  const dir = path.join(ob.vault_dir, ob.subdir || 'RSS');
  const assetsDir = path.join(ob.vault_dir, ob.assets_subdir || 'RSS/assets');
  await fsp.mkdir(dir, { recursive: true });

  const { state, dirty } = loadState(dir, config.EXPORT_STATE_PATH);
  const importedAt = new Date().toISOString();
  const added = [];
  const skipped = [];
  const failed = [];
  let seq = 0;

  for (const entry of entries) {
    try {
      if (since && entry.published_at && new Date(entry.published_at) < new Date(since)) {
        skipped.push(`${entry.title}（早于起始日期，跳过）`);
        continue;
      }
      if (state[entry.url]) {
        skipped.push(entry.title);
        continue;
      }
      const date = (entry.published_at || importedAt).slice(0, 10);
      let base = `${date}-${sanitizeFilename(entry.title)}`;
      let file = `${base}.md`;
      for (let i = 2; fs.existsSync(path.join(dir, file)); i++) {
        file = `${base}-${i}.md`;
      }
      if (enrich) await enrich(entry); // 拉取原文全文（失败保留原正文，见 fulltext 模块）
      let body = nhm.translate(backfillLazyImages(entry.content || ''));
      body = body.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n'); // 换行统一 + 连续空行压缩
      if (ob.download_images !== false) {
        body = await localizeImages(body, assetsDir, entry.url, entry._imgReferer);
      }
      await fsp.writeFile(path.join(dir, file), `${frontmatter(entry, importedAt)}\n\n${body}\n`, 'utf8');
      state[entry.url] = file;
      added.push({ file, title: entry.title });
      seq += 1;
    } catch (e) {
      failed.push({ title: entry.title, reason: e.message });
    }
  }
  if (dirty || seq > 0) config.writeJson(config.EXPORT_STATE_PATH, state);
  return { added, skipped, failed };
}

module.exports = { exportMd, sanitizeFilename, frontmatter, yamlStr, slugTag, hash8 };
