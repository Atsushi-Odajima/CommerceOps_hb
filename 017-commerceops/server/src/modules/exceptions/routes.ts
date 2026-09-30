import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canAccessWarehouse, orgTx, perm, requireOrg } from '../../http.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { resolveProductByCode } from '../products/routes.js';
import { createException } from './service.js';

export const FIELD_REPORT_CATEGORIES = ['damaged', 'location_issue', 'barcode_unreadable', 'missing_item', 'safety', 'other'] as const;

const CATEGORY_LABEL: Record<(typeof FIELD_REPORT_CATEGORIES)[number], string> = {
  damaged: '破損品',
  location_issue: 'ロケーションの問題',
  barcode_unreadable: 'バーコード読取不可',
  missing_item: '商品が見当たらない',
  safety: '安全上の問題',
  other: 'その他',
};

export async function exceptionRoutes(app: FastifyInstance) {
  /**
   * 現場からの例外報告（Picker / Packer 等）。個人情報は入力しない前提で、メモは 500 文字まで。
   * requestId により二重送信は同じ例外にまとめる。
   */
  app.post('/api/exceptions/report', { preHandler: perm('exceptions.report') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(
      z.object({
        category: z.enum(FIELD_REPORT_CATEGORIES),
        note: z.string().trim().max(500).default(''),
        code: z.string().trim().max(128).optional(),
        warehouseId: z.uuid().optional(),
        pickTaskId: z.uuid().optional(),
        requestId: z.string().trim().min(8).max(64),
      }),
      req.body,
    );
    return orgTx(req, async (tx) => {
      let warehouseId = body.warehouseId ?? null;
      let waveId: string | null = null;
      if (body.pickTaskId) {
        const t = await tx.maybeOne(`SELECT warehouse_id, wave_id FROM pick_tasks WHERE organization_id = $1 AND id = $2`, [tx.orgId, body.pickTaskId]);
        if (!t) throw notFound('Pick タスク');
        warehouseId = t.warehouse_id;
        waveId = t.wave_id;
      }
      if (warehouseId && !canAccessWarehouse(auth, warehouseId)) throw forbidden('この倉庫へのアクセス権限がありません');
      if (warehouseId) {
        const wh = await tx.maybeOne(`SELECT 1 FROM warehouses WHERE organization_id = $1 AND id = $2`, [tx.orgId, warehouseId]);
        if (!wh) throw notFound('倉庫');
      }
      let productId: string | null = null;
      let locationId: string | null = null;
      if (body.code) {
        const p = await resolveProductByCode(tx, body.code);
        if (p) productId = p.id;
        else {
          const loc = await tx.maybeOne(
            `SELECT id, warehouse_id FROM locations WHERE organization_id = $1 AND barcode = $2 AND ($3::uuid IS NULL OR warehouse_id = $3)
              AND ($4::uuid[] IS NULL OR warehouse_id = ANY($4)) ORDER BY code LIMIT 1`,
            [tx.orgId, body.code, warehouseId, auth.warehouseIds],
          );
          if (loc) {
            locationId = loc.id;
            warehouseId ??= loc.warehouse_id;
          }
        }
      }
      const r = await createException(tx, req.server.deps, {
        type: 'field_report',
        severity: body.category === 'safety' ? 'high' : 'medium',
        title: `現場報告: ${CATEGORY_LABEL[body.category]}`,
        detail: { category: body.category, note: body.note || undefined, code: body.code, reporterRole: auth.role },
        dedupeKey: `field:${auth.userId}:${body.requestId}`,
        productId,
        locationId,
        warehouseId,
        pickTaskId: body.pickTaskId ?? null,
        waveId,
      });
      return { id: r.id, created: r.created };
    });
  });
}
