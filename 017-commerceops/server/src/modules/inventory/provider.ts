/**
 * StockPilot（#013）連携の境界（将来）。
 * 初版は CommerceOps 内の最小在庫台帳（LocalInventoryProvider 相当 = inventory/service.ts）のみ。
 * 仕入発注・補充分析・本格棚卸は #013 の領域として CommerceOps には実装しない。
 *
 * 想定する連携方式:
 *  - StockPilot の on_hand を正として定期取込 → 差分を adjust movement として記録（applyExternalOnHand）
 *  - CommerceOps の出荷/返品 movement を StockPilot へ送る（exportMovements）
 *  - allocated / held は CommerceOps 側で保持（Fulfillment の責務）
 */
export interface ExternalOnHandSnapshot {
  warehouseCode: string;
  locationCode: string;
  sku: string;
  onHand: number;
  asOf: string;
}

export interface InventoryMovementExport {
  id: string;
  warehouseCode: string;
  locationCode: string;
  sku: string;
  type: string;
  onHandDelta: number;
  createdAt: string;
  referenceType: string | null;
  referenceId: string | null;
}

export interface InventoryProvider {
  readonly kind: 'local' | 'stockpilot';
  /** 倉庫・商品ごとの Available（販売可能ロケーションの on_hand − allocated − held） */
  getAvailability(warehouseId: string, productIds: string[]): Promise<Map<string, number>>;
  /** 外部の実在庫スナップショットを取り込み、差分を調整として記録（将来） */
  applyExternalOnHand?(snapshots: ExternalOnHandSnapshot[]): Promise<{ adjusted: number }>;
  /** 指定時刻以降の movement を外部へ送るために取得（将来） */
  exportMovements?(since: Date, limit: number): Promise<InventoryMovementExport[]>;
}
