import { expect, test } from '@playwright/test';
import { Api, DEVICES, loginPage, PASSWORD, signupOrg } from '../support/api.js';

/** 自分のパスワード変更: 画面右上の「パスワード変更」→ 変更 → 新しいパスワードでだけログインできる */
test('account: change my own password from the top bar; the old password stops working', async ({ browser, baseURL }) => {
  const errors: string[] = [];
  const { email } = await signupOrg(baseURL!);
  const { ctx, page } = await loginPage(browser, email, DEVICES.pc, errors);
  await page.getByRole('button', { name: 'パスワード変更' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'パスワード変更' });
  await dialog.getByLabel('現在のパスワード').fill('wrong-password-1');
  await dialog.getByLabel('新しいパスワード', { exact: true }).fill('New-Passw0rd-2026-x');
  await dialog.getByLabel('新しいパスワード（確認）').fill('New-Passw0rd-2026-x');
  await dialog.getByRole('button', { name: '変更する' }).click();
  await expect(dialog.getByText('現在のパスワードが正しくありません')).toBeVisible();
  await dialog.getByLabel('現在のパスワード').fill(PASSWORD);
  await dialog.getByRole('button', { name: '変更する' }).click();
  await expect(page.getByText(/パスワードを変更しました/)).toBeVisible();
  // この端末はログインしたまま使える
  await page.goto('/orders');
  await expect(page).toHaveURL(/\/orders/);
  // 古いパスワードは使えず、新しいパスワードでログインできる
  await expect(Api.login(baseURL!, email, PASSWORD)).rejects.toThrow(/login .* failed: 401/);
  const api = await Api.login(baseURL!, email, 'New-Passw0rd-2026-x');
  expect((await api.get('/auth/me')).user.email).toBe(email);
  await api.dispose();
  expect(errors.filter((e) => !/status of 400/.test(e))).toEqual([]);
  await ctx.close();
});
