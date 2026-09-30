import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppDeps } from './http.js';
import { AppError, pgCode } from './lib/errors.js';
import { uuidv7 } from './lib/uuid.js';
import { registerAuthHooks } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { registerModuleRoutes } from './routes.js';
import { APP_VERSION } from './version.js';

export interface BuildAppOptions {
  logger?: boolean;
}

export async function buildApp(deps: AppDeps, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            // 個人情報・認証情報をログに出さない
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers["x-csrf-token"]',
                'req.headers.authorization',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
            serializers: {
              // クエリ文字列（検索語 = 氏名等を含みうる）はログに出さない
              req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }),
            },
          },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => uuidv7(),
  });

  app.decorate('deps', deps);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.NODE_ENV === 'production' ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    allowList: config.NODE_ENV === 'test' ? () => true : undefined,
    errorResponseBuilder: (_req, ctx) =>
      new AppError(429, 'RATE_LIMITED', `リクエストが多すぎます。${Math.ceil(ctx.ttl / 1000)}秒後に再試行してください`),
  });
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 20, parts: 30 },
  });

  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const fe = err as FastifyError;
    if (fe.validation) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: '入力内容に誤りがあります' } });
    }
    if (fe.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: fe.message } });
    }
    if (fe.code === 'FST_REQ_FILE_TOO_LARGE' || fe.code === 'FST_FILES_LIMIT') {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: 'ファイルサイズが上限を超えています' } });
    }
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: { code: fe.code ?? 'BAD_REQUEST', message: 'リクエストが不正です' } });
    }
    const code = pgCode(err);
    if (code === '23505') {
      return reply.status(409).send({ error: { code: 'DUPLICATE', message: '既に登録されているデータと重複しています' } });
    }
    if (code === '23514' || code === '23503') {
      req.log.warn({ err: { message: err.message, code } }, 'constraint violation');
      return reply
        .status(409)
        .send({ error: { code: 'CONSTRAINT_VIOLATION', message: 'データの整合性を保てないため処理できませんでした（最新の状態を確認してください）' } });
    }
    if (code === '40001' || code === '40P01' || code === '55P03') {
      return reply.status(409).send({ error: { code: 'CONCURRENT_UPDATE', message: '他の操作と競合しました。もう一度実行してください' } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL', message: 'サーバーエラーが発生しました', requestId: String(req.id) } });
  });

  registerAuthHooks(app);

  app.get('/healthz', async () => ({ ok: true, version: APP_VERSION }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  await app.register(authRoutes);
  await app.register(registerModuleRoutes);

  // ---- SPA 静的配信 ----
  const webDist = resolve(config.WEB_DIST_DIR ?? join(process.cwd(), '..', 'web', 'dist'));
  const hasWeb = existsSync(join(webDist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      index: false,
      setHeaders: (reply, path) => {
        if (/[\\/]assets[\\/]/.test(path)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else reply.header('Cache-Control', 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !hasWeb || req.method !== 'GET') {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });

  return app;
}
