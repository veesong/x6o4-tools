// 界面语言与界面文案表测试：三层判定（--lang > ui.language > 系统检测）、
// zh/en 两表键集合一致（防新增文案漏翻译）、登录语言选择解析、子进程输出
// 按 --lang 与配置 ui.language 切换。全部离线，不依赖网络与真实账号。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { UI_TEXT, setUiLang, ui, uiLang, uiLangOf, parseUiLangChoice, LANG_FLAG_ERROR } = require('../cli/uitext');

function nodeCli(args, env = {}) {
  return execFileSync(process.execPath, [path.join(__dirname, '..', 'cli', 'x6o4.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('zh/en 两表键集合完全一致（新增文案漏翻译在这里失败）', () => {
  assert.deepStrictEqual(Object.keys(UI_TEXT.zh).sort(), Object.keys(UI_TEXT.en).sort());
});

test('两表同名键类型一致（函数模板对函数模板、字符串对字符串）', () => {
  for (const k of Object.keys(UI_TEXT.zh)) {
    assert.strictEqual(typeof UI_TEXT.zh[k], typeof UI_TEXT.en[k], `键 ${k} 两语言类型应一致`);
  }
});

test('缺省中文；setUiLang 切换后 ui() 取对应语言表', () => {
  assert.strictEqual(uiLang(), 'zh', '被测试直接导入时缺省中文');
  assert.strictEqual(ui().loginEmail, '邮箱：');
  setUiLang('en');
  assert.strictEqual(ui().loginEmail, 'Email: ');
  setUiLang('zh'); // 恢复缺省，不影响同进程的其他测试
});

test('uiLangOf：--lang > 配置 ui.language > 系统检测；auto 跳过配置', () => {
  const detectEn = () => 'en';
  assert.strictEqual(uiLangOf({ lang: 'en' }, {}, detectEn).lang, 'en', '参数直接生效');
  assert.strictEqual(uiLangOf({ lang: 'zh' }, { ui: { language: 'en' } }, detectEn).lang, 'zh', '参数优先于配置');
  assert.strictEqual(uiLangOf({}, { ui: { language: 'en' } }, detectEn).lang, 'en', '配置次之');
  assert.strictEqual(uiLangOf({ lang: 'auto' }, { ui: { language: 'en' } }, detectEn).lang, 'en', 'auto 跳过配置按系统判断');
  assert.strictEqual(uiLangOf({}, {}, detectEn).lang, 'en', '都没有时按系统判断');
  assert.strictEqual(uiLangOf({}, { ui: { language: '垃圾' } }, detectEn).cfgInvalid, '垃圾', '配置值无法识别时原样返回');
  assert.throws(() => uiLangOf({ lang: 'fr' }, {}), (e) => e.message === LANG_FLAG_ERROR, '非法 --lang 值抛双语错误');
});

test('parseUiLangChoice：空输入取系统默认，1/zh/中文→zh，2/en/english→en，其他 null', () => {
  assert.strictEqual(parseUiLangChoice('', 'zh'), 'zh');
  assert.strictEqual(parseUiLangChoice('  ', 'en'), 'en');
  assert.strictEqual(parseUiLangChoice('1', 'en'), 'zh');
  assert.strictEqual(parseUiLangChoice('zh', 'en'), 'zh');
  assert.strictEqual(parseUiLangChoice('中文', 'en'), 'zh');
  assert.strictEqual(parseUiLangChoice('2', 'zh'), 'en');
  assert.strictEqual(parseUiLangChoice('EN', 'zh'), 'en');
  assert.strictEqual(parseUiLangChoice('english', 'zh'), 'en');
  assert.strictEqual(parseUiLangChoice('3', 'zh'), null);
  assert.strictEqual(parseUiLangChoice('法语', 'zh'), null);
});

test('帮助文本按 --lang 切换：en 出 Usage、zh 出 用法', () => {
  const en = nodeCli(['help', '--lang', 'en']);
  assert.ok(en.includes('Usage:'), '英文帮助应有 Usage 段');
  assert.ok(!en.includes('用法：'), '英文帮助不应残留中文段标');
  assert.ok(en.includes('x6o4 config path|show|check|language'), '英文帮助也应包含 language 子命令');
  const zh = nodeCli(['help', '--lang', 'zh']);
  assert.ok(zh.includes('用法：'));
  assert.ok(zh.includes('界面语言'));
});

test('未配置指引按 --lang 切换语言（status 离线报错路径）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-home-'));
  const env = { USERPROFILE: home, HOME: home };
  let err = null;
  try { nodeCli(['status', '--lang', 'en'], env); } catch (e) { err = e; }
  assert.ok(err, '未配置应非零退出');
  const out = String(err.stdout || '') + String(err.stderr || '');
  assert.ok(out.includes('Configuration not ready'), '英文模式下应输出英文指引');
  assert.ok(out.includes('x6o4 login'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('config language：设置持久生效、显示来源、auto 清除（离线）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-home-'));
  const env = { USERPROFILE: home, HOME: home };

  // 设置 en：确认行按设置前的语言输出（zh），下一次命令才切换
  let out = nodeCli(['config', 'language', 'en', '--lang', 'zh'], env);
  assert.ok(out.includes('界面语言已设为 en'), '确认行用切换前的语言');

  // 不带 --lang 的后续命令读配置 ui.language=en，输出英文
  out = nodeCli(['config', 'language'], env);
  assert.ok(out.includes('Interface language: en'), '应显示当前语言 en');
  assert.ok(out.includes('setting ui.language'), '应说明判定来源是配置');
  out = nodeCli(['help'], env);
  assert.ok(out.includes('Usage:'), '配置 ui.language=en 后帮助应为英文');

  // --lang zh 临时覆盖配置（只影响本次运行）
  out = nodeCli(['config', 'language', '--lang', 'zh'], env);
  assert.ok(out.includes('界面语言：'), '参数临时覆盖配置');

  // auto 清除设置：配置文件里 language 归空串，后续按系统判断
  out = nodeCli(['config', 'language', 'auto'], env);
  assert.ok(out.includes('back to automatic'), 'auto 的确认行用英文（此时配置仍为 en）');
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.x6o4-tools', 'config.json'), 'utf8'));
  assert.strictEqual(saved.ui.language, '', 'auto 应把配置清成空串');

  // 非法值报用法错误
  let threw = null;
  try { nodeCli(['config', 'language', 'fr'], env); } catch (e) { threw = e; }
  assert.ok(threw, '非法语言值应非零退出');
  fs.rmSync(home, { recursive: true, force: true });
});
