// ビルド後に SQL マイグレーションを dist へコピーする
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'src', 'db', 'migrations');
const to = join(root, 'dist', 'db', 'migrations');
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copied migrations -> ${to}`);
