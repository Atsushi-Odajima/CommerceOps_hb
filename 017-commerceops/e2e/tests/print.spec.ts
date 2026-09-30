import { expect, test } from '@playwright/test';
import { DEVICES, loginPage, packViaApi, receive, seed, shippedOrder, signupOrg, manualOrder, waveAndPick } from '../support/api.js';

/**
 * 帳票（Pick List・納品書・出荷作業票・返品受領票・注文識別コード・ロケーションラベル）を印刷用 HTML から PDF 化できる（ADR-015）。
 * 配送会社の公式送り状は作らない。
 */
test('printables render to PDF (pick list, packing slip, shipment sheet, return slip, order label, location labels)', async ({ browser, baseURL }) => {
  const errors: string[] = [];
  const { api: owner, email } = await signupOrg(baseURL!);
  const s = await seed(owner, ['PR-A', 'PR-B']);
  await receive(owner, s.locations.TKY['A-01']!.id, s.products['PR-A']!.id, 10);
  await receive(owner, s.locations.TKY['A-02']!.id, s.products['PR-B']!.id, 10);
  const shipped = await shippedOrder(owner, s, `PR-${Date.now()}`, [{ sku: 'PR-A', quantity: 1 }, { sku: 'PR-B', quantity: 2 }]);
  const o = await manualOrder(owner, s.channels.WEB, `PR2-${Date.now()}`, [{ sku: 'PR-B', quantity: 1 }]);
  await owner.post(`/orders/${o.id}/allocate`, {});
  const d = await owner.get(`/orders/${o.id}`);
  const waveId = await waveAndPick(owner, s.warehouses.TKY, [d.fulfillments[0].id]);
  await packViaApi(owner, d.fulfillments[0].id);
  const ret = await owner.post('/returns', { orderId: shipped.id, reasonCode: 'defective', items: [{ orderItemId: shipped.items[0].id, qty: 1 }] });
  const { ctx, page } = await loginPage(browser, email, DEVICES.pc, errors);
  const targets = {
    'pick-list': `/print/pick-list/${waveId}`,
    'packing-slip': `/print/packing-slip/${shipped.fulfillments[0].id}`,
    'shipment-sheet': `/print/shipment/${shipped.shipments[0].id}`,
    'return-slip': `/print/return/${ret.id}`,
    'order-label': `/print/order-label/${o.id}`,
    'location-labels': `/print/location-labels/${s.warehouses.TKY}`,
  };
  for (const [name, path] of Object.entries(targets)) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500); // バーコード描画
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    expect(pdf.subarray(0, 5).toString(), name).toBe('%PDF-');
    expect(pdf.length, name).toBeGreaterThan(3000);
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages, name).toBeGreaterThanOrEqual(1);
    // バーコード/QR が描画されている（img または svg / canvas）
    expect(await page.locator('.print-area img, .print-area svg, .print-area canvas, img[alt*="コード"], svg').count(), name).toBeGreaterThan(0);
    await page.emulateMedia({ media: 'screen' });
  }
  expect(errors).toEqual([]);
  await ctx.close();
});
