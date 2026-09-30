-- Phase 10: 大量データ（段階的生成データ）での実行計画の検証結果に基づく索引の見直し（docs/TEST_REPORT.md）
-- どの照合順序（C / en_US.UTF-8 等）の DB でも前方一致（LIKE 'x%'）に索引が使えるよう text_pattern_ops を使う。

-- 外部注文番号: 完全一致と前方一致
DROP INDEX IF EXISTS orders_ext_idx;
CREATE INDEX orders_ext_idx ON orders (organization_id, external_order_id text_pattern_ops);

-- SKU から新しい注文明細（横断検索の「SKU を含む最近の注文」を上位 N 件で打ち切る）
DROP INDEX IF EXISTS order_items_sku_idx;
CREATE INDEX order_items_sku_idx ON order_items (organization_id, sku, created_at DESC);

-- 監査ログ: 対象（entity_id は UUID で一意なので種別は不要）と操作の種類（前方一致）
DROP INDEX IF EXISTS audit_logs_entity_idx;
CREATE INDEX audit_logs_entity_idx ON audit_logs (organization_id, entity_id, created_at DESC) WHERE entity_id IS NOT NULL;
DROP INDEX IF EXISTS audit_logs_action_idx;
CREATE INDEX audit_logs_action_idx ON audit_logs (organization_id, action text_pattern_ops, created_at DESC);

-- Wave 一覧・詳細の Pick 進捗の集計
CREATE INDEX IF NOT EXISTS pick_task_lines_wave_idx ON pick_task_lines (organization_id, wave_id);

-- RLS（FORCE）の下では LEAKPROOF でない演算子（LIKE / ILIKE / pg_trgm の類似演算子）は索引条件に使えない
-- （行レベルセキュリティの条件が先に評価されるため）。実測でトライグラム索引が一切使われないことを確認したので削除し、
-- 前方一致は LEAKPROOF な starts_with（^@）+ text_pattern_ops の B-tree で索引を使う。
DROP INDEX IF EXISTS orders_recipient_trgm;
DROP INDEX IF EXISTS orders_customer_trgm;
DROP INDEX IF EXISTS products_name_trgm;
-- 氏名（姓から）の前方一致
CREATE INDEX orders_recipient_prefix_idx ON orders (organization_id, recipient_name text_pattern_ops);
CREATE INDEX orders_customer_prefix_idx ON orders (organization_id, customer_name text_pattern_ops);
