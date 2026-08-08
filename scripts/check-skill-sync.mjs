// skills/ (Agent Plugins 正本) と .claude/skills/ (Claude Code 用コピー) の同期チェック。
// symlink ではなくコピーで共存させているため、乖離したら check を落とす。
import { readFileSync } from 'node:fs';

const canonical = 'skills/setup/SKILL.md';
const claudeCopy = '.claude/skills/setup/SKILL.md';

const a = readFileSync(canonical);
const b = readFileSync(claudeCopy);

if (!a.equals(b)) {
  console.error(`${canonical} と ${claudeCopy} の内容が一致しません。正本は ${canonical} です。cp ${canonical} ${claudeCopy} で同期してください。`);
  process.exit(1);
}
