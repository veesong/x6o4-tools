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
const { enrichEntries, newStats, fulltextLine } = require('./fulltext');

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

// ---- 全文拉取装配：取按源阅读配置（取不到按无配置继续），供两条产物线共用 ----
async function readingConfigMap(client) {
  try {
    const r = await client.feeds();
    const map = {};
    for (const f of r.feeds || []) {
      if (f.reading_config) map[f.id] = f.reading_config;
    }
    return map;
  } catch {
    return {}; // 配置拉不到不阻断生成，按无配置走启发式
  }
}

// export-md 的逐篇增强钩子：在导出跳过判定之后才访问原文网页，并汇总统计
function enrichHook(cfgMap) {
  const stats = newStats();
  return { stats, enrich: async (entry) => { await enrichEntries([entry], cfgMap, { stats }); } };
}

// 分页翻取时按编号去重（两页之间若有文章被标记已读，窗口会前移导致重复）
function dedupEntries(list) {
  const seen = new Set();
  return list.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
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
    const sub = positional[0];
    if (sub === 'config') {
      // 保存单源阅读设置（需读写档令牌；手机 App 与网页管理页共用同一份设置）
      const id = Number(flags.id);
      const toBool = (v) => (v === 'true' ? true : v === 'false' ? false : undefined);
      const full = toBool(String(flags.full));
      const referer = toBool(String(flags.referer));
      if (!id || full === undefined || referer === undefined) {
        console.error('用法：x6o4 feeds config --id N --full true|false --referer true|false [--referer-url 网址]');
        process.exitCode = 1;
        return;
      }
      const body = { full, referer };
      if (flags['referer-url'] !== undefined && flags['referer-url'] !== true) {
        body.referer_url = String(flags['referer-url']);
      }
      await client.putReadingConfig(id, body);
      console.log(`✔ 已保存订阅源 ${id} 的阅读设置（拉取原文：${full ? '开' : '关'}；解除图片防盗链：${referer ? '开' : '关'}${body.referer_url ? `；来源网址 ${body.referer_url}` : ''}）`);
      return;
    }
    const { feeds, categories } = await client.feeds();
    console.log(`订阅源 ${feeds.length} 个 / 分类 ${categories.length} 个：`);
    for (const f of feeds) {
      const cat = f.category ? `[${f.category.title}]` : '[]';
      const marks = [];
      if (f.reading_config && f.reading_config.full) marks.push('全文');
      if (f.reading_config && f.reading_config.referer) marks.push('防盗链');
      console.log(`  ${f.id}\t${cat}\t未读 ${f.unread}\t${f.title}${marks.length ? `  [${marks.join(' ')}]` : ''}`);
    }
    return;
  }

  if (cmd === 'entries') {
    const { cfg, client } = api();
    // --sync：增量模式。只取编号比本机游标大的文章，按编号升序（到达顺序），
    // 与阅读 App 的增量同步同一套机制；游标仅在 --out 成功写入后推进——
    // 中途中断的运行不推进，文章下次还会取到，不会悄悄漏掉。
    const useSync = !!flags.sync;
    if (useSync && (flags.order || flags.direction)) {
      console.error('✘ --sync 自带按编号升序，请去掉 --order/--direction（两者不能同用）');
      process.exitCode = 1;
      return;
    }
    const cursor = useSync ? config.readCursor(config.SYNC_STATE_PATH) : 0;
    const params = {
      status: flags.status, starred: flags.starred ? 'true' : '',
      feed_id: flags['feed-id'], category_id: flags['category-id'],
      order: useSync ? 'id' : flags.order,
      direction: useSync ? 'asc' : flags.direction,
      after_entry_id: useSync && cursor > 0 ? cursor : undefined,
      limit: flags.limit || 50, offset: flags.offset,
      content: flags.content || 'full',
    };
    const minRT = Number(flags['min-reading-time']) || 0;
    const excerptLen = Number(flags.excerpt) || 160;
    const skip = flags['no-skip-state'] ? {} : loadSkipState();
    const applyFilters = (list) => {
      let r = list;
      if (Object.keys(skip).length) r = r.filter((e) => !skip[e.id]);
      if (minRT > 0) r = r.filter((e) => (e.reading_time || 0) >= minRT);
      return r;
    };
    // --fill N：逐页拉取（服务端每页上限 100），跳过记录与时长过滤在客户端
    // 生效，凑够 N 条可推候选即停——避免大量短文占住窗口导致永远取不到后面
    // 的长文。最多翻 50 页作为保护上限。
    const fill = Number(flags.fill) || 0;
    let res;
    let rawAll = [];
    let entries;
    if (fill > 0) {
      let offset = Number(flags.offset) || 0;
      for (let page = 0; page < 50; page++) {
        res = await client.entries({ ...params, limit: 100, offset });
        const batch = res.entries || [];
        rawAll.push(...batch);
        entries = applyFilters(rawAll);
        if (entries.length >= fill || batch.length < 100) break;
        offset += batch.length;
      }
      rawAll = dedupEntries(rawAll);
      entries = applyFilters(rawAll).slice(0, fill);
    } else {
      res = await client.entries(params);
      rawAll = res.entries || [];
      entries = applyFilters(rawAll);
    }
    const total = res.total;
    const beforeSkip = rawAll.length;
    const out = flags.out;
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ total, entries: rawAll }, null, 2));
      if (useSync && rawAll.length) {
        config.writeCursor(config.SYNC_STATE_PATH, Math.max(...rawAll.map((e) => Number(e.id) || 0)));
      }
    } else if (useSync) {
      console.error('⚠ 未指定 --out，游标未推进（下次仍从同一位置取）');
    }
    if (flags.print) {
      const view = entries.map((e) => ({
        id: e.id, title: e.title, url: e.url, author: e.author,
        published_at: e.published_at, reading_time: e.reading_time, starred: e.starred,
        feed: e.feed ? e.feed.title : '',
        excerpt: excerptOf(e.content, excerptLen),
      }));
      const skippedByState = beforeSkip - rawAll.filter((e) => !skip[e.id]).length;
      const syncInfo = useSync ? { sync_cursor_before: cursor } : {};
      console.log(JSON.stringify({ total, fetched: rawAll.length, filtered: entries.length, skipped_by_state: skippedByState, ...syncInfo, entries: view }, null, 2));
      return;
    }
    console.log(`共 ${total} 条；本次取 ${rawAll.length} 条` +
      `${minRT ? `（时长≥${minRT}分钟后 ${entries.length} 条）` : ''}` +
      `${Object.keys(skip).length ? `、跳过记录排除 ${beforeSkip - entries.length - (minRT ? rawAll.filter((e) => (e.reading_time || 0) >= minRT).length - entries.length : 0)} 条` : ''}` +
      (useSync ? `；增量游标 ${cursor} → ${config.readCursor(config.SYNC_STATE_PATH)}` : '') +
      (out ? `；全文已写入 ${out}` : '（未指定 --out，正文未保存）'));
    return;
  }

  if (cmd === 'sync') {
    const sub = positional[0] || 'status';
    if (sub === 'reset') {
      config.writeCursor(config.SYNC_STATE_PATH, 0);
      console.log('✔ 增量游标已清零，下次拉取将从最早的未读重新开始');
      return;
    }
    if (sub !== 'status') { console.error('用法：x6o4 sync status|reset'); process.exitCode = 1; return; }
    const c = config.readCursor(config.SYNC_STATE_PATH);
    console.log(c > 0
      ? `增量游标：${c}（只取编号比它大的未读文章；x6o4 sync reset 可清零重来）`
      : '增量游标：未启用（还没有用 --sync 拉取过）');
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
    const ftStats = await enrichEntries(picked, await readingConfigMap(client));
    const results = await buildEpub(picked, { title: flags.title, out: flags.out, cfg });
    for (const r of results) {
      console.log(`✔ ${r.title}：${r.count} 篇 / ${r.images} 图 → ${r.file}`);
    }
    const ftLine = fulltextLine(ftStats);
    if (ftLine) console.log(ftLine);
    return;
  }

  if (cmd === 'send-kindle') {
    const { cfg } = api();
    if (!flags.file) { console.error('用法：x6o4 send-kindle --file a.epub[,b.epub] [--subject 书名]'); process.exitCode = 1; return; }
    const files = String(flags.file).split(',').map((s) => s.trim()).filter(Boolean);
    const r = await sendKindle(files, cfg, { subject: flags.subject });
    console.log(`✔ 已发送 ${r.emails} 封邮件（附件 ${r.attachments.length} 个）到 ${cfg.kindle_email}`);
    for (const w of r.warnings || []) console.log(`⚠ ${w}（不影响本次推送）`);
    return;
  }

  if (cmd === 'export-md') {
    const { cfg, client } = api();
    if (!flags.from) { console.error('用法：x6o4 export-md --from entries.json [--since 2026-01-01]'); process.exitCode = 1; return; }
    const data = JSON.parse(fs.readFileSync(flags.from, 'utf8'));
    const hook = enrichHook(await readingConfigMap(client));
    const r = await exportMd(data.entries || [], cfg, { since: flags.since, enrich: hook.enrich });
    console.log(`✔ 新增 ${r.added.length} 篇，跳过 ${r.skipped.length} 篇（已导入/范围外）${r.failed.length ? `，失败 ${r.failed.length} 篇` : ''}`);
    for (const a of r.added) console.log(`  + ${a.file} ← ${a.title}`);
    for (const f of r.failed) console.log(`  ✘ ${f.title}：${f.reason}`);
    const ftLine = fulltextLine(hook.stats);
    if (ftLine) console.log(ftLine);
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
  x6o4 feeds                     订阅源与分类（含未读数；[全文]/[防盗链] 为已设置的阅读配置）
  x6o4 feeds config --id N --full true|false --referer true|false [--referer-url 网址]
                                 保存单源阅读设置到服务端（App 与网页面板共用；需读写令牌）
  x6o4 entries [--status unread|read] [--starred] [--feed-id N] [--category-id N]
              [--limit N] [--offset N] [--order ...] [--direction ...] [--content full|none]
              [--min-reading-time N] [--fill N] [--sync] [--excerpt N] [--no-skip-state] [--print] --out 文件
  x6o4 sync status|reset          增量拉取游标查看/清零（清零后从未读最早重新开始）
  x6o4 mark-read --ids 9001,9002
  x6o4 build-epub --ids 9001,9002 --from entries.json [--title 书名] [--out 文件]
  x6o4 send-kindle --file a.epub[,b.epub] [--subject 书名]
  x6o4 export-md --from entries.json [--since 2026-01-01]
  x6o4 skip add --ids ... [--days 30] | list | clear
  x6o4 skills install           把三个 AI 技能链接到 ~/.agents/skills（各助手通用）
  x6o4 config path|check`);
}

main().catch(fail);
