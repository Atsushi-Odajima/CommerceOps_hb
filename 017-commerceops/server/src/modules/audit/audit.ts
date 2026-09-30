import type { Tx } from '../../db/tx.js';
import { uuidv7 } from '../../lib/uuid.js';

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string | null;
  summary?: string;
  /** 個人情報（氏名・住所・電話・メール）は入れない */
  metadata?: Record<string, unknown>;
}

/** 監査ログ（追記専用）。業務トランザクションと同じトランザクションで記録し、失敗時は一緒にロールバックされる */
export async function audit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.exec(
    `INSERT INTO audit_logs (organization_id, id, actor_user_id, actor_type, action, entity_type, entity_id, summary,
                             metadata, ip, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      tx.orgId,
      uuidv7(),
      tx.actor.userId,
      tx.actor.type,
      e.action,
      e.entityType ?? null,
      e.entityId ?? null,
      e.summary?.slice(0, 500) ?? null,
      JSON.stringify(e.metadata ?? {}),
      tx.actor.ip ?? null,
      tx.actor.userAgent ?? null,
      tx.actor.requestId ?? null,
    ],
  );
}
