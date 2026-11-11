// 界面文案表：终端输出的固定文字，中文（zh）与英文（en）两套。zh 表与
// 引入本文件之前的历史输出逐字相同（回归底线），en 表为新增。
// 界面语言由命令行入口按「--lang 参数 > 配置 ui.language > 系统区域设置」
// 判定一次后 setUiLang 写入；此后所有终端输出经 ui() 取当前语言表。被测试
// 直接导入而未设置语言时缺省中文，既有断言不受影响。
// 生成物（epub 内文 / 邮件正文）的语言走 i18n.js（--lang > epub.language >
// 系统检测），与界面语言两个字段互不影响：界面语言管「工具对你说话」，
// 生成物语言管「做出来的东西」。
const { parseLangFlag, resolveLang, LANG_FLAG_ERROR } = require('./i18n');

// --lang 非法值的报错文案（定义在 i18n.js，抛错发生在语言判定之前，固定双语）。
// 登录时的界面语言提问同样发生在语言确定之前，固定双语。
const LOGIN_LANG_QUESTION = '界面语言 / Interface language（1. 中文  2. English，回车/Enter = 自动 auto）：';
const LOGIN_LANG_RETRY = '无法识别，请输入 1 或 2 / Not recognized, enter 1 or 2：';

const UI_TEXT = {
  zh: {
    // ---- 通用 ----
    cfgNotReady: (detail) => `✘ 配置未就绪：${detail}`,
    cfgMissingToken: '缺少令牌',
    cfgLoginHint: '  请先运行 x6o4 login（终端交互输入邮箱密码，自动换取长期令牌）',
    langCfgInvalid: (v, lang) => `（配置 epub.language 的值「${v}」无法识别，应为 zh 或 en；本次按系统环境判断为 ${lang}）`,
    uiCfgInvalid: (v, lang) => `（配置 ui.language 的值「${v}」无法识别，应为 zh 或 en；本次按系统环境判断为 ${lang}）`,
    usageBody: `x6o4 —— RSS Cloud 技能命令行（配置与状态存 ~/.x6o4-tools/）

用法：
  x6o4 login [--name 名] [--scope read|readwrite]              终端交互登录换长期令牌（密码不回显）
  x6o4 logout                    吊销本机令牌并清除本地保存（其他电脑上的令牌不受影响）
  x6o4 status                    账号/权益/未读/收藏概览（令牌只显前缀）
  x6o4 tokens list|revoke <编号>  查看与吊销个人令牌
  x6o4 feeds                     订阅源与分类（含未读数；[全文]/[防盗链] 为已设置的阅读配置）
  x6o4 feeds config --id N --full true|false --referer true|false [--referer-url 网址]
                                 保存单源阅读设置到服务端（App 与网页面板共用；需读写令牌）
  x6o4 entries [--status unread|read] [--starred] [--feed-id N] [--category-id N]
              [--limit N] [--offset N] [--order ...] [--direction ...] [--content full|none]
              [--min-reading-time N] [--fill N] [--sync] [--excerpt N] [--no-skip-state] [--print] --out 文件
  x6o4 sync status|set <id>|reset [--category-id N | --feed-id N]
                                 增量拉取游标查看/摆位/清零（set 把游标摆到指定条目——没处理到的未读下次还会取到；
                                 reset 不带参数清零全局与全部筛选游标并列出原值，带筛选参数只清该筛选的游标）
  x6o4 mark-read --ids 9001,9002
  x6o4 build-epub --ids 9001,9002 --from a.json[,b.json] [--title 书名] [--out 文件] [--max-mail-mb N] [--lang zh|en]
                                 做成 epub（--from 可逗号分隔或重复传入多个文件；--max-mail-mb 一封邮件附件总体积上限，
                                 触顶在篇边界截断并输出未入选清单与最后入选条目 id；缺省读配置 mail.max_attachment_mb；
                                 --lang 指定书内固定文案与书名的语言，不传时读配置 epub.language，再没有就按系统环境判断）
  x6o4 send-kindle --file a.epub[,b.epub] [--subject 书名] [--lang zh|en]
                                 多册时也可重复传 --file（Git Bash 下逗号分隔的路径列表不会被自动转换）；
                                 --lang 指定邮件正文的语言，不传时的判定顺序同 build-epub
  x6o4 export-md --from entries.json [--since 2026-01-01] [--lang zh|en]
                                 收藏转 Markdown（--lang 只影响图片占位文字的语言）
  x6o4 skip add --ids ... [--days 30] | list | clear
  x6o4 skills install           把三个 AI 技能链接到 ~/.agents/skills（各助手通用）
  x6o4 config path|show|check|language [zh|en|auto]
                                 配置文件位置 / 关键设置（凑篇目标与体积上限）/ 完整性检查 / 界面语言
  任意命令都可加 --lang zh|en|auto：切换本次运行的全部终端输出语言（生成物语言判定见各命令说明）`,

    // ---- status ----
    statusAccount: (email, nickname) => `账号：${email}（${nickname || '-'}）`,
    statusEntitle: (ok, reason) => `权益：${ok ? '有效' : `无（${reason || '未知'}）`}`,
    statusUnread: (n) => `未读：${n == null ? '未知' : n} 篇`,
    statusStarred: (n) => `收藏：${n == null ? '未知' : n} 篇`,
    statusToken: (prefix) => `令牌：${prefix}…（只显示前缀）`,

    // ---- tokens ----
    tokensUsage: '用法：x6o4 tokens revoke <编号>',
    tokensRevoked: (id) => `✔ 已吊销令牌 ${id}`,

    // ---- feeds ----
    feedsConfigUsage: '用法：x6o4 feeds config --id N --full true|false --referer true|false [--referer-url 网址]',
    feedsConfigSaved: (id, full, referer, url) => `✔ 已保存订阅源 ${id} 的阅读设置（拉取原文：${full ? '开' : '关'}；解除图片防盗链：${referer ? '开' : '关'}${url ? `；来源网址 ${url}` : ''}）`,
    feedsHead: (n, m) => `订阅源 ${n} 个 / 分类 ${m} 个：`,
    feedsUnread: (n) => `未读 ${n}`,
    feedsMarkFull: '全文',
    feedsMarkReferer: '防盗链',

    // ---- entries ----
    entriesSyncOrder: '✘ --sync 自带按编号升序，请去掉 --order/--direction（两者不能同用）',
    entriesNoOut: '⚠ 未指定 --out，游标未推进（下次仍从同一位置取）',
    entriesSummary: (p) => `共 ${p.total} 条；本次取 ${p.fetched} 条`
      + (p.minRT ? `（时长≥${p.minRT}分钟后 ${p.filtered} 条）` : '')
      + (p.skippedByState != null ? `、跳过记录排除 ${p.skippedByState} 条` : '')
      + (p.exhausted ? '；未读池已取尽' : '')
      + (p.syncFilter != null
        ? `；增量游标[${p.syncFilter}] ${p.cursorBefore} → ${p.cursorAfter}（全局游标 ${p.globalCursor} 未动）`
        : (p.sync != null ? `；增量游标 ${p.cursorBefore} → ${p.cursorAfter}` : ''))
      + (p.out ? `；全文已写入 ${p.out}` : '（未指定 --out，正文未保存）'),
    poolBound: (filter, filterCursor, globalCursor) =>
      `筛选 ${filter} 的游标(${filterCursor})低于全局游标(${globalCursor})：编号 ≤ ${globalCursor} 的未读不在本次候选池`
      + '（增量机制：不带筛选的拉取已越过的条目不重复取）；要连这些存量一起重筛，先 x6o4 sync reset（会清零全部游标，含其他筛选的进度）',
    cursorGlobalLabel: (v) => `全局 ${v}`,
    cursorFilterLabel: (k, v) => `${k}=${v}`,
    cursorJoin: '；',
    cursorItemJoin: '、',
    cursorFilterPrefix: '筛选 ',

    // ---- sync ----
    syncSetUsage: '用法：x6o4 sync set <条目id，正整数> [--category-id N | --feed-id N]',
    syncUsage: '用法：x6o4 sync status|set <id>|reset [--category-id N | --feed-id N]',
    syncResetFilter: (filter, before, globalBefore) => `✔ 已清零筛选 ${filter} 的增量游标${before ? `（原值 ${before}）` : ''}，`
      + (globalBefore
        ? `下次按该筛选拉取从全局游标 ${globalBefore} 之后重新开始（要连更早的存量一起重筛，需不带参数 x6o4 sync reset）`
        : '下次按该筛选拉取将从最早的未读重新开始'),
    syncResetAll: (values) => `✔ 增量游标已全部清零（含各分类/订阅源的单独游标${values ? `；原值：${values}` : ''}），下次拉取将从最早的未读重新开始`,
    syncSetDone: (id) => `✔ 已把增量游标摆到 ${id}（比它大的未读下次还会取到）`,
    syncSetFilterDone: (filter, id) => `✔ 已把筛选 ${filter} 的增量游标摆到 ${id}（比它大的未读下次还会取到）`,
    syncStatusNone: '增量游标：未启用（还没有用 --sync 拉取过）',
    syncStatusGlobal: (c) => `增量游标（全部未读）：${c}（只取编号比它大的未读文章）`,
    syncStatusFilter: (k, v) => `增量游标（筛选 ${k}）：${v}`,
    syncStatusHint: 'x6o4 sync reset 全部清零；x6o4 sync reset --category-id N（或 --feed-id N）只清某一个；x6o4 sync set <id> 摆到指定位置',

    // ---- mark-read ----
    markReadUsage: '用法：x6o4 mark-read --ids 9001,9002',
    markReadDone: (n) => `✔ 已标记 ${n} 条为已读`,

    // ---- build-epub ----
    buildUsage: '用法：x6o4 build-epub --ids 9001,9002 --from a.json[,b.json] [--title 书名] [--out 文件] [--max-mail-mb N] [--lang zh|en]',
    buildMissingIds: (ids) => `✘ 以下条目不在 --from 文件里（请先重跑 entries 命令）：${ids}`,
    buildVolume: (r, abs) => `✔ ${r.title}：${r.count} 篇 / ${r.images} 图 / ${(r.size / 1048576).toFixed(1)}MB → ${abs}（条目 ${r.ids.join(',')}）`,
    buildTextLang: (lang) => `文案语言：${lang}`,
    buildExcludedHead: (n) => `因体积未入选 ${n} 篇（保持未读，下次自动再取）：`,
    buildExcludedItem: (e) => `  - ${e.id} ${e.title}`,
    buildLastIncluded: (id) => `最后入选条目 id：${id}`,

    // ---- send-kindle ----
    sendUsage: '用法：x6o4 send-kindle --file a.epub[,b.epub] [--subject 书名] [--lang zh|en]',
    sendDone: (n, files, to) => `✔ 已发送 ${n} 封邮件（附件 ${files} 个）到 ${to}`,
    sendWarn: (w) => `⚠ ${w}（不影响本次推送）`,
    sendNoKindle: '缺少 kindle_email（Kindle 接收邮箱）',
    sendNoSmtp: '缺少 SMTP 配置（host/user/pass）',
    sendNoFiles: '未指定要发送的文件',
    sendAttachMissing: (abs) => `附件文件不存在：${abs}。build-epub 未指定 --out 时把文件生成在运行命令的目录（当前工作目录），不是 /tmp；请用 build-epub 完成行「→」后面的完整路径原样传给 --file，不要自己拼路径或用通配符`,
    sendZipTooBig: (mb) => `分册打包 zip 后仍为 ${mb}MB，超过亚马逊每封邮件 50MB 上限；`
      + '请减少单次篇数（调低 unread.max_articles_per_run 或 epub.max_articles_per_book）后重试，'
      + '或改用亚马逊 Send to Kindle 网页版手动上传（支持单个文档最大 200MB）',
    sendAttachTooBig: '单个附件超过 50MB（亚马逊个人文档邮件上限），请减少单册篇数后重试',
    sendAgentlyNoCli: '未找到 agently-cli 命令，请先安装：npm install -g @tencent-qqmail/agently-cli',
    sendAgentlyNoAuth: 'agently-cli 尚未登录或登录已过期，请先在终端运行 agently-cli auth login',
    sendAgentlyVerified: (log) => `发送命令异常（${log}），但已在「已发送」列表确认邮件实际发出，按成功处理；未重发，避免重复推送`,
    sendAgentlyListErr: (err) => `无法核对「已发送」列表（${err}）；重发前请先在邮箱的「已发送」里确认没有这封邮件，以免重复推送`,
    sendAgentlyChecked: '已核对「已发送」列表未发现这封邮件，可以安全重试',
    sendAgentlyPreSubmit: '这类失败发生在邮件提交之前，不会产生已发出的邮件',
    sendAgentlyFail: (log, checked, hint) => `agently-cli 发送失败（${log}）。${checked}。${hint}`
      + '人工兜底：亚马逊 Send to Kindle 网页版上传（单个文档最大 200MB）或数据线拷贝，epub 文件已在本地',
    sendSmtpFail: (msg) => `发送失败（${msg}）。常见原因：SMTP 授权码失效、发件地址未加入亚马逊认可列表。`
      + '人工兜底：亚马逊 Send to Kindle 网页版上传（单个文档最大 200MB）或数据线拷贝，epub 文件已在本地',
    sendDeleteListErr: (err) => `查询「已发送」列表失败（${err}），这封邮件的副本未清理`,
    sendDeleteNotFound: (subject) => `「已发送」里没找到主题为「${subject}」的邮件，副本未清理`,

    // ---- export-md ----
    mdUsage: '用法：x6o4 export-md --from entries.json [--since 2026-01-01] [--lang zh|en]',
    mdDone: (a, s, f) => `✔ 新增 ${a} 篇，跳过 ${s} 篇（已导入/范围外）${f ? `，失败 ${f} 篇` : ''}`,
    mdAdded: (file, title) => `  + ${file} ← ${title}`,
    mdFailed: (title, reason) => `  ✘ ${title}：${reason}`,
    mdNoVault: '缺少 obsidian.vault_dir（笔记库目录）',

    // ---- 全文拉取统计行 ----
    ftNoNeed: 'ℹ 全文拉取：无需拉取（正文均已完整）',
    ftLine: (configured, heuristic, failed) => `ℹ 全文拉取：配置成功 ${configured} 篇 / 启发式成功 ${heuristic} 篇 / 失败保留原文 ${failed} 篇`,
    ftFailedTitles: (shown, more) => `（${shown}${more ? ' 等' : ''}）`,
    ftPersistable: (shown, more) => `；可保存拉取原文设置的源：${shown}${more ? ' 等' : ''}`,
    ftItemJoin: '、',
    ftPersistableItem: (id, title) => `${id}（${title}）`,
    ftFeedFallback: (id) => `源 ${id}`,
    ftEntryFallback: (id) => `条目 ${id}`,

    // ---- skills ----
    skillsUsage: '用法：x6o4 skills install',
    skillsNameSep: '：',
    skillsLinked: '✔ 已链接（随 npm 包自动更新）',
    skillsCopied: '✔ 已复制（链接创建失败时的兜底，不随 npm 自动更新）',
    skillsSkipped: '↷ 跳过（该目录已存在且不是本工具的链接，未改动）',
    skillsMissing: '✘ 安装包里找不到该技能',

    // ---- skip ----
    skipUsage: '用法：x6o4 skip add --ids 9001,9002 [--days 30]',
    skipAddDone: '✔ 已记入本地跳过记录（默认 30 天后过期重新纳入筛选）',
    skipClearDone: '✔ 已清空跳过记录',
    skipListSome: (n, ids) => `跳过记录 ${n} 条：${ids}`,
    skipListNone: '跳过记录为空',

    // ---- config ----
    cfgShowUnread: (n) => `未读推送：凑篇目标 ${n} 篇/次（配置 unread.max_articles_per_run）`,
    cfgShowMailMb: (n) => `邮件附件体积上限：${n} MB（配置 mail.max_attachment_mb）`,
    cfgShowEpub: (total, articles) => `电子书：单册图片预算 ${total} MB、单册篇数上限 ${articles}`,
    cfgShowUiLang: (lang, src) => `界面语言：${lang}（${src}；所有命令可用 --lang zh|en 临时切换）`,
    cfgShowTextLang: (lang, src) => `文案语言：${lang}（${src}；生成与发送命令可用 --lang zh|en 临时指定）`,
    cfgShowTransport: (transport, kindle) => `发信方式：${transport}${kindle ? `；Kindle 接收：${kindle}` : ''}`,
    langSrcFlag: '命令行 --lang',
    langSrcUiCfg: '配置 ui.language',
    langSrcTextCfg: '配置 epub.language',
    langSrcSystem: '按系统环境自动判断',
    langSrcInvalidTextCfg: (v) => `配置 epub.language 的值「${v}」无法识别，已按系统环境判断`,
    langSrcInvalidUiCfg: (v) => `配置 ui.language 的值「${v}」无法识别，已按系统环境判断`,
    cfgCheckMissing: (m) => `✘ 缺少 ${m}`,
    cfgCheckOk: '✔ 配置完整（含 Kindle 与笔记库字段）',
    langCmdUsage: '用法：x6o4 config language [zh|en|auto]（不带值显示当前；auto = 恢复跟随系统）',
    langCmdSet: (lang) => `✔ 界面语言已设为 ${lang}（已写入 config.json）`,
    langCmdAuto: '✔ 界面语言已恢复自动（按系统区域设置判断，已清除配置）',
    chkBaseUrlHttp: '服务地址为 http 且非本机回环，必须使用 https',
    chkBaseUrlInvalid: '服务地址格式无效',
    chkToken: 'token（先运行 x6o4 login）',
    chkKindle: 'kindle_email（Kindle 接收邮箱）',
    chkSmtp: 'smtp（host/user/pass，常见邮箱可用 --preset 一键填）',
    chkObsidian: 'obsidian.vault_dir（笔记库目录）',

    // ---- 登录与退出 ----
    loginEmail: '邮箱：',
    loginPassword: '密码（输入不回显）：',
    loginFail: (msg) => `✘ 登录失败：${msg}`,
    loginTokenLimit: '个人令牌数量已达上限。',
    loginTokenHead: '当前令牌（未吊销）：',
    loginTokenColumns: '  编号  名称                权限        创建时间            最近使用',
    loginNeverUsed: '从未使用',
    loginRevokePrompt: '输入要吊销的令牌编号（回车放弃登录）：',
    loginAborted: '✘ 已放弃：未吊销任何令牌。',
    loginListRevokeFail: (msg) => `✘ 列出/吊销令牌失败：${msg}`,
    loginCreateFail: (msg) => `✘ 创建令牌失败：${msg}`,
    loginAuthorized: (email) => `✔ 已授权：${email}`,
    loginTokenSaved: (name, scope, p) => `✔ 令牌「${name}」（${scope}）已保存到 ${p}`,
    loginNextHint: '现在可以对 AI 说：把未读文章推到 Kindle / 把我的收藏转成 Markdown',
    loginVerifyFail: (msg) => `✘ 令牌自校验失败（配置已保存，可重试 x6o4 status）：${msg}`,
    logoutNoToken: '本机没有保存 RSS Cloud 令牌，无需退出。',
    logoutDone: (name) => `✔ 已退出：令牌「${name}」已在服务端吊销，本机保存的令牌也已清除。`,
    logoutOtherNote: '其他电脑上的令牌不受影响；要全部吊销，可运行 x6o4 tokens list 逐个吊销，或修改 RSS Cloud 密码（会立即吊销全部令牌）。',
    logoutClearedNoMatch: '✔ 本机保存的令牌已清除（服务端列表里没有匹配的令牌，可能早已吊销）。',
    logoutClearedInvalid: '✔ 服务端已不认这个令牌（可能已被吊销），本机保存已清除。',
    logoutFail: (msg) => `✘ 退出失败：${msg}`,
    saveLinksFail: (msg) => `（收藏链接未添加：${msg}）`,

    // ---- 服务端错误码的友好指引（api.js）----
    apiTokenInvalid: '令牌无效或已吊销（修改过密码、重置过密码、账号被封都会联动吊销），请在终端重新运行 x6o4 login',
    apiScopeDenied: '当前令牌为只读权限，无法执行写操作（标记已读、保存订阅源阅读设置）；请重新运行 x6o4 login --scope readwrite',
    apiFeedNotFound: '订阅源编号不存在；先用 x6o4 feeds 查看你的订阅源编号',
    apiAgentDisabled: '服务端已停用技能数据接口（AGENT_API_ENABLED=false），请联系网关管理员',
    apiRateLimited: '请求过于频繁，请等待约一分钟再试',
    apiUpstream: 'RSS 上游暂时不可用或账号开通中，请稍后重试；若刚刚按编号过滤（feed/category），请先运行 x6o4 feeds 核对编号是否存在——不存在的编号同样会报这个错',
    apiEntitle: (msg) => `RSS Cloud 权益不足（${msg}），续订或领取试用后即可使用`,
  },

  en: {
    // ---- common ----
    cfgNotReady: (detail) => `✘ Configuration not ready: ${detail}`,
    cfgMissingToken: 'missing token',
    cfgLoginHint: '  Please run x6o4 login first (interactive email + password in the terminal; it exchanges them for a long-term token)',
    langCfgInvalid: (v, lang) => `(Config value epub.language "${v}" is not recognized; expected zh or en. Falling back to system locale: ${lang})`,
    uiCfgInvalid: (v, lang) => `(Config value ui.language "${v}" is not recognized; expected zh or en. Falling back to system locale: ${lang})`,
    usageBody: `x6o4 — RSS Cloud command-line tool (config and state live in ~/.x6o4-tools/)

Usage:
  x6o4 login [--name NAME] [--scope read|readwrite]              Interactive login in the terminal for a long-term token (password hidden)
  x6o4 logout                    Revoke this machine's token and clear the local copy (tokens on other computers are unaffected)
  x6o4 status                    Account / entitlement / unread / starred overview (token prefix only)
  x6o4 tokens list|revoke <id>   View and revoke personal tokens
  x6o4 feeds                     Feeds and categories (with unread counts; [fulltext]/[hotlink] marks configured reading settings)
  x6o4 feeds config --id N --full true|false --referer true|false [--referer-url URL]
                                 Save per-feed reading settings to the server (shared with the app and web console; needs a read-write token)
  x6o4 entries [--status unread|read] [--starred] [--feed-id N] [--category-id N]
              [--limit N] [--offset N] [--order ...] [--direction ...] [--content full|none]
              [--min-reading-time N] [--fill N] [--sync] [--excerpt N] [--no-skip-state] [--print] --out FILE
  x6o4 sync status|set <id>|reset [--category-id N | --feed-id N]
                                 View / move / clear the incremental-fetch cursor (set moves it to a given entry — unread entries
                                 above it are fetched again; reset without arguments clears the global and all filter cursors and
                                 lists their previous values, with a filter argument clears only that filter's cursor)
  x6o4 mark-read --ids 9001,9002
  x6o4 build-epub --ids 9001,9002 --from a.json[,b.json] [--title TITLE] [--out FILE] [--max-mail-mb N] [--lang zh|en]
                                 Build an epub (--from accepts comma-separated or repeated files; --max-mail-mb is the size cap
                                 per email, truncating at an article boundary and listing left-out entries plus the last included
                                 id; default from setting mail.max_attachment_mb; --lang sets the language of fixed texts and the
                                 book title, falling back to setting epub.language, then to the system locale)
  x6o4 send-kindle --file a.epub[,b.epub] [--subject TITLE] [--lang zh|en]
                                 With multiple books --file can be repeated (Git Bash does not auto-convert comma-separated
                                 path lists); --lang sets the mail body language, resolved the same way as build-epub
  x6o4 export-md --from entries.json [--since 2026-01-01] [--lang zh|en]
                                 Starred entries to Markdown (--lang only affects the image placeholder text)
  x6o4 skip add --ids ... [--days 30] | list | clear
  x6o4 skills install           Link the three AI skills into ~/.agents/skills (shared across assistants)
  x6o4 config path|show|check|language [zh|en|auto]
                                 Config file path / key settings (fill target and size cap) / completeness check / interface language
  Any command accepts --lang zh|en|auto: switches the language of all terminal output for that run (generated-content language per command above)`,

    // ---- status ----
    statusAccount: (email, nickname) => `Account: ${email} (${nickname || '-'})`,
    statusEntitle: (ok, reason) => `Entitlement: ${ok ? 'active' : `none (${reason || 'unknown'})`}`,
    statusUnread: (n) => `Unread: ${n == null ? 'unknown' : n}`,
    statusStarred: (n) => `Starred: ${n == null ? 'unknown' : n}`,
    statusToken: (prefix) => `Token: ${prefix}… (prefix only)`,

    // ---- tokens ----
    tokensUsage: 'Usage: x6o4 tokens revoke <id>',
    tokensRevoked: (id) => `✔ Token ${id} revoked`,

    // ---- feeds ----
    feedsConfigUsage: 'Usage: x6o4 feeds config --id N --full true|false --referer true|false [--referer-url URL]',
    feedsConfigSaved: (id, full, referer, url) => `✔ Saved reading settings for feed ${id} (fetch full text: ${full ? 'on' : 'off'}; bypass image hotlink protection: ${referer ? 'on' : 'off'}${url ? `; referer URL ${url}` : ''})`,
    feedsHead: (n, m) => `${n} feeds / ${m} categories:`,
    feedsUnread: (n) => `unread ${n}`,
    feedsMarkFull: 'fulltext',
    feedsMarkReferer: 'hotlink',

    // ---- entries ----
    entriesSyncOrder: '✘ --sync always sorts by entry id ascending; remove --order/--direction (they cannot be combined)',
    entriesNoOut: '⚠ No --out given, the cursor was not advanced (next run fetches from the same position)',
    entriesSummary: (p) => `${p.total} in total; fetched ${p.fetched} this run`
      + (p.minRT ? ` (${p.filtered} left after reading-time ≥ ${p.minRT} min)` : '')
      + (p.skippedByState != null ? `, ${p.skippedByState} excluded by skip list` : '')
      + (p.exhausted ? '; unread pool exhausted' : '')
      + (p.syncFilter != null
        ? `; sync cursor[${p.syncFilter}] ${p.cursorBefore} → ${p.cursorAfter} (global cursor ${p.globalCursor} untouched)`
        : (p.sync != null ? `; sync cursor ${p.cursorBefore} → ${p.cursorAfter}` : ''))
      + (p.out ? `; full content written to ${p.out}` : ' (no --out given, content not saved)'),
    poolBound: (filter, filterCursor, globalCursor) =>
      `The cursor of filter ${filter} (${filterCursor}) is below the global cursor (${globalCursor}): unread entries with id ≤ ${globalCursor} are not in this candidate pool`
      + ' (incremental mechanism: entries already passed by an unfiltered fetch are not fetched again). To re-screen those older entries, run x6o4 sync reset first (it clears every cursor, including other filters\' progress)',
    cursorGlobalLabel: (v) => `global ${v}`,
    cursorFilterLabel: (k, v) => `${k}=${v}`,
    cursorJoin: '; ',
    cursorItemJoin: ', ',
    cursorFilterPrefix: 'filters ',

    // ---- sync ----
    syncSetUsage: 'Usage: x6o4 sync set <entry-id, positive integer> [--category-id N | --feed-id N]',
    syncUsage: 'Usage: x6o4 sync status|set <id>|reset [--category-id N | --feed-id N]',
    syncResetFilter: (filter, before, globalBefore) => `✔ Sync cursor of filter ${filter} cleared${before ? ` (was ${before})` : ''}, `
      + (globalBefore
        ? `next filtered fetch restarts right after the global cursor ${globalBefore} (to re-screen older entries too, run x6o4 sync reset without arguments)`
        : 'next filtered fetch will start from the earliest unread'),
    syncResetAll: (values) => `✔ All sync cursors cleared (including per-category/per-feed cursors${values ? `; previous values: ${values}` : ''}). The next fetch starts from the earliest unread`,
    syncSetDone: (id) => `✔ Sync cursor moved to ${id} (unread entries above it will be fetched again)`,
    syncSetFilterDone: (filter, id) => `✔ Sync cursor of filter ${filter} moved to ${id} (unread entries above it will be fetched again)`,
    syncStatusNone: 'Sync cursor: not enabled yet (no --sync fetch has run)',
    syncStatusGlobal: (c) => `Sync cursor (all unread): ${c} (only unread entries above it are fetched)`,
    syncStatusFilter: (k, v) => `Sync cursor (filter ${k}): ${v}`,
    syncStatusHint: 'x6o4 sync reset clears everything; x6o4 sync reset --category-id N (or --feed-id N) clears one filter; x6o4 sync set <id> moves to a given entry',

    // ---- mark-read ----
    markReadUsage: 'Usage: x6o4 mark-read --ids 9001,9002',
    markReadDone: (n) => `✔ Marked ${n} entries as read`,

    // ---- build-epub ----
    buildUsage: 'Usage: x6o4 build-epub --ids 9001,9002 --from a.json[,b.json] [--title TITLE] [--out FILE] [--max-mail-mb N] [--lang zh|en]',
    buildMissingIds: (ids) => `✘ These entries are not in the --from file(s) (re-run the entries command first): ${ids}`,
    buildVolume: (r, abs) => `✔ ${r.title}: ${r.count} articles / ${r.images} images / ${(r.size / 1048576).toFixed(1)}MB → ${abs} (entries ${r.ids.join(',')})`,
    buildTextLang: (lang) => `Text language: ${lang}`,
    buildExcludedHead: (n) => `${n} entries left out for size (they stay unread and will be picked up next time):`,
    buildExcludedItem: (e) => `  - ${e.id} ${e.title}`,
    buildLastIncluded: (id) => `Last included entry id: ${id}`,

    // ---- send-kindle ----
    sendUsage: 'Usage: x6o4 send-kindle --file a.epub[,b.epub] [--subject TITLE] [--lang zh|en]',
    sendDone: (n, files, to) => `✔ Sent ${n} email(s) (${files} attachment(s)) to ${to}`,
    sendWarn: (w) => `⚠ ${w} (this delivery still succeeded)`,
    sendNoKindle: 'Missing kindle_email (your Kindle receive address)',
    sendNoSmtp: 'Missing SMTP settings (host/user/pass)',
    sendNoFiles: 'No files given to send',
    sendAttachMissing: (abs) => `Attachment not found: ${abs}. When build-epub runs without --out it writes to the directory the command was run in (the current working directory), not /tmp. Pass the full path from after the "→" on the build-epub completion line to --file verbatim; do not build the path yourself or use wildcards`,
    sendZipTooBig: (mb) => `The bundled zip is still ${mb}MB after packing, over Amazon's 50MB-per-email limit; `
      + 'reduce the number of articles per run (lower unread.max_articles_per_run or epub.max_articles_per_book) and retry, '
      + 'or upload manually via the Amazon Send to Kindle web page (supports documents up to 200MB)',
    sendAttachTooBig: 'A single attachment exceeds 50MB (Amazon personal-document mail limit); reduce articles per book and retry',
    sendAgentlyNoCli: 'agently-cli command not found; install it first: npm install -g @tencent-qqmail/agently-cli',
    sendAgentlyNoAuth: 'agently-cli is not logged in or the login expired; run agently-cli auth login in a terminal first',
    sendAgentlyVerified: (log) => `The send command failed (${log}), but the message was verified as actually sent via the "Sent" list, so it is treated as success; not re-sent, to avoid duplicate delivery`,
    sendAgentlyListErr: (err) => `Could not check the "Sent" list (${err}); before re-sending, confirm in your mailbox's "Sent" folder that this message is not there, to avoid duplicates`,
    sendAgentlyChecked: 'The "Sent" list was checked and this message is not there; it is safe to retry',
    sendAgentlyPreSubmit: 'This kind of failure happens before the message is submitted, so no email was sent',
    sendAgentlyFail: (log, checked, hint) => `agently-cli send failed (${log}). ${checked}. ${hint}`
      + ' Manual fallback: upload via the Amazon Send to Kindle web page (documents up to 200MB) or copy over USB; the epub file is already local',
    sendSmtpFail: (msg) => `Send failed (${msg}). Common causes: the SMTP app password expired, or the sender address is not on your Amazon approved list.`
      + ' Manual fallback: upload via the Amazon Send to Kindle web page (documents up to 200MB) or copy over USB; the epub file is already local',
    sendDeleteListErr: (err) => `Failed to query the "Sent" list (${err}); the sent copy was not cleaned up`,
    sendDeleteNotFound: (subject) => `No message with subject "${subject}" found in "Sent"; the copy was not cleaned up`,

    // ---- export-md ----
    mdUsage: 'Usage: x6o4 export-md --from entries.json [--since 2026-01-01] [--lang zh|en]',
    mdDone: (a, s, f) => `✔ Added ${a}, skipped ${s} (already imported / out of range)${f ? `, failed ${f}` : ''}`,
    mdAdded: (file, title) => `  + ${file} ← ${title}`,
    mdFailed: (title, reason) => `  ✘ ${title}: ${reason}`,
    mdNoVault: 'Missing obsidian.vault_dir (your note library directory)',

    // ---- full-text stats line ----
    ftNoNeed: 'ℹ Full text: nothing to fetch (content already complete)',
    ftLine: (configured, heuristic, failed) => `ℹ Full text: ${configured} via feed setting / ${heuristic} via heuristic / ${failed} kept original`,
    ftFailedTitles: (shown, more) => ` (${shown}${more ? ' and more' : ''})`,
    ftPersistable: (shown, more) => `; feeds whose full-text setting could be saved: ${shown}${more ? ' and more' : ''}`,
    ftItemJoin: ', ',
    ftPersistableItem: (id, title) => `${id} (${title})`,
    ftFeedFallback: (id) => `feed ${id}`,
    ftEntryFallback: (id) => `entry ${id}`,

    // ---- skills ----
    skillsUsage: 'Usage: x6o4 skills install',
    skillsNameSep: ': ',
    skillsLinked: '✔ linked (updates automatically with the npm package)',
    skillsCopied: '✔ copied (fallback when linking failed; does not auto-update)',
    skillsSkipped: '↷ skipped (that folder already exists and is not this tool\'s link; untouched)',
    skillsMissing: '✘ skill not found in the installed package',

    // ---- skip ----
    skipUsage: 'Usage: x6o4 skip add --ids 9001,9002 [--days 30]',
    skipAddDone: '✔ Added to the local skip list (entries return to screening after 30 days by default)',
    skipClearDone: '✔ Skip list cleared',
    skipListSome: (n, ids) => `Skip list, ${n} entries: ${ids}`,
    skipListNone: 'Skip list is empty',

    // ---- config ----
    cfgShowUnread: (n) => `Unread push: fill target ${n} articles per run (setting unread.max_articles_per_run)`,
    cfgShowMailMb: (n) => `Mail attachment size cap: ${n} MB (setting mail.max_attachment_mb)`,
    cfgShowEpub: (total, articles) => `E-book: image budget ${total} MB per book, article cap ${articles} per book`,
    cfgShowUiLang: (lang, src) => `Interface language: ${lang} (${src}; any command accepts --lang zh|en for one run)`,
    cfgShowTextLang: (lang, src) => `Text language: ${lang} (${src}; generation and send commands accept --lang zh|en)`,
    cfgShowTransport: (transport, kindle) => `Mail transport: ${transport}${kindle ? `; Kindle receive: ${kindle}` : ''}`,
    langSrcFlag: '--lang flag',
    langSrcUiCfg: 'setting ui.language',
    langSrcTextCfg: 'setting epub.language',
    langSrcSystem: 'auto-detected from system locale',
    langSrcInvalidTextCfg: (v) => `setting epub.language value "${v}" is not recognized, fell back to system locale`,
    langSrcInvalidUiCfg: (v) => `setting ui.language value "${v}" is not recognized, fell back to system locale`,
    cfgCheckMissing: (m) => `✘ Missing ${m}`,
    cfgCheckOk: '✔ Configuration complete (including Kindle and note-library fields)',
    langCmdUsage: 'Usage: x6o4 config language [zh|en|auto] (no value shows the current one; auto = follow the system again)',
    langCmdSet: (lang) => `✔ Interface language set to ${lang} (written to config.json)`,
    langCmdAuto: '✔ Interface language back to automatic (detected from system locale; setting cleared)',
    chkBaseUrlHttp: 'base_url uses plain http on a non-loopback host; https is required',
    chkBaseUrlInvalid: 'base_url is not a valid URL',
    chkToken: 'token (run x6o4 login first)',
    chkKindle: 'kindle_email (your Kindle receive address)',
    chkSmtp: 'smtp (host/user/pass; common providers can be filled via --preset)',
    chkObsidian: 'obsidian.vault_dir (your note library directory)',

    // ---- login / logout ----
    loginEmail: 'Email: ',
    loginPassword: 'Password (input hidden): ',
    loginFail: (msg) => `✘ Login failed: ${msg}`,
    loginTokenLimit: 'You have reached the personal-token limit.',
    loginTokenHead: 'Current tokens (not revoked):',
    loginTokenColumns: '  id    name                scope      created             last used',
    loginNeverUsed: 'never used',
    loginRevokePrompt: 'Enter the id of the token to revoke (Enter = give up login): ',
    loginAborted: '✘ Aborted: no token was revoked.',
    loginListRevokeFail: (msg) => `✘ Failed to list/revoke tokens: ${msg}`,
    loginCreateFail: (msg) => `✘ Failed to create token: ${msg}`,
    loginAuthorized: (email) => `✔ Authorized: ${email}`,
    loginTokenSaved: (name, scope, p) => `✔ Token "${name}" (${scope}) saved to ${p}`,
    loginNextHint: 'You can now tell your AI: push my unread articles to Kindle / turn my starred articles into Markdown',
    loginVerifyFail: (msg) => `✘ Token self-check failed (config saved; you can retry x6o4 status): ${msg}`,
    logoutNoToken: 'No RSS Cloud token saved on this machine; nothing to log out.',
    logoutDone: (name) => `✔ Logged out: token "${name}" revoked on the server and removed locally.`,
    logoutOtherNote: 'Tokens on other computers are unaffected; to revoke all of them run x6o4 tokens list and revoke one by one, or change your RSS Cloud password (revokes every token immediately).',
    logoutClearedNoMatch: '✔ Local token removed (no matching token in the server list; it may have been revoked already).',
    logoutClearedInvalid: '✔ The server no longer accepts this token (probably revoked); local copy removed.',
    logoutFail: (msg) => `✘ Logout failed: ${msg}`,
    saveLinksFail: (msg) => `(Bookmark links not added: ${msg})`,

    // ---- server error-code guidance (api.js) ----
    apiTokenInvalid: 'Token invalid or revoked (a password change/reset or account suspension revokes every token); run x6o4 login again in a terminal',
    apiScopeDenied: 'The current token is read-only and cannot write (mark as read, save feed reading settings); run x6o4 login --scope readwrite again',
    apiFeedNotFound: 'Feed id not found; run x6o4 feeds to check your feed ids',
    apiAgentDisabled: 'The server has disabled the agent data API (AGENT_API_ENABLED=false); contact the service administrator',
    apiRateLimited: 'Too many requests; wait about a minute and try again',
    apiUpstream: 'The RSS upstream is temporarily unavailable or the account is still being provisioned; retry later. If you just filtered by feed/category id, run x6o4 feeds first to confirm the id exists — a nonexistent id produces this same error',
    apiEntitle: (msg) => `RSS Cloud entitlement missing (${msg}); renew the subscription or claim the trial to continue`,
  },
};

let currentLang = 'zh';

// 设置当前界面语言（'en' 之外的值一律回到中文）。
function setUiLang(lang) {
  currentLang = lang === 'en' ? 'en' : 'zh';
}

function uiLang() {
  return currentLang;
}

// 当前界面语言表。
function ui() {
  return UI_TEXT[currentLang];
}

// 界面语言判定：--lang 参数（zh/en/auto）> 配置 ui.language（zh/en）> 系统
// 区域设置。返回 { lang, cfgInvalid }，cfgInvalid 是配置里无法识别的原值
// （没有问题时为空字符串）。--lang 非法值由 parseLangFlag 抛双语错误。
// detect 是「按系统环境判断」的函数，测试可换成固定值。
function uiLangOf(flags, cfg, detect) {
  return resolveLang({
    flag: parseLangFlag(flags && flags.lang),
    cfgValue: ((cfg && cfg.ui) || {}).language,
    detect,
  });
}

// 登录提问的答案解析：'1'/'zh'/'中文' → 'zh'；'2'/'en'/'english' → 'en'；
// 空输入 → detected（按系统检测的默认值）；无法识别 → null（提问方重问）。
function parseUiLangChoice(input, detected) {
  const s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) return detected;
  if (s === '1' || s === 'zh' || s === '中文' || s === 'chinese') return 'zh';
  if (s === '2' || s === 'en' || s === 'english') return 'en';
  return null;
}

module.exports = {
  LANG_FLAG_ERROR, LOGIN_LANG_QUESTION, LOGIN_LANG_RETRY, UI_TEXT,
  setUiLang, uiLang, ui, uiLangOf, parseUiLangChoice,
};
