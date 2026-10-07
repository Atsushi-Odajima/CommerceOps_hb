import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { PageHeader } from '../../components/ui';

export default function InventoryLayout() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="在庫・商品" sub="在庫台帳（OnHand / Allocated / 調査中 / Available）と、仕入先・発注・補充・棚卸。" />
      <nav className="tabs" aria-label="在庫・商品の項目">
        {can('inventory.read') && (
          <NavLink to="/inventory" end className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            在庫
          </NavLink>
        )}
        <NavLink to="/inventory/products" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
          商品
        </NavLink>
        {can('inventory.read') && (
          <NavLink to="/inventory/movements" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            在庫履歴
          </NavLink>
        )}
        {can('purchasing.read') && (
          <NavLink to="/inventory/purchase-orders" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            発注
          </NavLink>
        )}
        {can('purchasing.read') && (
          <NavLink to="/inventory/replenishment" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            補充
          </NavLink>
        )}
        {can('purchasing.read') && (
          <NavLink to="/inventory/suppliers" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            仕入先
          </NavLink>
        )}
        {(can('stocktake.count') || can('inventory.read')) && (
          <NavLink to="/inventory/stocktakes" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            棚卸
          </NavLink>
        )}
      </nav>
      <Outlet />
    </>
  );
}
