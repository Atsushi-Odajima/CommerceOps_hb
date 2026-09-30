import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { LocalDiskStorage } from './modules/attachments/storage.js';
import { startWorker } from './jobs/worker.js';

async function main() {
  const config = loadConfig();
  const pool = createPool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX, ssl: config.DATABASE_SSL });
  const numberingPool = createPool({
    connectionString: config.DATABASE_URL,
    max: 3,
    ssl: config.DATABASE_SSL,
    applicationName: 'commerceops-numbering',
  });
  // SUPERUSER / BYPASSRLS のユーザーでは行レベルセキュリティ（組織の分離の多層防御）が効かない。本番では起動しない
  const role = (await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
  if (role?.rolsuper || role?.rolbypassrls) {
    const msg =
      'DATABASE_URL のユーザーが SUPERUSER または BYPASSRLS を持っています。組織の分離（RLS）が効かないため、' +
      'NOSUPERUSER NOBYPASSRLS のアプリ専用ユーザーを使ってください（docs/DEPLOY.md）';
    if (config.NODE_ENV === 'production' && process.env.ALLOW_RLS_BYPASS_ROLE !== 'true') throw new Error(msg);
    console.warn(`[warn] ${msg}`);
  }
  if (process.env.SKIP_MIGRATIONS !== 'true') {
    await migrate(pool, (m) => console.log(`[migrate] ${m}`));
  }
  const storage = new LocalDiskStorage(config.DATA_DIR);
  const app = await buildApp({ config, pool, numberingPool, storage });
  const worker = config.RUN_WORKER ? startWorker({ config, pool, numberingPool, storage }, app.log) : null;

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await worker?.stop();
    await app.close();
    await pool.end();
    await numberingPool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
