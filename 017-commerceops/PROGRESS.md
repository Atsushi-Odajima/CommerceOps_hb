# 進捗 (PROGRESS.md)

凡例: ✅ 完了（テスト済） / 🟡 実装済・一部未検証 / ⬜ 未着手 / ❌ 未完了

| Phase | 内容 | 状態 | メモ |
|---|---|---|---|
| 0 | 技術/料金/ライセンス、設計文書、RLS/RBAC/競合 PoC、PWA シェル | ✅ | PoC テスト 10/10。料金は公式ページ直接取得不可のため [A]/[B] 区分で記録 |
| 1 | Organization, Warehouse, Users/RBAC, Channel, ImportProfile | ✅ | API テスト 14 + マッピング単体 21。画面: 設定（組織/倉庫・ロケーション/ユーザー/チャネル/Import Profile エディタ）、商品 |
| 2 | CSV Import, 正規化, Order/Item, 重複/競合 | ⬜ | |
| 3 | 最小在庫, Allocation, 欠品/保留, 複数倉庫 | ⬜ | |
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
