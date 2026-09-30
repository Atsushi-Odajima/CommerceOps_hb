import type { FastifyInstance } from 'fastify';
import { hasPerm, orgTx, requireOrg } from '../../http.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard/badges', async (req) => {
    const auth = requireOrg(req);
    if (!hasPerm(auth, 'exceptions.read')) return { exceptionsOpen: 0 };
    return orgTx(req, async (tx) => {
      const r = await tx.one(
        `SELECT count(*)::int AS n FROM exception_cases WHERE organization_id = $1 AND status IN ('open', 'investigating')`,
        [tx.orgId],
      );
      return { exceptionsOpen: r.n };
    });
  });
}
