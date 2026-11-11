#!/usr/bin/env node
// x6o4 命令行入口：login / logout / status / tokens / feeds / entries /
// mark-read / build-epub / send-kindle / export-md / skip / config。
// 输出纪律：正文永不进终端（entries 默认写文件只打印摘要；--print 只输出元数据
// 与摘要）；令牌与授权码永不回显（status 只显示令牌前缀）。
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { Api, ApiError } = require('./api');
const { runLogin, runLogout, printTokenTable } = require('./login');
const { buildEpub } = require('./epub');
const { sendKindle } = require('./send');
const { installSkills } = require('./skills');
const { exportMd } = require('./md');
const { enrichEntries, newStats, fulltextLine } = require('./fulltext');
const { parseLangFlag, resolveLang } = require('./i18n');
// 界面文案与界面语言（终端输出语言）：入口处判定一次并 setUiLang，此后所有
// 输出经 ui() 取当前语言表；被测试直接导入纯函数时缺省中文。
const { setUiLang, ui, uiLangOf } = require('./uitext');

const SKIP_TTL_DAYS = 30;
const MB = 1024 * 1024;

// --from/--file/--ids 这类逗号列表参数允许重复传入并合并为同一个逗号分隔值。
// Git Bash 会把单个路径参数自动转换成 Windows 路径，但是逗号分隔的整串不在
// 转换范围内；重复传参让每个路径单独经过转换，工具因此不会收到未转换的路径。
const LIST_FLAGS = new Set(['from', 'file', 'ids']);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else if (LIST_FLAGS.has(key) && typeof flags[key] === 'string') { flags[key] += `,${next}`; i++; }
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
    console.error(ui().cfgNotReady(chk.base_url_invalid || ui().cfgMissingToken));
    console.error(ui().cfgLoginHint);
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

// 生成物文案语言（zh/en）：命令行 --lang 优先，其次配置 epub.language，都没有
// 指定时按系统区域设置判断（规则见 i18n.js）。配置值无法识别时提醒一行
// （走 stderr，不混进正常输出），然后按系统环境继续，不中断命令。
function langOf(flags, cfg) {
  const { lang, cfgInvalid } = resolveLang({
    flag: parseLangFlag(flags.lang),
    cfgValue: (cfg.epub || {}).language,
  });
  if (cfgInvalid) {
    console.error(ui().langCfgInvalid(cfgInvalid, lang));
  }
  return lang;
}

// 铸造「收藏文章」链接并挂到条目（v1.23）：链接由网关铸造（内含签名令牌，
// 不含个人访问令牌），条目挂上 save_url 后 epub 页脚才会出现收藏行。
// 超过单次上限 500 条按 500 分批。铸造失败（只读令牌 403、网关版本过旧 404、
// 网络异常等）不阻断出书——stderr 提示一行后继续，epub 只是少了收藏行。
async function applySaveLinks(entries, client) {
  const byId = new Map();
  try {
    for (let i = 0; i < entries.length; i += 500) {
      const r = await client.saveLinks(entries.slice(i, i + 500).map((e) => e.id));
      for (const l of r.links || []) byId.set(l.entry_id, l.url);
    }
  } catch (err) {
    console.error(ui().saveLinksFail(err && err.friendly ? err.friendly : err.message || err));
    return;
  }
  for (const e of entries) {
    const u = byId.get(e.id);
    if (u) e.save_url = u;
  }
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

// --sync 配合筛选参数时的游标键：如 category:5、feed:12、category:5|feed:12。
function syncFilterKey(flags) {
  const parts = [];
  if (flags['category-id']) parts.push(`category:${flags['category-id']}`);
  if (flags['feed-id']) parts.push(`feed:${flags['feed-id']}`);
  return parts.join('|');
}

// 筛选拉取的候选池下界提示：筛选游标低于全局游标时，起点按全局游标算，
// 编号不大于全局游标的未读（不带筛选的拉取已经越过的）不在本次候选池里。
// 这是增量机制的预期行为，但是没有提示时「共 N 条」看起来完全正常，
// 调用方无从察觉有存量被截在池外，因此单独给出一行说明。
function poolBoundNotice(filter, filterCursor, globalCursor) {
  if (!filter || filterCursor >= globalCursor) return '';
  return ui().poolBound(filter, filterCursor, globalCursor);
}

// sync reset 之前各游标的原值文案。清零不可撤销，列出原值便于事后用
// sync set 恢复不想清掉的那部分（例如只想重筛一个分类却误清了其他分类的进度）。
function cursorValuesText(state) {
  const t = ui();
  const parts = [];
  const g = Number(state.unread_cursor) || 0;
  if (g > 0) parts.push(t.cursorGlobalLabel(g));
  const filters = Object.entries(state.filter_cursors || {}).filter(([, v]) => Number(v) > 0);
  if (filters.length) parts.push(t.cursorFilterPrefix + filters.map(([k, v]) => t.cursorFilterLabel(k, v)).join(t.cursorItemJoin));
  return parts.join(t.cursorJoin);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  // 界面语言判定（--lang 参数 > 配置 ui.language > 系统区域设置）：入口处
  // 设置一次，此后全部终端输出（含帮助文本）经 ui() 取表。--lang 非法值在
  // 这里就报错，早于任何读文件与联网的动作。
  const u = uiLangOf(flags, config.load());
  setUiLang(u.lang);
  if (u.cfgInvalid) console.error(ui().uiCfgInvalid(u.cfgInvalid, u.lang));
  if (!cmd || cmd === 'help' || flags.help) return usage();

  if (cmd === 'login') {
    return runLogin({
      name: flags.name,
      scope: flags.scope === 'read' ? 'read' : 'readwrite',
      // --lang 显式给定时不问界面语言（本次运行已按参数切换）。
      skipLangPrompt: flags.lang !== undefined,
    });
  }

  if (cmd === 'logout') {
    return runLogout();
  }

  if (cmd === 'config') {
    const sub = positional[0] || 'check';
    const cfg = config.load();
    if (sub === 'path') {
      console.log(config.CONFIG_PATH);
      return;
    }
    // 界面语言的查看与设置：zh/en 写入配置 ui.language；auto 清除设置恢复
    // 跟随系统。不带值时显示当前判定结果与来源。
    if (sub === 'language') {
      const t = ui();
      const arg = String(positional[1] || '').trim().toLowerCase();
      if (!arg) {
        const r = uiLangOf(flags, cfg);
        const src = flags.lang ? t.langSrcFlag
          : (r.cfgInvalid ? t.langSrcInvalidUiCfg(r.cfgInvalid)
            : (cfg.ui && cfg.ui.language ? t.langSrcUiCfg : t.langSrcSystem));
        console.log(t.cfgShowUiLang(r.lang, src));
        return;
      }
      if (arg === 'auto') {
        const next = { ...cfg, ui: { ...(cfg.ui || {}), language: '' } };
        config.save(next);
        console.log(t.langCmdAuto);
        return;
      }
      if (arg !== 'zh' && arg !== 'en') {
        console.error(t.langCmdUsage);
        process.exitCode = 1;
        return;
      }
      config.save({ ...cfg, ui: { ...(cfg.ui || {}), language: arg } });
      console.log(t.langCmdSet(arg));
      return;
    }
    if (sub === 'show') {
      // 显示关键非敏感设置（不含令牌与授权码），供技能读取推送参数。
      const t = ui();
      console.log(t.cfgShowUnread(cfg.unread.max_articles_per_run));
      console.log(t.cfgShowMailMb((cfg.mail || {}).max_attachment_mb));
      console.log(t.cfgShowEpub(cfg.epub.max_total_mb, cfg.epub.max_articles_per_book));
      const uiR = uiLangOf(flags, cfg);
      const uiSrc = uiR.cfgInvalid ? t.langSrcInvalidUiCfg(uiR.cfgInvalid)
        : (cfg.ui && cfg.ui.language ? t.langSrcUiCfg : t.langSrcSystem);
      console.log(t.cfgShowUiLang(uiR.lang, uiSrc));
      const langR = resolveLang({ cfgValue: cfg.epub.language });
      const langSrc = langR.cfgInvalid
        ? t.langSrcInvalidTextCfg(langR.cfgInvalid)
        : (cfg.epub.language ? t.langSrcTextCfg : t.langSrcSystem);
      console.log(t.cfgShowTextLang(langR.lang, langSrc));
      console.log(t.cfgShowTransport(cfg.mail_transport, cfg.kindle_email));
      return;
    }
    const chk = config.check(cfg, { needKindle: true, needObsidian: true });
    if (chk.base_url_invalid) console.log('✘ ' + chk.base_url_invalid);
    for (const m of chk.missing) console.log(ui().cfgCheckMissing(m));
    if (chk.ok) console.log(ui().cfgCheckOk);
    else process.exitCode = 1;
    return;
  }

  if (cmd === 'status') {
    const { cfg, client } = api();
    const t = ui();
    const me = await client.me();
    console.log(t.statusAccount(me.user.email, me.user.nickname));
    console.log(t.statusEntitle(!!me.entitled, me.block_reason));
    console.log(t.statusUnread(me.unread_total));
    console.log(t.statusStarred(me.starred_total));
    console.log(t.statusToken(cfg.token.slice(0, 12)));
    return;
  }

  if (cmd === 'tokens') {
    const { client } = api();
    const sub = positional[0] || 'list';
    if (sub === 'revoke') {
      const id = Number(positional[1]);
      if (!id) { console.error(ui().tokensUsage); process.exitCode = 1; return; }
      await client.revokeToken(id);
      console.log(ui().tokensRevoked(id));
      return;
    }
    const { tokens } = await client.listTokens();
    printTokenTable(tokens);
    return;
  }

  if (cmd === 'feeds') {
    const { client } = api();
    const sub = positional[0];
    const t = ui();
    if (sub === 'config') {
      // 保存单源阅读设置（需读写档令牌；手机 App 与网页管理页共用同一份设置）
      const id = Number(flags.id);
      const toBool = (v) => (v === 'true' ? true : v === 'false' ? false : undefined);
      const full = toBool(String(flags.full));
      const referer = toBool(String(flags.referer));
      if (!id || full === undefined || referer === undefined) {
        console.error(t.feedsConfigUsage);
        process.exitCode = 1;
        return;
      }
      const body = { full, referer };
      if (flags['referer-url'] !== undefined && flags['referer-url'] !== true) {
        body.referer_url = String(flags['referer-url']);
      }
      await client.putReadingConfig(id, body);
      console.log(t.feedsConfigSaved(id, full, referer, body.referer_url));
      return;
    }
    const { feeds, categories } = await client.feeds();
    console.log(t.feedsHead(feeds.length, categories.length));
    for (const f of feeds) {
      const cat = f.category ? `[#${f.category.id} ${f.category.title}]` : '[]';
      const marks = [];
      if (f.reading_config && f.reading_config.full) marks.push(t.feedsMarkFull);
      if (f.reading_config && f.reading_config.referer) marks.push(t.feedsMarkReferer);
      console.log(`  ${f.id}\t${cat}\t${t.feedsUnread(f.unread)}\t${f.title}${marks.length ? `  [${marks.join(' ')}]` : ''}`);
    }
    return;
  }

  if (cmd === 'entries') {
    const { cfg, client } = api();
    // --sync：增量模式。只取编号比本机游标大的文章，按编号升序（到达顺序），
    // 与阅读 App 的增量同步同一套机制；游标仅在 --out 成功写入后推进——
    // 中途中断的运行不推进，文章下次还会取到，不会悄悄漏掉。
    // 带分类/订阅源筛选时游标单独记：筛选结果只是全部未读的一部分，若推进
    // 全局游标，会越过其他分类里还没取过的未读，下次全量拉取就漏掉它们。
    // 因此筛选拉取从「全局游标与该筛选自己游标的较大者」继续，结束时只
    // 推进该筛选的游标；全局游标只由不带筛选的拉取推进。
    const useSync = !!flags.sync;
    if (useSync && (flags.order || flags.direction)) {
      console.error(ui().entriesSyncOrder);
      process.exitCode = 1;
      return;
    }
    const syncFilter = useSync ? syncFilterKey(flags) : '';
    const globalCursor = useSync ? config.readCursor(config.SYNC_STATE_PATH) : 0;
    const filterCursor = syncFilter ? config.readFilterCursor(config.SYNC_STATE_PATH, syncFilter) : 0;
    const cursor = Math.max(globalCursor, filterCursor);
    const boundNotice = poolBoundNotice(syncFilter, filterCursor, globalCursor);
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
    // considered：本次纳入处理的条目范围（--out 与游标推进都以它为准）。
    // --fill 模式下进度截止到最后一条候选在 rawAll 里的位置：候选之后的
    // 同页数据不算已处理，下次运行会重新取到，不会未经筛选就被游标跳过；
    // 候选为 0 时，取到的整批都被筛选条件排除，视为已处理。
    // exhausted：--fill 模式下最后一页不足 100 条 = 未读池已取尽，供凑篇
    // 循环判断"还有没有下一批可拉"。
    let considered;
    let exhausted = false;
    if (fill > 0) {
      let offset = Number(flags.offset) || 0;
      for (let page = 0; page < 50; page++) {
        res = await client.entries({ ...params, limit: 100, offset });
        const batch = res.entries || [];
        rawAll.push(...batch);
        entries = applyFilters(rawAll);
        if (batch.length < 100) { exhausted = true; break; }
        if (entries.length >= fill) break;
        offset += batch.length;
      }
      rawAll = dedupEntries(rawAll);
      entries = applyFilters(rawAll).slice(0, fill);
      const lastPos = entries.length ? rawAll.findIndex((e) => e.id === entries[entries.length - 1].id) : -1;
      considered = lastPos >= 0 ? rawAll.slice(0, lastPos + 1) : rawAll;
    } else {
      res = await client.entries(params);
      rawAll = res.entries || [];
      entries = applyFilters(rawAll);
      considered = rawAll;
    }
    const total = res.total;
    const beforeSkip = considered.length;
    const out = flags.out;
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ total, entries: considered }, null, 2));
      if (useSync && considered.length) {
        const maxId = Math.max(...considered.map((e) => Number(e.id) || 0));
        if (syncFilter) config.writeFilterCursor(config.SYNC_STATE_PATH, syncFilter, maxId);
        else config.writeCursor(config.SYNC_STATE_PATH, maxId);
      }
    } else if (useSync) {
      console.error(ui().entriesNoOut);
    }
    if (flags.print) {
      const view = entries.map((e) => ({
        id: e.id, title: e.title, url: e.url, author: e.author,
        published_at: e.published_at, reading_time: e.reading_time, starred: e.starred,
        feed: e.feed ? { id: e.feed.id, title: e.feed.title } : null,
        excerpt: excerptOf(e.content, excerptLen),
      }));
      const skippedByState = beforeSkip - considered.filter((e) => !skip[e.id]).length;
      const syncInfo = useSync ? { sync_cursor_before: cursor, sync_scope: syncFilter || 'all' } : {};
      const boundInfo = boundNotice ? { pool_bound_warning: boundNotice } : {};
      const fillInfo = fill > 0 ? { exhausted } : {};
      console.log(JSON.stringify({ total, fetched: considered.length, filtered: entries.length, skipped_by_state: skippedByState, ...syncInfo, ...boundInfo, ...fillInfo, entries: view }, null, 2));
      return;
    }
    const cursorAfter = useSync
      ? (syncFilter ? config.readFilterCursor(config.SYNC_STATE_PATH, syncFilter) : config.readCursor(config.SYNC_STATE_PATH))
      : 0;
    if (boundNotice) console.log(`⚠ ${boundNotice}`);
    // 汇总行由界面语言表拼装：各段是否出现由这里的条件算好传入（跳过记录
    // 排除数的口径依赖 minRT 是否生效，保持与历史行为一致）。
    const skippedByState = Object.keys(skip).length
      ? beforeSkip - entries.length - (minRT ? considered.filter((e) => (e.reading_time || 0) >= minRT).length - entries.length : 0)
      : null;
    console.log(ui().entriesSummary({
      total, fetched: considered.length, filtered: entries.length, minRT,
      skippedByState,
      exhausted: fill > 0 && exhausted,
      syncFilter: useSync && syncFilter ? syncFilter : null,
      sync: useSync ? 1 : null,
      cursorBefore: useSync && syncFilter ? filterCursor : cursor,
      cursorAfter, globalCursor,
      out: out || '',
    }));
    return;
  }

  if (cmd === 'sync') {
    const sub = positional[0] || 'status';
    const filter = syncFilterKey(flags);
    const t = ui();
    if (sub === 'reset') {
      // 不带筛选参数清零全部游标；带 --category-id/--feed-id 只清那一个筛选的。
      // 清零前先读出原值一并输出：清零不可撤销，原值是事后用 sync set 恢复的依据。
      const state = config.readJson(config.SYNC_STATE_PATH, {});
      const globalBefore = Number(state.unread_cursor) || 0;
      config.clearCursors(config.SYNC_STATE_PATH, filter || undefined);
      if (filter) {
        const filterBefore = Number((state.filter_cursors || {})[filter]) || 0;
        // 筛选拉取的起点是全局游标与该筛选游标中较大者，因此全局游标仍在时，
        // 只清筛选游标并不会回到最早的未读。
        console.log(t.syncResetFilter(filter, filterBefore, globalBefore));
      } else {
        console.log(t.syncResetAll(cursorValuesText(state)));
      }
      return;
    }
    if (sub === 'set') {
      // 把游标摆到指定位置：未读技能在电子书生成成功后用它回拨到「实际
      // 入选末篇」——没进书（配额外/体积外/没轮到评估）的条目落在游标
      // 之后，下次 --sync 拉取自动再取。带筛选参数写该筛选自己的游标，
      // 键换算与 entries 筛选拉取一致。
      const id = Number(positional[1]);
      if (!Number.isInteger(id) || id <= 0) {
        console.error(t.syncSetUsage);
        process.exitCode = 1;
        return;
      }
      if (filter) config.writeFilterCursor(config.SYNC_STATE_PATH, filter, id);
      else config.writeCursor(config.SYNC_STATE_PATH, id);
      console.log(filter ? t.syncSetFilterDone(filter, id) : t.syncSetDone(id));
      return;
    }
    if (sub !== 'status') { console.error(t.syncUsage); process.exitCode = 1; return; }
    const c = config.readCursor(config.SYNC_STATE_PATH);
    const filters = Object.entries(config.readJson(config.SYNC_STATE_PATH, {}).filter_cursors || {});
    if (c === 0 && filters.length === 0) {
      console.log(t.syncStatusNone);
      return;
    }
    if (c > 0) console.log(t.syncStatusGlobal(c));
    for (const [k, v] of filters) console.log(t.syncStatusFilter(k, v));
    console.log(t.syncStatusHint);
    return;
  }

  if (cmd === 'mark-read') {
    const { client } = api();
    if (!flags.ids) { console.error(ui().markReadUsage); process.exitCode = 1; return; }
    const ids = String(flags.ids).split(',').map((s) => Number(s.trim())).filter(Boolean).slice(0, 500);
    const r = await client.markRead(ids);
    console.log(ui().markReadDone(r.updated));
    return;
  }

  if (cmd === 'build-epub') {
    const { cfg, client } = api();
    const t = ui();
    if (!flags.ids || !flags.from) { console.error(t.buildUsage); process.exitCode = 1; return; }
    const lang = langOf(flags, cfg);
    const want = String(flags.ids).split(',').map((s) => Number(s.trim())).filter(Boolean);
    // --from 支持逗号分隔多文件：凑篇循环每批一个文件，这里合并成条目池
    // （重复 id 先到先得——正常批次之间天然不重复）。
    const byId = new Map();
    for (const f of String(flags.from).split(',').map((s) => s.trim()).filter(Boolean)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const e of data.entries || []) {
        if (!byId.has(e.id)) byId.set(e.id, e);
      }
    }
    const picked = [];
    const missing = [];
    for (const id of want) {
      if (byId.has(id)) picked.push(byId.get(id));
      else missing.push(id);
    }
    if (missing.length) {
      console.error(t.buildMissingIds(missing.join(', ')));
      process.exitCode = 1;
      return;
    }
    // --max-mail-mb：整封邮件附件体积上限（MB），0/负/不传 = 不限制；
    // 缺省从配置读（mail.max_attachment_mb）。触顶时在篇边界截断砍尾。
    const maxMailMb = flags['max-mail-mb'] !== undefined && String(flags['max-mail-mb']) !== 'true'
      ? Number(flags['max-mail-mb'])
      : Number((cfg.mail || {}).max_attachment_mb) || 0;
    const ftStats = await enrichEntries(picked, await readingConfigMap(client));
    await applySaveLinks(picked, client);
    const { volumes, excluded, lastIncludedId } = await buildEpub(picked, {
      title: flags.title, out: flags.out, cfg, lang,
      maxMailBytes: maxMailMb > 0 ? maxMailMb * MB : 0,
    });
    for (const r of volumes) {
      // 输出绝对路径：生成位置是当前工作目录，只打印裸文件名时
      // 调用方（AI 助手/脚本）可能把文件误认为在其他目录。
      console.log(t.buildVolume(r, path.resolve(r.file)));
    }
    console.log(t.buildTextLang(lang));
    if (excluded.length) {
      console.log(t.buildExcludedHead(excluded.length));
      for (const e of excluded) console.log(t.buildExcludedItem(e));
    }
    if (lastIncludedId !== null) console.log(t.buildLastIncluded(lastIncludedId));
    const ftLine = fulltextLine(ftStats);
    if (ftLine) console.log(ftLine);
    return;
  }

  if (cmd === 'send-kindle') {
    const { cfg } = api();
    const t = ui();
    if (!flags.file) { console.error(t.sendUsage); process.exitCode = 1; return; }
    const files = String(flags.file).split(',').map((s) => s.trim()).filter(Boolean);
    const r = await sendKindle(files, cfg, { subject: flags.subject, lang: langOf(flags, cfg) });
    console.log(t.sendDone(r.emails, r.attachments.length, cfg.kindle_email));
    for (const w of r.warnings || []) console.log(t.sendWarn(w));
    return;
  }

  if (cmd === 'export-md') {
    const { cfg, client } = api();
    const t = ui();
    if (!flags.from) { console.error(t.mdUsage); process.exitCode = 1; return; }
    const data = JSON.parse(fs.readFileSync(flags.from, 'utf8'));
    const hook = enrichHook(await readingConfigMap(client));
    const r = await exportMd(data.entries || [], cfg, { since: flags.since, enrich: hook.enrich, lang: langOf(flags, cfg) });
    console.log(t.mdDone(r.added.length, r.skipped.length, r.failed.length));
    for (const a of r.added) console.log(t.mdAdded(a.file, a.title));
    for (const f of r.failed) console.log(t.mdFailed(f.title, f.reason));
    const ftLine = fulltextLine(hook.stats);
    if (ftLine) console.log(ftLine);
    return;
  }

  if (cmd === 'skills') {
    const sub = positional[0] || 'install';
    if (sub !== 'install') { console.error(ui().skillsUsage); process.exitCode = 1; return; }
    const results = installSkills();
    const labels = {
      linked: ui().skillsLinked,
      copied: ui().skillsCopied,
      skipped: ui().skillsSkipped,
      missing: ui().skillsMissing,
    };
    let bad = false;
    for (const r of results) {
      console.log(`${r.name}${ui().skillsNameSep}${labels[r.action]}`);
      if (r.action === 'missing') bad = true;
    }
    if (bad) process.exitCode = 1;
    return;
  }

  if (cmd === 'skip') {
    const sub = positional[0] || 'list';
    const t = ui();
    if (sub === 'add') {
      if (!flags.ids) { console.error(t.skipUsage); process.exitCode = 1; return; }
      const state = config.readJson(config.SKIP_STATE_PATH, {});
      for (const id of String(flags.ids).split(',')) {
        const n = Number(id.trim());
        if (n) state[n] = Date.now();
      }
      config.writeJson(config.SKIP_STATE_PATH, state);
      console.log(t.skipAddDone);
      return;
    }
    if (sub === 'clear') {
      config.writeJson(config.SKIP_STATE_PATH, {});
      console.log(t.skipClearDone);
      return;
    }
    const live = loadSkipState();
    const ids = Object.keys(live);
    console.log(ids.length ? t.skipListSome(ids.length, ids.join(', ')) : t.skipListNone);
    return;
  }

  usage();
}

function usage() {
  console.log(ui().usageBody);
}

// 作为命令运行时才执行入口；被测试引入时只导出纯函数，不触发任何命令。
if (require.main === module) main().catch(fail);

module.exports = { poolBoundNotice, cursorValuesText, applySaveLinks };
