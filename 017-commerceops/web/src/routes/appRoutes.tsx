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

export const fieldRoutes: RouteObject[] = [];

export const printRoutes: RouteObject[] = [{ path: 'location-labels/:warehouseId', element: P('warehouses.manage', <LocationLabelsPrint />) }];
