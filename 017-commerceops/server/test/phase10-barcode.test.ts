import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import bwipjs from 'bwip-js';
import { PNG } from 'pngjs';
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, NotFoundException, RGBLuminanceSource } from '@zxing/library';
import { createTestEnv, expectStatus, type TestEnv } from './helpers/env.js';
import { setupBasicOrg } from './helpers/scenario.js';
import { gtinVariants, guessSymbology } from '../src/modules/products/routes.js';

/**
 * カメラ読取で「対応済み」と表記するシンボルの実測（CameraScanner.tsx の ZXing 経路 = iOS Safari 等と同じデコーダ）。
 * bwip-js（印刷ラベルと同じ生成ライブラリ）で画像を作り、@zxing/library（画面と同じ設定: POSSIBLE_FORMATS + TRY_HARDER）でデコードする。
 * 撮影を模した劣化（縮小・ノイズ・ぼかし・低コントラスト・傾き）も与える。実機カメラでの読取率はこのテストの範囲外（RELEASE_CHECKLIST の人間の確認項目）。
 */

// ZXing は読めなかった候補ごとに console.warn を出す（「読めない」は想定内の結果なのでテスト出力から除く）
const realWarn = console.warn;
vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('MultiFormatReader:')) return;
  realWarn(...args);
});

// 画面（CameraScanner.tsx）と同じ設定
const FORMATS = [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF, BarcodeFormat.QR_CODE];

interface Gray {
  w: number;
  h: number;
  px: Uint8ClampedArray;
}

async function render(bcid: string, text: string, extra: Record<string, unknown> = {}): Promise<Gray> {
  const opts: Record<string, unknown> =
    bcid === 'qrcode'
      ? { bcid, text, scale: 4, paddingwidth: 16, paddingheight: 16, backgroundcolor: 'FFFFFF' }
      : { bcid, text, scale: 3, height: 14, includetext: true, textxalign: 'center', paddingwidth: 16, paddingheight: 10, backgroundcolor: 'FFFFFF' };
  const png = PNG.sync.read(await bwipjs.toBuffer({ ...opts, ...extra } as never));
  const px = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0; i < px.length; i++) {
    const [r, g, b, a] = [png.data[i * 4]!, png.data[i * 4 + 1]!, png.data[i * 4 + 2]!, png.data[i * 4 + 3]!];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    px[i] = (lum * a + 255 * (255 - a)) / 255; // 透明部分は白の上に合成
  }
  return { w: png.width, h: png.height, px };
}

function decode(img: Gray): { text: string; format: string } {
  const reader = new MultiFormatReader();
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, FORMATS],
    [DecodeHintType.TRY_HARDER, true],
    [DecodeHintType.ALLOWED_LENGTHS, [14]], // 画面と同じ: ITF は 14 桁（ITF-14）のみ
  ]);
  const r = reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(img.px, img.w, img.h))), hints);
  return { text: r.getText(), format: BarcodeFormat[r.getBarcodeFormat()]! };
}

// ---- 撮影を模した劣化（決定的: 乱数は固定シード）----
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const map = (img: Gray, f: (v: number, i: number) => number): Gray => ({ ...img, px: Uint8ClampedArray.from(img.px, f) });
/** 1/2 に縮小（平均） */
function half(img: Gray): Gray {
  const w = img.w >> 1;
  const h = img.h >> 1;
  const px = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = 2 * y * img.w + 2 * x;
      px[y * w + x] = (img.px[o]! + img.px[o + 1]! + img.px[o + img.w]! + img.px[o + img.w + 1]!) / 4;
    }
  return { w, h, px };
}
function blur(img: Gray): Gray {
  const px = new Uint8ClampedArray(img.px.length);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < img.h && xx >= 0 && xx < img.w) {
            s += img.px[yy * img.w + xx]!;
            n++;
          }
        }
      px[y * img.w + x] = s / n;
    }
  return { ...img, px };
}
/** 背景を白で広げてから回転（双線形補間） */
function rotate(img: Gray, deg: number): Gray {
  const pad = Math.ceil(Math.max(img.w, img.h) * 0.3);
  const w = img.w + pad * 2;
  const h = img.h + pad * 2;
  const t = (deg * Math.PI) / 180;
  const [c, s] = [Math.cos(t), Math.sin(t)];
  const px = new Uint8ClampedArray(w * h).fill(255);
  const get = (x: number, y: number) => (x >= 0 && y >= 0 && x < img.w && y < img.h ? img.px[y * img.w + x]! : 255);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x - w / 2;
      const dy = y - h / 2;
      const sx = c * dx + s * dy + img.w / 2;
      const sy = -s * dx + c * dy + img.h / 2;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      px[y * w + x] = get(x0, y0) * (1 - fx) * (1 - fy) + get(x0 + 1, y0) * fx * (1 - fy) + get(x0, y0 + 1) * (1 - fx) * fy + get(x0 + 1, y0 + 1) * fx * fy;
    }
  return { w, h, px };
}
const lowContrast = (img: Gray) => map(img, (v) => 80 + (v / 255) * 110); // 黒 80 / 白 190
const noisy = (img: Gray, seed = 7) => {
  const r = rng(seed);
  return map(img, (v) => v + (r() - 0.5) * 80);
};
const noise20 = (g: Gray, seed = 5) => {
  const r = rng(seed);
  return map(g, (v) => v + (r() - 0.5) * 40);
};
/** すべてのシンボルで読めることを要求する条件（撮影でよくある程度の劣化） */
const MUST_READ: [string, (g: Gray) => Gray][] = [
  ['そのまま', (g) => g],
  ['ぼかし', blur],
  ['ノイズ ±40', (g) => noisy(g)],
  ['低コントラスト（黒 80 / 白 190）', lowContrast],
  ['傾き 6°', (g) => rotate(g, 6)],
  ['傾き 12°', (g) => rotate(g, 12)],
];
/** 読めなくてもよいが、読めた場合に違う値を返してはならない条件（厳しい劣化）。結果は TEST_REPORT.md に表で記録 */
const HARSH: [string, (g: Gray) => Gray][] = [
  ['1/2 縮小（1 モジュール約 1.5px）', half],
  ['1/2 縮小 + ぼかし', (g) => blur(half(g))],
  ['1/2 縮小 + ノイズ ±20', (g) => noise20(half(g), 13)],
  ['低コントラスト + ノイズ ±20', (g) => noise20(lowContrast(g), 9)],
  ['低コントラスト + ノイズ ±40', (g) => noisy(lowContrast(g))],
  ['傾き 20°', (g) => rotate(g, 20)],
  ['傾き 30°', (g) => rotate(g, 30)],
];

// [表記, bwip-js の bcid, 入力, ZXing の期待値, 期待フォーマット, 追加オプション]
const CASES: [string, string, string, string, string, Record<string, unknown>?][] = [
  ['JAN（EAN-13）', 'ean13', '4901234567894', '4901234567894', 'EAN_13'],
  ['EAN-8（短縮 JAN）', 'ean8', '49123456', '49123456', 'EAN_8'],
  ['UPC-A', 'upca', '036000291452', '036000291452', 'UPC_A'],
  ['Code128（ロケーション・伝票番号）', 'code128', 'TKY-A-01-03', 'TKY-A-01-03', 'CODE_128'],
  ['Code128（英小文字・記号）', 'code128', 'sku_ab-12/x', 'sku_ab-12/x', 'CODE_128'],
  ['Code39', 'code39', 'SKU-12345', 'SKU-12345', 'CODE_39'],
  ['ITF（Interleaved 2 of 5・14 桁）', 'interleaved2of5', '14901234567891', '14901234567891', 'ITF'],
  ['QR（注文番号）', 'qrcode', 'SO-000123', 'SO-000123', 'QR_CODE'],
  ['QR（長い英数字）', 'qrcode', 'CO:RET:R-000045:ORD:SO-000123', 'CO:RET:R-000045:ORD:SO-000123', 'QR_CODE'],
];

describe('Phase10 barcode symbologies decoded with the in-app decoder (ZXing) — only these are claimed as supported', () => {
  for (const [label, bcid, input, expected, format, extra] of CASES) {
    it(`${label}: decodes under common camera conditions and never returns a wrong value under harsh ones`, async () => {
      const base = await render(bcid, input, extra);
      const failures: string[] = [];
      for (const [name, f] of MUST_READ) {
        try {
          const r = decode(f(base));
          if (r.text !== expected || r.format !== format) failures.push(`${name}: ${r.format} ${r.text}`);
        } catch (e) {
          failures.push(`${name}: ${e instanceof NotFoundException ? '読めない' : String(e)}`);
        }
      }
      const wrong: string[] = [];
      for (const [name, f] of HARSH) {
        try {
          const r = decode(f(base));
          if (r.text !== expected || r.format !== format) wrong.push(`${name}: ${r.format} ${r.text}`);
        } catch {
          /* 読めないのは許容（利用者が読み直す） */
        }
      }
      expect(failures).toEqual([]);
      expect(wrong).toEqual([]);
    });
  }

  it('a blank image or random noise is not decoded as anything (no phantom reads)', async () => {
    const blank: Gray = { w: 400, h: 200, px: new Uint8ClampedArray(400 * 200).fill(255) };
    expect(() => decode(blank)).toThrow();
    const r = rng(3);
    const noise: Gray = { w: 400, h: 200, px: Uint8ClampedArray.from({ length: 400 * 200 }, () => (r() < 0.5 ? 0 : 255)) };
    expect(() => decode(noise)).toThrow();
  });

  it('a leading-zero EAN-13 is returned by ZXing as the 12-digit UPC-A — the server treats both forms as the same GTIN', async () => {
    const r = decode(await render('ean13', '0036000291452'));
    expect(r).toEqual({ text: '036000291452', format: 'UPC_A' });
    expect(gtinVariants('036000291452')).toEqual(['036000291452', '0036000291452']);
    expect(gtinVariants('0036000291452')).toEqual(['0036000291452', '036000291452']);
    // チェックディジットが合わないものは別コードのまま（誤って別商品に一致させない）
    expect(gtinVariants('036000291453')).toEqual(['036000291453']);
    expect(gtinVariants('4901234567894')).toEqual(['4901234567894']);
    expect(guessSymbology('036000291452')).toBe('upca');
  });
});

describe('Phase10 GTIN equivalence in product lookup / pick / duplicate checks', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  it('a product registered with the 13-digit form is found by the 12-digit read (and vice versa); the two forms cannot be split across products', async () => {
    const s = await setupBasicOrg(env);
    const c = s.owner.client;
    const a = expectStatus(await c.post('/api/products', { sku: 'GT-A', name: 'GTIN A', barcodes: [{ code: '0036000291452' }] }), 200).body;
    const b = expectStatus(await c.post('/api/products', { sku: 'GT-B', name: 'GTIN B', barcodes: [{ code: '012345678905' }] }), 200).body;
    expect(expectStatus(await c.get('/api/products/lookup?code=036000291452'), 200).body.product.sku).toBe('GT-A');
    expect(expectStatus(await c.get('/api/products/lookup?code=0036000291452'), 200).body.product.sku).toBe('GT-A');
    expect(expectStatus(await c.get('/api/products/lookup?code=0012345678905'), 200).body.product.sku).toBe('GT-B');
    expect((await c.get('/api/products/lookup?code=036000291453')).status).toBe(404);
    // 全角で手入力されたコード（日本語入力のまま）も同じ商品として照合する
    expect(expectStatus(await c.get(`/api/products/lookup?code=${encodeURIComponent('０３６０００２９１４５２')}`), 200).body.product.sku).toBe('GT-A');
    // 一覧・横断検索でも同じ
    expect(expectStatus(await c.get('/api/products?q=036000291452'), 200).body.items.map((p: any) => p.sku)).toEqual(['GT-A']);
    expect(expectStatus(await c.get('/api/search?q=036000291452'), 200).body.results.products.map((p: any) => p.sku)).toEqual(['GT-A']);
    // 同じ GTIN の別表記を別商品へ登録することはできない
    const dup = await c.post(`/api/products/${b.id}/barcodes`, { code: '036000291452' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('BARCODE_TAKEN');
    expect(a.id).not.toBe(b.id);
  });
});
