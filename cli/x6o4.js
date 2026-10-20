#!/usr/bin/env node
// x6o4 命令行入口：login / status / tokens / feeds / entries /
// mark-read / build-epub / send-kindle / export-md / skip / config。
// 输出纪律：正文永不进终端（entries 默认写文件只打印摘要；--print 只输出元数据
// 与摘要）；令牌与授权码永不回显（status 只显示令牌前缀）。
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { Api, ApiError } = require('./api');
const { runLogin, printTokenTable } = require('./login');
const { buildEpub } = require('./epub');
const { sendKindle } = require('./send');
const { installSkills } = require('./skills');
const { exportMd } = require('./md');

const SKIP_TTL_DAYS = 30;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function api() {
  const cfg = config.load();
  const chk = config.check(cfg);
  if (chk.base_url_invalid || !cfg.token) {
    console.error('✘ 配置未就绪：' + (chk.base_url_invalid || '缺少令牌'));
    console.error('  请先运行 x6o4 login（终端交互输入邮箱密码，自动换取长期令牌）');
    process.exit(1);
  }
  return { cfg, client: new Api(cfg.base_url, cfg.token) };
}

function fail(e) {
  if (e instanceof ApiError) {
    console.error('✘ ' + e.friendly);
  } else {
    console.error('✘ ' + (e.message || e));
  }
  process.exit(1);
}

// 摘要：剥标签后优先取第一个有实质内容的段落（脚注多的文章别截到脚注），
// 总长默认 160 字。
function excerptOf(content, n = 160) {
  const text = String(content || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const paras = text.split(/(?<=[。！？.!?])\s*/);
  for (const p of paras) {
    if (p.length >= 40) return p.slice(0, n);
  }
  return text.slice(0, n);
}

// ---- 本地跳过记录（未读技能：筛掉的文章 30 天内不重复筛）----
function loadSkipState() {
  const state = config.readJson(config.SKIP_STATE_PATH, {});
  const cutoff = Date.now() - SKIP_TTL_DAYS * 86400_000;
  const live = {};
  for (const [id, ts] of Object.entries(state)) {
    if (Number(ts) >= cutoff) live[id] = ts;
  }
  return live;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  if (!cmd || cmd === 'help' || flags.help) return usage();

  if (cmd === 'login') {
    return runLogin({
      name: flags.name,
      scope: flags.scope === 'read' ? 'read' : 'readwrite',
    });
  }

  if (cmd === 'config') {
    const sub = positional[0] || 'check';
    const cfg = config.load();
    if (sub === 'path') {
      console.log(config.CONFIG_PATH);
      return;
    }
    const chk = config.check(cfg, { needKindle: true, needObsidian: true });
    if (chk.base_url_invalid) console.log('✘ ' + chk.base_url_invalid);
    for (const m of chk.missing) console.log('✘ 缺少 ' + m);
    if (chk.ok) console.log('✔ 配置完整（含 Kindle 与笔记库字段）');
    else process.exitCode = 1;
    return;
  }

  if (cmd === 'status') {
    const { cfg, client } = api();
    const me = await client.me();
    console.log(`账号：${me.user.email}（${me.user.nickname || '-'}）`);
    console.log(`权益：${me.entitled ? '有效' : '无（' + (me.block_reason || '未知') + '）'}`);
    console.log(`未读：${me.unread_total == null ? '未知' : me.unread_total} 篇`);
    console.log(`收藏：${me.starred_total == null ? '未知' : me.starred_total} 篇`);
    console.log(`令牌：${cfg.token.slice(0, 12)}…（只显示前缀）`);
    return;
  }

  if (cmd === 'tokens') {
    const { client } = api();
    const sub = positional[0] || 'list';
    if (sub === 'revoke') {
      const id = Number(positional[1]);
      if (!id) { console.error('用法：x6o4 tokens revoke <编号>'); process.exitCode = 1; return; }
      await client.revokeToken(id);
      console.log(`✔ 已吊销令牌 ${id}`);
      return;
    }
    const { tokens } = await client.listTokens();
    printTokenTable(tokens);
    return;
  }

  if (cmd === 'feeds') {
    const { client } = api();
    const { feeds, categories } = await client.feeds();
    console.log(`订阅源 ${feeds.length} 个 / 分类 ${categories.length} 个：`);
    for (const f of feeds) {
      const cat = f.category ? `[${f.category.title}]` : '[]';
      console.log(`  ${f.id}\t${cat}\t未读 ${f.unread}\t${f.title}`);
    }
    return;
  }

  if (cmd === 'entries') {
    const { cfg, client } = api();
    const params = {
      status: flags.status, starred: flags.starred ? 'true' : '',
      feed_id: flags['feed-id'], category_id: flags['category-id'],
      order: flags.order, direction: flags.direction,
      limit: flags.limit || 50, offset: flags.offset,
      content: flags.content || 'full',
    };
    const minRT = Number(flags['min-reading-time']) || 0;
    const excerptLen = Number(flags.excerpt) || 160;
    const skip = flags['no-skip-state'] ? {} : loadSkipState();
    let res = await client.entries(params);
    const total = res.total;
    let entries = res.entries || [];
    const beforeSkip = entries.length;
    if (Object.keys(skip).length) entries = entries.filter((e) => !skip[e.id]);
    if (minRT > 0) entries = entries.filter((e) => (e.reading_time || 0) >= minRT);
    const out = flags.out;
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ total, entries: res.entries }, null, 2));
    }
    if (flags.print) {
      const view = entries.map((e) => ({
        id: e.id, title: e.title, url: e.url, author: e.author,
        published_at: e.published_at, reading_time: e.reading_time, starred: e.starred,
        feed: e.feed ? e.feed.title : '',
        excerpt: excerptOf(e.content, excerptLen),
      }));
      console.log(JSON.stringify({ total, filtered: entries.length, skipped_by_state: beforeSkip - entries.filter((e) => !skip[e.id]).length, entries: view }, null, 2));
      return;
    }
    console.log(`共 ${total} 条；本次取 ${res.entries.length} 条` +
      `${minRT ? `（时长≥${minRT}分钟后 ${entries.length} 条）` : ''}` +
      `${Object.keys(skip).length ? `、跳过记录排除 ${beforeSkip - entries.length + (minRT ? entries.filter((e) => (e.reading_time || 0) >= minRT).length - entries.length : 0)} 条` : ''}` +
      (out ? `；全文已写入 ${out}` : '（未指定 --out，正文未保存）'));
    return;
  }

  if (cmd === 'mark-read') {
    const { client } = api();
    if (!flags.ids) { console.error('用法：x6o4 mark-read --ids 9001,9002'); process.exitCode = 1; return; }
    const ids = String(flags.ids).split(',').map((s) => Number(s.trim())).filter(Boolean).slice(0, 500);
    const r = await client.markRead(ids);
    console.log(`✔ 已标记 ${r.updated} 条为已读`);
    return;
  }

  if (cmd === 'build-epub') {
    const { cfg, client } = api();
    if (!flags.ids || !flags.from) { console.error('用法：x6o4 build-epub --ids 9001,9002 --from entries.json --title 书名 --out 文件'); process.exitCode = 1; return; }
    const want = String(flags.ids).split(',').map((s) => Number(s.trim())).filter(Boolean);
    const data = JSON.parse(fs.readFileSync(flags.from, 'utf8'));
    const byId = new Map((data.entries || []).map((e) => [e.id, e]));
    const picked = [];
    const missing = [];
    for (const id of want) {
      if (byId.has(id)) picked.push(byId.get(id));
      else missing.push(id);
    }
    if (missing.length) {
      console.error('✘ 以下条目不在 --from 文件里（请先重跑 entries 命令）：' + missing.join(', '));
      process.exitCode = 1;
      return;
    }
    const results = await buildEpub(picked, { title: flags.title || 'x6o4 文章精选', out: flags.out, cfg });
    for (const r of results) {
      console.log(`✔ ${r.title}：${r.count} 篇 / ${r.images} 图 → ${r.file}`);
    }
    return;
  }

  if (cmd === 'send-kindle') {
    const { cfg } = api();
    if (!flags.file) { console.error('用法：x6o4 send-kindle --file a.epub[,b.epub] [--subject 书名]'); process.exitCode = 1; return; }
    const files = String(flags.file).split(',').map((s) => s.trim()).filter(Boolean);
    const r = await sendKindle(files, cfg, { subject: flags.subject });
    console.log(`✔ 已发送 ${r.emails} 封邮件（附件 ${r.attachments.length} 个）到 ${cfg.kindle_email}`);
    return;
  }

  if (cmd === 'export-md') {
    const { cfg } = api();
    if (!flags.from) { console.error('用法：x6o4 export-md --from entries.json [--since 2026-01-01]'); process.exitCode = 1; return; }
    const data = JSON.parse(fs.readFileSync(flags.from, 'utf8'));
    const r = await exportMd(data.entries || [], cfg, { since: flags.since });
    console.log(`✔ 新增 ${r.added.length} 篇，跳过 ${r.skipped.length} 篇（已导入/范围外）${r.failed.length ? `，失败 ${r.failed.length} 篇` : ''}`);
    for (const a of r.added) console.log(`  + ${a.file} ← ${a.title}`);
    for (const f of r.failed) console.log(`  ✘ ${f.title}：${f.reason}`);
    return;
  }

  if (cmd === 'skills') {
    const sub = positional[0] || 'install';
    if (sub !== 'install') { console.error('用法：x6o4 skills install'); process.exitCode = 1; return; }
    const results = installSkills();
    const labels = {
      linked: '✔ 已链接（随 npm 包自动更新）',
      copied: '✔ 已复制（链接创建失败时的兜底，不随 npm 自动更新）',
      skipped: '↷ 跳过（该目录已存在且不是本工具的链接，未改动）',
      missing: '✘ 安装包里找不到该技能',
    };
    let bad = false;
    for (const r of results) {
      console.log(`${r.name}：${labels[r.action]}`);
      if (r.action === 'missing') bad = true;
    }
    if (bad) process.exitCode = 1;
    return;
  }

  if (cmd === 'skip') {
    const sub = positional[0] || 'list';
    if (sub === 'add') {
      if (!flags.ids) { console.error('用法：x6o4 skip add --ids 9001,9002 [--days 30]'); process.exitCode = 1; return; }
      const state = config.readJson(config.SKIP_STATE_PATH, {});
      for (const id of String(flags.ids).split(',')) {
        const n = Number(id.trim());
        if (n) state[n] = Date.now();
      }
      config.writeJson(config.SKIP_STATE_PATH, state);
      console.log('✔ 已记入本地跳过记录（默认 30 天后过期重新纳入筛选）');
      return;
    }
    if (sub === 'clear') {
      config.writeJson(config.SKIP_STATE_PATH, {});
      console.log('✔ 已清空跳过记录');
      return;
    }
    const live = loadSkipState();
    const ids = Object.keys(live);
    console.log(ids.length ? `跳过记录 ${ids.length} 条：${ids.join(', ')}` : '跳过记录为空');
    return;
  }

  usage();
}

function usage() {
  console.log(`x6o4 —— RSS Cloud 技能命令行（配置与状态存 ~/.x6o4-tools/）

用法：
  x6o4 login [--name 名] [--scope read|readwrite]              终端交互登录换长期令牌（密码不回显）
  x6o4 status                    账号/权益/未读/收藏概览（令牌只显前缀）
  x6o4 tokens list|revoke <编号>  查看与吊销个人令牌
  x6o4 feeds                     订阅源与分类（含未读数）
  x6o4 entries [--status unread|read] [--starred] [--feed-id N] [--category-id N]
              [--limit N] [--offset N] [--order ...] [--direction ...] [--content full|none]
              [--min-reading-time N] [--excerpt N] [--no-skip-state] [--print] --out 文件
  x6o4 mark-read --ids 9001,9002
  x6o4 build-epub --ids 9001,9002 --from entries.json --title 书名 [--out 文件]
  x6o4 send-kindle --file a.epub[,b.epub] [--subject 书名]
  x6o4 export-md --from entries.json [--since 2026-01-01]
  x6o4 skip add --ids ... [--days 30] | list | clear
  x6o4 skills install           把三个 AI 技能链接到 ~/.agents/skills（各助手通用）
  x6o4 config path|check`);
}

main().catch(fail);
