# 設計判断ログ (DECISIONS.md)

形式: ADR-番号 / 日付 / 決定 / 理由 / 代替案。日付はすべて実装時点（2026-09-30〜）。

## ADR-001 専用フォルダで独立開発
- 決定: リポジトリ直下 `017-commerceops/` に閉じたモノレポ（npm workspaces: server, web, e2e, load）。他商品のコードは参照・変更しない。
- 理由: 指示「既存#001〜#016や他プロジェクトを変更せず専用フォルダで開始」。

## ADR-002 技術スタック
- 決定: Node.js 22 LTS / TypeScript 6.0 / Fastify 5 / PostgreSQL 16 / pg 8 / zod 4 / React 19 / Vite 7 / React Router 7 / TanStack Query 5 / vite-plugin-pwa 1.3 / Vitest 4 / Playwright 1.56。
- 理由: 実装時点（2026-09）で「安定構成」を優先。最新メジャーの Vite 8・Vitest 5・TypeScript 7・React Router 8 はリリースから日が浅いため採用せず、
  1 つ前の成熟ラインを選択（Vite 7.3 / Vitest 4.1 / TS 6.0 / RR 7.18）。Playwright は実行環境にプリインストールされた Chromium 141 (rev 1194) と一致する 1.56.1 に固定。
- 代替案: Next.js（SSR 不要・PWA/オフライン制御を単純にしたいので不採用）、NestJS（規模に対し重い）。

## ADR-003 ORM を使わず手書き SQL
- 決定: `pg` + parameterized SQL。マイグレーションは番号付き SQL ファイル。
- 理由: 引当・出荷確定・claim は「条件付き UPDATE」「FOR UPDATE」「SKIP LOCKED」「advisory lock」など DB 機能を明示的に使う必要があり、
  500 万注文規模のインデックス設計も SQL で直接管理したい。SQL インジェクションは全クエリの placeholder 化で防ぐ（文字列連結禁止、lint ルール + レビュー）。

## ADR-004 マルチテナント = 共有スキーマ + RLS(FORCE) + 複合キー
- 決定: 全業務テーブルに `organization_id`、PK は `(organization_id, id)`、FK も `(organization_id, xxx_id)` の複合。
  RLS を ENABLE + FORCE し、ポリシー `organization_id = app_org_id()`（`current_setting('app.org_id')`）。リクエストごとに `SET LOCAL` 相当を設定。
- 理由: アプリの WHERE 漏れがあっても他テナント行は見えない（多層防御）。FK は RLS をバイパスするため、複合 FK で「他テナントの親を参照する子行」を DB 制約で禁止。
  さらに複合 PK のため、別組織としての復元時に UUID を振り直す必要がない（ADR-012）。
- 代替案: テナントごとスキーマ/DB（運用コスト増・マイグレーションが煩雑）。

## ADR-005 ID は UUIDv7（アプリ生成）+ 人が読む連番
- 決定: 主キーは UUIDv7（時系列順で B-tree 局所性が良い）。画面表示は組織内連番（SO-/F-/W-/SH-/RT-/EX-/EXC-）。
- 連番はカウンタ行をブロック単位で払い出す（別コネクションで即コミット、欠番は許容）ことで長時間ロックを避ける。

## ADR-006 認証はサーバーセッション
- 決定: 32 バイト乱数トークンを HttpOnly Cookie に、DB には SHA-256 のみ保存。アイドル 12 時間 / 絶対 7 日（設定可）。
  CSRF は同期トークン（セッションに保存し `X-CSRF-Token` ヘッダで照合）+ SameSite=Lax。パスワードは scrypt（N=2^15, r=8, p=3 = OWASP の N=2^17,p=1 と同等強度）。
- 理由: 倉庫の共有 iPad/スマホで即時ログアウト・無効化ができる。外部 IdP 依存なし（有料契約不要）。
- 代替案: Auth0/Clerk 等（有料・外部依存）、JWT（失効が難しい）。

## ADR-007 Job キューは PostgreSQL
- 決定: `jobs` テーブル + `FOR UPDATE SKIP LOCKED`、`dedupe_key`（queued/running 中は UNIQUE）、リトライ回数、指数バックオフ。
- 理由: Redis 等の追加インフラ・費用が不要。引当 Job は dedupe で組織ごとに同時 1 本、さらに注文行ロック + 残必要数再計算で冪等。

## ADR-008 在庫はロケーション単位で引当
- 決定: `inventory_balances` は (location, product) 単位。Available = on_hand − allocated − held。引当はロケーションまで確定させ、Pick 行はそこから生成。
- 理由: Pick List のロケーションが引当時に確定し、Short Pick 時の在庫調査対象（どの棚か）が明確。ロケーションを使わない倉庫は DEFAULT ロケーション 1 つで運用可能。

## ADR-009 Short Pick は on_hand を減らさず held へ
- 決定: 現物なし等の数量は `held` に移し Available から除外、例外キューで「紛失確定/発見」を人が決める。
- 理由: 「在庫を勝手に調整しない」と「同じ幻の在庫に再引当しない」を両立。

## ADR-010 注文状態は導出 + 許可遷移の検証
- 決定: 状態は事実から導出し、許可遷移表で検証してから保存・履歴化（FULFILLMENT_RULES.md）。
- 理由: 複数 Fulfillment/分割出荷/返品が絡むと手動遷移は不整合を生みやすい。導出にすることで常に事実と一致し、遷移表でバグを検知できる。

## ADR-011 交換は Replacement Order + Replacement Fulfillment
- 決定: 交換品は `order_type='replacement'` の注文として作成し、通常の引当→Fulfillment(type=replacement)→Wave→Pick→Pack→Ship を通す。
- 理由: 「交換は通常の Allocation→Pick→Pack→Ship を通す」要件を、特別経路を作らずに満たす。元注文の状態導出を汚さない。KPI では replacement を受注件数から除外。

## ADR-012 バックアップは組織単位の gzip NDJSON（ZIP を受け付けない）
- 決定: `commerceops-backup-*.ndjson.gz`（ヘッダ行: schemaVersion/appVersion/日時/組織、行データ、トレーラ行: テーブル別件数と SHA-256、全体 SHA-256）。
  復元は検証（チェックサム・件数・スキーマ版・参照整合）→ 新しい組織として 1 トランザクションで投入 → 復元後の整合性検証。失敗時はロールバックで現行データ非破壊。
- 理由: ZIP を扱わないことで Zip Slip / パストラバーサルを構造的に排除。複合 PK のため別組織として復元しても ID 衝突しない（ユーザー ID のみメールで対応付け）。
- 環境全体の DR は PostgreSQL のマネージドバックアップ/PITR または `pg_dump`（OPERATIONS.md）。

## ADR-013 PWA キャッシュ範囲
- 決定: アプリシェル（静的アセット）のみ precache。`/api` はキャッシュしない（個人情報を端末に残さない）。
  オフライン下書きは Pick scan のみ（IndexedDB、未同期表示、再接続時にサーバー再検証）。
- 理由: 要件「Pack 完了、Shipment 確定、在庫減算、Return Restock 等を危険なオフライン確定にしない」。

## ADR-014 バーコード
- 決定: 読取はネイティブ `BarcodeDetector`（Android Chrome 等）優先、非対応（iOS Safari 等）は `@zxing/browser`。生成は `bwip-js`。
  対応済みと表記するのは、採用ライブラリ（ZXing）で自動テストにより実測デコードできたシンボルのみ（TEST_REPORT.md）。
  外部画像認識 API には送らない。カメラ不可時はハンディスキャナ（キーボード入力）/手入力 fallback。

## ADR-015 帳票は印刷用 HTML
- 決定: Pick List / Packing Slip / Shipment 作業票 / Return 受領票 / 注文識別コードは印刷 CSS 付き HTML（ブラウザで紙/PDF）。
  PDF 生成を Playwright の `page.pdf()` で自動テスト。配送会社公式送り状は再現しない。

## ADR-016 CSV Import Profile は宣言的変換のみ
- 決定: 許可リストの変換（trim/nfkc/removeChars/リテラル replace/map 等）のみ。正規表現・式・コード実行は不可。
- 理由: 任意コード実行禁止、ReDoS 防止、プロファイルの説明可能性。

## ADR-017 Picker/Packer の個人情報
- 決定: Pick API は注文番号/Fulfillment 番号以外の注文情報を返さない。Pack API は送付先の氏名・住所のみ（電話/メールなし）。
- 理由: 最小権限（「Pickerへ不要な住所全文を出さない」）。

## ADR-018 ロック順序と deadlock 時の自動再試行
- 決定: 作業系（Pick/Pack/出荷）は Fulfillment → 作業行（PickTask / PackSession / Shipment）→（状態再計算で）Order の順にロックする。
  注文キャンセル・保留は Order → Fulfillment の順（業務上まれな競合）。PostgreSQL が検出した deadlock（40P01）とシリアライズ失敗（40001）は
  `withTenant` がトランザクション全体を最大 2〜3 回再試行する。冪等キー（client_event_id / requestId / movement idempotency_key）により再試行でも二重処理しない。
- 理由: すべての経路で完全に同じ順序にするより、頻出経路の順序統一 + 検出・再試行 + 冪等化の方が単純で安全。

## ADR-019 追跡番号の正規化と一意性
- 決定: 追跡番号は NFKC → 空白/ハイフン除去 → 英大文字 → `^[A-Z0-9]{4,40}$` で保存。一意性は (組織, 配送会社, 追跡番号)、取消済みを除く（部分 UNIQUE）。
- 理由: 送り状の印字（ハイフン区切り）とバーコード読取値（区切りなし）を同一視して重複・検索漏れを防ぐ。配送会社が違えば同じ番号体系があり得る。

## ADR-020 KPI の定義と個人評価をしない方針
- 決定: KPI は物流オペレーションの指標のみ。率は必ず分子・分母・定義文を API と画面で返す/表示する。期間は組織タイムゾーンの日付。
  受注件数などから交換品の注文（order_type=replacement）を除外。作業者ごとの指標・ランキングは作らない（作業割当画面の「現在の担当数」は進行中の件数のみ）。
- 理由: 要件「率は分母/期間を明示し個人評価を自動化しない」。

## ADR-021 CSV 出力と個人情報
- 決定: CSV 出力は `export.csv` + 対象データの閲覧権限が必要。注文の個人情報は要求レベル（none / ship_to / full）と本人の権限の小さい方まで。
  すべてのセルに数式インジェクション対策、UTF-8(BOM) / Shift_JIS、最大 10 万行。出力は監査ログに件数・範囲・個人情報レベルのみ記録（中身は記録しない）。
  ファイル名は ASCII（`orders_YYYY-MM-DD.csv` 等）。環境によって非 ASCII のダウンロード名が「download」になるため。
