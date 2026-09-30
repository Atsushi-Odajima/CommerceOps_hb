# 返品・交換ルール (RETURN_RULES.md)

## 1. エンティティ

- `returns`: return_number(RT-xxxxxx), order_id（必須）, shipment_id（任意）, status, reason_code, customer_note,
  internal_note, 各状態の日時と実行者, 返送追跡番号（任意）
- `return_items`: order_item_id, product_id, requested_qty, received_qty, inspected_qty, reason_code
- `return_inspections`: return_item_id, disposition, qty, location_id（戻し先）, inspector, inspected_at, reason, note,
  photo attachments（任意）, `client_request_id`（冪等）
- `exchanges` / `exchange_items`: return_id, 交換品 SKU×数量, replacement_order_id

Return は Order を上書きしない。Order → Shipment → Return → (Exchange → Replacement Order → Fulfillment → Shipment) の参照で追跡。

## 2. 状態

`requested`(受付) → `authorized`(承認) → `in_transit`(返送中, 任意) → `received`(到着) → `inspecting`(検品中) → `completed`(完了)
分岐: `rejected`(却下・理由必須) / `cancelled`(取消・理由必須)

| 遷移 | 権限 |
|---|---|
| 作成(requested) / 承認 / 却下 / 取消 / 返送中 | `returns.request`（Support・Manager・Owner） |
| 到着 scan（received） | `returns.receive`（Manager・Owner、倉庫作業者に付与可） |
| 検品・Disposition | `returns.inspect`（Manager・Owner）※Picker/Packer/Support は不可 |

## 3. 受付時の検証
- 返品数量 ≤ 出荷済数量 − 既存返品数量（rejected/cancelled を除く）。明細は出荷済みの order_item のみ。
- 未出荷の注文は返品不可（キャンセルで扱う）。

## 4. 到着（Received）
- RMA コードまたは注文番号を scan → 到着数量を入力（既定 = 申請数量）。**在庫は増えない。**
- 申請と到着の数量差・想定外 SKU → 例外 `return_discrepancy`。

## 5. 検品と Disposition
| Disposition | 在庫処理 | 販売可能在庫 |
|---|---|---|
| `restock`（再販可） | 指定の販売可能ロケーションに on_hand +q | **増える**（唯一） |
| `damaged`（破損） | 倉庫の damaged ロケーションに on_hand +q | 増えない |
| `quarantine`（保留・要確認） | 倉庫の quarantine ロケーションに on_hand +q | 増えない（後で移動/廃棄を判断） |
| `discard`（廃棄） | on_hand 変化なし（数量 0 の movement を記録） | 増えない |

- 1 明細を複数 Disposition に分割可（例: 2 個 Restock + 1 個 Damaged）。
- 検品者・日時・理由・メモ・写真（任意）を履歴として保存（上書きしない）。
- **冪等・二重 Restock 防止**: `return_items` 行を `FOR UPDATE` → `inspected_qty + q <= received_qty` を検証 →
  `client_request_id` UNIQUE、movement の `return_inspection:{id}` UNIQUE。再送は同じ結果を返す。
- すべての到着数量を検品したら `completed`。注文状態は Return 完了で shipped/partially_shipped（または closed）へ戻る。
- 返金・会計処理は対象外（決済/会計は範囲外）。

## 6. 交換（Exchange）
- `exchanges.create`（Support・Manager・Owner）。Return が authorized 以降で作成可（先出し交換も可）。
- 交換品は **Replacement Order**（`order_type='replacement'`, `source_order_id`, `exchange_id`, 単価 0,
  送付先は元注文のスナップショットをコピー）として作成し、**通常の Allocation → Fulfillment(type=replacement) → Wave → Pick → Pack → Shipment** を通す。
  特別な近道は作らない（在庫引当・検品・出荷確定のルールをすべて適用）。
- KPI の受注件数には replacement を含めない（交換件数として別集計）。

## 7. 実装メモ（Phase7）
- API: `/api/returns`（一覧・状態グループ別件数）, `/lookup`（RMA / 注文番号）, `/:id`, `POST /api/returns`, `/:id/authorize|reject|cancel|in-transit`,
  `/:id/receive`, `/:id/inspect`, `/:id/exchange`, `/:id/attachments`（写真）, `/api/attachments/:id`, `/api/orders/:id/returnable`。
- 同じ注文への同時返品申請は注文行ロックで直列化（返品可能数を超えない）。却下・取消で返品可能数は戻る。
- 到着: 倉庫を指定（担当倉庫のみ）。到着数量 0〜申請数。差異・想定外の品物は例外 `return_discrepancy`。再登録は `alreadyReceived`（冪等）。在庫は動かない。
- 検品: 1 明細を複数判定に分割可。Restock の戻し先は指定がなければ「その商品の在庫がある販売可能ロケーション」→ 倉庫の DEFAULT。
  Damaged / Quarantine は倉庫の DAMAGED / QUARANTINE ロケーション、Discard は数量 0 の movement（記録のみ）。再販不可は理由必須。
- 検品の冪等: Return 行ロック → 同じ `client_request_id` が既にあれば前回の結果を返す（同時再送でも 1 回）→ 明細行ロック → `inspected_qty + q <= received_qty`
  → movement 冪等キー `return_inspection:{id}`。整合性チェックで「各検品に対応する movement が 1 つ・数量と戻し先の種類が正しい」ことを検証。
- 写真: JPEG / PNG / WebP のみ（拡張子や Content-Type ではなく先頭バイトで判定、SVG 等は拒否）、10MB・1 返品 20 枚まで、保存キーはサーバー生成、
  配信は `nosniff` + `sandbox` CSP + private キャッシュ。外部の画像認識サービスには送らない。
- 交換: 返品の承認後に作成（1 返品に有効な交換は 1 つ）。交換品の注文は通常の注文作成・検証・引当エンジンを通り（欠品なら欠品例外）、Fulfillment 種別 replacement、
  Wave → Pick → Pack → 出荷確定も通常どおり。交換品の注文が出荷済みになると交換は completed、キャンセルで cancelled。
- 画面: 返品一覧・受付（注文から）・詳細（承認/却下/取消/返送中/到着/検品/交換/写真）、スマホ `/m/returns`（RMA scan → 到着登録・検品）、返品受領票（RMA の Code128 + QR）。
