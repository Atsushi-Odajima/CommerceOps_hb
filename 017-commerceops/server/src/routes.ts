import type { FastifyInstance } from 'fastify';
import { orgRoutes } from './modules/orgs/routes.js';
import { warehouseRoutes } from './modules/warehouses/routes.js';
import { productRoutes } from './modules/products/routes.js';
import { channelRoutes } from './modules/channels/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';

/** 業務モジュールのルート登録 */
export async function registerModuleRoutes(app: FastifyInstance) {
  await app.register(orgRoutes);
  await app.register(warehouseRoutes);
  await app.register(productRoutes);
  await app.register(channelRoutes);
  await app.register(dashboardRoutes);
}
