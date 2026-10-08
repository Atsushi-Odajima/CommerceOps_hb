import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { devices, expect, test, type Page } from '@playwright/test';
import { asciiTempPath, DEVICES, expectNoHorizontalOverflow, loginPage, signupOrg } from '../support/api.js';

/**
 * CommerceOps 商品画像チェック（ADR-041。#006 商品CSV × 商品画像 照合ツールの統合）
 * 商品画面・商品 CSV 取込から開き、CSV と画像を選択 → 6 分類の結果・絞り込み・検索・CSV 保存 → 登録済み商品マスタの照合。
 * ファイルはサーバーへ送信しない（照合中に /api への GET 以外の通信が無いこと）。
 */
const SAMPLE_CSV =
  '﻿商品コード,商品名,画像\r\nA001,黒Tシャツ,A001.jpg\r\nA002,白Tシャツ,A002.jpg\r\nA003,青Tシャツ,A003.jpg\r\nA004,帽子,A004.jpg\r\nA005,バッグ,A001.jpg\r\n';
const jpg = (name: string) => ({ name, mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });

async function counts(page: Page) {
  const out: Record<string, string> = {};
  for (const el of await page.locator('[data-testid=ic-summary] [data-status]').all()) {
    out[(await el.getAttribute('data-status'))!] = (await el.textContent())!.trim();
  }
  return out;
}

test('product image check: CSV + image files → six categories, filter, search, CSV export, options; existing product master check; nothing is uploaded', async ({
  browser,
  baseURL,
}) => {
  const { api: owner, email } = await signupOrg(baseURL!);
  await owner.post('/products', { sku: 'IC-A', name: '画像あり A', imageUrl: 'https://cdn.example.com/p/IC-A.jpg?v=2' });
  await owner.post('/products', { sku: 'IC-B', name: '画像あり B', imageUrl: 'https://cdn.example.com/p/IC-B.jpg' });
  await owner.post('/products', { sku: 'IC-C', name: '画像なし C' });

  const errors: string[] = [];
  const { ctx, page } = await loginPage(browser, email, DEVICES.pc, errors);
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') sent.push(`${r.method()} ${r.url()}`);
  });

  // 商品 CSV 取込の画面から開ける
  await page.goto('/inventory/products');
  await expect(page.getByRole('link', { name: '商品画像チェック' })).toBeVisible();
  await page.getByRole('button', { name: 'CSV 取込' }).click();
  await page.getByRole('link', { name: 'CommerceOps 商品画像チェック' }).click();
  await expect(page).toHaveURL(/\/inventory\/products\/image-check$/);
  await expect(page.getByRole('heading', { name: 'CommerceOps 商品画像チェック' })).toBeVisible();

  // 1. CSV（#006 のサンプルと同じ内容）→ 画像列・識別列の仮選択
  await page.setInputFiles('#ic-csv', { name: 'sample_products.csv', mimeType: 'text/csv', buffer: Buffer.from(SAMPLE_CSV, 'utf8') });
  await expect(page.getByTestId('ic-csv-info')).toContainText('データ行数：5行');
  await expect(page.locator('#ic-image-col')).toHaveValue('2');
  await expect(page.locator('#ic-id-col')).toHaveValue('0');

  // 画像を選ばずにチェック → エラー
  await page.getByRole('button', { name: 'チェックする' }).click();
  await expect(page.getByText('商品画像が選択されていません')).toBeVisible();

  // 2. 画像（対応外の memo.txt は除外）
  await page.setInputFiles('#ic-images', [
    jpg('A001.jpg'),
    jpg('A002.jpg'),
    jpg('A004.jpg'),
    jpg('A006.jpg'),
    { name: 'memo.txt', mimeType: 'text/plain', buffer: Buffer.from('x') },
  ]);
  await expect(page.getByTestId('ic-image-info')).toContainText('照合する画像：4件');
  await expect(page.getByText(/対応形式ではないファイルが1件/)).toBeVisible();

  // 3. チェック → サンプルどおり 正常2・画像不足1・未使用1・CSV内重複2
  await page.getByRole('button', { name: 'チェックする' }).click();
  await expect.poll(() => counts(page)).toEqual({ 正常: '2', 画像不足: '1', 未使用画像: '1', CSV内重複: '2', 複数候補: '0', 画像指定なし: '0' });
  const table = page.getByTestId('ic-result');
  await expect(table.locator('tbody tr')).toHaveCount(6);

  // 絞り込み・検索
  await page.getByRole('button', { name: '画像不足 1', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody tr').first()).toContainText('A003');
  await page.getByRole('button', { name: /^すべて/ }).click();
  await page.fill('#ic-search', 'ａ００６'); // 全角でも検索できる
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody tr').first()).toContainText('未使用画像');
  await page.fill('#ic-search', '');

  // CSV 保存（問題だけ）: BOM 付き、見出し + 正常以外 4 件
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '問題だけCSV保存' }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^image_check_csv_problems_\d{4}-\d{2}-\d{2}\.csv$/);
  const saved = readFileSync((await dl.path())!, 'utf8');
  expect(saved.charCodeAt(0)).toBe(0xfeff);
  const lines = saved.slice(1).trim().split('\r\n');
  expect(lines[0]).toBe('CSV行番号,識別値,画像ファイル名,判定,詳細');
  expect(lines.length).toBe(5);
  expect(lines.some((l) => l.startsWith('4,A003,A003.jpg,画像不足,'))).toBe(true);

  // 比較設定を変えると結果が自動で更新される（拡張子無視: A001.jpg → 候補 1 件のまま）
  await page.getByLabel(/拡張子を無視して照合/).check();
  await expect(page.getByText('比較設定が変わったため、結果を更新しました。')).toBeVisible();

  // フォルダごと選択: 別フォルダに同名の画像 → 複数候補
  const dir = asciiTempPath('imgs');
  for (const sub of ['x', 'y']) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, 'A001.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  await page.setInputFiles('#ic-folder', dir);
  await expect(page.getByTestId('ic-image-info')).toContainText('フォルダごと選択');
  await page.getByRole('button', { name: 'チェックする' }).click();
  await expect.poll(async () => (await counts(page))['複数候補']).toBe('2');
  await expect(table).toContainText(/imgs\/[xy]\/A001\.jpg、[^。]*imgs\/[xy]\/A001\.jpg。/);

  // 登録済みの商品マスタ: image_url のファイル名で照合
  await page.setInputFiles('#ic-images', [jpg('IC-A.jpg'), jpg('orphan.webp')]);
  await page.getByLabel(/拡張子を無視して照合/).uncheck();
  await page.getByLabel('登録済みの商品マスタ').check();
  await page.getByRole('button', { name: '商品マスタを読み込む' }).click();
  await expect(page.getByTestId('ic-master-info')).toContainText('商品 3件');
  await expect(page.getByTestId('ic-master-info')).toContainText('画像URLあり 2件');
  await page.getByRole('button', { name: 'チェックする' }).click();
  await expect.poll(() => counts(page)).toEqual({ 正常: '1', 画像不足: '1', 未使用画像: '1', CSV内重複: '0', 複数候補: '0', 画像指定なし: '1' });
  await expect(table.locator('tbody tr', { hasText: 'IC-B' })).toContainText('画像不足');
  await expect(table.locator('tbody tr', { hasText: 'orphan.webp' })).toContainText('商品マスタのどの商品でも使われていない画像です。');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '全結果をCSV保存' }).click()]);
  expect(dl2.suggestedFilename()).toMatch(/^image_check_master_\d{4}-\d{2}-\d{2}\.csv$/);
  expect(readFileSync((await dl2.path())!, 'utf8')).toContain('No.,SKU,画像（image_url）,判定,詳細');

  // アクセシビリティ（重大・深刻な違反なし）
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = axe.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(bad, bad.join('\n')).toEqual([]);

  // ファイルはサーバーへ送信していない（照合中の通信は商品一覧の GET のみ）
  expect(sent).toEqual([]);
  await ctx.close();

  // スマホ幅でも横にはみ出さない
  const phone = await loginPage(browser, email, devices['iPhone 14'], errors);
  await phone.page.goto('/inventory/products/image-check');
  await expect(phone.page.getByRole('heading', { name: 'CommerceOps 商品画像チェック' })).toBeVisible();
  await expectNoHorizontalOverflow(phone.page);
  await phone.ctx.close();
  expect(errors).toEqual([]);
});
