import { lazy, Suspense, type ReactNode } from 'react';
import type { RouteObject } from 'react-router';
import { Loading } from '../components/ui';
import { RequirePerm } from './guards';

const HomePage = lazy(() => import('../pages/HomePage'));
const SettingsLayout = lazy(() => import('../pages/settings/SettingsLayout'));
const SettingsIndex = lazy(() => import('../pages/settings/SettingsLayout').then((m) => ({ default: m.SettingsIndex })));
const OrgSettingsPage = lazy(() => import('../pages/settings/OrgSettingsPage'));
const WarehousesPage = lazy(() => import('../pages/settings/WarehousesPage'));
const UsersPage = lazy(() => import('../pages/settings/UsersPage'));
const ChannelsPage = lazy(() => import('../pages/settings/ChannelsPage'));
const ImportProfilesPage = lazy(() => import('../pages/settings/ImportProfilesPage'));
const ImportProfileEditor = lazy(() => import('../pages/settings/ImportProfilesPage').then((m) => ({ default: m.ImportProfileEditor })));
const InventoryLayout = lazy(() => import('../pages/inventory/InventoryLayout'));
const ProductsPage = lazy(() => import('../pages/inventory/ProductsPage'));
const LocationLabelsPrint = lazy(() => import('../print/LocationLabelsPrint'));
const ImportsPage = lazy(() => import('../pages/imports/ImportPages'));
const NewImportPage = lazy(() => import('../pages/imports/ImportPages').then((m) => ({ default: m.NewImportPage })));
const ImportDetailPage = lazy(() => import('../pages/imports/ImportPages').then((m) => ({ default: m.ImportDetailPage })));
const OrdersPage = lazy(() => import('../pages/orders/OrdersPage'));
const OrderDetailPage = lazy(() => import('../pages/orders/OrderDetailPage'));
const NewOrderPage = lazy(() => import('../pages/orders/NewOrderPage'));
const AllocationPage = lazy(() => import('../pages/allocation/AllocationPage'));
const InventoryPage = lazy(() => import('../pages/inventory/InventoryPage'));
const MovementsPage = lazy(() => import('../pages/inventory/InventoryPage').then((m) => ({ default: m.MovementsPage })));
const WavesPage = lazy(() => import('../pages/waves/WavePages'));
const WaveCreatePage = lazy(() => import('../pages/waves/WavePages').then((m) => ({ default: m.WaveCreatePage })));
const WaveDetailPage = lazy(() => import('../pages/waves/WavePages').then((m) => ({ default: m.WaveDetailPage })));
const FulfillmentsPage = lazy(() => import('../pages/waves/WavePages').then((m) => ({ default: m.FulfillmentsPage })));
const MobileHome = lazy(() => import('../mobile/MobileHome'));
const TaskListPage = lazy(() => import('../mobile/MobileHome').then((m) => ({ default: m.TaskListPage })));
const PickMode = lazy(() => import('../mobile/PickMode'));
const ProductLookup = lazy(() => import('../mobile/ProductLookup'));
const FieldReport = lazy(() => import('../mobile/FieldReport'));
const PickListPrint = lazy(() => import('../print/PickListPrint'));
const OrderLabelPrint = lazy(() => import('../print/OrderLabelPrint'));
const PackHome = lazy(() => import('../pages/pack/PackPages'));
const PackStation = lazy(() => import('../pages/pack/PackPages').then((m) => ({ default: m.PackStation })));
const PackingSlipPrint = lazy(() => import('../print/PackingSlipPrint'));

const S = (el: ReactNode) => <Suspense fallback={<Loading />}>{el}</Suspense>;
const P = (perm: string | string[], el: ReactNode) => S(<RequirePerm perm={perm}>{el}</RequirePerm>);

export const appRoutes: RouteObject[] = [
  { index: true, element: S(<HomePage />) },
  { path: 'imports', element: P('orders.import', <ImportsPage />) },
  { path: 'imports/new', element: P('orders.import', <NewImportPage />) },
  { path: 'imports/:id', element: P('orders.import', <ImportDetailPage />) },
  { path: 'orders', element: P('orders.read', <OrdersPage />) },
  { path: 'orders/new', element: P('orders.import', <NewOrderPage />) },
  { path: 'orders/:id', element: P('orders.read', <OrderDetailPage />) },
  { path: 'allocation', element: P('allocation.manage', <AllocationPage />) },
  { path: 'fulfillments', element: P(['fulfillment.manage', 'waves.manage'], <FulfillmentsPage />) },
  { path: 'waves', element: P(['waves.read', 'waves.manage'], <WavesPage />) },
  { path: 'waves/new', element: P('waves.manage', <WaveCreatePage />) },
  { path: 'waves/:id', element: P(['waves.read', 'waves.manage'], <WaveDetailPage />) },
  { path: 'pack', element: P(['pack.execute', 'fulfillment.manage'], <PackHome />) },
  { path: 'pack/:sessionId', element: P(['pack.execute', 'fulfillment.manage'], <PackStation />) },
  {
    path: 'settings',
    element: S(<SettingsLayout />),
    children: [
      { index: true, element: S(<SettingsIndex />) },
      { path: 'organization', element: P('org.manage', <OrgSettingsPage />) },
      { path: 'warehouses', element: P('warehouses.manage', <WarehousesPage />) },
      { path: 'users', element: P('users.manage', <UsersPage />) },
      { path: 'channels', element: P('channels.manage', <ChannelsPage />) },
      { path: 'import-profiles', element: P('channels.manage', <ImportProfilesPage />) },
      { path: 'import-profiles/:id', element: P('channels.manage', <ImportProfileEditor />) },
    ],
  },
  {
    path: 'inventory',
    element: P(['inventory.read', 'products.read'], <InventoryLayout />),
    children: [
      { index: true, element: P('inventory.read', <InventoryPage />) },
      { path: 'products', element: S(<ProductsPage />) },
      { path: 'movements', element: P('inventory.read', <MovementsPage />) },
    ],
  },
];

export const fieldRoutes: RouteObject[] = [
  { index: true, element: S(<MobileHome />) },
  { path: 'tasks', element: P('pick.execute', <TaskListPage />) },
  { path: 'pick/:taskId', element: P('pick.execute', <PickMode />) },
  { path: 'lookup', element: P('products.read', <ProductLookup />) },
  { path: 'report', element: P('exceptions.report', <FieldReport />) },
];

export const printRoutes: RouteObject[] = [
  { path: 'location-labels/:warehouseId', element: P('warehouses.manage', <LocationLabelsPrint />) },
  { path: 'pick-list/:waveId', element: P(['waves.read', 'waves.manage'], <PickListPrint />) },
  { path: 'order-label/:id', element: P('orders.read', <OrderLabelPrint />) },
  { path: 'packing-slip/:fulfillmentId', element: P(['pack.execute', 'fulfillment.manage'], <PackingSlipPrint />) },
];
