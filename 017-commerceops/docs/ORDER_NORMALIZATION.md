# 注文取込・正規化 (ORDER_NORMALIZATION.md)

初版は **CSV 取込を最優先**。Shopify・Amazon・楽天・BASE・STORES・自社 EC・卸・手動・その他を想定するが、
**未確認の各社 CSV 仕様を決め打ちしない**。汎用の列マッピング（Import Profile）で対応する。
将来の API Connector は `SalesChannelConnector` インターフェースで追加可能（初版は CSV / 手動のみ実装）。

## 1. Sales Channel

`sales_channels`: name, type(`shopify`/`amazon`/`rakuten`/`base`/`stores`/`own_site`/`wholesale`/`manual`/`other`),
code（表示用短縮名）, connector_type(`csv`/`manual`、将来 `api`), active。
type は表示・集計用のラベルであり、type によって CSV 仕様を自動決定しない。

```ts
// server/src/modules/channels/connector.ts（将来拡張用）
interface SalesChannelConnector {
  kind: 'csv' | 'manual' | 'api';
  fetchOrders?(since: Date): AsyncIterable<NormalizedOrder>;   // 将来の API 連携
  pushTracking?(shipment: ShipmentTrackingPayload): Promise<void>; // 将来の追跡番号返送
}
```

## 2. Import Profile

チャネルごとに複数保存可。`import_profiles`: channel_id, name, encoding(`utf-8` / `shift_jis`), delimiter(`,` / `\t`),
has_header, skip_rows, date_format, timezone, mapping(JSON), version。

### 2.1 マッピング対象フィールド
| 区分 | フィールド | 必須 |
|---|---|---|
| 注文 | externalOrderId（注文番号） | ✓ |
| 注文 | orderDate（注文日時） | ✓ |
| 注文 | customerName / customerEmail / customerPhone / channelCustomerId | |
| 送付先 | recipientName | ✓ |
| 送付先 | postalCode / address1 | ✓ |
| 送付先 | prefecture / city / address2 / recipientPhone | |
| 注文 | shippingMethod / notes / priority / cancelFlag | |
| 明細 | sku / quantity | ✓ |
| 明細 | productName / unitPrice / variant / externalLineId | |

### 2.2 マッピング定義（宣言的・任意コード実行禁止）
各フィールドに対し:
- `source`: `{ column: "注文番号" }`（ヘッダー名）または `{ index: 3 }`（0 始まり列番号）、
  `{ columns: ["住所1","住所2"], separator: " " }`（連結）
- `fixed`: 固定値（例: 配送方法を「宅配便」に固定）
- `transforms`: 許可リストの操作のみ、順に適用
  - `trim` / `upper` / `lower` / `nfkc`（全角英数→半角）/ `digitsOnly`
  - `removeChars { chars }`（例: `¥,`）/ `replace { from, to }`（**リテラル置換のみ。正規表現は受け付けない**＝ReDoS 防止）
  - `emptyAs { value }`（空欄時の既定値）/ `truncate { length }` / `map { table, fallback }`（値の対応表）
- 型変換はフィールド型で固定: 日付（プロファイルの date_format。`yyyy-MM-dd HH:mm:ss` 等のトークンのみ）、
  整数（quantity: 1 以上）、金額（小数 2 桁まで）、郵便番号（7 桁に正規化 `123-4567`）、電話（数字とハイフン）。
- `eval`・テンプレート式・正規表現・外部参照は一切サポートしない。マッピング JSON は zod で厳格検証。

## 3. 取込フロー

```
ファイル選択 → 文字コード判定 → Profile 選択 → プレビュー（マッピング結果）
 → 構文検証（CSV parser エラー）→ 行検証 → 注文検証 → 重複/競合判定
 → 件数・数量サマリ確認 → 確定（単一トランザクション）
```

1. **文字コード**: UTF-8（BOM 有無とも）必須対応。BOM を検出したら除去。UTF-8 として不正なバイト列なら
   「Shift_JIS の可能性」を表示し、Profile で `shift_jis` を明示選択した場合のみ CP932 としてデコード（自動推測で確定しない）。
2. **CSV パース**: `csv-parse`（RFC4180: ダブルクォート・改行を含むセル・エスケープ `""` 対応）。`split(",")` 禁止。
   列数不一致・閉じられていないクォートは構文エラーとして行番号付きで表示。
3. **行検証**: 必須項目、数量が正の整数、日付がフォーマット通り、郵便番号 7 桁、SKU の存在（未登録 SKU は警告→注文は要確認）。
4. **注文グルーピング**: 1 行 = 1 明細を前提に externalOrderId で束ねる。同じ注文内で注文レベル項目（送付先など）が行ごとに
   異なる場合はエラー（どちらが正しいか決め打ちしない）。
5. **重複判定**
   - ファイル: SHA-256 が同組織で確定済みの取込と一致 → 取込不可（同一ファイル二重取込防止）。
   - 注文: `UNIQUE (organization_id, channel_id, external_order_id)`。既存注文と比較し分類:
     | 分類 | 条件 | 確定時の扱い |
     |---|---|---|
     | `new` | 未登録 | 作成 |
     | `identical` | 正規化内容ハッシュが一致 | スキップ（重複なし） |
     | `update_candidate` | 内容が異なり、既存注文がまだ引当前（imported/validation_required/ready_for_allocation/on_hold 未引当） | 既定はスキップ。ユーザーが「更新を適用」を選んだものだけ更新（住所は履歴付き） |
     | `conflict` | 内容が異なり、既存注文が引当済み以降 | 更新しない。例外 `import_conflict` を作成 |
     | `cancel_candidate` | cancelFlag 列が取消を示す | 自動キャンセルしない。例外 `import_conflict`（取消候補）を作成し人間が判断 |
     | `invalid` | 検証エラー | 取込対象外（または要確認として取込: Profile 設定） |
   - **無条件上書きはしない。**
6. **確定**: 組織×チャネルの advisory lock を取り、トランザクション内で重複判定を再実行してから INSERT。
   途中で失敗したら全体をロールバック（既存データ非破壊）。確定後に取込バッチを `committed` とし、ファイルハッシュを記録。
7. プレビューのステージングデータ（`import_batch_orders`）は個人情報を含むため、確定/取消後 7 日で Job が削除。

## 4. 正規化後の Order / OrderItem

- Order: 内部 ID, organization, channel, externalOrderId, order_number（組織内連番 `SO-000001`）, orderDate, status,
  customer snapshot（customer_name/email/phone）, shipping address snapshot（recipient_name, postal_code, prefecture, city,
  address1, address2, recipient_phone）, shippingMethod, notes, importBatchId, content_hash, createdAt。
- OrderItem: ID, orderId, line_no, sku, product_id（解決済み）, product_name_snapshot, variant_snapshot, quantity,
  unit_price_snapshot（任意）, allocation_status, allocated_qty, shipped_qty, cancelled_qty。
- **スナップショット保持**: 注文時の顧客・住所・商品名・単価を注文行に固定保存。顧客マスター（customers）を後で編集しても
  過去注文の送付先は変わらない。住所変更は注文側の明示操作（出荷前のみ・履歴保存）。
- 状態は `imported` で作成 → 検証結果により `validation_required` または `ready_for_allocation`（履歴に 2 行残る）。

## 5. CSV エクスポートの安全化
出力セルが `=`, `+`, `-`, `@`, タブ, CR で始まる場合は先頭に `'` を付与（CSV/Formula Injection 対策）。
UTF-8 BOM 付き（既定）/ Shift_JIS（CP932）を選択可。
