// 技能安装测试：在临时目录模拟包目录与技能目录，不碰真实用户目录。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installSkills, agentsSkillsDir, SKILL_DIRS } = require('../cli/skills');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'x6o4-skills-'));
  const srcRoot = path.join(root, 'pkg', 'skills');
  for (const name of SKILL_DIRS) {
    fs.mkdirSync(path.join(srcRoot, name), { recursive: true });
    fs.writeFileSync(path.join(srcRoot, name, 'SKILL.md'), `# ${name}\n`);
  }
  const destRoot = path.join(root, 'agents', 'skills');
  return { srcRoot, destRoot };
}

test('首次安装：全部建立链接且内容可读', () => {
  const { srcRoot, destRoot } = makeFixture();
  const r = installSkills({ srcRoot, destRoot });
  assert.deepStrictEqual(r.map((x) => x.action), ['linked', 'linked', 'linked']);
  for (const name of SKILL_DIRS) {
    assert.ok(fs.readFileSync(path.join(destRoot, name, 'SKILL.md'), 'utf8').includes(name));
  }
  fs.rmSync(path.dirname(srcRoot), { recursive: true, force: true });
  fs.rmSync(destRoot, { recursive: true, force: true });
});

test('重复安装：旧链接被重建指向当前位置（幂等）', () => {
  const { srcRoot, destRoot } = makeFixture();
  installSkills({ srcRoot, destRoot });
  const r = installSkills({ srcRoot, destRoot });
  assert.deepStrictEqual(r.map((x) => x.action), ['linked', 'linked', 'linked']);
  fs.rmSync(path.dirname(srcRoot), { recursive: true, force: true });
  fs.rmSync(destRoot, { recursive: true, force: true });
});

test('同名真实目录存在时跳过、不覆盖', () => {
  const { srcRoot, destRoot } = makeFixture();
  const own = path.join(destRoot, SKILL_DIRS[0]);
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), '# 用户自己的版本');
  const r = installSkills({ srcRoot, destRoot });
  assert.strictEqual(r[0].action, 'skipped');
  assert.ok(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8').includes('用户自己'));
  fs.rmSync(path.dirname(srcRoot), { recursive: true, force: true });
  fs.rmSync(destRoot, { recursive: true, force: true });
});

test('技能目录约定：位于用户主目录 .agents/skills', () => {
  assert.strictEqual(agentsSkillsDir('/home/u'), path.join('/home/u', '.agents', 'skills'));
});
