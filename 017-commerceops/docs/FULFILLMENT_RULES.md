# 注文状態・Fulfillment・Wave・出荷ルール (FULFILLMENT_RULES.md)

## 1. 注文状態

| 値 | 表示 | 意味 |
|---|---|---|
| `imported` | 取込済 | 取込直後（検証前の一時状態） |
| `validation_required` | 要確認 | 必須項目欠落・未登録 SKU・住所不備など |
| `ready_for_allocation` | 引当待ち | 引当対象（在庫なしの欠品を含む） |
| `partially_allocated` | 一部引当 | 一部の数量のみ確保 |
| `allocated` | 引当済 | 残数量をすべて確保 |
| `on_hold` | 保留 | 有効な Hold がある |
| `picking` | ピッキング中 | Wave 投入済み〜ピック中 |
| `picked` | ピック済 | 残作業がすべてピック済 |
| `packing` | 梱包中 | 梱包セッション中 |
| `packed` | 梱包済 | 出荷待ち |
| `partially_shipped` | 一部出荷 | 出荷済数量 > 0 かつ < 注文数量 |
| `shipped` | 出荷済 | 全数量出荷 |
| `cancelled` | キャンセル | 取消（終端） |
| `return_in_progress` | 返品対応中 | 未完了の Return がある |
| `closed` | 完了 | クローズ済み |

### 1.1 状態の決定方法（導出 + 検証 + 履歴）

注文状態は事実（明細数量・Allocation・Fulfillment・Shipment・Hold・Return）から **サーバーで導出** し、
「許可遷移表」に照らして検証してから保存する。許可されない遷移はエラー（バグ検知）。変更は `order_status_history` に記録。

導出順:
1. `cancelled_at` あり → cancelled / `closed_at` あり → closed
2. 有効な Hold → on_hold
3. 未完了 Return（requested〜inspecting）→ return_in_progress
4. 有効数量（quantity − cancelled_qty）がすべて 0 → cancelled
5. 検証エラーあり → validation_required
6. 出荷済 ≥ 有効数量 → shipped / 出荷済 > 0 → partially_shipped
7. 未引当の残数量がある → 引当済みがあれば partially_allocated、なければ ready_for_allocation
8. 残数量すべて引当済み → 残作業の **最も遅れている段階**:
   未 release の引当 = allocated / Fulfillment `ready` = allocated / `waved`・`picking` = picking /
   `picked` = picked / `packing` = packing / `packed` = packed

### 1.2 許可遷移（主要なもの。完全な表は `server/src/modules/orders/status.ts`）

- imported → validation_required, ready_for_allocation, on_hold, cancelled
- validation_required → ready_for_allocation, on_hold, cancelled
- ready_for_allocation ⇄ partially_allocated ⇄ allocated（解除・Short Pick で戻る）
- allocated → picking → picked → packing → packed → partially_shipped / shipped
- picking/picked → partially_allocated / ready_for_allocation / allocated（Short Pick 差戻し・Wave 取消）
- packing → picked（梱包セッション取消）
- partially_shipped → shipped
- shipped / partially_shipped → return_in_progress → shipped / partially_shipped / closed
- shipped → closed、closed → return_in_progress
- 非終端の任意状態 ⇄ on_hold、非終端の未出荷状態 → cancelled
- cancelled は終端（遷移なし）

## 2. 保留（Hold）

- 理由コード: `address_check`（住所確認）/ `stock_shortage`（欠品）/ `customer_confirm`（顧客確認）/
  `payment_check`（支払確認）/ `fraud_check`（不正注文確認）/ `other`（その他・メモ必須）
- `holds` テーブルに 誰が・いつ・なぜ 保留し、誰が・いつ・なぜ 解除したかを保存（削除しない）。
- 保留中の注文の Fulfillment は `on_hold=true` になり **Wave 対象外**。梱包開始・出荷確定もブロック。
- Pick 中の注文を保留する場合は確認ダイアログ（`confirm=true`）必須。

## 3. キャンセル

| 状況 | 挙動 |
|---|---|
| 出荷なし・Wave 前 | 未出荷 Allocation を解放、ready Fulfillment をキャンセル、注文 cancelled |
| Pick/Pack 中 | `confirm=true` 必須。ピック済み商品の「キャンセル棚戻し」例外を作成し Allocation を解放。梱包セッション・下書き Shipment を取消 |
| 一部出荷済み | 注文全体は取消不可。未出荷の明細数量のみ取消可（出荷済みは返品で扱う） |
| 全量出荷済み | 取消不可 → 返品を使う（Shipment 済みを単純取消しない） |

明細単位の取消（`cancelled_qty`）は人間の明示操作のみ。システムが自動で数量を減らすことはない。

## 4. 住所変更

- 出荷確定前のみ（出荷済 Shipment が 1 件でもあれば不可）。梱包済みの場合は警告（送り状再作成が必要）。
- 変更前後の値・理由・実行者を `order_address_history` に保存。Shipment は確定時点の送付先を `ship_to` に固定保存。
- 顧客マスター（customers）を編集しても、注文の顧客/送付先スナップショットは変わらない。

## 5. Fulfillment

- 1 注文 × 1 倉庫の作業単位。1 注文に複数 Fulfillment 可（倉庫分割・先行出荷・Short Pick 後の再割当・交換）。
- `fulfillment_items`: required_qty, allocated_qty, picked_qty, packed_qty, shipped_qty, short_qty
- 状態: `ready` → `waved` → `picking` → `picked` → `packing` → `packed` → `shipped`、または `cancelled`
- `fulfillment_type`: standard / replacement（交換品）
- 優先度 `priority` と期限 `due_at`（倉庫の締切時刻から算出、手動変更可）

## 6. Wave

- 条件: 倉庫（必須）、配送方法、優先度、期限（締切）、注文日、最大件数。
- 作成手順: プレビュー（候補 Fulfillment ID 一覧）→ 確定。確定時に
  `UPDATE fulfillments SET status='waved', wave_id=$w WHERE id = ANY($preview_ids) AND status='ready' AND NOT on_hold AND wave_id IS NULL`
  を実行し、返ってきた ID だけを `wave_fulfillments` に **snapshot として固定**。
  プレビュー後に到着した注文や、別 Wave に取られた Fulfillment は混入しない。
- Pick タスク生成: allocation（ロケーション確定済み）から pick_task_lines を作る。分割方式は「1 タスク / ゾーン別 / N 行ごと」。
- Pick List は SKU/Location 集約・ロケーション順（pick_sequence → code）で表示・印刷（ブラウザ印刷で PDF 化可）。
- Wave 取消: ピック実績がなければ Fulfillment を ready に戻す。実績があれば確認必須 + 棚戻し例外。

## 7. 出荷（Shipment）と分割発送

- Shipment = 1 箱（1 追跡番号）。梱包完了時に箱ごとに下書き Shipment を作成（ShipmentItem = SKU×数量×order_item）。
- 1 注文 → 複数 Fulfillment → 複数 Shipment。例: X2/Y1 で X だけ揃う → 「全商品待ち」または「X 先行」。
  X 先行なら Shipment1 = X×2（注文は partially_shipped）、後日 Y 引当 → Shipment2 = Y×1 → shipped。
- 追跡番号: 手入力 / CSV 取込 / CSV 出力。同一配送会社で同一追跡番号は重複エラー（CSV 取込時は例外キューへ）。
- **出荷確定**（`shipments.manage`）: Shipment 行 `FOR UPDATE` → 既に shipped なら同じ結果を返す（冪等）→
  数量検証（ShipmentItem 合計 ≤ packed − shipped、注文明細の出荷合計 ≤ 有効数量）→
  在庫減算 + Allocation 消化（INVENTORY_RULES.md）→ fulfillment_items / order_items の shipped_qty 更新 →
  Fulfillment/注文状態の再計算。送付先スナップショットを `ship_to` に保存。
- 配送会社 API 連携・ラベル購入は初版対象外。配送会社公式送り状のレイアウトは再現しない（汎用 CSV 出力のみ）。
