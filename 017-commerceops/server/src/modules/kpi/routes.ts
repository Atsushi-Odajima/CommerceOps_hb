import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertWarehouse, hasPerm, orgTx, perm, requireOrg } from '../../http.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { contentDisposition, encodeCsv, toCsv } from '../../lib/csv.js';
import { parse } from '../../lib/validate.js';
import { audit } from '../audit/audit.js';
import { computeKpi } from './service.js';

const Query = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), warehouseId: z.uuid().optional() });

function resolvePeriod(req: FastifyRequest, q: z.infer<typeof Query>) {
  const auth = requireOrg(req);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: auth.org.timezone }).format(new Date());
  const to = q.to ?? today;
  const from = q.from ?? new Date(new Date(`${to}T00:00:00Z`).getTime() - 6 * 86400_000).toISOString().slice(0, 10);
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000;
  if (span < 0) throw badRequest('INVALID_PERIOD', '期間の開始が終了より後になっています');
  if (span > 366) throw badRequest('INVALID_PERIOD', '期間は最大 1 年（367 日）までです');
  if (q.warehouseId) assertWarehouse(req, q.warehouseId);
  const warehouseIds = q.warehouseId ? [q.warehouseId] : auth.warehouseIds;
  return { from, to, timezone: auth.org.timezone, warehouseIds };
}

export async function kpiRoutes(app: FastifyInstance) {
  app.get('/api/kpi', { preHandler: perm('kpi.read') }, async (req) => {
    const q = parse(Query, req.query);
    const p = resolvePeriod(req, q);
    return orgTx(req, (tx) => computeKpi(tx, p));
  });

  app.get('/api/kpi/export', { preHandler: perm('kpi.read') }, async (req, reply) => {
    const auth = requireOrg(req);
    if (!hasPerm(auth, 'export.csv')) throw forbidden();
    const q = parse(Query.extend({ encoding: z.enum(['utf-8', 'shift_jis']).default('utf-8') }), req.query);
    const p = resolvePeriod(req, q);
    const text = await orgTx(req, async (tx) => {
      const k = await computeKpi(tx, p);
      const summary = toCsv(
        ['指標', '値', '単位', '分子', '分母', '定義'],
        k.metrics.map((m) => [m.label, m.value ?? '', m.unit, m.numerator ?? '', m.denominator ?? '', m.definition]),
      );
      const daily = toCsv(['日付', '受注件数', '出荷件数（荷物）', '返品受付'], k.daily.map((d) => [d.date, d.orders, d.shipments, d.returns]));
      await audit(tx, { action: 'export.kpi', entityType: 'kpi', summary: `KPI CSV 出力（${p.from}〜${p.to}）`, metadata: { from: p.from, to: p.to } });
      return `期間,${p.from},${p.to},${p.timezone}\r\n\r\n${summary}\r\n${daily}`;
    });
    reply.header('content-type', `text/csv; charset=${q.encoding === 'shift_jis' ? 'Shift_JIS' : 'utf-8'}`);
    reply.header('content-disposition', contentDisposition(`kpi_${p.from}_${p.to}.csv`));
    return reply.send(encodeCsv(text, q.encoding));
  });
}
