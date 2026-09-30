# データモデル (DATA_MODEL.md)

定義の正は `server/src/db/migrations/*.sql`。本書は設計意図と主要制約の説明。

## 共通規約
- 主キー: UUIDv7（アプリ生成。SQL 生成時は `uuidv7()` 関数）。業務テーブルは **`PRIMARY KEY (organization_id, id)`**。
- 外部キー: **`(organization_id, xxx_id) REFERENCES xxx(organization_id, id)`** の複合 FK。別組織の親を参照できない。
- RLS: 業務テーブルはすべて `ENABLE` + `FORCE ROW LEVEL SECURITY`、ポリシー `organization_id = app_org_id()`。
- 表示用番号: 組織内連番（`counters` テーブル）。SO-（注文）/F-（Fulfillment）/W-（Wave）/PT-（Pick タスク）/SH-（出荷）/RT-（返品）/EX-（交換）/EXC-（例外）/IMP-（取込）。
- 時刻は `timestamptz`（UTC 保存、表示は組織タイムゾーン。既定 Asia/Tokyo）。
- 数量は整数。CHECK 制約で負数・超過を DB レベルで禁止。

## グローバル（RLS なし・認証/システム用）
| テーブル | 用途 | 主な制約 |
|---|---|---|
| organizations | 組織（テナント）。`is_sample` でサンプル組織を分離、`settings`（引当/claim/Wave/出荷の設定 JSON） | |
| users | ユーザー（メール一意・scrypt ハッシュ・ロック状態） | `lower(email)` UNIQUE |
| memberships | 組織 × ユーザー × ロール × 倉庫範囲（`warehouse_ids` NULL=全倉庫） | PK(org, user) |
| sessions | セッション（トークンは SHA-256 のみ保存、CSRF トークン、アイドル/絶対期限） | token_hash UNIQUE |
| invitations / password_resets | 招待・パスワードリセット（トークンはハッシュ保存・期限付き・1 回限り） | |
| security_events | ログイン成功/失敗/ロック等（メールはハッシュ化） | |
| jobs | Job キュー（dedupe_key は queued/running 中 UNIQUE、SKIP LOCKED で取得） | |

## マスター
| テーブル | 用途 | 主な制約 |
|---|---|---|
| warehouses | 倉庫（住所・timezone・営業時間・締切時刻・優先度・有効） | UNIQUE(org, code) |
| locations | ロケーション（kind: pick/quarantine/damaged、pick_sequence、barcode） | UNIQUE(org, wh, code)、UNIQUE(org, wh, barcode) |
| products | SKU・商品名・バリエーション・group_code（別 variant 判定）・画像 URL（https のみ） | UNIQUE(org, sku)、名称 trigram |
| product_barcodes | JAN/EAN/UPC/Code128/QR 等の読取コード → 商品 | UNIQUE(org, code) |
| sales_channels | 販売チャネル（type はラベル、connector_type=csv/manual/api） | UNIQUE(org, code) |
| import_profiles | CSV 列マッピング（宣言的 JSON）・文字コード・区切り・日付形式 | |
| customers | 顧客マスター（編集しても注文スナップショットは不変） | |

## 注文
| テーブル | 用途 | 主な制約 |
|---|---|---|
| import_batches | 取込バッチ（ファイル SHA-256、件数、サマリ、状態） | 確定済みの (org, file_sha256) UNIQUE |
| import_batch_orders | プレビュー時の正規化結果・分類・エラー（7 日後に削除） | |
| orders | 注文。**CustomerSnapshot**（customer_name/email/phone）と **ShippingAddressSnapshot**（recipient_name, postal_code, prefecture, city, address1, address2, recipient_phone）を行に固定保存。`order_type`=standard/replacement、`content_hash`、`validation_errors`、状態 | UNIQUE(org, channel, external_order_id)、UNIQUE(org, order_number) |
| order_items | 明細（SKU/商品名/単価のスナップショット、quantity、cancelled_qty、allocated_qty、shipped_qty） | `shipped+cancelled <= quantity`、`allocated+shipped+cancelled <= quantity` |
| holds | 保留（理由コード・メモ・保留/解除の実行者と日時） | |
| order_status_history | 状態遷移履歴 | |
| order_address_history | 住所変更履歴（変更前後・理由・実行者） | |

## 在庫・引当
| テーブル | 用途 | 主な制約 |
|---|---|---|
| inventory_balances | (location, product) の on_hand / allocated / held | `allocated + held <= on_hand`、非負 |
| inventory_movements | on_hand / held の全変動（種別・参照・理由・実行者） | UNIQUE(org, idempotency_key) |
| allocations | 注文明細への引当（ロケーション確定）。quantity / shipped_qty / released_qty / status | `shipped + released <= quantity` |
| allocation_runs | 引当実行の記録（件数・実行者） | |

## Fulfillment・作業
| テーブル | 用途 | 主な制約 |
|---|---|---|
| fulfillments | 注文 × 倉庫の作業単位（状態・保留フラグ・優先度・期限・wave_id） | |
| fulfillment_items | required / allocated / picked / short / packed / shipped | `picked+short <= required`、`packed <= picked`、`shipped <= packed` |
| waves / wave_fulfillments | Wave と確定時 snapshot（有効な所属は Fulfillment ごとに 1 つ） | 部分 UNIQUE(org, fulfillment) WHERE removed_at IS NULL |
| pick_tasks | Pick 作業（担当者・claim 期限） | |
| pick_task_lines | ロケーション × SKU × Fulfillment 明細 × Allocation の作業行 | `picked+short <= required` |
| pick_events | scan/訂正/Short/誤 scan の履歴（上書きしない） | UNIQUE NULLS NOT DISTINCT(org, client_event_id, line) |
| pack_sessions | 梱包セッション（担当・誤 scan 数・強制完了の理由/実行者） | 部分 UNIQUE(org, fulfillment) WHERE active |
| pack_events | 梱包 scan・訂正・誤 scan（種類別）・箱区切り | UNIQUE(org, client_event_id) |
| shipments / shipment_items | 出荷（1 箱 = 1 追跡番号）。carrier/service/tracking/shipped_at/ship_to スナップショット | 部分 UNIQUE(org, carrier, tracking) |

## 返品・交換
| テーブル | 用途 | 主な制約 |
|---|---|---|
| returns | 返品（元注文/出荷への参照、状態、理由、各状態の日時と実行者） | |
| return_items | requested / received / inspected 数量 | `inspected <= received` |
| return_inspections | 検品結果（Disposition・数量・戻し先・検品者・理由・写真） | UNIQUE(org, client_request_id, line_index) |
| exchanges / exchange_items | 交換（Replacement Order への参照） | |

## 運用
| テーブル | 用途 |
|---|---|
| exception_cases / exception_events | 例外キュー（type, status open/investigating/resolved/ignored, 関連エンティティ、dedupe_key、無視は理由必須） |
| audit_logs | 監査ログ（追記専用: UPDATE/DELETE をトリガで拒否）。個人情報を入れない |
| attachments | 返品写真等（キーはサーバー生成 `{org}/{uuid}` のみ、画像 MIME 限定、10MB 上限） |
| backup_runs | バックアップ/復元の実行記録 |

## 主要インデックス（負荷目標: Order 500 万 / OrderItem 1,500 万 / Allocation 1,500 万 / PickEvent 3,000 万 / Shipment 500 万 / Return 50 万）
- 注文一覧: `(org, status, order_date DESC)`, `(org, order_date DESC)`
- 検索: `(org, external_order_id)`, `(org, postal_code)`, trigram GIN `(org, recipient_name)`, `(org, customer_name)`, `(org, tracking_number)`, `(org, sku)`（明細）
- 引当: `allocations (org, balance_id) WHERE status='active'`, `inventory_balances (org, product_id, warehouse_id)`
- Wave 候補: `fulfillments (org, warehouse_id, status, priority DESC, due_at)`
- KPI: `pick_events (org, created_at, event_type)`, `pack_events (org, created_at, event_type)`, `shipments (org, status, shipped_at DESC)`, `exception_cases (org, resolved_at)`
- 実測結果は TEST_REPORT.md（負荷試験）に記載。
