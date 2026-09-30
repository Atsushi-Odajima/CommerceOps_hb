/**
 * 段階的な大量データでの index / query 検証（本番ビルドには含まれない）。
 *
 * 方式: 実 API で「テンプレート組織」（1,000 注文。取込 → 引当 → Wave → Pick → 梱包 → 出荷 → 返品/交換、少量の進行中・保留・取消・Short を含む）を作り、
 * その業務データを SQL で「大きな組織」へ K 回複製する（ID は時刻を保った UUIDv7 に振り直し、番号・外部注文番号・追跡番号・冪等キーも一意に変換、
 * 日時は 1 年に分散）。マスター（倉庫・ロケーション・商品・チャネル）は共有し、在庫残高は在庫移動と引当から再計算する。
 * → 大規模でも整合性チェックが通る（生成データ自体が正しいことを確認できる）。小さな組織を多数作ってマルチテナントも再現する。
 *
 *   npx tsx load/scale.ts template [--orders 1000]
 *   npx tsx load/scale.ts clone --from 0 --to 99 --total 1000      # 大きな組織へ K=0..99 を複製
 *   npx tsx load/scale.ts tenants --count 50                        # テンプレートを小さな組織として 50 個複製
 *   npx tsx load/scale.ts finalize                                  # 在庫残高・採番の再計算、ANALYZE
 *   npx tsx load/scale.ts measure --label stageA                    # API / SQL の応答時間、実行計画、容量、整合性チェック、バックアップ速度
 *   npx tsx load/scale.ts stats
 * DB は --db（既定 commerceops_load）。状態は load/results/scale-state.json。
 * 販売保証値ではない。実測した規模・環境の値だけを TEST_REPORT.md に記録する。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { SYSTEM_ACTOR, withSystem, withTenant } from '../src/db/tx.js';
import { checkIntegrity } from '../src/modules/integrity/check.js';
import { exportOrganizationLines } from '../src/modules/backup/export.js';
import { BACKUP_TABLES, USER_COLUMNS, type BackupTable } from '../src/modules/backup/format.js';
import { MemoryStorage } from '../src/modules/attachments/storage.js';
import { upsertMembership } from '../src/modules/orgs/service.js';
import { purgeImportStaging } from '../src/modules/imports/maintenance.js';
import { addUser, Client, createLoadEnv, LOAD_PASSWORD, newOrg, round, Timings } from './lib.js';
import { runFlow, setupMaster } from './flow.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string', default: process.env.LOAD_DATABASE_URL ?? 'postgres://commerceops:commerceops_dev_pw@localhost:5432/commerceops_load' },
    orders: { type: 'string', default: '1000' },
    from: { type: 'string', default: '0' },
    to: { type: 'string', default: '0' },
    total: { type: 'string', default: '1000' },
    batch: { type: 'string', default: '10' },
    count: { type: 'string', default: '50' },
    label: { type: 'string', default: 'stage' },
    'skip-backup': { type: 'boolean', default: false },
    // 複製で振る番号の基準値（計測中に API で作った注文の番号と重ならないよう、後の段階では大きくする）
    numbase: { type: 'string', default: '0' },
    // データ生成専用（複製は組織をまたいで読み書きするため RLS をバイパスするロールで行う。アプリ本体は使わない）
    admin: { type: 'string', default: process.env.LOAD_ADMIN_DATABASE_URL ?? 'postgres://commerceops_loadadmin:loadadmin_dev_pw@localhost:5432/commerceops_load' },
  },
});
const cmd = positionals[0];
const RESULTS = new URL('../../load/results/', import.meta.url);
mkdirSync(RESULTS, { recursive: true });
const STATE = new URL('scale-state.json', RESULTS);
interface State {
  templateOrgId?: string;
  templateOwnerEmail?: string;
  bigOrgId?: string;
  clonedK: number[];
  totalK?: number;
  tenants: string[];
  counters?: Record<string, number>;
}
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { clonedK: [], tenants: [] };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

const MASTER: BackupTable[] = ['warehouses', 'locations', 'products', 'product_barcodes', 'sales_channels', 'import_profiles', 'inventory_balances'];
const KEEP_UUID_COLUMNS = new Set(['warehouse_id', 'location_id', 'product_id', 'balance_id', 'channel_id', 'profile_id']);
const NUMBER_COLUMNS: Partial<Record<BackupTable, [string, string]>> = {
  orders: ['order_number', 'order'],
  fulfillments: ['fulfillment_number', 'fulfillment'],
  waves: ['wave_number', 'wave'],
  pick_tasks: ['task_number', 'pick_task'],
  shipments: ['shipment_number', 'shipment'],
  returns: ['return_number', 'return'],
  exchanges: ['exchange_number', 'exchange'],
  exception_cases: ['exception_number', 'exception'],
  import_batches: ['batch_number', 'import_batch'],
};
const YEAR_MS = 365 * 86_400_000;

/** 時刻を保った UUID の振り直し（v7 は先頭 48bit の時刻をずらし、残りは md5 由来。v7 以外は v4 形式）。インライン展開できる 1 式の SQL 関数 */
const REMAP_FN = `CREATE OR REPLACE FUNCTION load_remap(u uuid, k int, shift_ms bigint) RETURNS uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN u IS NULL THEN NULL
    WHEN substr(u::text, 15, 1) = '7' THEN
      (lpad(to_hex(('x' || lpad(replace(substr(u::text, 1, 13), '-', ''), 16, '0'))::bit(64)::bigint - shift_ms), 12, '0')
        || '7' || substr(md5(u::text || ':' || k), 1, 3) || '8' || substr(md5(u::text || ':' || k), 4, 15))::uuid
    ELSE (substr(md5(u::text || ':' || k), 1, 12) || '4' || substr(md5(u::text || ':' || k), 13, 3) || '8' || substr(md5(u::text || ':' || k), 16, 15))::uuid
  END $$`;

async function superPool() {
  return new pg.Pool({ connectionString: values.admin, max: 4 });
}

async function columnsOf(pool: pg.Pool) {
  const cols = (
    await pool.query(
      `SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name, ordinal_position`,
      [BACKUP_TABLES],
    )
  ).rows as { table_name: string; column_name: string; udt_name: string }[];
  const fk = (
    await pool.query(
      `SELECT c.conrelid::regclass::text AS t, a.attname AS col, c.confrelid::regclass::text AS ref
         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND a.attname <> 'organization_id'`,
    )
  ).rows as { t: string; col: string; ref: string }[];
  const refOf = new Map(fk.map((f) => [`${f.t}.${f.col}`, f.ref]));
  const byTable = new Map<string, { name: string; type: string; ref?: string }[]>();
  for (const c of cols) {
    let a = byTable.get(c.table_name);
    if (!a) byTable.set(c.table_name, (a = []));
    a.push({ name: c.column_name, type: c.udt_name, ref: refOf.get(`${c.table_name}.${c.column_name}`) });
  }
  return byTable;
}

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const remapKey = (col: string) =>
  `CASE WHEN ${col} IS NULL THEN NULL
        WHEN ${col} ~ '${UUID_RE}' THEN array_to_string(ARRAY(
          SELECT CASE WHEN x.p ~ '^${UUID_RE}$' THEN load_remap(x.p::uuid, k, sh)::text ELSE x.p END
            FROM unnest(string_to_array(${col}, ':')) WITH ORDINALITY AS x(p, i) ORDER BY x.i), ':')
        ELSE ${col} || ':c' || k END`;

/** 業務テーブル 1 つを K の範囲で複製する SELECT 式 */
function cloneSelect(t: BackupTable, cols: { name: string; type: string; ref?: string }[], counters: Record<string, number>) {
  const userCols = new Set(USER_COLUMNS[t] ?? []);
  const exprs = cols.map((c) => {
    const col = `s.${c.name}`;
    if (c.name === 'organization_id') return '$1::uuid';
    if (c.type === 'uuid') {
      if (userCols.has(c.name) || KEEP_UUID_COLUMNS.has(c.name) || (c.ref && MASTER.includes(c.ref as BackupTable))) return col;
      return `load_remap(${col}, k, sh)`;
    }
    if (c.type === '_uuid') return `'{}'::uuid[]`;
    if (c.type === 'timestamptz') return `${col} - make_interval(secs => sh / 1000.0)`;
    const num = NUMBER_COLUMNS[t];
    if (num && c.name === num[0])
      // lpad は指定長より長い文字列を切り詰めるため、6 桁未満のときだけ 0 埋めする
      return `split_part(${col}, '-', 1) || '-' || (SELECT CASE WHEN length(v) < 6 THEN lpad(v, 6, '0') ELSE v END FROM (SELECT (split_part(${col}, '-', 2)::bigint + k::bigint * ${counters[num[1]] ?? 1000000} + ${Number(values.numbase)})::text AS v) x)`;
    if ((t === 'orders' || t === 'import_batch_orders') && c.name === 'external_order_id') return `${col} || '-' || k`;
    if (t === 'shipments' && c.name === 'tracking_number') return `CASE WHEN ${col} IS NULL THEN NULL ELSE left(${col}, 33) || lpad(k::text, 7, '0') END`;
    // 冪等キー・重複防止キーに埋め込まれた ID も同じ規則で振り直す（例: ship:{荷物ID}:{引当ID}）。ID を含まないキーは K を付けて一意にする
    if ((t === 'inventory_movements' && c.name === 'idempotency_key') || (t === 'exception_cases' && c.name === 'dedupe_key')) return remapKey(col);
    if (t === 'import_batches' && c.name === 'file_sha256') return `encode(sha256(convert_to(${col} || ':' || k, 'UTF8')), 'hex')`;
    return col;
  });
  return { list: cols.map((c) => c.name).join(', '), exprs: exprs.join(', ') };
}

async function main() {
  const t0 = performance.now();
  if (cmd === 'template') {
    const env = await createLoadEnv(values.db!);
    try {
      const n = Number(values.orders);
      const email = `template-${Date.now().toString(36)}@example.invalid`;
      const { orgId, owner } = await newOrg(env, `負荷検証テンプレート（${n} 注文）`, email);
      const master = await setupMaster(owner, { skus: 40, stockPerSku: n * 2, scarceSkus: 1 });
      const pickers = await Promise.all([0, 1, 2, 3].map((i) => addUser(env, orgId, `tpl-picker${i}-${email}`, 'picker')));
      const packers = await Promise.all([0, 1, 2, 3].map((i) => addUser(env, orgId, `tpl-packer${i}-${email}`, 'packer')));
      // 過去分（すべて完了）+ 当日分（進行中を含む）を別の取込として作る
      const hist = await runFlow(owner, master, { orders: Math.round(n * 0.9), seed: 7, extPrefix: 'H-', date: '2026-09-29 10:00:00', pickers, packers, returnRatio: 0.11, exchangeRatio: 0.03, shortRatio: 0.005, searchSamples: 0, cancelRatio: 0.03 });
      const today = await runFlow(owner, master, {
        orders: n - Math.round(n * 0.9),
        seed: 11,
        extPrefix: 'T-',
        date: '2026-09-30 09:00:00',
        channelIndex: 1,
        pickers,
        packers,
        holdRatio: 0.03,
        cancelRatio: 0.02,
        leaveReadyRatio: 0.2,
        leaveUnpickedRatio: 0.2,
        leaveUnpackedRatio: 0.2,
        leaveUnshippedRatio: 0.3,
        searchSamples: 0,
      });
      const violations = await withTenant(env.pool, orgId, SYSTEM_ACTOR, (tx) => checkIntegrity(tx));
      state.templateOrgId = orgId;
      state.templateOwnerEmail = email;
      state.bigOrgId = undefined;
      state.clonedK = [];
      state.tenants = [];
      save();
      console.log(JSON.stringify({ orgId, hist, today, integrity: violations.length }, null, 1));
    } finally {
      await env.close();
    }
  } else if (cmd === 'clone' || cmd === 'tenants') {
    if (!state.templateOrgId) throw new Error('run template first');
    const pool = await superPool();
    try {
      await pool.query(REMAP_FN);
      const cols = await columnsOf(pool);
      const T = state.templateOrgId;
      const counters: Record<string, number> = Object.fromEntries(
        (await withOrg(pool, T, (c) => c.query(`SELECT name, value FROM counters WHERE organization_id = $1`, [T]))).rows.map((r: any) => [r.name, Number(r.value)]),
      );
      state.counters = counters;
      if (cmd === 'tenants') {
        // 小さな組織: テンプレートをそのまま（ID も同じ。組織 ID だけ違う）複製
        const n = Number(values.count);
        for (let i = 0; i < n; i++) {
          const orgId = (await pool.query(`INSERT INTO organizations (id, name, timezone, settings) SELECT gen_random_uuid(), '小規模テナント ' || $2, timezone, settings FROM organizations WHERE id = $1 RETURNING id`, [T, state.tenants.length + 1])).rows[0].id;
          await withOrg(pool, orgId, async (c) => {
            for (const t of BACKUP_TABLES) {
              if (t === 'attachments') continue;
              const list = cols.get(t)!.map((x) => x.name);
              await c.query(`INSERT INTO ${t} (${list.join(', ')}) SELECT ${list.map((x) => (x === 'organization_id' ? '$1::uuid' : x === 'attachment_ids' ? `'{}'::uuid[]` : x)).join(', ')} FROM ${t} WHERE organization_id = $2`, [orgId, T]);
            }
          }, T);
          state.tenants.push(orgId);
          save();
          process.stdout.write(`tenant ${state.tenants.length} `);
        }
        console.log();
      } else {
        // 大きな組織: マスターは 1 回だけ（同じ ID）、業務データは K ごとに ID・番号を振り直して複製
        const total = Number(values.total);
        state.totalK = total;
        if (!state.bigOrgId) {
          const big = (await pool.query(`INSERT INTO organizations (id, name, timezone, settings) SELECT gen_random_uuid(), '大規模検証組織', timezone, settings FROM organizations WHERE id = $1 RETURNING id`, [T])).rows[0].id;
          await withOrg(pool, big, async (c) => {
            for (const t of MASTER) {
              const list = cols.get(t)!.map((x) => x.name);
              await c.query(`INSERT INTO ${t} (${list.join(', ')}) SELECT ${list.map((x) => (x === 'organization_id' ? '$1::uuid' : x)).join(', ')} FROM ${t} WHERE organization_id = $2`, [big, T]);
            }
          }, T);
          // テンプレートの Owner を大きな組織の Owner にもする（API 計測用）
          await withSystem(pool as never, async (c) => {
            const uid = (await c.query(`SELECT id FROM users WHERE email = $1`, [state.templateOwnerEmail])).rows[0].id;
            await upsertMembership(c, big, uid, 'owner', null);
          });
          state.bigOrgId = big;
          save();
        }
        const B = state.bigOrgId!;
        const from = Number(values.from);
        const to = Number(values.to);
        const step = Number(values.batch);
        const tx = BACKUP_TABLES.filter((t) => !MASTER.includes(t) && t !== 'attachments' && t !== 'counters');
        for (let k0 = from; k0 <= to; k0 += step) {
          const k1 = Math.min(to, k0 + step - 1);
          if (state.clonedK.includes(k0)) continue;
          const b0 = performance.now();
          await withOrg(pool, B, async (c) => {
            for (const t of tx) {
              const { list, exprs } = cloneSelect(t, cols.get(t)!, counters);
              await c.query(
                `INSERT INTO ${t} (${list}) SELECT ${exprs}
                   FROM ${t} s CROSS JOIN LATERAL (SELECT k, (k::bigint * ${YEAR_MS}::bigint / ${total})::bigint AS sh FROM generate_series($3::int, $4::int) k) g
                  WHERE s.organization_id = $2`,
                [B, T, k0, k1],
              );
            }
          }, T);
          for (let k = k0; k <= k1; k++) state.clonedK.push(k);
          save();
          console.log(`cloned K=${k0}..${k1} in ${round((performance.now() - b0) / 1000)}s`);
        }
      }
    } finally {
      await pool.end();
    }
  } else if (cmd === 'finalize') {
    const pool = await superPool();
    try {
      for (const orgId of [state.bigOrgId].filter(Boolean) as string[]) {
        const f0 = performance.now();
        await withOrg(pool, orgId, async (c) => {
          await c.query(
            `UPDATE inventory_balances b SET on_hand = x.on_hand, held = x.held, updated_at = now()
               FROM (SELECT balance_id, SUM(on_hand_delta)::int AS on_hand, SUM(held_delta)::int AS held FROM inventory_movements WHERE organization_id = $1 GROUP BY balance_id) x
              WHERE b.organization_id = $1 AND b.id = x.balance_id`,
            [orgId],
          );
          await c.query(
            `UPDATE inventory_balances b SET allocated = COALESCE(x.open, 0)
               FROM inventory_balances b2 LEFT JOIN (SELECT balance_id, SUM(quantity - shipped_qty - released_qty)::int AS open FROM allocations WHERE organization_id = $1 AND status = 'active' GROUP BY balance_id) x ON x.balance_id = b2.id
              WHERE b.organization_id = $1 AND b2.organization_id = $1 AND b.id = b2.id`,
            [orgId],
          );
          // 採番カウンタは実データの最大番号に合わせる（以後 API で作る番号と重ならない）
          for (const [t, [col, kind]] of Object.entries(NUMBER_COLUMNS) as [string, [string, string]][]) {
            const max = (await c.query(`SELECT COALESCE(max(split_part(${col}, '-', 2)::bigint), 0) AS m FROM ${t} WHERE organization_id = $1`, [orgId])).rows[0].m;
            await c.query(`INSERT INTO counters (organization_id, name, value) VALUES ($1, $2, $3) ON CONFLICT (organization_id, name) DO UPDATE SET value = GREATEST(counters.value, EXCLUDED.value)`, [orgId, kind, Number(max)]);
          }
        }, orgId);
        console.log(`finalized ${orgId} in ${round((performance.now() - f0) / 1000)}s`);
      }
      // 取込ステージング（個人情報）の保持期限処理を実運用と同じく適用（確定から 7 日で正規化データを削除）
      const env = await createLoadEnv(values.db!);
      try {
        const p0 = performance.now();
        const pr = await purgeImportStaging(env.deps);
        console.log(`purged import staging ${JSON.stringify(pr)} in ${round((performance.now() - p0) / 1000)}s`);
      } finally {
        await env.close();
      }
      await pool.query('VACUUM FULL import_batch_orders');
      const a0 = performance.now();
      await pool.query('ANALYZE');
      console.log(`ANALYZE ${round((performance.now() - a0) / 1000)}s`);
    } finally {
      await pool.end();
    }
  } else if (cmd === 'stats') {
    const pool = await superPool();
    try {
      console.log(JSON.stringify(await sizeStats(pool), null, 1));
    } finally {
      await pool.end();
    }
  } else if (cmd === 'measure') {
    await measure();
  } else {
    console.log('usage: scale.ts template|clone|tenants|finalize|measure|stats');
  }
  console.log(`done in ${round((performance.now() - t0) / 1000)}s`);
}

/** 1 トランザクションで実行（生成用ロールは RLS をバイパスする。app.org_id は念のため対象組織に設定） */
async function withOrg<T>(pool: pg.Pool, orgId: string, fn: (c: pg.PoolClient) => Promise<T>, _readOrg?: string): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function sizeStats(pool: pg.Pool) {
  const rows = (
    await pool.query(
      `SELECT c.relname AS t, c.reltuples::bigint AS rows, pg_total_relation_size(c.oid) AS bytes, pg_relation_size(c.oid) AS heap, pg_indexes_size(c.oid) AS idx
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC`,
    )
  ).rows;
  const db = (await pool.query(`SELECT pg_database_size(current_database()) AS b`)).rows[0].b;
  return { dbBytes: Number(db), dbGB: round(Number(db) / 1024 ** 3, 2), tables: rows.map((r) => ({ t: r.t, rows: Number(r.rows), MB: round(Number(r.bytes) / 1024 ** 2), heapMB: round(Number(r.heap) / 1024 ** 2), idxMB: round(Number(r.idx) / 1024 ** 2) })) };
}

/** 規模ごとの計測 */
async function measure() {
  if (!state.bigOrgId || !state.templateOwnerEmail) throw new Error('clone first');
  const env = await createLoadEnv(values.db!);
  const pool = await superPool();
  const out: any = { label: values.label, at: new Date().toISOString() };
  try {
    const B = state.bigOrgId;
    const counts = await withOrg(pool, B, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM orders WHERE organization_id = $1)::int AS orders, (SELECT count(*) FROM order_items WHERE organization_id = $1)::int AS items,
                (SELECT count(*) FROM allocations WHERE organization_id = $1)::int AS allocations, (SELECT count(*) FROM pick_events WHERE organization_id = $1)::int AS pick_events,
                (SELECT count(*) FROM shipments WHERE organization_id = $1)::int AS shipments, (SELECT count(*) FROM returns WHERE organization_id = $1)::int AS returns,
                (SELECT count(*) FROM audit_logs WHERE organization_id = $1)::int AS audit_logs, (SELECT count(*) FROM inventory_movements WHERE organization_id = $1)::int AS movements`,
        [B],
      ),
    );
    out.bigOrg = counts.rows[0];
    out.allOrgs = (await pool.query(`SELECT (SELECT count(*) FROM orders)::int AS orders, (SELECT count(*) FROM organizations)::int AS organizations`)).rows[0];
    out.size = await sizeStats(pool);
    console.log('big org:', JSON.stringify(out.bigOrg), 'all:', JSON.stringify(out.allOrgs), 'db:', out.size.dbGB, 'GB');

    const timings = new Timings();
    const owner = await new Client(env.app, timings).login(state.templateOwnerEmail, LOAD_PASSWORD, B);
    const sample = await withOrg(pool, B, (c) =>
      c.query(
        `SELECT o.id, o.order_number, o.external_order_id, o.recipient_name, o.postal_code, s.tracking_number, r.return_number
           FROM orders o LEFT JOIN shipments s ON s.organization_id = o.organization_id AND s.order_id = o.id AND s.status = 'shipped'
           LEFT JOIN returns r ON r.organization_id = o.organization_id AND r.order_id = o.id
          WHERE o.organization_id = $1 AND o.status = 'shipped' ORDER BY random() LIMIT 20`,
        [B],
      ),
    );
    const REPEAT = 3;
    const api = async (label: string, url: string) => {
      for (let i = 0; i < REPEAT; i++) await owner.get(url, label);
    };
    // 画面で使う主な参照系
    await api('orders.list (最新 50)', '/api/orders?limit=50');
    await api('orders.list (状態: 引当待ち)', '/api/orders?limit=50&status=ready_for_allocation');
    await api('orders.list (未完了)', '/api/orders?limit=50&statusGroup=open');
    await api('orders.status_counts', '/api/orders/status-counts');
    await api('dashboard.home', '/api/dashboard/home');
    await api('dashboard.badges', '/api/dashboard/badges');
    for (const s of sample.rows.slice(0, 10)) {
      await owner.get(`/api/orders/${s.id}`, 'orders.detail');
      await owner.get(`/api/search?q=${encodeURIComponent(s.order_number)}`, 'search: 注文番号');
      await owner.get(`/api/search?q=${encodeURIComponent(s.external_order_id)}`, 'search: 外部注文番号');
      if (s.tracking_number) await owner.get(`/api/search?q=${encodeURIComponent(s.tracking_number)}`, 'search: 追跡番号');
      if (s.return_number) await owner.get(`/api/search?q=${encodeURIComponent(s.return_number)}`, 'search: 返品番号');
      await owner.get(`/api/search?q=${encodeURIComponent(s.postal_code)}`, 'search: 郵便番号');
      await owner.get(`/api/search?q=${encodeURIComponent(String(s.recipient_name).split(' ')[0])}`, 'search: 氏名（姓）');
    }
    await api('search: SKU', '/api/search?q=LD-005');
    await api('orders.list (外部注文番号の前方一致)', `/api/orders?limit=50&q=${encodeURIComponent(sample.rows[0].external_order_id.slice(0, 6))}`);
    await api('fulfillments.list (Wave 待ち)', '/api/fulfillments?status=ready&limit=50');
    const whs = (await owner.get('/api/warehouses')).items as { id: string }[];
    await api('waves.list', '/api/waves?limit=50');
    for (let i = 0; i < REPEAT; i++) await owner.post('/api/waves/preview', { warehouseId: whs[0]!.id }, 'waves.preview (Wave 作成画面)');
    await api('pick-tasks.list', '/api/pick-tasks?limit=50');
    await api('pack.queue', '/api/pack/queue');
    await api('shipments.list (出荷待ち)', '/api/shipments?status=draft&limit=50');
    await api('shipments.list (出荷済み)', '/api/shipments?status=shipped&limit=50');
    await api('returns.list', '/api/returns?limit=50');
    await api('exceptions.list (未解決)', '/api/exceptions?status=active&limit=50');
    await api('audit.list', '/api/audit?limit=50');
    await api('inventory.list (在庫一覧)', '/api/inventory?limit=50');
    await api('inventory.balances (商品別)', `/api/inventory/balances?productId=${(await owner.get('/api/products?limit=1')).items[0].id}`);
    await api('inventory.movements', '/api/inventory/movements?limit=50');
    await api('assignments', '/api/assignments');
    const today = new Date().toISOString().slice(0, 10);
    const d30 = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    await api('kpi (30 日)', `/api/kpi?from=${d30}&to=${today}`);
    // 新しい注文 1 件の引当（大量の在庫待ち注文がある状態での候補抽出を含む）
    const ch = (await owner.get('/api/channels')).items[0].id;
    for (let i = 0; i < 5; i++) {
      const o = await owner.post('/api/orders', { channelId: ch, order: { externalOrderId: `M-${values.label}-${Date.now()}-${i}`, customer: { name: '計測 太郎' }, shipTo: { name: '計測 太郎', postalCode: '150-0001', prefecture: '東京都', city: '渋谷区', address1: '計測町1-1', phone: '090-0000-0000' }, lines: [{ sku: 'LD-010', quantity: 1 }] } }, 'orders.create_manual');
      await owner.post(`/api/orders/${o.id}/allocate`, {}, 'orders.allocate (1 件)');
    }
    for (let i = 0; i < 2; i++) await owner.post('/api/allocation/run-now', {}, 'allocation.run_now (候補抽出 + 処理)');
    out.api = timings.summary();
    for (const [k, s] of Object.entries(out.api) as [string, any][]) console.log(`  ${k.padEnd(34)} n=${String(s.n).padStart(3)} p50=${String(s.p50).padStart(8)}ms p95=${String(s.p95).padStart(8)}ms max=${String(s.max).padStart(8)}ms`);

    // SQL の実行計画（Seq Scan の有無と実行時間）
    out.plans = {};
    const explain = async (name: string, sql: string, params: unknown[]) => {
      const r = await withOrg(pool, B, (c) => c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params));
      const plan = r.rows[0]['QUERY PLAN'][0];
      const nodes: string[] = [];
      const walk = (n: any) => {
        nodes.push(`${n['Node Type']}${n['Relation Name'] ? ` on ${n['Relation Name']}` : ''}${n['Index Name'] ? ` using ${n['Index Name']}` : ''}`);
        for (const ch of n.Plans ?? []) walk(ch);
      };
      walk(plan.Plan);
      const seq = nodes.filter((x) => x.startsWith('Seq Scan'));
      out.plans[name] = { ms: round(plan['Execution Time']), seqScans: seq, nodes: nodes.slice(0, 12) };
      console.log(`  [plan] ${name.padEnd(40)} ${String(round(plan['Execution Time'])).padStart(8)}ms ${seq.length ? 'SEQ: ' + seq.join(', ') : 'index only'}`);
    };
    const s0 = sample.rows[0];
    await explain('orders: 最新 50 件', `SELECT id FROM orders WHERE organization_id = $1 ORDER BY order_date DESC, id DESC LIMIT 50`, [B]);
    await explain('orders: 状態別 50 件', `SELECT id FROM orders WHERE organization_id = $1 AND status = 'ready_for_allocation' ORDER BY order_date DESC, id DESC LIMIT 50`, [B]);
    await explain('orders: 注文番号', `SELECT id FROM orders WHERE organization_id = $1 AND order_number = $2`, [B, s0.order_number]);
    await explain('orders: 外部注文番号', `SELECT id FROM orders WHERE organization_id = $1 AND external_order_id = $2`, [B, s0.external_order_id]);
    await explain('orders: 郵便番号', `SELECT id FROM orders WHERE organization_id = $1 AND postal_code = $2 ORDER BY order_date DESC LIMIT 50`, [B, s0.postal_code]);
    await explain('shipments: 追跡番号', `SELECT id FROM shipments WHERE organization_id = $1 AND tracking_number = $2`, [B, s0.tracking_number]);
    await explain('order_items: 注文の明細', `SELECT * FROM order_items WHERE organization_id = $1 AND order_id = $2`, [B, s0.id]);
    await explain('allocations: 注文の引当', `SELECT * FROM allocations WHERE organization_id = $1 AND order_id = $2`, [B, s0.id]);
    await explain('pick_events: タスクの記録', `SELECT * FROM pick_events WHERE organization_id = $1 AND pick_task_id = (SELECT id FROM pick_tasks WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1)`, [B]);
    await explain('fulfillments: Wave 待ち', `SELECT id FROM fulfillments WHERE organization_id = $1 AND warehouse_id = $2 AND status = 'ready' AND NOT on_hold AND wave_id IS NULL LIMIT 100`, [B, whs[0]!.id]);
    await explain('audit: 最新 50 件', `SELECT id FROM audit_logs WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`, [B]);
    await explain('audit: 操作の種類で絞り込み（まれな操作）', `SELECT id FROM audit_logs WHERE organization_id = $1 AND action LIKE 'backup%' ORDER BY created_at DESC, id DESC LIMIT 50`, [B]);
    await explain('audit: 操作の種類で絞り込み（多い操作）', `SELECT id FROM audit_logs WHERE organization_id = $1 AND action LIKE 'order%' ORDER BY created_at DESC, id DESC LIMIT 50`, [B]);
    await explain('audit: 対象の履歴', `SELECT id FROM audit_logs WHERE organization_id = $1 AND entity_id = $2 ORDER BY created_at DESC LIMIT 50`, [B, s0.id]);
    await explain('movements: 残高の履歴', `SELECT id FROM inventory_movements WHERE organization_id = $1 AND balance_id = (SELECT id FROM inventory_balances WHERE organization_id = $1 LIMIT 1) ORDER BY created_at DESC LIMIT 50`, [B]);

    // 整合性チェック（組織全体）
    const i0 = performance.now();
    const violations = await withTenant(env.pool, B, SYSTEM_ACTOR, (tx) => checkIntegrity(tx));
    out.integrity = { violations: violations.length, ms: Math.round(performance.now() - i0), sample: violations.slice(0, 3) };
    console.log(`  integrity: ${violations.length ? 'NG ' + JSON.stringify(violations.slice(0, 2)) : 'OK'} in ${out.integrity.ms}ms`);

    // バックアップ（gzip を捨てて速度だけ測る）。--skip-backup で省略（応答時間だけを測り直す場合）
    if (!values['skip-backup']) {
      const b0 = performance.now();
      let bytes = 0;
      await pipeline(
        Readable.from(exportOrganizationLines(env.pool, new MemoryStorage(), B)),
        createGzip(),
        new Writable({
          write(chunk, _e, cb) {
            bytes += chunk.length;
            cb();
          },
        }),
      );
      out.backup = { ms: Math.round(performance.now() - b0), gzipBytes: bytes };
      console.log(`  backup export: ${round(out.backup.ms / 1000)}s, ${round(bytes / 1024 ** 2)} MB gzip`);
    }
  } finally {
    await pool.end();
    await env.close();
  }
  writeFileSync(new URL(`scale-${values.label}.json`, RESULTS), JSON.stringify(out, null, 2));
}

await main();
