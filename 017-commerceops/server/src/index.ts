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
