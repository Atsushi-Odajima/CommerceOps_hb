/**
 * THIRD_PARTY_NOTICES.txt を生成する（販売物に同梱される本番依存 = server / web の dependencies と、
 * ビルド時に web の成果物へ取り込まれる Service Worker ランタイム（workbox）のライセンス表記）。
 *   node scripts/third-party-notices.mjs [出力先=buyer-docs/THIRD_PARTY_NOTICES.txt]
 * テスト・ビルド専用の devDependencies（Playwright・axe-core 等）は同梱しないため含めない。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'buyer-docs', 'THIRD_PARTY_NOTICES.txt');
const tree = JSON.parse(execFileSync('npm', ['ls', '--omit=dev', '--all', '--json', '--long', '-w', 'server', '-w', 'web'], { cwd: root, maxBuffer: 256 * 1024 * 1024 }).toString());

const pkgs = new Map();
function add(path) {
  const pj = join(path, 'package.json');
  if (!existsSync(pj)) return;
  const p = JSON.parse(readFileSync(pj, 'utf8'));
  if (!p.name || p.name.startsWith('@commerceops/')) return;
  const key = `${p.name}@${p.version}`;
  if (pkgs.has(key)) return;
  const files = readdirSync(path).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f));
  const texts = files.map((f) => readFileSync(join(path, f), 'utf8').trim());
  const license = typeof p.license === 'string' ? p.license : p.license?.type ?? (Array.isArray(p.licenses) ? p.licenses.map((l) => l.type).join(' OR ') : 'UNKNOWN');
  const repo = typeof p.repository === 'string' ? p.repository : p.repository?.url ?? p.homepage ?? '';
  pkgs.set(key, { name: p.name, version: p.version, license, repo: repo.replace(/^git\+/, '').replace(/\.git$/, ''), author: typeof p.author === 'string' ? p.author : p.author?.name ?? '', texts });
}
(function walk(n) {
  for (const v of Object.values(n.dependencies ?? {})) {
    if (v.path && !v.missing) add(v.path);
    walk(v);
  }
})(tree);
// web の成果物（sw.js / workbox-*.js / registerSW）に取り込まれる workbox ランタイム
for (const name of ['workbox-window', 'workbox-core', 'workbox-precaching', 'workbox-routing', 'workbox-strategies']) {
  const p = join(root, 'node_modules', name);
  if (existsSync(p)) add(p);
}

const MIT = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const list = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const byLicense = {};
for (const p of list) byLicense[p.license] = (byLicense[p.license] ?? 0) + 1;
const lines = [];
lines.push('CommerceOps — 第三者ソフトウェアのライセンス表記（THIRD_PARTY_NOTICES）');
lines.push('');
lines.push('本ソフトウェアには、以下のオープンソースソフトウェアが含まれています（サーバーの実行時依存と、ブラウザで動く画面の成果物に含まれるもの）。');
lines.push('各ソフトウェアの著作権は各著作権者に帰属し、それぞれのライセンス条件に従って利用しています。');
lines.push('テスト・開発専用のツール（Playwright、axe-core、Vitest、TypeScript、Vite など）は販売物に含まれないため記載していません。');
lines.push('PostgreSQL・Node.js は本ソフトウェアに同梱せず、購入者が別途用意する実行環境です（それぞれのライセンスに従います）。');
lines.push('');
lines.push(`生成日: ${new Date().toISOString().slice(0, 10)} / パッケージ数: ${list.length}`);
lines.push(`ライセンス別: ${Object.entries(byLicense).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
lines.push('');
lines.push('=== 一覧 ===');
for (const p of list) lines.push(`- ${p.name} ${p.version} (${p.license})${p.repo ? ` ${p.repo}` : ''}`);
lines.push('');
lines.push('=== ライセンス本文 ===');
for (const p of list) {
  lines.push('');
  lines.push('-'.repeat(78));
  lines.push(`${p.name} ${p.version} — ${p.license}${p.author ? ` — ${p.author}` : ''}`);
  lines.push('-'.repeat(78));
  if (p.texts.length) lines.push(...p.texts.flatMap((t) => [t, '']));
  else if (p.license === 'MIT') lines.push(`（パッケージにライセンス本文のファイルがないため、package.json の宣言に基づき MIT License の標準本文を記載）`, '', MIT(p.author || p.name));
  else lines.push(`（パッケージにライセンス本文のファイルがありません。ライセンス: ${p.license}。${p.repo || ''}）`);
}
writeFileSync(out, lines.join('\n').replace(/\r\n/g, '\n') + '\n');
console.log(`${list.length} packages → ${out}`);
console.log(byLicense);
const bad = list.filter((p) => !/^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|BlueOak-1\.0\.0|\(MIT OR Apache-2\.0\)|MIT OR Apache-2\.0|Python-2\.0|CC0-1\.0|\(Unlicense OR Apache-2\.0\))$/.test(p.license));
if (bad.length) console.log('要確認のライセンス:', bad.map((p) => `${p.name}@${p.version} ${p.license}`));
