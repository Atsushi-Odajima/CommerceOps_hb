import type { FastifyInstance } from 'fastify';
import { orgRoutes } from './modules/orgs/routes.js';
import { warehouseRoutes } from './modules/warehouses/routes.js';
import { productRoutes } from './modules/products/routes.js';
import { channelRoutes } from './modules/channels/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { orderRoutes } from './modules/orders/routes.js';
import { importRoutes } from './modules/imports/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { allocationRoutes } from './modules/allocation/routes.js';
import { waveRoutes } from './modules/waves/routes.js';
import { exceptionRoutes } from './modules/exceptions/routes.js';
import { packingRoutes } from './modules/packing/routes.js';
import { shipmentRoutes } from './modules/shipments/routes.js';
import { returnRoutes } from './modules/returns/routes.js';
import './jobs/register.js';

/** 業務モジュールのルート登録 */
export async function registerModuleRoutes(app: FastifyInstance) {
  await app.register(orgRoutes);
  await app.register(warehouseRoutes);
  await app.register(productRoutes);
  await app.register(channelRoutes);
  await app.register(dashboardRoutes);
  await app.register(orderRoutes);
  await app.register(importRoutes);
  await app.register(inventoryRoutes);
  await app.register(allocationRoutes);
  await app.register(waveRoutes);
  await app.register(exceptionRoutes);
  await app.register(packingRoutes);
  await app.register(shipmentRoutes);
  await app.register(returnRoutes);
}
