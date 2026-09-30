# セキュリティ設計 (SECURITY.md)

最終更新: Phase 9（2026-09-30）。テスト ID は `server/test/*.test.ts` のテスト名、R00 は必須テスト番号。

## 1. 守るもの・想定する攻撃者

| 守るもの | 例 |
|---|---|
| 他の事業者（組織）のデータ | 注文・顧客・住所・SKU・在庫・出荷・返品・CSV・監査ログ・バックアップ |
| 個人情報 | 購入者/送付先の氏名・住所・電話・メール（注文スナップショット・顧客マスター・取込ステージング・バックアップファイル） |
| 在庫・出荷の正しさ | 二重引当・二重出荷減算・二重 Restock・誤出荷 |
| アカウント | パスワード・セッション・招待/再設定リンク |

| 攻撃者 | 想定 |
|---|---|
| 別の組織のユーザー（Owner を含む） | 自分の組織では全権限を持つ。URL・ID・リクエスト本文を書き換える、細工したバックアップファイルを復元する、招待リンクを自分で開く |
| 同じ組織の権限の低いユーザー | Picker / Packer / Support が UI を迂回して API を直接呼ぶ。倉庫限定のユーザーが他倉庫の ID を指定する |
| 未ログインの第三者 | 総当たり、CSRF（ログイン済みの利用者に踏ませる）、XSS、アップロード悪用 |
| 誤操作・再送 | 二度押し、通信断後の再送、複数端末の同時操作 |

## 2. 脅威と対策

| 脅威 | 対策 | 検証 |
|---|---|---|
| 他テナントのデータ閲覧・改ざん（URL/ID 書き換え） | RLS（FORCE、DB ロールは NOSUPERUSER NOBYPASSRLS）+ 全 SQL の組織条件 + 複合 FK（組織をまたぐ参照は DB が拒否）。別組織の ID は一律 **404**（存在を明かさない） | phase0-poc、**R22 全ルート横断テスト**（登録済みの API 154 ルートを列挙し、ID を含む 75 ルートすべてに別組織の ID で要求 → 2xx/5xx なし・GET は 404・データ不変） |
| 本文・絞り込みに他テナントの ID を入れる | 参照先は常に自組織の中で検索（見つからなければ 404）。一括処理は対象ごとに判定し、他組織の ID は「失敗」として何もしない | R22（本文・絞り込み・検索・CSV 出力） |
| 倉庫限定ユーザーによる他倉庫の操作 | `assertWarehouse`（Wave・Pick タスク・梱包・Fulfillment・荷物・返品・例外・ロケーション）。倉庫に紐づかない例外（欠品など）は組織全体の例外として表示 | 倉庫スコープ横断テスト、Phase4〜8 の倉庫テスト |
| 権限外操作（UI を迂回した API 直叩き） | 全ルートで `perm()` preHandler、担当者チェック（Pick/梱包の claim） | rbac-matrix、R23、R24、E2E-7 |
| SQL インジェクション | すべて parameterized query（`$1`）。動的な識別子はコード内のホワイトリストのみ。LIKE のワイルドカードはエスケープ | HTTP hardening（`' OR '1'='1` 等が値として扱われる）、監査ログの `%` 検索 |
| XSS | React の自動エスケープ、`dangerouslySetInnerHTML` 不使用、CSP `script-src 'self'`、写真は画像のマジックバイト検証 + `nosniff` で配信（SVG 不可） | HTTP hardening（CSP）、写真テスト |
| CSRF | SameSite=Lax Cookie + 同期 CSRF トークン（`X-CSRF-Token`、定数時間比較）+ 全状態変更に `X-Requested-With: CommerceOps` 必須（ログイン CSRF も防止） | phase0-poc、HTTP hardening |
| セッション盗用・固定化 | HttpOnly / SameSite / 本番は Secure + `__Host-` Cookie。DB にはトークンの SHA-256 のみ。ログインごとに新しいセッション、ログアウトで失効、アイドル 12h / 絶対 7d、パスワード変更・再設定で全セッション破棄 | HTTP hardening |
| 総当たり | ログイン rate limit（IP 単位、既定 15 分 20 回）+ アカウントロック（5 回失敗で 15 分）+ 存在の有無を区別しない同一エラー | login rate limit テスト、HTTP hardening |
| **招待リンクによるアカウント乗っ取り**（Phase 9 で修正） | 招待リンクは発行した Owner も開けるため、承諾時に既存アカウントのパスワードを設定できる条件を限定: 有効なアカウントは本人のパスワードが必要（未設定なら常に不一致）、無効化されたアカウントは拒否、パスワード未設定のアカウントが他の組織に所属している場合は拒否（無効化中の所属を含む。`ACCOUNT_NEEDS_RESET`） | account takeover guards |
| **パスワード再設定リンクによる乗っ取り**（Phase 9 で修正） | Owner が再設定リンクを発行できるのは、対象ユーザーが所属する**すべての**組織（無効化中の所属を含む）で自分が Owner の場合だけ（`USER_IN_OTHER_ORGANIZATION`）。それ以外はサーバー運用者が CLI（`npm run password-reset`）で本人確認のうえ発行 | account takeover guards、R26（restore 後の再設定可否） |
| 細工したバックアップの復元 | 画面からの復元は「新しい組織」として作成し、既存の行・他組織には一切書き込まない（全行の organization_id を新組織に置換、RLS の WITH CHECK、複合 FK）。ユーザーは**復元する人が Owner を務める組織のメンバーだけ**を対応付け、それ以外はアカウント作成もメンバー追加もしない（一覧で返す）。形式・件数・チェックサム・スキーマ版の検証 → 投入 → 件数照合・整合性チェック、失敗時は全体をロールバック（添付も削除） | backup tests（改ざん・途中切れ・ZIP・版違い・organization_id 混入・対象外テーブル・整合性違反・FK 違反・他社ユーザー混入） |
| パスワード漏えい | scrypt（N=2^15, r=8, p=3）、10 文字以上・弱パスワード拒否。バックアップにはパスワードハッシュを含めない | |
| CSV/Formula Injection | 出力セル先頭 `= + - @ \t \r` に `'` を付与（注文・返品・在庫・出荷・例外・KPI・監査ログ） | R25、監査ログ CSV |
| CSV パーサ攻撃 | 正規 CSV パーサ（csv-parse 7.x、`split(",")` 不使用）、サイズ/行数/列数/セル長の上限、配列で受け取る（`columns` 未使用 = ヘッダー名でのプロトタイプ汚染経路なし）、文字コード明示 | phase1-mapping、phase2 |
| Import Profile による任意コード実行 / ReDoS | 宣言的変換のみ（正規表現・式・eval 不可）、zod 厳格検証 | phase1-mapping |
| Zip Slip / パストラバーサル | ZIP を受け付けない（バックアップは gzip NDJSON、先頭バイトで判定）。添付の保存キーはサーバー生成 `{uuid}/{uuid}` のみで、解決パスが基底配下か検証。アップロードの一時ファイル名もサーバー生成 | backup tests（ZIP）、storage |
| アップロード悪用 | multipart のサイズ上限（既定 20MB、バックアップはファイル 256MB・展開後 1024MB（設定可）で一時ファイルへストリーミング）・1 ファイル、超過は 413 で一時ファイル削除。写真は MIME とマジックバイト検証 | HTTP hardening（413）、backup upload テスト |
| 個人情報の過剰露出 | ロール別の表示範囲（Picker は注文情報なし、Packer は送付先の氏名住所のみ、Support は受付に必要な範囲）、CSV は `export.csv` + 閲覧権限 + 個人情報レベル選択（ADR-021） | Phase4/5/8、personal data minimization |
| ログからの漏えい | pino redact（Cookie/CSRF/Authorization）、リクエストボディ非記録、URL のクエリ文字列非記録、DB エラーは種類・SQLSTATE・制約名のみ（`detail`/`where` の行データを出さない） | error serializer テスト |
| 監査ログからの漏えい | 監査ログには番号・件数・理由の有無のみを記録し、氏名・住所・電話・メールを入れない | audit log テスト（全行を個人情報文字列で走査） |
| 監査ログ改ざん | 追記専用（UPDATE/DELETE を DB トリガで拒否。アプリの DB ロールでも不可）。変更・削除 API なし | audit log テスト |
| 二重処理（再送・連打） | client_event_id / requestId / 在庫移動の idempotency_key、行ロック、DB 一意制約 | R08, R11, R12, R17 |
| DoS（過負荷） | グローバル rate limit、ボディ 2MB 上限、statement_timeout 60s、ページング上限 200、CSV 出力 10 万行上限 | HTTP hardening（413） |
| 秘密情報の混入 | 環境変数のみ（`.env`・`data/`・`backups/`・`*.ndjson.gz` は gitignore）、`.env.example` はダミー値 | |
| クリックジャッキング | CSP `frame-ancestors 'none'` | HTTP hardening |
| 依存ライブラリ | ライセンス確認（GPL/AGPL なし）、`npm audit` をリリース前に実施（§6） | RELEASE_CHECKLIST |

| DB ロールの設定ミスで RLS が効かない | 本番設定では、`DATABASE_URL` のユーザーが SUPERUSER / BYPASSRLS なら起動を拒否（Phase 11）。docker compose はアプリ専用ユーザーを自動作成 | TEST_REPORT §8.3（Docker で確認） |
| 初期パスワード・共有パスワードの放置 | 画面から自分のパスワードを変更（現在のパスワード必須、他の端末のセッションを終了）（Phase 10） | E2E `account` |

## 3. HTTP セキュリティヘッダ
- `Content-Security-Policy`: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'（本番は upgrade-insecure-requests）
- `Strict-Transport-Security`（本番のみ）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=()`、`X-Powered-By` なし
- 未知の `/api/*` は 404（SPA の index.html を返さない）

## 4. 個人情報の取り扱い
- 保存: 注文の顧客/送付先スナップショット、顧客マスター、取込ステージング（7 日で削除）、バックアップファイル（利用者が保管）。
- 端末: PWA は API レスポンスをキャッシュしない。オフライン下書き（Pick scan）には個人情報を含めない。
- 表示: RBAC.md の表示範囲表に従う。
- エクスポート: 権限 + 個人情報レベル + 監査ログ（件数・レベルのみ記録）。
- バックアップ: Owner のみ。ダウンロード・復元は監査ログに記録。ファイルは個人情報を含むため、保管先・期間は購入者が管理（OPERATIONS.md §3）。
- 実顧客データ・実注文の利用は購入者の責任で行う（開発・検証はサンプルデータのみ）。

## 5. 運用上の注意（購入者向けにも記載）
- DB ユーザーに SUPERUSER/BYPASSRLS を付与しない（RLS が無効になる）。
- HTTPS 終端の背後で `TRUST_PROXY=true`（rate limit を利用者の IP 単位にするため）、`COOKIE_SECURE` は本番で自動 true。
- バックアップファイルは暗号化ストレージに保管し、アクセスを制限する。不要になったら削除する。
- パスワード再設定リンク・招待リンクは本人にだけ渡す（チャット等に残さない）。
- サーバー運用者の CLI（backup / restore / password-reset / integrity）は本番サーバーのシェルに入れる人だけが使える前提。

## 6. 依存ライブラリの脆弱性（`npm audit`、2026-09-30）
| 範囲 | 結果 | 対応 |
|---|---|---|
| 本番依存（`--omit=dev`） | **0 件** | Phase 9 で csv-parse 6.2.1 → 7.0.3 に更新（GHSA-8cw4-87c7-c6xx: `columns` オプション経由のプロトタイプ置換。本製品は `columns` を使わないため到達しないが更新） |
| 開発依存 | moderate 3 件（uuid < 11.1.1 ← hyperid ← autocannon） | 負荷試験ツール（autocannon）内部のリクエスト ID 生成のみで、本番には含まれない。修正版は破壊的変更のため据え置き。販売前に再確認 |

## 7. Phase 9 の点検で見つけて直したもの
| 内容 | 影響 | 修正 |
|---|---|---|
| 招待の承諾で、パスワード未設定・無効化されたアカウントにパスワードを設定できた | 他組織に所属するアカウントを、招待を発行した Owner が乗っ取れる経路 | §2「招待リンク」 |
| Owner が他組織にも所属するユーザーの再設定リンクを発行できた | 同上 | §2「パスワード再設定リンク」 |
| 別組織の ID に空の結果（200）を返すエンドポイントが 5 つ（引当計画・ロケーション一覧・取込明細・Wave プレビュー・引当解除） | データ漏えいはなし（RLS）。方針「存在を明かさない = 404」と不一致 | 存在確認を追加して 404 |
| DB エラーのログに行の値が出る可能性（PostgreSQL の `detail`） | ログへの個人情報出力 | エラーのシリアライザで除外 |
| バックアップのアップロードが 20MB 上限・メモリ読込 | 大きな組織は画面から復元できない | 一時ファイルへストリーミング、上限を別設定（既定 1GB）に |

## 8. Phase 10〜11 の点検で見つけて直したもの（セキュリティ・データ保全に関係するもの）
| 内容 | 影響 | 修正 |
|---|---|---|
| 自分のパスワードを変える画面がなかった（API のみ） | create-owner の初期パスワードやサンプル用アカウントのパスワードを変えられない | 画面右上 / メニュー / スマホのホームに「パスワード変更」 |
| DB ユーザーの権限を起動時に確認していなかった | SUPERUSER の接続文字列で動かすと組織の分離（RLS）が効かない | 本番設定では起動を拒否（index.ts）、DEPLOY.md §2 |
| 写真ファイルが保存先に無くても CLI バックアップが成功扱い | 写真の欠落に気付かない | backup-cli が警告・終了コード 1、検証結果に欠落数 |
| 販売可能な棚と返品保留・破損の棚の間の移動に理由が不要 | 破損品を売れる在庫に戻しても理由が残らない | 理由必須・監査ログに移動元/先の種類（ADR-036） |
| Pick の同時再送で後着が誤 scan として記録、デッドロックで 409 | 記録の誤り・作業の中断（在庫の二重計上はなし） | ADR-032 |
