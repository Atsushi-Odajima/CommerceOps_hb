import type { FastifyInstance, FastifyReply } from 'fastify';
import { AppError } from '../lib/errors.js';
import { safeEqual } from '../lib/hash.js';
import { loadSession } from './session.js';

/** 認証 Cookie 名。Secure 環境では __Host- 接頭辞（Domain 指定不可・Path=/ 固定・Secure 必須） */
export function sessionCookieName(secure: boolean) {
  return secure ? '__Host-co_sid' : 'co_sid';
}

/** CSRF トークン照合を免除する（未ログイン状態で呼ぶ）エンドポイント */
const CSRF_EXEMPT = new Set([
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/invitations/preview',
  '/api/auth/invitations/accept',
  '/api/auth/password-reset',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function registerAuthHooks(app: FastifyInstance) {
  const { config, pool } = app.deps;
  const cookieName = sessionCookieName(config.cookieSecure);
  const sessionCfg = { idleHours: config.SESSION_IDLE_HOURS, absoluteDays: config.SESSION_ABSOLUTE_DAYS };

  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const token = req.cookies[cookieName];
    req.auth = token ? await loadSession(pool, token, sessionCfg) : null;

    if (!SAFE_METHODS.has(req.method)) {
      // クロスサイトのフォーム送信を遮断（カスタムヘッダはクロスオリジンでは CORS preflight なしに付与できない）
      if (req.headers['x-requested-with'] !== 'CommerceOps') {
        throw new AppError(403, 'CSRF_HEADER_MISSING', '不正なリクエストです（ページを再読み込みしてください）');
      }
      const path = req.url.split('?')[0]!;
      if (req.auth && !CSRF_EXEMPT.has(path)) {
        const t = req.headers['x-csrf-token'];
        if (typeof t !== 'string' || !safeEqual(t, req.auth.csrfToken)) {
          throw new AppError(403, 'CSRF_TOKEN_INVALID', 'セッションの確認に失敗しました（ページを再読み込みしてください）');
        }
      }
    }
  });
}

export function setSessionCookie(app: FastifyInstance, reply: FastifyReply, token: string) {
  const { config } = app.deps;
  reply.setCookie(sessionCookieName(config.cookieSecure), token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: config.SESSION_ABSOLUTE_DAYS * 24 * 3600,
  });
}

export function clearSessionCookie(app: FastifyInstance, reply: FastifyReply) {
  const { config } = app.deps;
  reply.clearCookie(sessionCookieName(config.cookieSecure), {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
  });
}
