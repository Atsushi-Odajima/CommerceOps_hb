# 進捗 (PROGRESS.md)

凡例: ✅ 完了（テスト済） / 🟡 実装済・一部未検証 / ⬜ 未着手 / ❌ 未完了

| Phase | 内容 | 状態 | メモ |
|---|---|---|---|
| 0 | 技術/料金/ライセンス、設計文書、RLS/RBAC/競合 PoC、PWA シェル | ✅ | PoC テスト 10/10。料金は公式ページ直接取得不可のため [A]/[B] 区分で記録 |
| 1 | Organization, Warehouse, Users/RBAC, Channel, ImportProfile | ✅ | API テスト 14 + マッピング単体 21。画面: 設定（組織/倉庫・ロケーション/ユーザー/チャネル/Import Profile エディタ）、商品 |
| 2 | CSV Import, 正規化, Order/Item, 重複/競合 | ✅ | テスト 14（R19/R20/R21/R25 含む）。画面: 取込ウィザード・取込履歴・注文一覧/詳細・手動注文 |
| 3 | 最小在庫, Allocation, 欠品/保留, 複数倉庫 | ✅ | テスト 13（R01〜R05, R24, R20 競合）。画面: 引当・在庫一覧/履歴・注文の引当パネル |
| 4 | Fulfillment, Wave, Pick List, スマホ Pick | ⬜ | |
| 5 | Packing Station, scan 検品 | ⬜ | |
| 6 | Shipment, 分割発送, Tracking | ⬜ | |
| 7 | Return, 検品, Restock, Exchange | ⬜ | |
| 8 | 例外, 作業割当, KPI, 検索, CSV export | ⬜ | |
| 9 | 監査, 個人情報, Backup/Restore, Security | ⬜ | |
| 10 | 負荷/競合, 端末 E2E, アクセシビリティ | ⬜ | |
| 11 | 購入者資料, デプロイ, 運用費, 販売前チェック | ⬜ | |

## Phase0 詳細（2026-09-30）
- 技術選定: DECISIONS.md ADR-002（Vite 7 / Vitest 4 / TS 6 / RR 7 の成熟ラインを採用、Playwright はプリインストール Chromium に合わせ 1.56.1）
- ライセンス: 依存 529 パッケージを走査。本体に同梱されるものは MIT/ISC/Apache-2.0/BSD のみ。MPL-2.0 は axe-core（テスト専用・非同梱）
- 料金: docs/research/pricing-2026-09-30.md、docs/OPERATING_COSTS.md（初版）
- PoC（server/test/phase0-poc.test.ts）:
  - RLS: 別組織コンテキストから SELECT/UPDATE/DELETE 0 行、WITH CHECK で他組織 INSERT 拒否、コンテキストなしで 0 行
  - 複合 FK: 他組織の倉庫を参照するロケーション INSERT が FK 違反
  - 認証: CSRF ヘッダ/トークン必須、5 回失敗でロック、Cookie HttpOnly/SameSite=Lax
  - 競合: 最後の 1 個に 20 並列の条件付き UPDATE → 1 件のみ成功、CHECK 制約で過剰引当拒否
- PWA シェル: manifest（standalone, icons 192/512/maskable, apple-touch-icon）、Workbox precache（API はキャッシュしない）、更新プロンプト

## Phase1 詳細（2026-09-30）
- API: /api/org, /api/users(+invitations, password-reset), /api/warehouses(+locations, bulk), /api/products(+barcodes, lookup, import), /api/channels, /api/import-profiles(+meta, inspect, test)
- 倉庫作成時に DEFAULT(pick) / QUARANTINE / DAMAGED ロケーションを自動作成
- 招待・パスワードリセットはリンク方式（メール自動送信なし。トークンは DB にハッシュのみ、URL フラグメントで受け渡し）
- 最後の Owner の降格/無効化を禁止（membership 行ロック）。無効化/ロール変更で当該組織のセッションを即時破棄
- Import Profile: 宣言的マッピング（列名/列番号/連結/固定値 + 許可リスト変換）、日付書式トークン + IANA タイムゾーン、列名同義語による候補提案、サンプル CSV での変換確認
- テスト: server/test/phase1-api.test.ts（14）, phase1-mapping.test.ts（21, R25 CSV formula injection を含む）
- UI スモーク: e2e/scripts/smoke-phase1.mjs（PC 1366px / スマホ 390px のスクリーンショットで確認）

## Phase2 詳細（2026-09-30）
- 取込: preview（ファイル SHA-256 重複拒否 → 文字コード → csv-parse → マッピング → 注文グルーピング → 行/注文検証 → 既存比較で分類）→ commit（advisory lock でチャネル単位に直列化、再分類、一括 INSERT、1 トランザクション）
- 分類: new / identical / update_candidate（引当前のみ・適用選択時のみ更新・住所履歴）/ conflict（例外 import_conflict）/ cancel_candidate（自動取消しない・例外）/ invalid
- 注文状態: 導出 + 許可遷移表 + order_status_history（imported → validation_required/ready_for_allocation の 2 行から開始）
- スナップショット: 注文行に購入者/送付先を固定。顧客マスターは新規作成のみで既存を上書きしない（R21）
- 要確認の解消: 未登録 SKU の商品対応付け（原文 SKU 保持・監査）、住所変更（履歴・出荷前のみ）、再検証
- 保留: 理由コード・メモ・保留/解除の実行者と日時、Pick 中は confirm 必須、Fulfillment の on_hold 連動
- 個人情報のステージングデータは 7 日後に削除（maintenance job）
- UI スモーク: e2e/scripts/smoke-phase2.mjs（取込プレビュー→確定→注文一覧→詳細）

## Phase3 詳細（2026-09-30）
- 在庫台帳: inventory_balances(on_hand/allocated/held) + inventory_movements（冪等キー UNIQUE）。入荷・調整（set/delta）・ロケーション移動・調査中解消・在庫 CSV 取込
- 引当: 注文行ロック→残必要数再計算→倉庫計画（全量可を優先、なければ最多の倉庫で一部）→ロケーション選択（単一で足りる所→pick_sequence 順）→balance ID 順に条件付き UPDATE。
  競合で取られた場合は在庫を再読込して最大 5 回再試行（R02b: 30 注文 × 在庫 10 で必ず 10 件確保・過剰引当なし）
- 分割は自動確定しない（分割候補を返し、倉庫指定の手動引当で確定）。全量引当で自動 Fulfillment 化（設定）、一部引当は「揃った分を先行出荷」で明示 release
- 欠品例外（dedupe: 注文単位）を作成し、全量引当・取消・明細取消で自動解決
- キャンセル: 未出荷 Allocation を解放、Pick/Pack 中は confirm 必須 + 棚戻し例外、出荷済みがあれば全体取消不可。明細取消は人間の明示操作のみ
- Job: allocation.run（dedupe key で組織ごとに同時 1 本）
- 整合性チェック: modules/integrity/check.ts（ledger と各数量の不変条件）をテストで毎回検証
- 発見・修正した問題: 同時実行で予定ロケーションを取られた際に再読込しておらず引当不足（過剰ではない）になっていた → 再試行ループを追加
