-- Phase 10: 在庫移動の一覧（新しい順・絞り込みなし）が履歴の全件を並べ替えていた（51 万注文・136 万移動で 460ms、履歴に比例して悪化）。
-- 新しい順の索引で先頭 50 件だけを読む（docs/TEST_REPORT.md）。
CREATE INDEX IF NOT EXISTS inventory_movements_created_idx ON inventory_movements (organization_id, created_at DESC, id DESC);
