# 開発ガイド (DEVELOPMENT.md)

## 構成
```
017-commerceops/
├─ server/            Fastify API + Job worker（TypeScript, ESM）
│  ├─ src/
│  │  ├─ app.ts        Fastify 組み立て（helmet/CSP, rate limit, cookie, multipart, エラー処理, SPA 配信）
│  │  ├─ index.ts      起動（マイグレーション → API → in-process worker）
│  │  ├─ worker.ts     Job worker 単独起動（スケール時）
│  │  ├─ config.ts     環境変数（zod 検証）
│  │  ├─ db/           pool, tx（withTenant: app.org_id を設定する RLS トランザクション）, migrate, migrations/*.sql
│  │  ├─ auth/         permissions（RBAC の正）, session, plugin（Cookie/CSRF）, routes
│  │  ├─ modules/      業務モジュール（routes + service）
│  │  ├─ jobs/         PostgreSQL Job キュー
│  │  └─ scripts/      seed-sample, create-owner, backup/restore CLI, integrity
│  └─ test/           Vitest（実 PostgreSQL）
├─ web/               React + Vite + PWA
├─ e2e/               Playwright（PC / iPhone / Android / iPad エミュレーション）
├─ load/              負荷・データ量試験スクリプト
├─ docs/              開発資料
└─ buyer-docs/        購入者向け資料
```

## 必要なもの
- Node.js 22.12 以上、PostgreSQL 16（`pg_trgm`, `btree_gin` 拡張。いずれも trusted extension で DB オーナー権限で作成可）

## セットアップ（ローカル）
```bash
# 1) DB ロールとデータベース（スーパーユーザーで一度だけ）
psql -U postgres -c "CREATE ROLE commerceops LOGIN PASSWORD 'commerceops_dev_pw' NOSUPERUSER NOBYPASSRLS"
psql -U postgres -c "CREATE DATABASE commerceops_dev OWNER commerceops"
psql -U postgres -c "CREATE DATABASE commerceops_test OWNER commerceops"

# 2) 依存関係
cd 017-commerceops && npm ci

# 3) 環境変数（.env.example をコピー）
cp .env.example server/.env   # DATABASE_URL などを設定

# 4) マイグレーション + サンプル組織
npm run db:migrate
npm run seed:sample            # Sample Commerce（is_sample=true の組織）を作成

# 5) 開発サーバー
npm run dev -w server          # http://localhost:3000 （API）
npm run dev -w web             # http://localhost:5173 （/api は 3000 へプロキシ）
```

> **重要**: アプリの DB ユーザーは SUPERUSER / BYPASSRLS を持たないこと。持っていると RLS が効かない（テナント分離の多層防御が失われる）。

## よく使うコマンド
| コマンド | 内容 |
|---|---|
| `npm run typecheck` | server/web の型検査 |
| `npm test` | サーバーの単体/統合/競合テスト（`commerceops_test` を毎回初期化） |
| `npm run e2e` | Playwright E2E（ビルド済み web + API を起動して実行） |
| `npm run build` | web → server の本番ビルド |
| `npm run create-owner -w server -- --org "店名" --email owner@example.com --name "氏名"` | 初期 Owner 作成（パスワードは対話入力または自動生成して表示） |
| `npm run integrity -w server -- --org <orgId>` | 在庫・数量の不変条件チェック |
| `npm run backup -w server -- --org <orgId> --out file.ndjson.gz` | 組織バックアップ |
| `npm run restore -w server -- --file file.ndjson.gz --actor-email <メール>` | 新しい組織として復元 |
| `npm run seed:sample -w server -- [--owner-email <メール>]` | サンプル組織 Sample Commerce（is_sample、本番データと分離）を作成 |
| `npm run password-reset -w server -- --email <メール>` | 運用者による再設定リンクの発行 |
| `npx tsx load/contention.ts` / `load/dayflow.ts` / `load/scale.ts`（server/） | 同時実行・1 日の業務量・大量データの検証（TEST_REPORT.md §4・§7・§8。負荷用 DB を使う） |
| `node scripts/third-party-notices.mjs` | buyer-docs/THIRD_PARTY_NOTICES.txt を再生成（本番依存のライセンス表記） |
| `docker build -t commerceops .` / `docker compose up -d` | 本番イメージ・1 台構成（docs/DEPLOY.md） |
| `node e2e/scripts/docker-smoke.mjs <URL> <メール> <パスワード>` | 起動したアプリに実ブラウザでログインして主要画面を確認 |

ビルド済みの環境（Docker・本番）では CLI を `node dist/scripts/<名前>-cli.js`（create-owner.js / seed-sample.js）で実行する（`server/` で）。

## コーディング規約
- SQL は必ず placeholder（`$1`）。文字列連結で値を埋め込まない。
- 業務データへのアクセスは `withTenant` / `orgTx(req, ...)` 経由のみ（RLS コンテキスト必須）。
- 権限チェックはルートの `preHandler: perm('...')` + 倉庫スコープは `assertWarehouse`。
- 状態を変える処理は「行ロック（FOR UPDATE）→ 再検証 → 条件付き更新 → 監査ログ」の順。状態列だけを更新する親行（注文・Fulfillment・Wave）は
  `FOR NO KEY UPDATE`（子行の INSERT の外部キー検査と衝突させない）、複数行は ID 順にロックする（ADR-032）。
- 冪等キーの確認は、対象の行ロックを取った後にもう一度行う（同時再送の後着を正しく「重複」として扱う）。
- 再送されうる操作（scan、完了、出荷確定、検品）はクライアント生成の UUID を受け取り冪等にする。
- 個人情報をログ・監査メタデータ・例外 detail に入れない。
- UI 文言は日本語。API エラーは `{ error: { code, message, details } }`。
