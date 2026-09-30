/** Job worker を単独プロセスで起動（API と分離してスケールする場合）: npm run worker -w server */
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { LocalDiskStorage } from './modules/attachments/storage.js';
import { startWorker } from './jobs/worker.js';

const config = loadConfig();
const pool = createPool({ connectionString: config.DATABASE_URL, max: 5, ssl: config.DATABASE_SSL });
const numberingPool = createPool({ connectionString: config.DATABASE_URL, max: 2, ssl: config.DATABASE_SSL, applicationName: 'commerceops-numbering' });
const worker = startWorker({ config, pool, numberingPool, storage: new LocalDiskStorage(config.DATA_DIR) }, undefined, 3);
console.log('[worker] started');
const stop = async () => {
  await worker.stop();
  await pool.end();
  await numberingPool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
