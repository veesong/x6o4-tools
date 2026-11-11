// 语言判定与固定文案表：生成物里的固定文字（书内页眉/页脚/目录/书名/分册
// 后缀/图片占位、邮件正文与主题后缀）有中文（zh）、英文（en）两套。
// 语言按三个来源依次判定，前面的来源给出有效值就不再看后面的：
//   1）命令行参数 --lang（zh / en；auto 表示跳过配置，直接按系统环境判断）
//   2）配置文件的 epub.language（zh / en；空值等于没有设置）
//   3）系统区域设置：zh 开头（zh-CN、zh_TW 等）判为中文，其余一律判为英文
// 中文文案与只有中文时的历史输出完全相同，中文环境生成的文件名不变。

const LANGS = ['zh', 'en'];

// 多册书名后缀用的中文数字，第十一册起改用阿拉伯数字
const ZH_VOLUME_MARKS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

const STRINGS = {
  zh: {
    langTag: 'zh',                    // xml:lang 与 dc:language 的值
    sourceLabel: '来源：',            // 文章页眉「来源：xx」
    authorLabel: '作者：',            // 文章页眉「作者：xx」
    publishedLabel: '发布：',          // 文章页眉「发布：yyyy-MM-dd」
    metaSep: ' ｜ ',                  // 页眉三项之间的分隔符
    originalLabel: '原文链接：',       // 文章页脚「原文链接：<网址>」
    saveArticle: '收藏文章',           // 文章页脚收藏链接的文字
    tocTitle: '目录',                 // 目录页（nav.xhtml）的标题
    titlePageLabel: '题头页',          // 目录文件（toc.ncx）里第一个导航点的名字
    defaultBookTitle: 'x6o4 文章精选', // 指定 --out 但没指定 --title 时的书名
    filePrefix: 'RSS 阅读-',          // 默认书名与文件名的开头，后面紧跟日期
    emptySubtitle: '精选',            // 条目列表为空时的副标题
    subtitleMax: 24,                  // 副标题（首篇标题）超过多少字符截断
    countSuffix: (total) => ` 等${total}篇`,           // 多篇时书名副标题后缀（total = 总篇数）
    volumeMark: (idx) => `（${ZH_VOLUME_MARKS[idx] || idx + 1}）`,  // 多册书名后缀（idx 从 0 起）
    volumePart: (idx, count) => `（第 ${idx + 1}/${count} 册）`,     // 题头页副行的册号（多册时才有）
    countPart: (n) => `共 ${n} 篇`,                    // 题头页副行的篇数
    imageAlt: '图片',                 // 正文图片的 alt 文本
    imageOmitted: '[图片已省略]',      // 图片取不到时的占位段落
    mailBody: (n) => `x6o4-tools 推送：${n} 个附件（epub 电子书）。`,            // 邮件正文
    // SMTP 发信时紧跟在邮件正文后面的一句（中文句子之间不加空格，英文版开头自带一个空格）
    mailSenderNote: (from) => `发件箱 ${from} 需已加入亚马逊认可的发件人列表。`,
    subjectPart: (i, n) => `（${i}/${n}）`,            // 一本书拆成多封邮件时的主题后缀
  },
  en: {
    langTag: 'en',
    sourceLabel: 'Source: ',
    authorLabel: 'Author: ',
    publishedLabel: 'Published: ',
    metaSep: ' | ',
    originalLabel: 'Original: ',
    saveArticle: 'Bookmark article',
    tocTitle: 'Contents',
    titlePageLabel: 'Title page',
    defaultBookTitle: 'x6o4 Articles',
    filePrefix: 'RSS Digest-',
    emptySubtitle: 'Selection',
    subtitleMax: 48,                  // 英文标题单位字符承载的信息少，上限放宽
    countSuffix: (total) => ` and ${total - 1} more`,  // total = 总篇数，比首篇多出的才是 more
    volumeMark: (idx) => ` (${idx + 1})`,
    volumePart: (idx, count) => ` (book ${idx + 1} of ${count})`,
    countPart: (n) => `${n} article${n === 1 ? '' : 's'}`,
    imageAlt: 'image',
    imageOmitted: '[image omitted]',
    mailBody: (n) => `x6o4-tools delivery: ${n} epub attachment${n === 1 ? '' : 's'}.`,
    mailSenderNote: (from) => ` The sender address ${from} must be on your Amazon Approved Personal Document E-mail List.`,
    subjectPart: (i, n) => ` (${i}/${n})`,
  },
};

// 取某种语言的文案表；lang 不是 en 时一律给中文表（调用方不传语言时的缺省就是中文）。
function stringsFor(lang) {
  return STRINGS[lang === 'en' ? 'en' : 'zh'];
}

// 读取系统区域设置名称（如 zh-CN、en-US）；读取失败时给空字符串。
function systemLocale() {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale || '';
  } catch {
    return '';
  }
}

// 把区域设置名称归为 zh 或 en：zh 开头（含 zh-CN、zh_TW）为中文，其余（含空值）为英文。
function langOfLocale(locale) {
  return /^zh(?:[-_]|$)/i.test(String(locale || '').trim()) ? 'zh' : 'en';
}

// 按系统区域设置判断语言（zh 或 en）。
function detectSystemLang() {
  return langOfLocale(systemLocale());
}

// --lang 非法值的报错文案：抛错发生在语言判定完成之前，无法按语言选表，
// 因此固定双语（中文在前，与历史输出兼容）。
const LANG_FLAG_ERROR = '--lang 的值只能是 zh、en 或 auto / --lang accepts only zh, en, or auto';

// 检查命令行 --lang 的值：返回规范化的小写值（zh / en / auto，未传时 undefined）；
// 值无法识别时抛错，错误信息写明可用的值。
function parseLangFlag(v) {
  if (v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === 'auto' || LANGS.includes(s)) return s;
  throw new Error(LANG_FLAG_ERROR);
}

// 判定最终语言。flag 是 parseLangFlag 的返回值，cfgValue 是配置 epub.language
// 的原值，detect 是「按系统环境判断」的函数（测试可换成固定值）。
// 返回 { lang: 'zh'|'en', cfgInvalid }：cfgInvalid 是配置里无法识别的原值
// （没有问题时为空字符串），调用方据此输出一行提醒。
function resolveLang({ flag, cfgValue, detect = detectSystemLang } = {}) {
  if (flag === 'auto') return { lang: detect(), cfgInvalid: '' };
  if (flag === 'zh' || flag === 'en') return { lang: flag, cfgInvalid: '' };
  const raw = String(cfgValue == null ? '' : cfgValue).trim();
  const cfg = raw.toLowerCase();
  if (LANGS.includes(cfg)) return { lang: cfg, cfgInvalid: '' };
  return { lang: detect(), cfgInvalid: raw };
}

module.exports = { LANGS, STRINGS, LANG_FLAG_ERROR, stringsFor, systemLocale, langOfLocale, detectSystemLang, parseLangFlag, resolveLang };
