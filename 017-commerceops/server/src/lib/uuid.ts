import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * UUIDv7（RFC 9562）。48bit ミリ秒時刻 + 12bit 単調増加シーケンス + 62bit 乱数。
 * 同一プロセス内では生成順に単調増加する。
 */
export function uuidv7(): string {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    seq = randomBytes(2).readUInt16BE(0) & 0x7ff;
  } else {
    seq++;
    if (seq > 0xfff) {
      lastMs++;
      seq = 0;
    }
  }
  const ms = lastMs;
  const b = randomBytes(16);
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = (ms >>> 24) & 0xff;
  b[3] = (ms >>> 16) & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = 0x70 | ((seq >>> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
