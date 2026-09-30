import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AppConfig } from './config.js';
import type { Pool } from './db/pool.js';
import { withTenant, type Actor, type Tx, type TenantTxOptions } from './db/tx.js';
import type { AuthContext, OrgContext } from './auth/context.js';
import type { Permission } from './auth/permissions.js';
import { AppError, forbidden, unauthorized } from './lib/errors.js';
import type { Storage } from './modules/attachments/storage.js';

export interface AppDeps {
  config: AppConfig;
  pool: Pool;
  /** 連番払い出し専用（業務トランザクションとは別接続で即コミット） */
  numberingPool: Pool;
  storage: Storage;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export type AuthedRequest = FastifyRequest & { auth: AuthContext & { org: OrgContext } };

export function actorFromReq(req: FastifyRequest): Actor {
  return {
    userId: req.auth?.userId ?? null,
    type: 'user',
    ip: req.ip,
    userAgent: (req.headers['user-agent'] ?? '').slice(0, 300),
    requestId: String(req.id),
  };
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function requireOrg(req: FastifyRequest): AuthContext & { org: OrgContext } {
  const auth = requireAuth(req);
  if (!auth.org) throw new AppError(403, 'NO_ORGANIZATION', '組織が選択されていません');
  return auth as AuthContext & { org: OrgContext };
}

export function hasPerm(auth: AuthContext | null, perm: Permission): boolean {
  return !!auth?.org && auth.permissions.has(perm);
}

/** preHandler: 指定の権限のいずれかを要求（ログイン + 組織必須） */
export function perm(...perms: Permission[]): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const auth = requireOrg(req);
    if (!perms.some((p) => auth.permissions.has(p))) throw forbidden();
  };
}

export function assertPerm(req: FastifyRequest, p: Permission) {
  const auth = requireOrg(req);
  if (!auth.permissions.has(p)) throw forbidden();
}

/** 倉庫スコープの検証（membership.warehouse_ids が NULL なら全倉庫） */
export function canAccessWarehouse(auth: AuthContext, warehouseId: string): boolean {
  return auth.warehouseIds === null || auth.warehouseIds.includes(warehouseId);
}

export function assertWarehouse(req: FastifyRequest, warehouseId: string) {
  const auth = requireOrg(req);
  if (!canAccessWarehouse(auth, warehouseId)) throw forbidden('この倉庫へのアクセス権限がありません');
}

/** リクエストの組織コンテキストでトランザクションを実行 */
export function orgTx<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>, opts?: TenantTxOptions): Promise<T> {
  const auth = requireOrg(req);
  return withTenant(req.server.deps.pool, auth.org.id, actorFromReq(req), fn, opts);
}
