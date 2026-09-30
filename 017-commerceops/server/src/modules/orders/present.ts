import type { AuthContext } from '../../auth/context.js';

/** 個人情報の表示範囲（docs/RBAC.md §4）に従って注文をシリアライズ */
export function piiLevel(auth: AuthContext): 'full' | 'ship_to' | 'none' {
  if (auth.permissions.has('orders.read_pii')) return 'full';
  if (auth.permissions.has('orders.read_ship_to')) return 'ship_to';
  return 'none';
}

export function presentOrder(o: any, level: 'full' | 'ship_to' | 'none') {
  const base = {
    id: o.id,
    orderNumber: o.order_number,
    channelId: o.channel_id,
    channelName: o.channel_name,
    externalOrderId: o.external_order_id,
    orderType: o.order_type,
    sourceOrderId: o.source_order_id,
    exchangeId: o.exchange_id,
    orderDate: o.order_date,
    status: o.status,
    statusChangedAt: o.status_changed_at,
    shippingMethod: o.shipping_method,
    notes: level === 'none' ? undefined : o.notes,
    priority: o.priority,
    dueAt: o.due_at,
    importBatchId: o.import_batch_id,
    validationErrors: o.validation_errors,
    totalQty: o.total_qty,
    cancelledAt: o.cancelled_at,
    cancelReason: o.cancel_reason,
    closedAt: o.closed_at,
    createdAt: o.created_at,
    version: o.version,
  };
  if (level === 'none') return base;
  const shipTo = {
    name: o.recipient_name,
    postalCode: o.postal_code,
    prefecture: o.prefecture,
    city: o.city,
    address1: o.address1,
    address2: o.address2,
    phone: level === 'full' ? o.recipient_phone : undefined,
  };
  if (level === 'ship_to') return { ...base, shipTo };
  return {
    ...base,
    customerId: o.customer_id,
    customer: { name: o.customer_name, email: o.customer_email, phone: o.customer_phone },
    shipTo,
  };
}

/** 一覧用（電話・メールは含めない） */
export function presentOrderListRow(o: any, level: 'full' | 'ship_to' | 'none') {
  return {
    id: o.id,
    orderNumber: o.order_number,
    channelName: o.channel_name,
    externalOrderId: o.external_order_id,
    orderType: o.order_type,
    orderDate: o.order_date,
    status: o.status,
    priority: o.priority,
    totalQty: o.total_qty,
    itemCount: o.item_count,
    shippingMethod: o.shipping_method,
    hasValidationErrors: Array.isArray(o.validation_errors) && o.validation_errors.length > 0,
    recipientName: level === 'none' ? undefined : o.recipient_name,
    prefecture: level === 'none' ? undefined : o.prefecture,
    customerName: level === 'full' ? o.customer_name : undefined,
    createdAt: o.created_at,
  };
}
