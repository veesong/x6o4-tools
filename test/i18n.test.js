// 语言判定与文案表测试：全部是纯函数，不联网，也不依赖本机的区域设置
// （「按系统环境判断」的函数在测试里换成固定返回值）。
const test = require('node:test');
const assert = require('node:assert');
const { STRINGS, stringsFor, langOfLocale, parseLangFlag, resolveLang } = require('../cli/i18n');

test('langOfLocale：zh 开头判为中文，其余一律判为英文', () => {
  for (const loc of ['zh', 'zh-CN', 'zh_CN', 'zh-TW', 'zh-Hans-CN', 'ZH-cn', ' zh-CN ']) {
    assert.strictEqual(langOfLocale(loc), 'zh', `「${loc}」应判为中文`);
  }
  for (const loc of ['en', 'en-US', 'en_GB', 'ja-JP', 'de', 'zhx', '', undefined, null]) {
    assert.strictEqual(langOfLocale(loc), 'en', `「${loc}」应判为英文`);
  }
});

test('parseLangFlag：zh/en/auto 通过且不分大小写，未传为 undefined，其余报错', () => {
  assert.strictEqual(parseLangFlag(undefined), undefined);
  assert.strictEqual(parseLangFlag('zh'), 'zh');
  assert.strictEqual(parseLangFlag('EN'), 'en');
  assert.strictEqual(parseLangFlag(' auto '), 'auto');
  // true 是「只写了 --lang、后面没有跟值」时命令行解析给出的值
  for (const bad of ['fr', 'cn', 'zh-CN', '', true]) {
    assert.throws(() => parseLangFlag(bad), /--lang 的值只能是 zh、en 或 auto/, `「${bad}」应报错`);
  }
});

test('resolveLang：命令行参数优先，其次配置，最后按系统环境', () => {
  const detectZh = () => 'zh';
  const detectEn = () => 'en';
  // 参数优先于配置与系统环境
  assert.deepStrictEqual(resolveLang({ flag: 'en', cfgValue: 'zh', detect: detectZh }), { lang: 'en', cfgInvalid: '' });
  assert.deepStrictEqual(resolveLang({ flag: 'zh', cfgValue: 'en', detect: detectEn }), { lang: 'zh', cfgInvalid: '' });
  // 没有参数时，配置优先于系统环境（配置值不分大小写）
  assert.deepStrictEqual(resolveLang({ cfgValue: 'en', detect: detectZh }), { lang: 'en', cfgInvalid: '' });
  assert.deepStrictEqual(resolveLang({ cfgValue: 'ZH', detect: detectEn }), { lang: 'zh', cfgInvalid: '' });
  // 参数与配置都没有时按系统环境
  assert.deepStrictEqual(resolveLang({ cfgValue: '', detect: detectZh }), { lang: 'zh', cfgInvalid: '' });
  assert.deepStrictEqual(resolveLang({ detect: detectEn }), { lang: 'en', cfgInvalid: '' });
  // auto：跳过配置，直接按系统环境
  assert.deepStrictEqual(resolveLang({ flag: 'auto', cfgValue: 'en', detect: detectZh }), { lang: 'zh', cfgInvalid: '' });
  // 配置值无法识别：按系统环境判断，并把用户写的原值带回，供调用方提醒
  assert.deepStrictEqual(resolveLang({ cfgValue: 'CN', detect: detectEn }), { lang: 'en', cfgInvalid: 'CN' });
  // 参数有效时不再检查配置（配置写错也不提醒）
  assert.deepStrictEqual(resolveLang({ flag: 'zh', cfgValue: 'cn', detect: detectEn }), { lang: 'zh', cfgInvalid: '' });
  assert.deepStrictEqual(resolveLang({ flag: 'auto', cfgValue: 'cn', detect: detectEn }), { lang: 'en', cfgInvalid: '' });
});

test('stringsFor：两种语言的键与类型一一对应，无法识别的语言给中文表', () => {
  const zhKeys = Object.keys(STRINGS.zh).sort();
  assert.deepStrictEqual(Object.keys(STRINGS.en).sort(), zhKeys, '英文表与中文表的键应完全相同');
  for (const k of zhKeys) {
    assert.strictEqual(typeof STRINGS.en[k], typeof STRINGS.zh[k], `键 ${k} 在两种语言里的类型应相同`);
  }
  assert.strictEqual(stringsFor('en'), STRINGS.en);
  assert.strictEqual(stringsFor('zh'), STRINGS.zh);
  assert.strictEqual(stringsFor(undefined), STRINGS.zh, '不传语言时是中文');
  assert.strictEqual(stringsFor('fr'), STRINGS.zh, '无法识别的语言按中文');
});

test('文案表：带参数的文案在两种语言下的输出', () => {
  const zh = stringsFor('zh');
  const en = stringsFor('en');
  assert.strictEqual(zh.countSuffix(3), ' 等3篇');
  assert.strictEqual(en.countSuffix(3), ' and 2 more', '英文写的是「除首篇外还有几篇」');
  assert.strictEqual(zh.volumeMark(0), '（一）');
  assert.strictEqual(zh.volumeMark(9), '（十）');
  assert.strictEqual(zh.volumeMark(10), '（11）', '第十一册起用阿拉伯数字');
  assert.strictEqual(en.volumeMark(0), ' (1)');
  assert.strictEqual(en.volumeMark(10), ' (11)');
  assert.strictEqual(zh.volumePart(0, 2), '（第 1/2 册）');
  assert.strictEqual(en.volumePart(0, 2), ' (book 1 of 2)');
  assert.strictEqual(zh.countPart(3), '共 3 篇');
  assert.strictEqual(en.countPart(1), '1 article');
  assert.strictEqual(en.countPart(3), '3 articles');
  assert.strictEqual(zh.subjectPart(1, 2), '（1/2）');
  assert.strictEqual(en.subjectPart(1, 2), ' (1/2)');
  assert.strictEqual(zh.mailBody(2), 'x6o4-tools 推送：2 个附件（epub 电子书）。');
  assert.strictEqual(en.mailBody(1), 'x6o4-tools delivery: 1 epub attachment.');
  assert.strictEqual(en.mailBody(2), 'x6o4-tools delivery: 2 epub attachments.');
  assert.strictEqual(zh.mailSenderNote('a@b.c'), '发件箱 a@b.c 需已加入亚马逊认可的发件人列表。');
  assert.ok(en.mailSenderNote('a@b.c').startsWith(' The sender address a@b.c '), '英文句子开头带一个空格，与前一句隔开');
});
