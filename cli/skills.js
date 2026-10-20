// 技能安装：把 npm 包里的三个技能以「链接」方式登记到 ~/.agents/skills
// （各家 AI 助手约定共同扫描的目录）。链接指向 npm 全局包内的技能目录，
// 因此 npm 升级包后技能内容自动更新，无需重新安装。
// Windows 用目录联接（不需要管理员权限），其他系统用普通符号链接；
// 链接创建失败时退化为整目录复制（复制版不会随 npm 升级，汇报时注明）。
const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_DIRS = ['x6o4-unread-to-kindle', 'x6o4-fav-to-kindle', 'x6o4-fav-to-md'];

function packageRoot() {
  // cli/ 的上一级是包根目录（仓库或全局安装位置），技能在包内 skills/ 下
  return path.join(__dirname, '..', 'skills');
}

function agentsSkillsDir(home = os.homedir()) {
  return path.join(home, '.agents', 'skills');
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 安装单个技能：返回动作 linked（新建或重建链接）/ copied / skipped / missing
function installOne(name, srcRoot, destRoot) {
  const src = path.join(srcRoot, name);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) return 'missing';
  const dest = path.join(destRoot, name);
  if (fs.existsSync(dest) || isLink(dest)) {
    if (!isLink(dest)) return 'skipped'; // 已有非本工具创建的目录，不覆盖
    fs.rmSync(dest, { recursive: true, force: true }); // 旧链接 → 重建以指向当前包位置
  }
  try {
    fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
    return 'linked';
  } catch {
    copyDir(src, dest);
    return 'copied'; // 无权限建链接时的兜底
  }
}

function installSkills({ srcRoot = packageRoot(), destRoot = agentsSkillsDir() } = {}) {
  fs.mkdirSync(destRoot, { recursive: true });
  return SKILL_DIRS.map((name) => ({ name, action: installOne(name, srcRoot, destRoot) }));
}

module.exports = { SKILL_DIRS, agentsSkillsDir, installSkills };
