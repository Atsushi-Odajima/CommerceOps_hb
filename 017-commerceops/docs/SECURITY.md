# セキュリティ設計 (SECURITY.md)

## 1. 脅威と対策

| 脅威 | 対策 | 検証 |
|---|---|---|
| 他テナントのデータ閲覧・改ざん（URL/ID 書き換え） | RLS(FORCE) + 全 SQL の org 条件 + 複合 FK。別組織 ID は 404（存在を漏らさない） | phase0-poc, R22 |
| 権限外操作（UI を迂回した API 直叩き） | 全ルートで `perm()` preHandler、倉庫スコープ、担当者チェック | rbac-matrix, R23, R24 |
| SQL インジェクション | すべて parameterized query（`$1`）。動的な識別子はホワイトリストのみ | コードレビュー・grep |
| XSS | React の自動エスケープ、`dangerouslySetInnerHTML` 不使用、CSP `script-src 'self'`、画像 URL は https のみ | CSP ヘッダテスト |
| CSRF | SameSite=Lax Cookie + 同期 CSRF トークン（`X-CSRF-Token`）+ 全状態変更に `X-Requested-With: CommerceOps` 必須（ログイン CSRF も防止） | phase0-poc |
| セッション盗用 | HttpOnly / Secure / `__Host-` Cookie、DB にはトークンの SHA-256 のみ、アイドル 12h/絶対 7d、パスワード変更で他セッション破棄 | |
| 総当たり | ログイン rate limit（IP 単位）+ アカウントロック（5 回失敗で 15 分）+ 汎用エラーメッセージ | phase0-poc |
| パスワード漏えい | scrypt（N=2^15,r=8,p=3）、10 文字以上・弱パスワード拒否 | |
| CSV/Formula Injection | 出力セル先頭 `= + - @ \t \r` に `'` を付与 | R25 |
| CSV パーサ攻撃 | RFC4180 準拠 parser、行数/サイズ上限、列数上限、BOM/文字コード明示 | |
| Import Profile による任意コード実行 / ReDoS | 宣言的変換のみ（正規表現・式・eval 不可）、zod 厳格検証 | import-profile テスト |
| Zip Slip / パストラバーサル | ZIP を受け付けない（バックアップは gzip NDJSON）。添付の保存キーはサーバー生成 `{uuid}/{uuid}` のみ、解決パスが基底配下か検証 | storage テスト |
| アップロード悪用 | multipart サイズ上限・1 ファイル、画像 MIME とマジックバイト検証 | |
| 個人情報の過剰露出 | ロール別の表示範囲（Picker は注文情報なし、Packer は送付先氏名住所のみ）、PII を含む CSV は `export.csv` 権限 + 監査 | pii テスト |
| ログからの漏えい | pino redact（Cookie/CSRF/Authorization）、リクエストボディ非記録、URL のクエリ文字列非記録 | |
| 二重処理（再送・連打） | client_event_id / requestId による冪等化、行ロック、DB 一意制約 | R08, R11, R12, R17 |
| 監査ログ改ざん | 追記専用（UPDATE/DELETE をトリガで拒否） | |
| DoS（過負荷） | グローバル rate limit、ボディサイズ上限、statement_timeout 60s、ページング上限 200 | |
| 秘密情報の混入 | 環境変数のみ（`.env` は gitignore）、`.env.example` にはダミー値 | |
| クリックジャッキング | CSP `frame-ancestors 'none'` | |
| 依存ライブラリ | ライセンス確認（GPL/AGPL なし）、`npm audit` をリリース前に実施 | RELEASE_CHECKLIST |

## 2. HTTP セキュリティヘッダ
- `Content-Security-Policy`: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'（本番は upgrade-insecure-requests）
- `Strict-Transport-Security`（本番）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy: camera=(self)` など（helmet）

## 3. 個人情報の取り扱い
- 保存: 注文の顧客/送付先スナップショット、顧客マスター、取込ステージング（7 日で削除）。
- 端末: PWA は API レスポンスをキャッシュしない。オフライン下書き（Pick scan）には個人情報を含めない。
- 表示: RBAC.md の表示範囲表に従う。
- エクスポート: 権限 + 監査ログ。
- 実顧客データ・実注文の利用は購入者の責任で行う（開発・検証はサンプルデータのみ）。

## 4. 運用上の注意（購入者向けにも記載）
- DB ユーザーに SUPERUSER/BYPASSRLS を付与しない。
- HTTPS 終端の背後で `TRUST_PROXY=true`、`COOKIE_SECURE` は本番で自動 true。
- バックアップファイルは個人情報を含むため暗号化ストレージに保管し、アクセスを制限する。
