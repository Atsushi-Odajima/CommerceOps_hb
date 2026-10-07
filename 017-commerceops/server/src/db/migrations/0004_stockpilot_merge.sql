-- StockPilot(#013)の機能を CommerceOps へ統合するための追加（DECISIONS.md ADR-040）
-- 仕入先 / 発注（分納・発注残）/ 補充設定 / 棚卸 / 在庫の誤登録の取消

CREATE TABLE suppliers (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  contact text CHECK (contact IS NULL OR length(contact) <= 500),
  lead_time_days int CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 365),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, code)
);

-- 補充設定（商品ごと。すべて未入力 = 補充設定なし の行は作らない）
CREATE TABLE product_replenishment (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  product_id uuid NOT NULL,
  supplier_id uuid,
  safety_stock int NOT NULL CHECK (safety_stock >= 0),
  reorder_point int NOT NULL,
  target_stock int NOT NULL,
  order_multiple int NOT NULL DEFAULT 1 CHECK (order_multiple >= 1),
  min_order_qty int NOT NULL DEFAULT 0 CHECK (min_order_qty >= 0),
  lead_time_days int CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 365),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, product_id),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id),
  FOREIGN KEY (organization_id, supplier_id) REFERENCES suppliers(organization_id, id),
  CONSTRAINT product_replenishment_order CHECK (safety_stock <= reorder_point AND reorder_point < target_stock)
);

CREATE TABLE purchase_orders (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  po_number text NOT NULL,
  supplier_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  -- draft=下書き（発注残に含めない）/ placed=発注済み / cancelled=取消（入荷前のみ）
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'placed', 'cancelled')),
  expected_date date,
  note text CHECK (note IS NULL OR length(note) <= 1000),
  placed_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, po_number),
  FOREIGN KEY (organization_id, supplier_id) REFERENCES suppliers(organization_id, id),
  FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouses(organization_id, id)
);
CREATE INDEX purchase_orders_status_idx ON purchase_orders (organization_id, status, created_at DESC);

-- Q=ordered_qty, R=received_qty, C=closed_qty（未入荷打切り）, 発注残 O = Q − R − C
CREATE TABLE purchase_order_lines (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  line_no int NOT NULL,
  product_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  ordered_qty int NOT NULL CHECK (ordered_qty BETWEEN 1 AND 1000000),
  received_qty int NOT NULL DEFAULT 0,
  closed_qty int NOT NULL DEFAULT 0,
  close_reason text,
  basis_p int,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, purchase_order_id, line_no),
  FOREIGN KEY (organization_id, purchase_order_id) REFERENCES purchase_orders(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id),
  FOREIGN KEY (organization_id, warehouse_id, location_id) REFERENCES locations(organization_id, warehouse_id, id),
  CONSTRAINT purchase_order_lines_qty CHECK (received_qty >= 0 AND closed_qty >= 0 AND received_qty + closed_qty <= ordered_qty)
);
CREATE INDEX purchase_order_lines_product_idx ON purchase_order_lines (organization_id, product_id);

-- 棚卸（1セッション = 1ロケーション）。開始時の理論在庫を保存し、確定時に変化していれば停止する
CREATE TABLE stocktakes (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'review', 'confirmed', 'cancelled')),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  started_by uuid,
  confirmed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, warehouse_id, location_id) REFERENCES locations(organization_id, warehouse_id, id)
);
-- 1ロケーションに進行中の棚卸は1つだけ
CREATE UNIQUE INDEX stocktakes_open_location ON stocktakes (organization_id, location_id) WHERE status IN ('counting', 'review');

CREATE TABLE stocktake_lines (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  stocktake_id uuid NOT NULL,
  product_id uuid NOT NULL,
  expected_qty int NOT NULL CHECK (expected_qty >= 0),
  counted_qty int CHECK (counted_qty IS NULL OR counted_qty BETWEEN 0 AND 1000000000),
  reason text CHECK (reason IS NULL OR length(reason) <= 300),
  version int NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, stocktake_id, product_id),
  FOREIGN KEY (organization_id, stocktake_id) REFERENCES stocktakes(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id)
);

-- 誤登録の取消（反対方向の補償 movement）。1つの movement は1回だけ取り消せる
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_movement_type_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_movement_type_check CHECK (movement_type IN (
  'receipt', 'adjust', 'ship', 'restock', 'return_damaged', 'return_quarantine', 'discard',
  'hold', 'unhold', 'hold_loss', 'transfer_out', 'transfer_in', 'restore', 'reversal'));
ALTER TABLE inventory_movements ADD COLUMN reversal_of_movement_id uuid;
CREATE UNIQUE INDEX inventory_movements_reversal_once ON inventory_movements (organization_id, reversal_of_movement_id)
  WHERE reversal_of_movement_id IS NOT NULL;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers', 'product_replenishment', 'purchase_orders', 'purchase_order_lines', 'stocktakes', 'stocktake_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id())',
      t);
  END LOOP;
END
$$;
