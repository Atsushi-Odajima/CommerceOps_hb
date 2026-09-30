-- CommerceOps schema v1
-- 全業務テーブル: organization_id + (organization_id, id) 複合 PK、複合 FK、RLS ENABLE + FORCE。
-- 詳細は docs/DATA_MODEL.md

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- ------------------------------------------------------------------
-- helper functions
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_org_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;

-- UUIDv7（SQL 側で行を生成する場合: 負荷試験データ生成など）
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  ts bytea;
  b bytea;
BEGIN
  ts := substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  b := ts || substring(uuid_send(gen_random_uuid()) FROM 7 FOR 10);
  b := set_byte(b, 6, (b'0111' || get_byte(b, 6)::bit(4))::bit(8)::int);
  b := set_byte(b, 8, (b'10' || get_byte(b, 8)::bit(6))::bit(8)::int);
  RETURN encode(b, 'hex')::uuid;
END
$$;

-- ------------------------------------------------------------------
-- global tables (RLS なし: 認証・システム用。アクセスは auth/system コードに限定)
-- ------------------------------------------------------------------
CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  timezone text NOT NULL DEFAULT 'Asia/Tokyo',
  is_sample boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  password_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'invited')),
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  password_changed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'ops_manager', 'picker', 'packer', 'support')),
  warehouse_ids uuid[],
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  role text NOT NULL CHECK (role IN ('owner', 'ops_manager', 'picker', 'packer', 'support')),
  warehouse_ids uuid[],
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_org_idx ON invitations (organization_id, created_at DESC);

CREATE TABLE password_resets (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE security_events (
  id uuid PRIMARY KEY,
  user_id uuid,
  email_hash text,
  event_type text NOT NULL,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_created_idx ON security_events (created_at DESC);

CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  dedupe_key text,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_by text,
  locked_at timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX jobs_dedupe_active_uq ON jobs (dedupe_key)
  WHERE status IN ('queued', 'running') AND dedupe_key IS NOT NULL;
CREATE INDEX jobs_queue_idx ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX jobs_org_idx ON jobs (organization_id, created_at DESC);

-- ------------------------------------------------------------------
-- tenant tables
-- ------------------------------------------------------------------
CREATE TABLE counters (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, name)
);

CREATE TABLE warehouses (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{1,20}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  postal_code text,
  address text,
  timezone text NOT NULL DEFAULT 'Asia/Tokyo',
  business_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  cutoff_time time NOT NULL DEFAULT '15:00',
  priority int NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, code)
);

CREATE TABLE locations (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  barcode text NOT NULL CHECK (length(barcode) BETWEEN 1 AND 64),
  zone text,
  kind text NOT NULL DEFAULT 'pick' CHECK (kind IN ('pick', 'quarantine', 'damaged')),
  pick_sequence int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, warehouse_id, id),
  UNIQUE (organization_id, warehouse_id, code),
  UNIQUE (organization_id, warehouse_id, barcode),
  FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouses(organization_id, id)
);

CREATE TABLE products (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  sku text NOT NULL CHECK (length(sku) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  variant text,
  group_code text,
  image_url text CHECK (image_url IS NULL OR image_url ~ '^https://[^\s<>"'']+$'),
  weight_g int CHECK (weight_g IS NULL OR weight_g >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, sku)
);
CREATE INDEX products_name_trgm ON products USING gin (organization_id, name gin_trgm_ops);

CREATE TABLE product_barcodes (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  product_id uuid NOT NULL,
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 128),
  symbology text NOT NULL DEFAULT 'other'
    CHECK (symbology IN ('ean13', 'ean8', 'upca', 'code128', 'code39', 'itf', 'qr', 'other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, code),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX product_barcodes_product_idx ON product_barcodes (organization_id, product_id);

CREATE TABLE sales_channels (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  type text NOT NULL CHECK (type IN ('shopify', 'amazon', 'rakuten', 'base', 'stores', 'own_site', 'wholesale', 'manual', 'other')),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{1,16}$'),
  connector_type text NOT NULL DEFAULT 'csv' CHECK (connector_type IN ('csv', 'manual', 'api')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, code)
);

CREATE TABLE customers (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  channel_id uuid,
  external_customer_id text,
  name text,
  email text,
  phone text,
  postal_code text,
  prefecture text,
  city text,
  address1 text,
  address2 text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, channel_id) REFERENCES sales_channels(organization_id, id)
);
CREATE INDEX customers_email_idx ON customers (organization_id, lower(email));
CREATE INDEX customers_ext_idx ON customers (organization_id, channel_id, external_customer_id);

CREATE TABLE import_profiles (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  channel_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  encoding text NOT NULL DEFAULT 'utf-8' CHECK (encoding IN ('utf-8', 'shift_jis')),
  delimiter text NOT NULL DEFAULT ',' CHECK (delimiter IN (',', E'\t')),
  has_header boolean NOT NULL DEFAULT true,
  skip_rows int NOT NULL DEFAULT 0 CHECK (skip_rows BETWEEN 0 AND 20),
  date_format text NOT NULL DEFAULT 'yyyy-MM-dd HH:mm:ss',
  timezone text NOT NULL DEFAULT 'Asia/Tokyo',
  mapping jsonb NOT NULL,
  invalid_policy text NOT NULL DEFAULT 'import_as_validation_required'
    CHECK (invalid_policy IN ('skip', 'import_as_validation_required')),
  version int NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, channel_id) REFERENCES sales_channels(organization_id, id)
);

CREATE TABLE import_batches (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  batch_number text NOT NULL,
  channel_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  profile_snapshot jsonb NOT NULL,
  filename text NOT NULL,
  file_sha256 text NOT NULL,
  file_size int NOT NULL,
  encoding text NOT NULL,
  status text NOT NULL CHECK (status IN ('previewed', 'committed', 'cancelled', 'failed', 'expired')),
  row_count int NOT NULL DEFAULT 0,
  order_count int NOT NULL DEFAULT 0,
  line_count int NOT NULL DEFAULT 0,
  total_qty int NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_by uuid,
  committed_at timestamptz,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, batch_number),
  FOREIGN KEY (organization_id, channel_id) REFERENCES sales_channels(organization_id, id),
  FOREIGN KEY (organization_id, profile_id) REFERENCES import_profiles(organization_id, id)
);
CREATE UNIQUE INDEX import_batches_file_uq ON import_batches (organization_id, file_sha256) WHERE status = 'committed';
CREATE INDEX import_batches_created_idx ON import_batches (organization_id, created_at DESC);

CREATE TABLE import_batch_orders (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  batch_id uuid NOT NULL,
  seq int NOT NULL,
  external_order_id text NOT NULL,
  classification text NOT NULL
    CHECK (classification IN ('new', 'identical', 'update_candidate', 'conflict', 'cancel_candidate', 'invalid')),
  existing_order_id uuid,
  content_hash text,
  normalized jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_numbers int[] NOT NULL DEFAULT '{}',
  decision text CHECK (decision IN ('import', 'skip', 'apply_update')),
  result text,
  result_order_id uuid,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, batch_id) REFERENCES import_batches(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX import_batch_orders_batch_idx ON import_batch_orders (organization_id, batch_id, seq);

CREATE TABLE orders (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  order_number text NOT NULL,
  channel_id uuid NOT NULL,
  external_order_id text NOT NULL CHECK (length(external_order_id) BETWEEN 1 AND 100),
  order_type text NOT NULL DEFAULT 'standard' CHECK (order_type IN ('standard', 'replacement')),
  source_order_id uuid,
  exchange_id uuid,
  order_date timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN (
    'imported', 'validation_required', 'ready_for_allocation', 'partially_allocated', 'allocated', 'on_hold',
    'picking', 'picked', 'packing', 'packed', 'partially_shipped', 'shipped', 'cancelled',
    'return_in_progress', 'closed')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  customer_id uuid,
  customer_name text,
  customer_email text,
  customer_phone text,
  recipient_name text,
  postal_code text,
  prefecture text,
  city text,
  address1 text,
  address2 text,
  recipient_phone text,
  shipping_method text,
  notes text,
  priority int NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 9),
  due_at timestamptz,
  import_batch_id uuid,
  content_hash text,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_qty int NOT NULL DEFAULT 0,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  closed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, order_number),
  UNIQUE (organization_id, channel_id, external_order_id),
  FOREIGN KEY (organization_id, channel_id) REFERENCES sales_channels(organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id),
  FOREIGN KEY (organization_id, import_batch_id) REFERENCES import_batches(organization_id, id),
  FOREIGN KEY (organization_id, source_order_id) REFERENCES orders(organization_id, id)
);
CREATE INDEX orders_status_date_idx ON orders (organization_id, status, order_date DESC);
CREATE INDEX orders_date_idx ON orders (organization_id, order_date DESC);
CREATE INDEX orders_created_idx ON orders (organization_id, created_at DESC);
CREATE INDEX orders_ext_idx ON orders (organization_id, external_order_id);
CREATE INDEX orders_postal_idx ON orders (organization_id, postal_code);
CREATE INDEX orders_recipient_trgm ON orders USING gin (organization_id, recipient_name gin_trgm_ops);
CREATE INDEX orders_customer_trgm ON orders USING gin (organization_id, customer_name gin_trgm_ops);
CREATE INDEX orders_source_idx ON orders (organization_id, source_order_id) WHERE source_order_id IS NOT NULL;

CREATE TABLE order_items (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_no int NOT NULL,
  external_line_id text,
  sku text NOT NULL,
  product_id uuid,
  product_name text NOT NULL DEFAULT '',
  variant text,
  quantity int NOT NULL CHECK (quantity > 0),
  unit_price numeric(12, 2),
  cancelled_qty int NOT NULL DEFAULT 0,
  allocated_qty int NOT NULL DEFAULT 0,
  shipped_qty int NOT NULL DEFAULT 0,
  allocation_status text NOT NULL DEFAULT 'unallocated'
    CHECK (allocation_status IN ('unallocated', 'partial', 'allocated', 'not_required')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, order_id, line_no),
  FOREIGN KEY (organization_id, order_id) REFERENCES orders(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id),
  CHECK (cancelled_qty >= 0 AND shipped_qty >= 0 AND allocated_qty >= 0),
  CHECK (shipped_qty + cancelled_qty <= quantity),
  CHECK (allocated_qty + shipped_qty + cancelled_qty <= quantity)
);
CREATE INDEX order_items_order_idx ON order_items (organization_id, order_id);
CREATE INDEX order_items_sku_idx ON order_items (organization_id, sku);
CREATE INDEX order_items_product_idx ON order_items (organization_id, product_id);

CREATE TABLE holds (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN
    ('address_check', 'stock_shortage', 'customer_confirm', 'payment_check', 'fraud_check', 'other')),
  note text,
  placed_by uuid,
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_at timestamptz,
  release_note text,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, order_id) REFERENCES orders(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX holds_order_idx ON holds (organization_id, order_id, placed_at DESC);
CREATE INDEX holds_active_idx ON holds (organization_id, order_id) WHERE released_at IS NULL;

CREATE TABLE order_status_history (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, order_id) REFERENCES orders(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX order_status_history_order_idx ON order_status_history (organization_id, order_id, created_at);

CREATE TABLE order_address_history (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  old_value jsonb NOT NULL,
  new_value jsonb NOT NULL,
  reason text,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, order_id) REFERENCES orders(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX order_address_history_order_idx ON order_address_history (organization_id, order_id, created_at);

-- ---------------- inventory ----------------
CREATE TABLE inventory_balances (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  product_id uuid NOT NULL,
  on_hand int NOT NULL DEFAULT 0,
  allocated int NOT NULL DEFAULT 0,
  held int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, location_id, product_id),
  FOREIGN KEY (organization_id, warehouse_id, location_id) REFERENCES locations(organization_id, warehouse_id, id),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id),
  CONSTRAINT inventory_balances_nonneg CHECK (on_hand >= 0 AND allocated >= 0 AND held >= 0),
  CONSTRAINT inventory_balances_available CHECK (allocated + held <= on_hand)
);
CREATE INDEX inventory_balances_product_idx ON inventory_balances (organization_id, product_id, warehouse_id);
CREATE INDEX inventory_balances_wh_idx ON inventory_balances (organization_id, warehouse_id);

CREATE TABLE inventory_movements (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  balance_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  product_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN (
    'receipt', 'adjust', 'ship', 'restock', 'return_damaged', 'return_quarantine', 'discard',
    'hold', 'unhold', 'hold_loss', 'transfer_out', 'transfer_in', 'restore')),
  on_hand_delta int NOT NULL DEFAULT 0,
  held_delta int NOT NULL DEFAULT 0,
  reference_type text,
  reference_id uuid,
  idempotency_key text,
  reason text,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, balance_id) REFERENCES inventory_balances(organization_id, id)
);
CREATE INDEX inventory_movements_balance_idx ON inventory_movements (organization_id, balance_id, created_at);
CREATE INDEX inventory_movements_product_idx ON inventory_movements (organization_id, product_id, created_at DESC);
CREATE INDEX inventory_movements_ref_idx ON inventory_movements (organization_id, reference_type, reference_id);

CREATE TABLE allocation_runs (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'job', 'import', 'order')),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  orders_considered int NOT NULL DEFAULT 0,
  orders_allocated int NOT NULL DEFAULT 0,
  orders_partial int NOT NULL DEFAULT 0,
  orders_unallocated int NOT NULL DEFAULT 0,
  started_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text,
  PRIMARY KEY (organization_id, id)
);
CREATE INDEX allocation_runs_started_idx ON allocation_runs (organization_id, started_at DESC);

-- ---------------- fulfillment ----------------
CREATE TABLE waves (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  wave_number text NOT NULL,
  warehouse_id uuid NOT NULL,
  label text,
  status text NOT NULL CHECK (status IN ('open', 'picking', 'picked', 'completed', 'cancelled')),
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  split_mode text NOT NULL DEFAULT 'single' CHECK (split_mode IN ('single', 'zone', 'lines')),
  fulfillment_count int NOT NULL DEFAULT 0,
  line_count int NOT NULL DEFAULT 0,
  unit_count int NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, wave_number),
  FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouses(organization_id, id)
);
CREATE INDEX waves_wh_status_idx ON waves (organization_id, warehouse_id, status, created_at DESC);

CREATE TABLE fulfillments (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  fulfillment_number text NOT NULL,
  order_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  fulfillment_type text NOT NULL DEFAULT 'standard' CHECK (fulfillment_type IN ('standard', 'replacement')),
  status text NOT NULL CHECK (status IN ('ready', 'waved', 'picking', 'picked', 'packing', 'packed', 'shipped', 'cancelled')),
  on_hold boolean NOT NULL DEFAULT false,
  hold_reason text,
  has_short boolean NOT NULL DEFAULT false,
  priority int NOT NULL DEFAULT 0,
  due_at timestamptz,
  shipping_method text,
  wave_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  picked_at timestamptz,
  packed_at timestamptz,
  shipped_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, fulfillment_number),
  FOREIGN KEY (organization_id, order_id) REFERENCES orders(organization_id, id),
  FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouses(organization_id, id),
  FOREIGN KEY (organization_id, wave_id) REFERENCES waves(organization_id, id)
);
CREATE INDEX fulfillments_wave_candidates_idx ON fulfillments (organization_id, warehouse_id, status, priority DESC, due_at);
CREATE INDEX fulfillments_order_idx ON fulfillments (organization_id, order_id);
CREATE INDEX fulfillments_wave_idx ON fulfillments (organization_id, wave_id);
CREATE INDEX fulfillments_due_idx ON fulfillments (organization_id, due_at)
  WHERE status NOT IN ('shipped', 'cancelled');

CREATE TABLE fulfillment_items (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  fulfillment_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  product_id uuid,
  required_qty int NOT NULL CHECK (required_qty >= 0),
  allocated_qty int NOT NULL DEFAULT 0,
  picked_qty int NOT NULL DEFAULT 0,
  short_qty int NOT NULL DEFAULT 0,
  packed_qty int NOT NULL DEFAULT 0,
  shipped_qty int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, fulfillment_id, order_item_id),
  FOREIGN KEY (organization_id, fulfillment_id) REFERENCES fulfillments(organization_id, id),
  FOREIGN KEY (organization_id, order_item_id) REFERENCES order_items(organization_id, id),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id),
  CHECK (allocated_qty >= 0 AND picked_qty >= 0 AND short_qty >= 0 AND packed_qty >= 0 AND shipped_qty >= 0),
  CHECK (picked_qty + short_qty <= required_qty),
  CHECK (packed_qty <= picked_qty),
  CHECK (shipped_qty <= packed_qty)
);
CREATE INDEX fulfillment_items_ff_idx ON fulfillment_items (organization_id, fulfillment_id);
CREATE INDEX fulfillment_items_oi_idx ON fulfillment_items (organization_id, order_item_id);

CREATE TABLE allocations (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  product_id uuid NOT NULL,
  balance_id uuid NOT NULL,
  fulfillment_id uuid,
  fulfillment_item_id uuid,
  quantity int NOT NULL CHECK (quantity > 0),
  shipped_qty int NOT NULL DEFAULT 0,
  released_qty int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'released')),
  reason text NOT NULL,
  allocation_run_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by uuid,
  release_reason text,
  consumed_at timestamptz,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, order_id) REFERENCES orders(organization_id, id),
  FOREIGN KEY (organization_id, order_item_id) REFERENCES order_items(organization_id, id),
  FOREIGN KEY (organization_id, balance_id) REFERENCES inventory_balances(organization_id, id),
  FOREIGN KEY (organization_id, fulfillment_item_id) REFERENCES fulfillment_items(organization_id, id),
  CHECK (shipped_qty >= 0 AND released_qty >= 0 AND shipped_qty + released_qty <= quantity)
);
CREATE INDEX allocations_order_item_idx ON allocations (organization_id, order_item_id);
CREATE INDEX allocations_order_idx ON allocations (organization_id, order_id);
CREATE INDEX allocations_balance_active_idx ON allocations (organization_id, balance_id) WHERE status = 'active';
CREATE INDEX allocations_ff_item_idx ON allocations (organization_id, fulfillment_item_id);

CREATE TABLE wave_fulfillments (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  wave_id uuid NOT NULL,
  fulfillment_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_reason text,
  PRIMARY KEY (organization_id, wave_id, fulfillment_id),
  FOREIGN KEY (organization_id, wave_id) REFERENCES waves(organization_id, id),
  FOREIGN KEY (organization_id, fulfillment_id) REFERENCES fulfillments(organization_id, id)
);
CREATE UNIQUE INDEX wave_fulfillments_active_uq ON wave_fulfillments (organization_id, fulfillment_id)
  WHERE removed_at IS NULL;

CREATE TABLE pick_tasks (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  task_number text NOT NULL,
  wave_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  zone text,
  seq int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  assignee_user_id uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  line_count int NOT NULL DEFAULT 0,
  unit_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, task_number),
  FOREIGN KEY (organization_id, wave_id) REFERENCES waves(organization_id, id),
  FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouses(organization_id, id)
);
CREATE INDEX pick_tasks_wh_status_idx ON pick_tasks (organization_id, warehouse_id, status);
CREATE INDEX pick_tasks_wave_idx ON pick_tasks (organization_id, wave_id);
CREATE INDEX pick_tasks_assignee_idx ON pick_tasks (organization_id, assignee_user_id)
  WHERE status IN ('open', 'in_progress');
CREATE INDEX pick_tasks_claim_exp_idx ON pick_tasks (claim_expires_at)
  WHERE assignee_user_id IS NOT NULL AND status IN ('open', 'in_progress');

CREATE TABLE pick_task_lines (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  pick_task_id uuid NOT NULL,
  wave_id uuid NOT NULL,
  fulfillment_id uuid NOT NULL,
  fulfillment_item_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  location_id uuid NOT NULL,
  product_id uuid NOT NULL,
  required_qty int NOT NULL CHECK (required_qty > 0),
  picked_qty int NOT NULL DEFAULT 0,
  short_qty int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'picked', 'short', 'cancelled')),
  seq int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, pick_task_id) REFERENCES pick_tasks(organization_id, id),
  FOREIGN KEY (organization_id, fulfillment_item_id) REFERENCES fulfillment_items(organization_id, id),
  FOREIGN KEY (organization_id, allocation_id) REFERENCES allocations(organization_id, id),
  CHECK (picked_qty >= 0 AND short_qty >= 0 AND picked_qty + short_qty <= required_qty)
);
CREATE INDEX pick_task_lines_task_idx ON pick_task_lines (organization_id, pick_task_id, seq);
CREATE INDEX pick_task_lines_ff_idx ON pick_task_lines (organization_id, fulfillment_id);
CREATE INDEX pick_task_lines_alloc_idx ON pick_task_lines (organization_id, allocation_id);

CREATE TABLE pick_events (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  client_event_id uuid NOT NULL,
  pick_task_id uuid NOT NULL,
  pick_task_line_id uuid,
  wave_id uuid NOT NULL,
  fulfillment_id uuid,
  warehouse_id uuid NOT NULL,
  location_id uuid,
  product_id uuid,
  picker_user_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN
    ('pick', 'correction', 'short', 'mis_scan_location', 'mis_scan_sku', 'over_pick', 'location_ok')),
  qty int NOT NULL DEFAULT 0,
  scanned_code text,
  reason_code text,
  note text,
  corrects_event_id uuid,
  input_method text CHECK (input_method IN ('camera', 'scanner', 'manual')),
  offline boolean NOT NULL DEFAULT false,
  client_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
CREATE UNIQUE INDEX pick_events_client_uq ON pick_events (organization_id, client_event_id, pick_task_line_id) NULLS NOT DISTINCT;
CREATE INDEX pick_events_task_idx ON pick_events (organization_id, pick_task_id, created_at);
CREATE INDEX pick_events_ff_idx ON pick_events (organization_id, fulfillment_id);
CREATE INDEX pick_events_created_idx ON pick_events (organization_id, created_at, event_type);

CREATE TABLE pack_sessions (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  fulfillment_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  packer_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  claim_expires_at timestamptz,
  current_box int NOT NULL DEFAULT 1,
  mis_scan_count int NOT NULL DEFAULT 0,
  forced boolean NOT NULL DEFAULT false,
  force_reason text,
  forced_by uuid,
  complete_request_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, fulfillment_id) REFERENCES fulfillments(organization_id, id)
);
CREATE UNIQUE INDEX pack_sessions_active_uq ON pack_sessions (organization_id, fulfillment_id) WHERE status = 'active';
CREATE INDEX pack_sessions_ff_idx ON pack_sessions (organization_id, fulfillment_id, started_at DESC);
CREATE INDEX pack_sessions_completed_idx ON pack_sessions (organization_id, completed_at) WHERE status = 'completed';

CREATE TABLE pack_events (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  client_event_id uuid NOT NULL,
  pack_session_id uuid NOT NULL,
  fulfillment_id uuid NOT NULL,
  fulfillment_item_id uuid,
  product_id uuid,
  packer_user_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN
    ('scan', 'correction', 'mis_scan_wrong_sku', 'mis_scan_other_order', 'mis_scan_variant', 'mis_scan_over',
     'mis_scan_unknown', 'box_close', 'force_complete')),
  qty int NOT NULL DEFAULT 0,
  box_no int NOT NULL DEFAULT 1,
  scanned_code text,
  input_method text CHECK (input_method IN ('camera', 'scanner', 'manual')),
  message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, client_event_id),
  FOREIGN KEY (organization_id, pack_session_id) REFERENCES pack_sessions(organization_id, id)
);
CREATE INDEX pack_events_session_idx ON pack_events (organization_id, pack_session_id, created_at);
CREATE INDEX pack_events_created_idx ON pack_events (organization_id, created_at, event_type);

CREATE TABLE shipments (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  shipment_number text NOT NULL,
  order_id uuid NOT NULL,
  fulfillment_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  pack_session_id uuid,
  box_no int NOT NULL DEFAULT 1,
  carrier text,
  service text,
  tracking_number text CHECK (tracking_number IS NULL OR tracking_number ~ '^[A-Za-z0-9-]{4,40}$'),
  no_tracking boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'shipped', 'cancelled')),
  ship_to jsonb,
  weight_g int,
  package_type text,
  shipped_at timestamptz,
  confirmed_by uuid,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, shipment_number),
  FOREIGN KEY (organization_id, order_id) REFERENCES orders(organization_id, id),
  FOREIGN KEY (organization_id, fulfillment_id) REFERENCES fulfillments(organization_id, id),
  FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouses(organization_id, id)
);
CREATE UNIQUE INDEX shipments_tracking_uq ON shipments (organization_id, carrier, tracking_number)
  WHERE tracking_number IS NOT NULL AND status <> 'cancelled';
CREATE INDEX shipments_order_idx ON shipments (organization_id, order_id);
CREATE INDEX shipments_ff_idx ON shipments (organization_id, fulfillment_id);
CREATE INDEX shipments_status_idx ON shipments (organization_id, status, shipped_at DESC);
CREATE INDEX shipments_tracking_idx ON shipments (organization_id, tracking_number);

CREATE TABLE shipment_items (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  fulfillment_item_id uuid NOT NULL,
  product_id uuid,
  quantity int NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, shipment_id, fulfillment_item_id),
  FOREIGN KEY (organization_id, shipment_id) REFERENCES shipments(organization_id, id),
  FOREIGN KEY (organization_id, order_item_id) REFERENCES order_items(organization_id, id),
  FOREIGN KEY (organization_id, fulfillment_item_id) REFERENCES fulfillment_items(organization_id, id)
);
CREATE INDEX shipment_items_shipment_idx ON shipment_items (organization_id, shipment_id);
CREATE INDEX shipment_items_oi_idx ON shipment_items (organization_id, order_item_id);

-- ---------------- returns ----------------
CREATE TABLE returns (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  return_number text NOT NULL,
  order_id uuid NOT NULL,
  shipment_id uuid,
  warehouse_id uuid,
  status text NOT NULL CHECK (status IN
    ('requested', 'authorized', 'in_transit', 'received', 'inspecting', 'completed', 'rejected', 'cancelled')),
  reason_code text NOT NULL CHECK (reason_code IN
    ('changed_mind', 'defective', 'wrong_item', 'damaged_in_transit', 'size_issue', 'other')),
  customer_note text,
  internal_note text,
  return_carrier text,
  return_tracking_number text,
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  authorized_by uuid,
  authorized_at timestamptz,
  in_transit_at timestamptz,
  received_by uuid,
  received_at timestamptz,
  inspection_started_at timestamptz,
  completed_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  reject_reason text,
  cancelled_by uuid,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, return_number),
  FOREIGN KEY (organization_id, order_id) REFERENCES orders(organization_id, id),
  FOREIGN KEY (organization_id, shipment_id) REFERENCES shipments(organization_id, id),
  FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouses(organization_id, id)
);
CREATE INDEX returns_order_idx ON returns (organization_id, order_id);
CREATE INDEX returns_status_idx ON returns (organization_id, status, created_at DESC);

CREATE TABLE return_items (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  return_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  product_id uuid,
  requested_qty int NOT NULL CHECK (requested_qty > 0),
  received_qty int NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  inspected_qty int NOT NULL DEFAULT 0 CHECK (inspected_qty >= 0),
  reason_code text,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, return_id, order_item_id),
  FOREIGN KEY (organization_id, return_id) REFERENCES returns(organization_id, id),
  FOREIGN KEY (organization_id, order_item_id) REFERENCES order_items(organization_id, id),
  CHECK (inspected_qty <= received_qty)
);
CREATE INDEX return_items_oi_idx ON return_items (organization_id, order_item_id);

CREATE TABLE return_inspections (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  return_id uuid NOT NULL,
  return_item_id uuid NOT NULL,
  product_id uuid,
  client_request_id uuid NOT NULL,
  line_index int NOT NULL DEFAULT 0,
  disposition text NOT NULL CHECK (disposition IN ('restock', 'damaged', 'quarantine', 'discard')),
  qty int NOT NULL CHECK (qty > 0),
  warehouse_id uuid,
  location_id uuid,
  inspector_user_id uuid NOT NULL,
  inspected_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  note text,
  attachment_ids uuid[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, client_request_id, line_index),
  FOREIGN KEY (organization_id, return_id) REFERENCES returns(organization_id, id),
  FOREIGN KEY (organization_id, return_item_id) REFERENCES return_items(organization_id, id)
);
CREATE INDEX return_inspections_return_idx ON return_inspections (organization_id, return_id);
CREATE INDEX return_inspections_date_idx ON return_inspections (organization_id, inspected_at);

CREATE TABLE exchanges (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  exchange_number text NOT NULL,
  return_id uuid NOT NULL,
  original_order_id uuid NOT NULL,
  replacement_order_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, exchange_number),
  FOREIGN KEY (organization_id, return_id) REFERENCES returns(organization_id, id),
  FOREIGN KEY (organization_id, original_order_id) REFERENCES orders(organization_id, id),
  FOREIGN KEY (organization_id, replacement_order_id) REFERENCES orders(organization_id, id)
);
CREATE INDEX exchanges_return_idx ON exchanges (organization_id, return_id);

CREATE TABLE exchange_items (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  exchange_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  original_order_item_id uuid,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, exchange_id) REFERENCES exchanges(organization_id, id),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id)
);

-- ---------------- exceptions / audit / misc ----------------
CREATE TABLE exception_cases (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  exception_number text NOT NULL,
  type text NOT NULL CHECK (type IN (
    'shortage', 'short_pick', 'address_invalid', 'forced_pack', 'inventory_mismatch', 'return_discrepancy',
    'tracking_duplicate', 'import_conflict', 'cancel_putback', 'field_report', 'other')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'ignored')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  title text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  order_id uuid,
  fulfillment_id uuid,
  wave_id uuid,
  pick_task_id uuid,
  pack_session_id uuid,
  shipment_id uuid,
  return_id uuid,
  import_batch_id uuid,
  product_id uuid,
  warehouse_id uuid,
  location_id uuid,
  balance_id uuid,
  dedupe_key text,
  created_by uuid,
  assignee_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_code text,
  resolution_note text,
  ignored_reason text,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, exception_number),
  FOREIGN KEY (organization_id, order_id) REFERENCES orders(organization_id, id),
  FOREIGN KEY (organization_id, fulfillment_id) REFERENCES fulfillments(organization_id, id),
  FOREIGN KEY (organization_id, shipment_id) REFERENCES shipments(organization_id, id),
  FOREIGN KEY (organization_id, return_id) REFERENCES returns(organization_id, id),
  CONSTRAINT exception_ignored_reason CHECK (status <> 'ignored' OR length(trim(coalesce(ignored_reason, ''))) > 0)
);
CREATE UNIQUE INDEX exception_cases_dedupe_uq ON exception_cases (organization_id, dedupe_key)
  WHERE status IN ('open', 'investigating') AND dedupe_key IS NOT NULL;
CREATE INDEX exception_cases_status_idx ON exception_cases (organization_id, status, type, created_at DESC);
CREATE INDEX exception_cases_order_idx ON exception_cases (organization_id, order_id);
CREATE INDEX exception_cases_resolved_idx ON exception_cases (organization_id, resolved_at) WHERE resolved_at IS NOT NULL;

CREATE TABLE exception_events (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  exception_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  note text,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, exception_id) REFERENCES exception_cases(organization_id, id)
);
CREATE INDEX exception_events_exc_idx ON exception_events (organization_id, exception_id, created_at);

CREATE TABLE audit_logs (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  actor_user_id uuid,
  actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'job')),
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  user_agent text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
CREATE INDEX audit_logs_created_idx ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (organization_id, entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (organization_id, actor_user_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (organization_id, action, created_at DESC);

-- 監査ログは追記専用（UPDATE 禁止、DELETE は組織削除手続き時のみ）
CREATE OR REPLACE FUNCTION audit_logs_protect() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_logs is append-only';
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.org_purge', true), '') <> 'on' THEN
    RAISE EXCEPTION 'audit_logs is append-only';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER audit_logs_protect_trg BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_protect();

CREATE TABLE attachments (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  storage_key text NOT NULL CHECK (storage_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  filename text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes int NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256 text NOT NULL,
  entity_type text,
  entity_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
CREATE INDEX attachments_entity_idx ON attachments (organization_id, entity_type, entity_id);

CREATE TABLE backup_runs (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('export', 'restore')),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  filename text,
  file_sha256 text,
  manifest jsonb,
  error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (organization_id, id)
);

-- ------------------------------------------------------------------
-- Row Level Security（FORCE: テーブル所有者にも適用）
-- ------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'counters', 'warehouses', 'locations', 'products', 'product_barcodes', 'sales_channels', 'customers',
    'import_profiles', 'import_batches', 'import_batch_orders', 'orders', 'order_items', 'holds',
    'order_status_history', 'order_address_history', 'inventory_balances', 'inventory_movements',
    'allocation_runs', 'waves', 'fulfillments', 'fulfillment_items', 'allocations', 'wave_fulfillments',
    'pick_tasks', 'pick_task_lines', 'pick_events', 'pack_sessions', 'pack_events', 'shipments',
    'shipment_items', 'returns', 'return_items', 'return_inspections', 'exchanges', 'exchange_items',
    'exception_cases', 'exception_events', 'audit_logs', 'attachments', 'backup_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id())',
      t);
  END LOOP;
END
$$;
