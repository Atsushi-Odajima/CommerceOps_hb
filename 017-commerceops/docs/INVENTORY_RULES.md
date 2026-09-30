# 在庫整合ルール (INVENTORY_RULES.md)

CommerceOps は仕入・本格棚卸を主役にしないが、Fulfillment のために **倉庫 × ロケーション × SKU** 単位の
最小在庫台帳を持つ。StockPilot（#013）なしでも単体で動作し、将来 StockPilot Connector を追加できる境界を持つ。

## 1. 数量の定義

`inventory_balances`（organization, warehouse, location, product ごとに 1 行）

| 列 | 意味 |
|---|---|
| `on_hand` | ロケーションに物理的に存在するはずの数量 |
| `allocated` | 注文明細に引当済み（未出荷）の数量 |
| `held` | 調査中で引当に使えない数量（Short Pick 等で「現物が見つからない」分） |

- **Available = on_hand − allocated − held**（販売可能ロケーションのみ合算）
- DB 制約: `on_hand >= 0`, `allocated >= 0`, `held >= 0`, `allocated + held <= on_hand`
- 引当可能なのは `locations.kind = 'pick'`（販売可能）かつ有効なロケーションのみ。
  `quarantine`（返品保留）・`damaged`（破損）ロケーションの on_hand は Available に含めない。
- 倉庫単位・SKU 単位の Available は上記の合計（`GET /api/inventory` で表示）。

例: OnHand 10 の SKU に注文 A が 3 引当 → `allocated = 3`, `Available = 7`（on_hand は 10 のまま）。

## 2. 変更操作と数量の動き（一貫ルール）

| 操作 | on_hand | allocated | held | 記録先 | 冪等キー |
|---|---|---|---|---|---|
| 入荷（簡易）/ 棚卸調整 | ±q | – | – | inventory_movements (receipt/adjust) | クライアント requestId |
| 引当 | – | +q | – | allocations (active) | 注文行ロック + 残必要数の再計算 |
| 引当解放（キャンセル/手動解除/再割当） | – | −q | – | allocations.released_qty | allocation 行ロック |
| ピック | – | – | – | pick_events（在庫数量は動かさない） | client_event_id |
| Short Pick | – | −q（該当 allocation 解放） | +q | pick_events + movements(hold) | client_event_id |
| Held 解消: 紛失確定 | −q | – | −q | movements (hold_loss) | exception 解決 requestId |
| Held 解消: 発見 | – | – | −q | movements (unhold) | exception 解決 requestId |
| 梱包 | – | – | – | pack_events（在庫数量は動かさない） | client_event_id |
| **出荷確定** | −q | −q（allocation 消化） | – | movements (ship) + allocations.shipped_qty | `ship:{shipment_id}:{allocation_id}` UNIQUE |
| 返品受付/到着 | – | – | – | returns（在庫は動かさない） | – |
| 返品検品 Restock | +q（販売可能ロケーション） | – | – | movements (restock) | `return_inspection:{id}` UNIQUE |
| 返品検品 Damaged | +q（damaged ロケーション） | – | – | movements (return_damaged) | 同上 |
| 返品検品 Quarantine | +q（quarantine ロケーション） | – | – | movements (return_quarantine) | 同上 |
| 返品検品 Discard | 0 | – | – | movements (discard, 数量 0 の記録) | 同上 |
| ロケーション移動 | 移動元 −q / 移動先 +q | – | – | movements (transfer) ×2 | requestId |

### 原則
1. **引当は on_hand を減らさない。** 減らすのは出荷確定時のみ。
2. **出荷確定 = 在庫減算 + Allocation 消化を 1 トランザクションで行う。**
   出荷行ごとに、その FulfillmentItem に紐づく active な Allocation を作成順(FIFO)に消化し、
   `on_hand -= q`, `allocated -= q`, `allocation.shipped_qty += q` を同時に更新する。
3. **再送・二重クリックで二重減算しない。** Shipment 行を `FOR UPDATE` でロックし、既に `shipped` なら何もせず
   同じ結果を返す。さらに movements の `(organization_id, idempotency_key)` UNIQUE がバックストップ。
4. **返品は受付/到着だけでは在庫に戻さない。** 検品で Disposition を確定した時点で初めて on_hand を動かし、
   Restock のみ販売可能ロケーションへ戻す（= Available が増えるのは Restock だけ）。
5. **在庫を勝手に調整しない。** Short Pick は on_hand を減らさず `held` に移して調査対象にする。
   紛失確定（on_hand 減）は `inventory.adjust` 権限を持つ人が例外キューから明示的に行う。
6. すべての on_hand / held の変化は `inventory_movements` に 1 行以上残す（誰が・いつ・なぜ・参照元）。
   allocated の変化は `allocations` 行（作成・消化・解放の各時刻/理由）が台帳。

## 3. 不変条件（整合性チェックで検証）

- `balance.on_hand = Σ movements.on_hand_delta`（同一 balance）
- `balance.held = Σ movements.held_delta`
- `balance.allocated = Σ (allocation.quantity − shipped_qty − released_qty)`（status=active の allocation）
- `order_item.shipped_qty = Σ shipment_items.quantity`（status=shipped の shipment）
- `order_item.shipped_qty <= order_item.quantity − cancelled_qty`
- `fulfillment_item.shipped_qty <= packed_qty <= picked_qty <= required_qty`（強制梱包時は packed=required）
- 返品: `return_item.inspected_qty <= received_qty`、Restock 合計 ≤ 出荷済数量 − 既返品数量

`npm run integrity -- --org <id>`（および Backup/Restore 後の検証）でこれらを SQL で照合する。

## 4. 同時実行制御

- 引当: `UPDATE inventory_balances SET allocated = allocated + $q WHERE ... AND on_hand - allocated - held >= $q`
  （READ COMMITTED の行ロック + 再評価により、最後の 1 個に同時に来た 2 注文のうち 1 件だけ成功）
- 複数 balance を更新するトランザクションは `(product_id, location_id)` 順でロックしデッドロックを回避。
  それでも発生した 40P01/40001 は安全なリトライ対象。
- CHECK 制約 `allocated + held <= on_hand` が最終防衛線。

## 5. StockPilot Connector 境界（将来）

`server/src/modules/inventory/provider.ts` に `InventoryProvider` インターフェースを定義:
- `getAvailability(warehouseId, productIds)` / `applyExternalOnHand(snapshot)` / `exportMovements(since)`
初版は `LocalInventoryProvider`（本台帳）のみ実装。StockPilot 連携時は
「StockPilot の on_hand を正として定期取込 → 差分を adjust movement として記録」「出荷/返品 movement を StockPilot へ送る」
方式を想定（allocated/held は CommerceOps 側で保持）。仕入発注・補充分析・本格棚卸は #013 の領域として実装しない。
