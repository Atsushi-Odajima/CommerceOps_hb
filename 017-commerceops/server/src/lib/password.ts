import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// OWASP Password Storage Cheat Sheet: scrypt N=2^15, r=8, p=3 は N=2^17, p=1 と同等強度（メモリ 32MiB/ハッシュ）
const N = 32768;
const R = 8;
const P = 3;
const KEYLEN = 64;
const MAXMEM = 128 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // タイミング差でユーザー存在を推測されないよう、ダミー計算を行う
    await scrypt(password, randomBytes(16), KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 10) return 'パスワードは10文字以上にしてください';
  if (password.length > 200) return 'パスワードが長すぎます';
  if (/^(.)\1+$/.test(password)) return '同じ文字だけのパスワードは使えません';
  const lower = password.toLowerCase();
  if (['password12', 'password123', '1234567890', 'qwertyuiop', 'commerceops'].some((w) => lower.includes(w))) {
    return '推測されやすいパスワードは使えません';
  }
  return null;
}
