import { expect, test } from '@playwright/test';
import { inviteUser, signupOrg } from '../support/api.js';
import { CAMERA_JAN } from '../global-setup.js';

/**
 * カメラ読取: Chromium の擬似カメラに EAN-13（JAN）の映像を流し、スマホ現場モードの「商品確認」でカメラボタン → ZXing で読み取れること。
 * （headless Chromium には BarcodeDetector がないため ZXing 経路。iOS Safari と同じ経路）
 */
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('camera scan: the in-browser ZXing decoder reads an EAN-13 from the (fake) camera and looks up the product', async ({ page, baseURL }) => {
  const { api: owner } = await signupOrg(baseURL!);
  await owner.post('/products', { sku: 'CAM-1', name: 'カメラ読取テスト商品', barcodes: [{ code: CAMERA_JAN }] });
  const picker = await inviteUser(owner, 'picker');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/login');
  await page.fill('#email', picker.email);
  await page.fill('#password', 'E2e-Passw0rd-2026');
  await page.click('button[type=submit]');
  await page.waitForURL(/\/m/);
  await page.goto('/m/lookup');
  await page.getByRole('button', { name: 'カメラで読み取る' }).click();
  await expect(page.getByRole('dialog', { name: 'カメラで読み取り' })).toBeVisible();
  await expect(page.getByText(/ZXing|BarcodeDetector/)).toBeVisible({ timeout: 15_000 });
  // 読み取れるとダイアログが閉じ、商品が表示される
  await expect(page.getByText('カメラ読取テスト商品')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('CAM-1').first()).toBeVisible();
  expect(errors).toEqual([]);
});
