import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { orgTx, perm, requireOrg } from '../../http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { IdParams, parse, zPage } from '../../lib/validate.js';
import { readUpload } from '../../lib/upload.js';
import { enqueue } from '../../jobs/queue.js';
import { cancelImport, commitImport, previewImport } from './service.js';

export async function importRoutes(app: FastifyInstance) {
  app.post('/api/imports/preview', { preHandler: perm('orders.import') }, async (req) => {
    const up = await readUpload(req);
    const profileId = up.fields.profileId;
    if (!profileId || !z.uuid().safeParse(profileId).success) throw badRequest('PROFILE_REQUIRED', 'Import Profile を選択してください');
    return orgTx(req, (tx) => previewImport(tx, req.server.deps, { profileId, filename: up.filename, buffer: up.buffer }));
  });

  app.get('/api/imports', { preHandler: perm('orders.import') }, async (req) => {
    const q = parse(zPage, req.query);
    return orgTx(req, async (tx) => {
      const total = (await tx.one(`SELECT count(*)::int AS n FROM import_batches WHERE organization_id = $1`, [tx.orgId])).n;
      const rows = await tx.many(
        `SELECT b.*, c.name AS channel_name, p.name AS profile_name, u.name AS created_by_name
           FROM import_batches b
           JOIN sales_channels c ON c.organization_id = b.organization_id AND c.id = b.channel_id
           JOIN import_profiles p ON p.organization_id = b.organization_id AND p.id = b.profile_id
           LEFT JOIN users u ON u.id = b.created_by
          WHERE b.organization_id = $1 ORDER BY b.created_at DESC LIMIT $2 OFFSET $3`,
        [tx.orgId, q.limit, q.offset],
      );
      return {
        total,
        items: rows.map((b) => ({
          id: b.id,
          batchNumber: b.batch_number,
          channelName: b.channel_name,
          profileName: b.profile_name,
          filename: b.filename,
          status: b.status,
          rowCount: b.row_count,
          orderCount: b.order_count,
          summary: b.summary,
          createdBy: b.created_by_name,
          createdAt: b.created_at,
          committedAt: b.committed_at,
        })),
      };
    });
  });

  app.get('/api/imports/:id', { preHandler: perm('orders.import') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    return orgTx(req, async (tx) => {
      const b = await tx.maybeOne(
        `SELECT b.*, c.name AS channel_name, p.name AS profile_name FROM import_batches b
           JOIN sales_channels c ON c.organization_id = b.organization_id AND c.id = b.channel_id
           JOIN import_profiles p ON p.organization_id = b.organization_id AND p.id = b.profile_id
          WHERE b.organization_id = $1 AND b.id = $2`,
        [tx.orgId, id],
      );
      if (!b) throw notFound('取込バッチ');
      return {
        id: b.id,
        batchNumber: b.batch_number,
        channelId: b.channel_id,
        channelName: b.channel_name,
        profileName: b.profile_name,
        profileVersion: b.profile_snapshot?.version,
        filename: b.filename,
        fileSha256: b.file_sha256,
        fileSize: b.file_size,
        encoding: b.encoding,
        status: b.status,
        rowCount: b.row_count,
        orderCount: b.order_count,
        lineCount: b.line_count,
        totalQty: b.total_qty,
        summary: b.summary,
        createdAt: b.created_at,
        committedAt: b.committed_at,
      };
    });
  });

  app.get('/api/imports/:id/orders', { preHandler: perm('orders.import') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const q = parse(
      zPage.extend({ classification: z.enum(['new', 'identical', 'update_candidate', 'conflict', 'cancel_candidate', 'invalid']).optional() }),
      req.query,
    );
    const pii = auth.permissions.has('orders.read_pii');
    return orgTx(req, async (tx) => {
      const params: unknown[] = [tx.orgId, id];
      let where = 'organization_id = $1 AND batch_id = $2';
      if (q.classification) {
        params.push(q.classification);
        where += ` AND classification = $${params.length}`;
      }
      const total = (await tx.one(`SELECT count(*)::int AS n FROM import_batch_orders WHERE ${where}`, params)).n;
      params.push(q.limit, q.offset);
      const rows = await tx.many(
        `SELECT * FROM import_batch_orders WHERE ${where} ORDER BY (CASE classification WHEN 'invalid' THEN 0 WHEN 'conflict' THEN 1 WHEN 'cancel_candidate' THEN 2 WHEN 'update_candidate' THEN 3 WHEN 'new' THEN 4 ELSE 5 END), seq
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return {
        total,
        items: rows.map((r) => {
          const n = r.normalized;
          return {
            id: r.id,
            externalOrderId: r.external_order_id,
            classification: r.classification,
            existingOrderId: r.existing_order_id,
            errors: r.errors,
            warnings: r.warnings,
            rowNumbers: r.row_numbers,
            result: r.result,
            resultOrderId: r.result_order_id,
            changed: n?.changed ?? [],
            orderDate: n?.orderDate,
            recipientName: pii ? n?.shipTo?.name : undefined,
            prefecture: pii ? n?.shipTo?.prefecture : undefined,
            shippingMethod: n?.shippingMethod,
            lines: n?.lines?.map((l: any) => ({ sku: l.sku, quantity: l.quantity, productName: l.productName })) ?? [],
          };
        }),
      };
    });
  });

  app.post('/api/imports/:id/commit', { preHandler: perm('orders.import') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ applyUpdateIds: z.array(z.uuid()).max(10000).default([]) }), req.body ?? {});
    const result = await orgTx(req, (tx) => commitImport(tx, req.server.deps, id, body));
    let allocationJobId: number | null = null;
    if (!result.alreadyCommitted && result.created > 0 && auth.org.settings.allocation.autoAllocateOnImport) {
      const j = await enqueue(req.server.deps.pool, {
        type: 'allocation.run',
        organizationId: auth.org.id,
        payload: { trigger: 'import', userId: auth.userId },
        dedupeKey: `allocation:${auth.org.id}`,
      });
      allocationJobId = j.id;
    }
    return { ...result, allocationJobId };
  });

  app.post('/api/imports/:id/cancel', { preHandler: perm('orders.import') }, async (req) => {
    const { id } = parse(IdParams, req.params);
    await orgTx(req, (tx) => cancelImport(tx, id));
    return { ok: true };
  });
}
