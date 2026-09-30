# デプロイ手順 (DEPLOY.md)

> 対象: CommerceOps を動かすサーバーを用意・運用する人（購入者の IT 担当・委託先）。
> 本書の構成は例であり、**本番公開・有料契約は購入者の判断で行う**（開発時に本番公開・課金は行っていない）。検証状況は §9。

## 1. 構成
- **アプリ 1 プロセス**: API（Fastify）+ 画面（`web/dist` の静的配信）+ Job worker（`RUN_WORKER=true` で同一プロセス）。
  起動時に DB マイグレーションを自動実行（`SKIP_MIGRATIONS=true` で無効化）。
- **PostgreSQL 16**: 業務データ・セッション・Job キュー。拡張 `pg_trgm`, `btree_gin`（trusted extension。DB オーナー権限で作成される）。
- **永続ディスク**（`DATA_DIR`、既定 `/data`）: 返品写真、バックアップのアップロード一時ファイル。
- 外部サービス（Redis・メール・画像認識 API 等）は不要。メールは送らない（招待・再設定はリンクを本人に渡す）。

## 2. DB ユーザーの要件（必須）
アプリが使う DB ユーザーは **SUPERUSER / BYPASSRLS を持たない**こと。持っていると行レベルセキュリティ（組織の分離の多層防御）が効かない。
本番（`NODE_ENV=production`）では、該当するユーザーで接続するとアプリは**起動を拒否**する。

```sql
-- 確認（どちらも f であること）
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;

-- 作成例（スーパーユーザーで一度だけ）
CREATE ROLE commerceops LOGIN PASSWORD '十分に長いランダムな値' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE DATABASE commerceops OWNER commerceops ENCODING 'UTF8' TEMPLATE template0;
```
マネージド PostgreSQL で既定のユーザーが上記を満たさない場合は、専用ユーザーとそのユーザーが所有する DB を作って `DATABASE_URL` に使う。

## 3. 環境変数
| 変数 | 必須 | 例 / 既定 | 説明 |
|---|---|---|---|
| `DATABASE_URL` | ✓ | `postgres://commerceops:***@db:5432/commerceops` | §2 のユーザー |
| `APP_BASE_URL` | ✓ | `https://commerceops.example.com` | 招待・再設定リンクの URL に使う |
| `NODE_ENV` | | `production`（Docker イメージの既定） | production では Cookie が Secure、DB ユーザー検査が有効 |
| `PORT` / `HOST` | | `3000` / `0.0.0.0` | |
| `DATABASE_SSL` | | `false` | 外部の DB に TLS で接続する場合 `true` |
| `DATABASE_POOL_MAX` | | `10` | 同時作業者 × 1〜2 が目安 |
| `TRUST_PROXY` | | `false` | リバースプロキシ / PaaS の背後なら `true`（接続元 IP・HTTPS 判定） |
| `COOKIE_SECURE` | | production で `true` | `http://localhost` で試すだけなら `false` |
| `DATA_DIR` | | `/data` | 永続ディスク |
| `RUN_WORKER` | | `true` | Job worker を別プロセスにするなら `false` にして `node dist/worker.js` |
| `SESSION_IDLE_HOURS` / `SESSION_ABSOLUTE_DAYS` | | `12` / `7` | |
| `MAX_UPLOAD_MB` | | `20` | CSV・写真のアップロード |
| `BACKUP_MAX_UPLOAD_MB` / `BACKUP_MAX_EXPANDED_MB` | | `256` / `1024` | 画面から検証・復元するバックアップ（ファイル / 展開後）。超える場合は CLI |
| `RATE_LIMIT_MAX` | | `1200` | API 全体: 1 分あたり（接続元 IP ごと） |
| `LOGIN_RATE_LIMIT_MAX` | | `20` | ログイン: 15 分あたり（接続元 IP ごと）。同じ回線から多人数が一斉にログインする倉庫では増やす |
| `ALLOW_SIGNUP` | | `false` | 画面からの組織作成。自社利用では `false` のまま |
| `LOG_LEVEL` | | `info` | ログは stdout の JSON。個人情報は出さない |

秘密情報（DB パスワード等）はリポジトリにコミットせず、PaaS の環境変数・`.env`（権限 600）で渡す。

## 4. 方法 A: Docker Compose（1 台のサーバー）
前提: Docker Engine + Compose v2。
```bash
cd 017-commerceops
cp deploy/compose.env.example .env        # POSTGRES_PASSWORD / APP_DB_PASSWORD / APP_BASE_URL を変更
docker compose up -d --build              # 初回は PostgreSQL の初期化で deploy/postgres-init.sh がアプリ用ユーザーと DB を作る
docker compose logs -f app                # "[migrate] applying ..." → "Server listening" を確認
docker compose exec app node dist/scripts/create-owner.js --org "店名" --email owner@example.com --name "氏名"
#   → パスワードが一度だけ表示される。ログイン後に変更する
```
- 画面: `APP_BASE_URL`（前段の HTTPS）または `http://サーバー:3000`（試用時は `.env` で `COOKIE_SECURE=false`）。
- サンプル組織（任意）: `docker compose exec app node dist/scripts/seed-sample.js --owner-email owner@example.com`（本番データと分離された「Sample Commerce」。buyer-docs/サンプル業務説明.txt）。
- データ: ボリューム `db-data`（DB）・`app-data`（写真）。DB のバックアップは §7。

## 5. 方法 B: Render（Blueprint）
`render.yaml`（Web Service = Docker、PostgreSQL 16、永続ディスク 1GB）。**Render 上では未検証**。
1. Render で New → Blueprint を選び、リポジトリとファイル `017-commerceops/render.yaml` を指定。
2. `APP_BASE_URL` に公開 URL（例 `https://<サービス名>.onrender.com` または独自ドメイン）を設定。
3. デプロイ後、Shell で `node dist/scripts/create-owner.js --org ... --email ... --name ...`。
4. 起動ログに DB ユーザーの権限エラーが出た場合は §2 の手順で専用ユーザーを作り、`DATABASE_URL` を差し替える。
5. プラン名・料金・リージョン（東京リージョンは無く Singapore が最寄り）は契約前に公式ページで確認（docs/OPERATING_COSTS.md）。

## 6. 方法 C: Node.js を直接動かす（VPS / 自社サーバー）
```bash
# Node.js 22.12 以上、PostgreSQL 16（§2 のユーザーと DB）
cd 017-commerceops
npm ci
npm run build                      # web → server
cd server && NODE_ENV=production DATABASE_URL=... APP_BASE_URL=... DATA_DIR=/var/lib/commerceops node dist/index.js
```
systemd の例:
```ini
[Service]
WorkingDirectory=/opt/commerceops/server
EnvironmentFile=/etc/commerceops.env      # 権限 600
ExecStart=/usr/bin/node dist/index.js
Restart=always
User=commerceops
```
前段に HTTPS を終端するリバースプロキシ（Caddy / nginx 等）を置き、`TRUST_PROXY=true`。
リバースプロキシのアップロード上限はバックアップの復元サイズ（`BACKUP_MAX_UPLOAD_MB`）以上にする。

## 7. バックアップ・更新・監視
- **DB 全体**: マネージド DB の自動バックアップ / PITR、または `pg_dump`（毎日、別の場所へ保管）。
- **組織単位**: 画面（設定 → バックアップ・復元）または `node dist/scripts/backup-cli.js --org <組織ID> --out <file>`（docs/OPERATIONS.md）。
- **更新**: バックアップ → 新しい版をビルド/取得 → 再起動（マイグレーションは起動時に自動。複数台で同時に起動しても advisory lock で 1 回だけ適用）。
- **監視**: `GET /healthz`（`{ ok, version }`）、stdout の JSON ログ、DB 容量（docs/OPERATING_COSTS.md の実測値で見積もる）。

## 8. 初期設定の流れ
1. Owner を作成（§4 / §5 / §6）→ ログインし、画面右上の「パスワード変更」で変更。
2. 設定 → 組織 / 倉庫・ロケーション / チャネル / Import Profile / ユーザー（招待リンクを本人に渡す）。
3. 在庫・商品 → 商品登録（CSV 可）→ 入荷で在庫を入れる。
4. 注文取込 → 引当 → Wave → Pick → 梱包 → 出荷（buyer-docs の各ガイド）。

## 9. 検証状況（2026-09-30）
- Node.js 直接起動（§6）: 開発・E2E で使用（ビルド済み web を API が配信する構成で Playwright E2E を実行）。
- Docker（§4）: `docker build`・`docker compose up`・create-owner・seed-sample・CLI・ブラウザでの確認・再起動まで確認済み（TEST_REPORT.md §8.3）。
  社内のプロキシが TLS を検査する環境では、ビルド中の `npm ci` がそのプロキシの CA を信頼できるよう設定が必要（例: BuildKit の secret で `NODE_EXTRA_CA_CERTS` を渡す）。
- Render（§5）: 未検証（アカウント作成・課金を伴うため実施していない）。
