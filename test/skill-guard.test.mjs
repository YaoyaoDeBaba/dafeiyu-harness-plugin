// skill-guard.test.mjs —— 技能包「篇幅」与「引用完整性」（2026-11-18）
// 为什么加：执行员的预算是有限的。SKILL.md 9.8KB 时，一个执行员动手前就要烧 6k token 读文档；
// 而且 SKILL.md 瘦身时最容易把 references 的入口写漏（文件还在，但没人知道该读它）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SKILL_DIR = join(ROOT, 'skills', 'selfloop');
const SKILL = join(SKILL_DIR, 'SKILL.md');

test('SKILL.md 篇幅 ≤ 5.5KB（含 frontmatter/角色分流/索引三段契约必需内容）', () => {
  const bytes = Buffer.byteLength(readFileSync(SKILL, 'utf8'));
  assert.ok(bytes <= 5600, 'SKILL.md 现在 ' + bytes + 'B，超了 5.6KB——把细节挪进 references（从 9.8KB 砍下来的底线是 5.6KB）');
});

test('references 的入口不许漏：每个文件都在 SKILL.md 里被点名', () => {
  const text = readFileSync(SKILL, 'utf8');
  const files = readdirSync(join(SKILL_DIR, 'references')).filter((f) => f.endsWith('.md'));
  const missing = files.filter((f) => !text.includes(f.replace(/\.md$/, '')));
  assert.deepEqual(missing, [], '这些 reference 没在 SKILL.md 里出现（等于没人会读）：' + missing.join(', '));
});

test('SKILL.md 点名的 reference 必须真实存在', () => {
  const text = readFileSync(SKILL, 'utf8');
  const files = readdirSync(join(SKILL_DIR, 'references')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  // 只校验「kebab-case 且带连字符」的代码名——references 全是这种形态，字段名（dir/changes/variants…）不是
  const kebab = [...text.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]);
  const bad = [...new Set(kebab)].filter((n) => !files.includes(n));
  assert.deepEqual(bad, [], 'SKILL.md 里点了不存在的文件：' + bad.join(', '));
});
