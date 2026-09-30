import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { PageHeader } from '../../components/ui';

export default function InventoryLayout() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="在庫・商品" sub="Fulfillment に必要な最小在庫台帳（OnHand / Allocated / 調査中 / Available）。仕入・本格棚卸は対象外です。" />
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
      </nav>
      <Outlet />
    </>
  );
}
