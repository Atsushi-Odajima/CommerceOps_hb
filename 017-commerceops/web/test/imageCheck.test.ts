/**
 * CommerceOps 商品画像チェック（ADR-041）の単体テスト。
 * 前半は #006「商品CSV × 商品画像 照合ツール」の tests/unit.test.js をそのまま移植（期待値は変えていない）。
 * 後半は CommerceOps 側で追加した補助処理（URL・商品マスタ・列の仮選択・ファイルの振り分け・絞り込み・結果 CSV）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as csv from '../src/lib/imageCheck/csv';
import * as m from '../src/lib/imageCheck/matcher';
import {
  classifySelectedFiles,
  columnLabel,
  columnLetter,
  filterItems,
  guessIdColumn,
  guessImageColumn,
  imageNameFromValue,
  normalizeForSearch,
  productsToRows,
  resultCsvRows,
  tableToRows,
  todayString,
} from '../src/lib/imageCheck/helpers';

const S = m.STATUS;
const here = dirname(fileURLToPath(import.meta.url));
const enc = (s: string) => new TextEncoder().encode(s);
const img = (...names: string[]) => names.map((n) => ({ name: n }));
const rows = (...images: string[]) => images.map((v, i) => ({ rowNumber: i + 2, id: 'ID' + (i + 1), image: v }));
const statusOf = (res: m.MatchResult) => res.items.filter((x) => x.rowNumber != null).map((x) => x.status);
const unusedOf = (res: m.MatchResult) => res.items.filter((x) => x.status === S.UNUSED).map((x) => x.image);
const codeIs = (code: string) => (e: unknown) => (e as csv.CsvError).code === code;
function expectThrowCode(fn: () => unknown, code: string) {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected CsvError ${code}`).toBeInstanceOf(csv.CsvError);
  expect(codeIs(code)(caught)).toBe(true);
}
const DEF = m.DEFAULT_OPTIONS;

describe('文字コード（#006 移植）', () => {
  it('UTF-8（BOMなし）', () => {
    const r = csv.decodeCsvBytes(enc('商品,画像\n'), 'auto');
    expect(r.text).toBe('商品,画像\n');
    expect(r.encodingLabel).toBe('UTF-8');
  });
  it('UTF-8 BOM付き：BOMは除去される', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('商品,画像')]);
    const r = csv.decodeCsvBytes(bytes, 'auto');
    expect(r.text).toBe('商品,画像');
    expect(r.encodingLabel).toMatch(/BOM/);
    expect(csv.buildTable(r.text + '\nx,y').headers).toEqual(['商品', '画像']);
  });
  it('Shift_JIS：autoでUTF-8として読めなければShift_JISで読み、フォールバックを報告', () => {
    const sjis = new Uint8Array([0x8f, 0xa4, 0x95, 0x69, 0x83, 0x52, 0x81, 0x5b, 0x83, 0x68, 0x2c, 0x89, 0xe6, 0x91, 0x9c]);
    const r = csv.decodeCsvBytes(sjis, 'auto');
    expect(r.text).toBe('商品コード,画像');
    expect(r.usedFallback).toBe(true);
    expectThrowCode(() => csv.decodeCsvBytes(sjis, 'utf-8'), 'ENCODING_UTF8');
    expect(csv.decodeCsvBytes(sjis, 'shift_jis').text).toBe('商品コード,画像');
  });
  it('空ファイル・xlsx・UTF-16はエラー', () => {
    expectThrowCode(() => csv.decodeCsvBytes(new Uint8Array(0)), 'EMPTY');
    expectThrowCode(() => csv.decodeCsvBytes(new Uint8Array([0x50, 0x4b, 3, 4, 0])), 'NOT_CSV_XLSX');
    expectThrowCode(() => csv.decodeCsvBytes(new Uint8Array([0xff, 0xfe, 0x41, 0])), 'UNSUPPORTED_UTF16');
  });
  it('Shift_JISとしても読めないバイト列はエラー（手動 Shift_JIS / auto）', () => {
    const bad = new Uint8Array([0x41, 0xff, 0xff, 0xff]);
    expectThrowCode(() => csv.decodeCsvBytes(bad, 'shift_jis'), 'ENCODING_SJIS');
    expectThrowCode(() => csv.decodeCsvBytes(bad, 'auto'), 'ENCODING_UNKNOWN');
  });
});

describe('CSV解析（#006 移植）', () => {
  it('引用符・カンマ入り・"" エスケープ・フィールド内改行・空欄・末尾空欄', () => {
    const text = 'a,b,c\r\n"x,1","say ""hi""","line1\nline2"\r\n,,\r\n1,,\r\n"",2,"3"';
    const rec = csv.parseCsv(text);
    expect(rec.map((r) => r.fields)).toEqual([
      ['a', 'b', 'c'],
      ['x,1', 'say "hi"', 'line1\nline2'],
      ['', '', ''],
      ['1', '', ''],
      ['', '2', '3'],
    ]);
    expect(rec[2]!.line).toBe(4);
  });
  it('LF・CR・CRLF 混在、末尾改行で余分な行を作らない', () => {
    expect(csv.parseCsv('a,b\nc,d\re,f\r\n').map((r) => r.fields)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    expect(csv.parseCsv('a,b\n').map((r) => r.fields)).toEqual([['a', 'b']]);
    expect(csv.parseCsv('a,\n').map((r) => r.fields)).toEqual([['a', '']]);
  });
  it('引用符が閉じていなければエラー', () => {
    expectThrowCode(() => csv.parseCsv('a,b\n"abc,d\n'), 'UNCLOSED_QUOTE');
  });
  it('buildTable：行番号はヘッダー=1、空行はスキップするが番号は進む', () => {
    const t = csv.buildTable('h1,h2\r\nA,1\r\n\r\n,\r\nB,"multi\nline"\r\nC,3');
    expect(t.rows.map((r) => r.rowNumber)).toEqual([2, 5, 6]);
    expect(t.blankRows).toBe(2);
  });
  it('buildTable：ヘッダーのみ・空・ヘッダー空はエラー、列の多い行を数える', () => {
    expectThrowCode(() => csv.buildTable('a,b\n'), 'NO_DATA_ROWS');
    expectThrowCode(() => csv.buildTable(''), 'EMPTY');
    expectThrowCode(() => csv.buildTable(',\nA,B'), 'NO_HEADER');
    expect(csv.buildTable('a,b\n1,2,3\n4,5').longRows).toBe(1);
  });
  it('1000行CSVを解析できる', () => {
    let s = 'code,name,image\n';
    for (let i = 1; i <= 1000; i++) s += `P${i},"名前,${i}",P${i}.jpg\n`;
    const t = csv.buildTable(s);
    expect(t.rows.length).toBe(1000);
    expect(t.rows[999]!.rowNumber).toBe(1001);
    expect(t.rows[0]!.fields[1]).toBe('名前,1');
  });
});

describe('出力（#006 移植）', () => {
  it('toCsvText：BOM・CRLF・エスケープ・数式対策', () => {
    const out = csv.toCsvText([['a', 'b,c', 'd"e', 'f\ng', '=SUM(1)', '+1', '-x', '@x', '']]);
    expect(out).toBe('﻿a,"b,c","d""e","f\ng",\'=SUM(1),\'+1,\'-x,\'@x,\r\n');
    expect(csv.parseCsv(out)[0]!.fields.slice(0, 4)).toEqual(['a', 'b,c', 'd"e', 'f\ng']);
  });
  it('sanitizeFileName', () => {
    expect(csv.sanitizeFileName('a/b\\c:d*e?f"g<h>i|j.csv')).toBe('a_b_c_d_e_f_g_h_i_j.csv');
    expect(csv.sanitizeFileName('CON.csv')).toBe('_CON.csv');
    expect(csv.sanitizeFileName('  ..  ')).toBe('result');
    expect(csv.sanitizeFileName('check_result_2026-01-02.csv')).toBe('check_result_2026-01-02.csv');
  });
});

describe('正規化（#006 移植）', () => {
  it('makeKey：前後空白・パス・拡張子・大文字小文字', () => {
    const o: m.MatchOptions = { caseMode: 'ignore', ignoreExtension: false, ignorePath: true };
    expect(m.makeKey('  images/products/A001.JPG ', o, true)).toBe('a001.jpg');
    expect(m.makeKey('images\\products\\A001.jpg', o, true)).toBe('a001.jpg');
    expect(m.makeKey('images/products/A001.jpg', { ...o, ignorePath: false }, true)).toBe('images/products/a001.jpg');
    expect(m.makeKey('A001.jpeg', { ...o, ignoreExtension: true }, true)).toBe('a001');
    expect(m.makeKey('A001.v2', { ...o, ignoreExtension: true }, true)).toBe('a001.v2');
    expect(m.makeKey('A001.jpg', { ...o, caseMode: 'exact' }, true)).toBe('A001.jpg');
  });
  it('makeKey：NFC（濁点の合成・分解を統一）、全角と半角は別、画像側はパスを外さない', () => {
    const decomposed = 'がばん.jpg'; // 「が」を分解した形
    expect(m.makeKey(decomposed, DEF, true)).toBe(m.makeKey('がばん.jpg', DEF, true));
    expect(m.makeKey('Ａ001.jpg', DEF, true)).not.toBe(m.makeKey('A001.jpg', DEF, true));
    expect(m.makeKey('x/A001.jpg', DEF, false)).toBe('x/a001.jpg');
  });
  it('getExtension / baseName / isSupportedImageName', () => {
    expect(m.getExtension('A.JPG')).toBe('jpg');
    expect(m.getExtension('.hidden')).toBe('');
    expect(m.getExtension('A.')).toBe('');
    expect(m.getExtension('dir.v1/file')).toBe('');
    expect(m.baseName('a/b\\c.jpg')).toBe('c.jpg');
    expect(['a.jpg', 'a.JPEG', 'a.png', 'a.webp'].every(m.isSupportedImageName)).toBe(true);
    expect(['a.gif', 'a.heic', 'a', 'a.txt'].some(m.isSupportedImageName)).toBe(false);
  });
});

describe('重点ケース 1〜10（#006 移植）', () => {
  it('初期値：大文字小文字無視・拡張子無視OFF・パス無視ON', () => {
    expect({ ...DEF }).toEqual({ caseMode: 'ignore', ignoreExtension: false, ignorePath: true });
  });
  it('1. CSV A001.jpg + 画像 A001.jpg → 正常', () => {
    const res = m.runMatch(rows('A001.jpg'), img('A001.jpg'), DEF);
    expect(statusOf(res)).toEqual([S.OK]);
    expect(res.items[0]!.detail).toBe('対応画像：A001.jpg');
  });
  it('2. CSV A002.jpg + 画像なし → 画像不足', () => {
    expect(statusOf(m.runMatch(rows('A002.jpg'), img('A001.jpg'), DEF))).toEqual([S.MISSING]);
    expect(statusOf(m.runMatch(rows('A002.jpg'), [], DEF))).toEqual([S.MISSING]);
  });
  it('3. CSVにない A003.jpg → 未使用画像（行番号・識別値は空）', () => {
    const res = m.runMatch(rows('A001.jpg'), img('A001.jpg', 'A003.jpg'), DEF);
    const u = res.items.filter((x) => x.status === S.UNUSED);
    expect(u.length).toBe(1);
    expect(u[0]!.image).toBe('A003.jpg');
    expect(u[0]!.rowNumber).toBeNull();
    expect(u[0]!.id).toBe('');
    expect(u[0]!.detail).toBe('CSVのどの行でも使われていない画像です。');
  });
  it('4. CSV複数行で A001.jpg → CSV内重複（両行）', () => {
    const res = m.runMatch(rows('A001.jpg', 'A002.jpg', 'A001.jpg'), img('A001.jpg', 'A002.jpg'), DEF);
    expect(statusOf(res)).toEqual([S.DUPLICATE, S.OK, S.DUPLICATE]);
    expect(res.items[0]!.detail).toMatch(/2行目、4行目/);
    expect(res.items[0]!.detail).toMatch(/意図的な共有であれば問題ありません/);
  });
  it('5. 大文字小文字無視：CSV abc.jpg + 画像 ABC.jpg → 正常', () => {
    expect(statusOf(m.runMatch(rows('abc.jpg'), img('ABC.jpg'), DEF))).toEqual([S.OK]);
  });
  it('6. 大文字小文字無視：画像 abc.jpg と ABC.jpg → 複数候補', () => {
    const res = m.runMatch(rows('abc.jpg'), img('abc.jpg', 'ABC.jpg'), DEF);
    expect(statusOf(res)).toEqual([S.MULTIPLE]);
    expect(unusedOf(res)).toEqual([]);
  });
  it('7. 拡張子無視ON：CSV A001 + A001.jpg → 正常', () => {
    expect(statusOf(m.runMatch(rows('A001'), img('A001.jpg'), { ...DEF, ignoreExtension: true }))).toEqual([S.OK]);
  });
  it('8. 拡張子無視ON：A001.jpg と A001.png → 複数候補', () => {
    const o = { ...DEF, ignoreExtension: true };
    expect(statusOf(m.runMatch(rows('A001'), img('A001.jpg', 'A001.png'), o))).toEqual([S.MULTIPLE]);
    expect(statusOf(m.runMatch(rows('A001.jpg'), img('A001.jpg', 'A001.png'), o))).toEqual([S.MULTIPLE]);
  });
  it('9. パス無視ON：CSV images/products/A001.jpg + A001.jpg → 正常（/ と \\ の両方）', () => {
    expect(statusOf(m.runMatch(rows('images/products/A001.jpg', 'images\\products\\A002.jpg'), img('A001.jpg', 'A002.jpg'), DEF))).toEqual([S.OK, S.OK]);
  });
  it('10. 画像列空欄 → 画像指定なし（画像不足とは別）', () => {
    const res = m.runMatch(rows('', '   '), img('A001.jpg'), DEF);
    expect(statusOf(res)).toEqual([S.EMPTY, S.EMPTY]);
    expect(res.summary.specified).toBe(0);
    expect(res.items[0]!.detail).toBe('画像列が空欄です。');
  });
});

describe('設定 OFF 側・その他（#006 移植）', () => {
  it('完全一致：abc.jpg と ABC.jpg は別物（画像不足＋参考表示、未使用画像）', () => {
    const res = m.runMatch(rows('abc.jpg'), img('ABC.jpg'), { ...DEF, caseMode: 'exact' });
    expect(statusOf(res)).toEqual([S.MISSING]);
    expect(res.items[0]!.detail).toMatch(/参考：大文字小文字だけ異なる画像/);
    expect(unusedOf(res)).toEqual(['ABC.jpg']);
    expect(statusOf(m.runMatch(rows('abc.jpg'), img('abc.jpg', 'ABC.jpg'), { ...DEF, caseMode: 'exact' }))).toEqual([S.OK]);
  });
  it('a001.JPG と A001.jpg（大小無視）→ 正常', () => {
    expect(statusOf(m.runMatch(rows('a001.JPG'), img('A001.jpg'), DEF))).toEqual([S.OK]);
  });
  it('拡張子無視OFF：CSV A001 + A001.jpg → 画像不足（参考表示あり）', () => {
    const res = m.runMatch(rows('A001'), img('A001.jpg'), DEF);
    expect(statusOf(res)).toEqual([S.MISSING]);
    expect(res.items[0]!.detail).toMatch(/参考：拡張子/);
  });
  it('拡張子無視ON のときは拡張子の参考表示を出さない、完全一致でないときは大文字小文字の参考表示を出さない', () => {
    const res = m.runMatch(rows('B001'), img('A001.jpg'), { ...DEF, ignoreExtension: true });
    expect(res.items[0]!.detail).not.toMatch(/参考/);
  });
  it('パス無視OFF：CSV images/A001.jpg → 画像不足（ヒントあり）', () => {
    const res = m.runMatch(rows('images/A001.jpg'), img('A001.jpg'), { ...DEF, ignorePath: false });
    expect(statusOf(res)).toEqual([S.MISSING]);
    expect(res.items[0]!.detail).toMatch(/パスを無視/);
    expect(unusedOf(res)).toEqual(['A001.jpg']);
  });
  it('パス無視OFF：パスなしの値は通常どおり一致する', () => {
    expect(statusOf(m.runMatch(rows('A001.jpg'), img('A001.jpg'), { ...DEF, ignorePath: false }))).toEqual([S.OK]);
  });
  it('パスのみ（images/）→ 画像不足', () => {
    const res = m.runMatch(rows('images/'), img('A001.jpg'), DEF);
    expect(statusOf(res)).toEqual([S.MISSING]);
    expect(res.items[0]!.detail).toMatch(/ファイル名がありません/);
  });
  it('日本語名・空白入り名・前後空白', () => {
    const res = m.runMatch(rows('黒 Tシャツ 01.jpg', '  帽子.png  ', 'バッグ（大）.webp'), img('黒 Tシャツ 01.jpg', '帽子.png', 'バッグ（大）.webp'), DEF);
    expect(statusOf(res)).toEqual([S.OK, S.OK, S.OK]);
    expect(res.items[1]!.image).toBe('帽子.png');
  });
  it('自動修正しない：A001.jpg がなく A0011.jpg がある → 画像不足・未使用画像', () => {
    const res = m.runMatch(rows('A001.jpg'), img('A0011.jpg'), DEF);
    expect(statusOf(res)).toEqual([S.MISSING]);
    expect(unusedOf(res)).toEqual(['A0011.jpg']);
  });
  it('重複＋画像不足 → 画像不足（詳細に重複を記載）、重複＋複数候補 → 複数候補', () => {
    let res = m.runMatch(rows('X.jpg', 'X.jpg'), img('A.jpg'), DEF);
    expect(statusOf(res)).toEqual([S.MISSING, S.MISSING]);
    expect(res.items[0]!.detail).toMatch(/2行で指定/);
    res = m.runMatch(rows('X.jpg', 'x.jpg'), img('X.jpg', 'x.JPG'), DEF);
    expect(statusOf(res)).toEqual([S.MULTIPLE, S.MULTIPLE]);
    expect(res.items[0]!.detail).toMatch(/2行で指定/);
  });
  it('画像指定なしは重複の数に入らない（空欄が複数あっても CSV内重複にならない）', () => {
    const res = m.runMatch(rows('', '', 'A.jpg'), img('A.jpg'), DEF);
    expect(statusOf(res)).toEqual([S.EMPTY, S.EMPTY, S.OK]);
  });
  it('フォルダ選択で同名ファイルが別フォルダにある → 複数候補（パスを表示）', () => {
    const res = m.runMatch(
      rows('A001.jpg'),
      [
        { name: 'A001.jpg', path: 'x/A001.jpg' },
        { name: 'A001.jpg', path: 'y/A001.jpg' },
      ],
      DEF,
    );
    expect(statusOf(res)).toEqual([S.MULTIPLE]);
    expect(res.items[0]!.detail).toMatch(/x\/A001\.jpg、y\/A001\.jpg/);
  });
  it('重複行が10行を超えると「ほか n行」、候補が5件を超えると「ほか n件」', () => {
    const many = Array.from({ length: 12 }, () => 'A.jpg');
    const res = m.runMatch(rows(...many), img('A.jpg'), DEF);
    expect(res.items[0]!.detail).toMatch(/12行で指定.*ほか2行/);
    const files = Array.from({ length: 7 }, (_, i) => ({ name: 'B.jpg', path: `d${i}/B.jpg` }));
    expect(m.runMatch(rows('B.jpg'), files, DEF).items[0]!.detail).toMatch(/7件あります.*ほか2件/);
  });
  it('未使用画像はパス順に並ぶ、サマリーの件数', () => {
    const res = m.runMatch(rows('A.jpg', ''), img('c.jpg', 'A.jpg', 'b.png'), DEF);
    expect(unusedOf(res)).toEqual(['b.png', 'c.jpg']);
    expect(res.summary).toEqual({
      csvRows: 2,
      specified: 1,
      images: 3,
      counts: { [S.OK]: 1, [S.MISSING]: 0, [S.UNUSED]: 2, [S.DUPLICATE]: 0, [S.MULTIPLE]: 0, [S.EMPTY]: 1 },
    });
    expect(res.options).toEqual(DEF);
  });
  it('サンプルデータ：正常2・画像不足1・未使用1・CSV内重複2', () => {
    const bytes = readFileSync(join(here, 'fixtures', 'sample_products.csv'));
    const t = csv.buildTable(csv.decodeCsvBytes(new Uint8Array(bytes), 'auto').text);
    const r = t.rows.map((x) => ({ rowNumber: x.rowNumber, id: x.fields[0], image: x.fields[2] }));
    const res = m.runMatch(r, img('A001.jpg', 'A002.jpg', 'A004.jpg', 'A006.jpg'), DEF);
    expect(res.summary.counts).toEqual({ [S.OK]: 2, [S.MISSING]: 1, [S.UNUSED]: 1, [S.DUPLICATE]: 2, [S.MULTIPLE]: 0, [S.EMPTY]: 0 });
    expect(res.items.map((x) => [x.rowNumber, x.id, x.status])).toEqual([
      [2, 'A001', S.DUPLICATE],
      [3, 'A002', S.OK],
      [4, 'A003', S.MISSING],
      [5, 'A004', S.OK],
      [6, 'A005', S.DUPLICATE],
      [null, '', S.UNUSED],
    ]);
  });
  it('規模：1000行 × 500画像を高速に照合', () => {
    const r = [];
    for (let i = 1; i <= 1000; i++) r.push({ rowNumber: i + 1, id: 'P' + i, image: `P${i}.jpg` });
    const im = [];
    for (let i = 1; i <= 500; i++) im.push({ name: `P${i}.jpg` });
    const t0 = Date.now();
    const res = m.runMatch(r, im, DEF);
    const ms = Date.now() - t0;
    expect(res.summary.counts[S.OK]).toBe(500);
    expect(res.summary.counts[S.MISSING]).toBe(500);
    expect(ms).toBeLessThan(500);
  });
});

describe('CommerceOps 追加: URL・商品マスタ', () => {
  it('imageNameFromValue：URL はパス部分（? # を除き %xx を戻す）、それ以外はそのまま', () => {
    expect(imageNameFromValue('https://cdn.example.com/img/A001.jpg?v=3#x')).toBe('/img/A001.jpg');
    expect(imageNameFromValue('https://cdn.example.com/img/%E5%B8%BD%E5%AD%90.png')).toBe('/img/帽子.png');
    expect(imageNameFromValue('https://cdn.example.com/img/%E0%A4%A.png')).toBe('/img/%E0%A4%A.png'); // 不正な %xx はそのまま
    expect(imageNameFromValue('images/A001.jpg')).toBe('images/A001.jpg');
    expect(imageNameFromValue('  A001.jpg ')).toBe('  A001.jpg ');
    expect(imageNameFromValue(null)).toBe('');
  });
  it('商品 CSV の image_url（URL）でも照合でき、結果には元の URL を表示する', () => {
    const t = csv.buildTable(
      'sku,name,variant,group_code,barcodes,weight_g,image_url,active\r\n' +
        'SKU-1,a,,,,,https://cdn.example.com/p/SKU-1.jpg?w=600,true\r\n' +
        'SKU-2,b,,,,,https://cdn.example.com/p/SKU-2.jpg,true\r\n' +
        'SKU-3,c,,,,,,true\r\n',
    );
    const gi = guessImageColumn(t.headers, t.rows);
    const gid = guessIdColumn(t.headers, gi);
    expect([gi, gid]).toEqual([6, 0]);
    const res = m.runMatch(tableToRows(t, gi, gid), img('SKU-1.jpg', 'extra.png'), DEF);
    expect(res.items.map((x) => [x.rowNumber, x.id, x.status])).toEqual([
      [2, 'SKU-1', S.OK],
      [3, 'SKU-2', S.MISSING],
      [4, 'SKU-3', S.EMPTY],
      [null, '', S.UNUSED],
    ]);
    expect(res.items[0]!.image).toBe('https://cdn.example.com/p/SKU-1.jpg?w=600');
    // パス無視 OFF なら URL のフォルダ部分が残るので一致しない（ヒント付き）
    const off = m.runMatch(tableToRows(t, gi, gid), img('SKU-1.jpg'), { ...DEF, ignorePath: false });
    expect(off.items[0]!.status).toBe(S.MISSING);
    expect(off.items[0]!.detail).toMatch(/パスを無視/);
  });
  it('tableToRows：識別列なし（-1）は空、足りない列は空欄扱い', () => {
    const t = csv.buildTable('a,b,c\r\n1,x.jpg\r\n');
    expect(tableToRows(t, 2, -1)).toEqual([{ rowNumber: 2, id: '', image: '', display: '' }]);
    expect(tableToRows(t, 1, 0)).toEqual([{ rowNumber: 2, id: '1', image: 'x.jpg', display: 'x.jpg' }]);
  });
  it('商品マスタ：image_url のファイル名で照合（SKU 表記の重複詳細・未使用の文言）', () => {
    const products = [
      { sku: 'A-1', imageUrl: 'https://cdn.example.com/a/shared.jpg' },
      { sku: 'A-2', imageUrl: 'https://cdn.example.com/b/shared.jpg' },
      { sku: 'B-1', imageUrl: 'https://cdn.example.com/B-1.png' },
      { sku: 'C-1', imageUrl: null },
      { sku: 'D-1', imageUrl: 'https://cdn.example.com/D-1.jpg' },
    ];
    const pr = productsToRows(products);
    expect(pr.map((r) => r.rowNumber)).toEqual([1, 2, 3, 4, 5]);
    const skuOf = new Map(pr.map((r) => [r.rowNumber, r.id as string]));
    const res = m.runMatch(
      pr,
      img('shared.jpg', 'b-1.PNG', 'D-1.jpg', 'D-1.png', 'orphan.webp'),
      { ...DEF, ignoreExtension: true },
      {
        rowLabel: (n) => `SKU ${skuOf.get(n)}`,
        rowUnit: '商品',
        unusedDetail: '商品マスタのどの商品でも使われていない画像です。',
      },
    );
    expect(res.items.map((x) => [x.id, x.status])).toEqual([
      ['A-1', S.DUPLICATE],
      ['A-2', S.DUPLICATE],
      ['B-1', S.OK],
      ['C-1', S.EMPTY],
      ['D-1', S.MULTIPLE],
      ['', S.UNUSED],
    ]);
    expect(res.items[0]!.detail).toMatch(/同じ画像名が2商品で指定されています（SKU A-1、SKU A-2）/);
    expect(res.items[5]!.detail).toBe('商品マスタのどの商品でも使われていない画像です。');
    expect(res.items[0]!.image).toBe('https://cdn.example.com/a/shared.jpg');
  });
});

describe('CommerceOps 追加: 画面の補助処理', () => {
  it('列ラベル', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
    expect(columnLabel(['商品コード', ''], 0)).toBe('A列：商品コード');
    expect(columnLabel(['商品コード', ''], 1)).toBe('B列：（列名なし）');
  });
  it('列の仮選択：列名 → 値の内容 → 見つからない', () => {
    expect(guessImageColumn(['商品コード', '商品名', '画像'], [])).toBe(2);
    expect(guessImageColumn(['code', 'x', 'y'], [{ fields: ['1', 'a', 'P1.jpg'] }, { fields: ['2', 'b', 'dir/P2.PNG'] }])).toBe(2);
    expect(guessImageColumn(['code', 'x'], [{ fields: ['1', 'a'] }])).toBe(-1);
    expect(guessIdColumn(['画像', '品番', 'code'], 0)).toBe(1);
    expect(guessIdColumn(['name', 'ID'], -1)).toBe(1);
    expect(guessIdColumn(['name', 'image'], 1)).toBe(-1);
  });
  it('選択ファイルの振り分け：対応形式・対応外・macOS 管理用', () => {
    const r = classifySelectedFiles([
      { name: 'A.jpg', webkitRelativePath: 'imgs/A.jpg' },
      { name: 'B.WEBP' },
      { name: 'memo.txt' },
      { name: 'C.gif' },
      { name: '._A.jpg', webkitRelativePath: 'imgs/._A.jpg' },
      { name: 'D.jpg', webkitRelativePath: 'imgs/__MACOSX/D.jpg' },
    ]);
    expect(r.images).toEqual([
      { name: 'A.jpg', path: 'imgs/A.jpg' },
      { name: 'B.WEBP', path: 'B.WEBP' },
    ]);
    expect(r.excluded).toEqual(['memo.txt', 'C.gif']);
    expect(r.systemFiles).toEqual(['imgs/._A.jpg', 'imgs/__MACOSX/D.jpg']);
  });
  it('絞り込みと検索（全角・半角、大文字小文字を区別しない）', () => {
    const res = m.runMatch(rows('A001.jpg', 'B002.jpg'), img('A001.jpg', 'Z.jpg'), DEF);
    expect(filterItems(res.items, 'all', '').length).toBe(3);
    expect(filterItems(res.items, S.MISSING, '').map((x) => x.image)).toEqual(['B002.jpg']);
    expect(filterItems(res.items, 'all', 'ａ００１').map((x) => x.image)).toEqual(['A001.jpg']);
    expect(filterItems(res.items, 'all', 'id2').map((x) => x.image)).toEqual(['B002.jpg']);
    expect(filterItems(res.items, S.OK, 'z')).toEqual([]);
    expect(normalizeForSearch('ＡＢＣ')).toBe('abc');
  });
  it('結果 CSV：全件 / 問題だけ、見出し、数式対策つきで出力', () => {
    const res = m.runMatch(rows('A.jpg', '=B.jpg'), img('A.jpg'), DEF);
    const all = resultCsvRows(res.items, false);
    expect(all[0]).toEqual(['CSV行番号', '識別値', '画像ファイル名', '判定', '詳細']);
    expect(all.length).toBe(3);
    const problems = resultCsvRows(res.items, true);
    expect(problems.map((r) => r[3])).toEqual(['判定', S.MISSING]);
    expect(csv.toCsvText(problems)).toContain("\r\n3,ID2,'=B.jpg,画像不足,");
    expect(resultCsvRows([], true, ['No.', 'SKU'])).toEqual([['No.', 'SKU']]);
  });
  it('todayString', () => {
    expect(todayString(new Date(2026, 0, 2))).toBe('2026-01-02');
  });
});
