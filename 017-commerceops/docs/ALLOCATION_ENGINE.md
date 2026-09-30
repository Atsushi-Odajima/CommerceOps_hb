# 引当エンジン (ALLOCATION_ENGINE.md)

目的: 注文明細に対して、どの倉庫・どのロケーションの在庫を確保するかを **説明可能なルール** で決め、
**二重引当を DB レベルで不可能にする**。AI 最適化は行わない。

## 1. データ

`allocations`: organization_id, id, order_id, order_item_id, warehouse_id, location_id, product_id,
`quantity`（確保数）, `shipped_qty`（出荷で消化）, `released_qty`（解放）, `status`(active/consumed/released),
`fulfillment_item_id`（Fulfillment へ release 済みなら設定）, `reason`, `allocation_run_id`, created_at/by, released_at/reason。

open 数量 = quantity − shipped_qty − released_qty。`status=active` の open 合計が `inventory_balances.allocated` と一致する。

## 2. 対象注文

- 状態が `ready_for_allocation` または `partially_allocated`
- 有効な保留（Hold）がない、検証エラーがない、キャンセルされていない
- 並び順（公平性・説明可能性）: `priority DESC, due_at ASC NULLS LAST, order_date ASC, order_number ASC`

## 3. 1 注文あたりの手順（1 注文 = 1 トランザクション）

1. `SELECT ... FROM orders WHERE id=$1 FOR UPDATE` で注文行をロック（同じ注文を 2 つのジョブ/人が同時に引当できない）。
2. ロック取得後に **残必要数を再計算**: `need = (quantity − cancelled_qty) − shipped_qty − open_allocated`。
   need が全行 0 なら何もしない（= Job 再実行・再送でも二重引当しない）。
3. 倉庫候補: 有効な倉庫を「既にこの注文の引当/Fulfillment がある倉庫 → 倉庫優先度 → コード」の順に並べる。
4. 各倉庫で need を満たせるか判定（販売可能ロケーションの Available 合計）。
5. **全量を満たせる倉庫がある** → 最初の倉庫で全量引当（理由 `FULL_SINGLE_WAREHOUSE`）。
6. **どの倉庫も全量を満たせない**:
   - 組織設定 `allowPartialAllocation=true`（既定）: 充足できる数量が最大の倉庫で可能な分だけ引当（理由 `PARTIAL`）。
     → 注文は `partially_allocated`。**注文数量は絶対に減らさない。**
   - 他倉庫で残りを満たせる場合は「分割候補」として表示するが **自動確定しない**。
     人間が「残りを大阪倉庫から引当」を実行して初めて分割引当（理由 `MANUAL_SPLIT`）。
   - `allowPartialAllocation=false`: 何も引当しない。
   - いずれも need が残る場合は欠品例外 `shortage`（dedupe: 注文単位）を作成/更新。全量引当になれば自動解決。
7. ロケーション選択（倉庫内）: 1 ロケーションで行の必要数を満たせるなら pick_sequence が最小のそこを使う。
   満たせなければ pick_sequence 順に取り崩す（複数 allocation 行になる）。
8. 各ロケーションの確保は **条件付き UPDATE**:
   ```sql
   UPDATE inventory_balances
      SET allocated = allocated + $qty, updated_at = now()
    WHERE organization_id = $org AND id = $balance
      AND on_hand - allocated - held >= $qty
   RETURNING id
   ```
   0 行なら他トランザクションに先を越されたので残量を再読込して次のロケーションへ。
   複数 balance の更新は `(product_id, location_id)` 昇順で行いデッドロックを避ける。
9. `order_items.allocated_qty / allocation_status` を更新し、注文状態を再計算（履歴記録）。
10. **Release（Fulfillment 作成）**: 設定 `autoReleaseFullyAllocated=true`（既定）かつ注文が全量引当になったら、
    未 release の allocation を倉庫ごとに Fulfillment 化（同じ注文・倉庫で `ready` の Fulfillment があれば追記）。
    一部引当の注文は既定で「全商品待ち」。人間が「揃った分を先行出荷」を選ぶと、その時点の引当分で Fulfillment を作る。

## 4. 手動操作（`allocation.manage` 権限）

| 操作 | 内容 |
|---|---|
| 引当実行（一括） | 上記ルールで対象注文を順に処理する Job `allocation.run` を投入。dedupe key により組織ごとに同時 1 本 |
| 注文単位で引当 | 1 注文だけ同ルールで処理 |
| 倉庫を指定して引当 | 残必要数を指定倉庫から確保（分割出荷の確定） |
| 引当解除 | 未 Wave の allocation を解放。ready の Fulfillment から明細を除く（空なら Fulfillment をキャンセル） |
| 先行出荷（一部 release） | 一部引当の注文で、引当済み分だけ Fulfillment を作成 |

## 5. 競合・冪等性の保証（テスト対応）

| 要件 | 仕組み | テスト |
|---|---|---|
| OnHand10→3 引当→Allocated3/Available7 | allocated のみ加算 | R01 |
| 最後の 1 個に 2 注文同時 → 1 件のみ成功 | 条件付き UPDATE + 行ロック再評価 + CHECK 制約 | R02, E2E-2 |
| Job 再実行で二重引当なし | 注文行ロック後に need 再計算、dedupe key | R03 |
| 数量 3 / Available 2 → Partially Allocated | 部分引当 + 数量不変 | R04 |
| 取消で未出荷 Allocation 解放 | キャンセル処理で open 分を解放 | R05 |

## 6. 引当結果の説明

`GET /api/orders/:id/allocation-plan` は、各倉庫の SKU 別 Available と「全量可/一部/不可」を返し、
UI で「東京倉庫で全 3 商品が揃うため東京を優先」「大阪に Y×1 あり（分割候補）」のように表示する。
