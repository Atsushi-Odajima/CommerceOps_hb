# CommerceOps 開発計画 (PLAN.md)

商品 #017 **CommerceOps — EC受注・ピッキング・梱包・出荷・返品管理**

複数チャネル（自社EC / Shopify等 / Amazon・楽天等 / 卸 / 手動）の注文を CSV で取り込み、
正規化 → 在庫引当 → 欠品・保留 → 出荷拠点 → Wave → Picking → バーコード検品 → Packing →
Shipment → 追跡番号 → 出荷確定 → 返品・交換 → 返品検品 → 再販可否 → 在庫処理 → KPI
までを一元管理する、小規模事業者向けマルチテナント SaaS 型 Web アプリ。

- #013 StockPilot は SKU/在庫中心（仕入・発注・入庫・保管・棚卸）。
- #017 CommerceOps は Order/Fulfillment 中心（注文を正しく倉庫作業へ流して発送する）。
- #012 見積/請求、#014 制作物承認、#016 予約運営の機能は持ち込まない。

---

## 1. 技術構成（Phase0 決定。詳細理由は DECISIONS.md）

| 層 | 採用 | 備考 |
|---|---|---|
| ランタイム | Node.js 22 LTS | サーバー/ビルド共通 |
| 言語 | TypeScript 6.0 | サーバー/フロント共通、strict |
| API サーバー | Fastify 5 | JSON API、`@fastify/helmet`(CSP)、`@fastify/rate-limit`、`@fastify/cookie`、`@fastify/multipart`、`@fastify/static` |
| DB | PostgreSQL 16 | Row Level Security (FORCE) によるテナント分離、条件付き UPDATE/行ロックによる引当競合制御 |
| DB アクセス | `pg` (node-postgres) + 手書き SQL | すべて parameterized query。ORM 不使用（ロック/インデックスを明示制御するため） |
| 入力検証 | zod 4 | 全 API の body/params/query を検証 |
| CSV | `csv-parse` (RFC4180 準拠 parser)、`iconv-lite`（Shift_JIS 入出力） | `split(",")` 禁止 |
| Job | PostgreSQL テーブル + `FOR UPDATE SKIP LOCKED` の自前キュー | Redis 不要。dedupe key で二重実行防止 |
| 認証 | Cookie セッション（DB 保存・トークンは SHA-256 ハッシュ保存）+ CSRF トークン | パスワードは scrypt (OWASP 同等パラメータ) |
| フロント | React 19 + Vite 7 + React Router 7 + TanStack Query 5 | 日本語 UI、独自 CSS（依存最小） |
| PWA | vite-plugin-pwa (Workbox) | standalone、アプリシェルのみキャッシュ、API はキャッシュしない |
| バーコード | カメラ: BarcodeDetector（対応端末）→ `@zxing/browser` フォールバック / 生成: `bwip-js` | キーボード型ハンディスキャナ対応、手入力 fallback 必須 |
| テスト | Vitest（単体/統合/競合、実 PostgreSQL）、Playwright（E2E、端末エミュレーション）、axe-core（a11y）、autocannon（負荷） | |
| 配備 | Docker（単一コンテナ: API + 静的配信 + Job worker）+ マネージド PostgreSQL | render.yaml / docker-compose.yml を同梱。本番公開は人間の承認後 |

## 2. アーキテクチャ概要

```
[PC ブラウザ] [iPhone/Android PWA] [iPad Pack Station]
        │  HTTPS (Cookie session + CSRF header)
        ▼
┌──────────────────────────── Node.js (Fastify) ────────────────────────────┐
│ auth / rbac ─ tenant context (org_id, user, role, warehouse scope)        │
│ modules: org, warehouses, products, inventory, channels, import-profiles, │
│          imports, orders, allocation, fulfillments, waves, picking,       │
│          packing, shipments, returns, exceptions, kpi, search, export,    │
│          backup, audit                                                     │
│ job worker (同一プロセス or 別プロセス): allocation.run, claim timeout,    │
│          import staging purge, backup                                      │
└──────────────┬─────────────────────────────────────────────────────────────┘
               ▼
        PostgreSQL 16（全業務テーブル RLS FORCE、organization_id 複合 PK/FK）
               │
        (任意) オブジェクトストレージ：返品写真・バックアップファイル
```

- すべての業務データは `organization_id` を持ち、PK/FK は `(organization_id, id)` の複合キー。
  別テナントの親を参照する行は DB 制約上作れない。
- リクエストごとにトランザクションを張り `set_config('app.org_id', <session の org>, true)` を設定。
  RLS ポリシー `organization_id = app_org_id()` により、アプリの WHERE 漏れがあっても他テナント行は見えない。
- 認可はサーバー側で「権限（RBAC）→ 倉庫スコープ → エンティティ所有（RLS/WHERE）」の3段で判定。UI 非表示は補助。

## 3. 中心データ（詳細は docs/DATA_MODEL.md）

Organization, Warehouse, Location, User, Membership(Role/Permission), SalesChannel, ImportProfile, ImportBatch,
Order, OrderItem, CustomerSnapshot / ShippingAddressSnapshot（注文行に固定保存 + 変更履歴）, Customer,
Product/Barcode, InventoryBalance(OnHand/Allocated/Held), InventoryMovement, Allocation,
Fulfillment, FulfillmentItem, Hold, Wave, PickTask, PickTaskLine, PickEvent, PackSession, PackEvent,
Shipment, ShipmentItem(Tracking), Return, ReturnItem, ReturnInspection, Exchange, ExceptionCase, AuditLog, Job。

Order と Shipment は分離。1 Order → 複数 Fulfillment → 複数 Shipment。Return は Order を上書きしない別エンティティ。

## 4. ドキュメント一覧

| 文書 | 内容 |
|---|---|
| PLAN.md | 本書。全体計画 |
| PROGRESS.md | Phase ごとの進捗・完了/未完了/未検証 |
| DECISIONS.md | 設計判断ログ（ADR 形式） |
| NEXT_STEPS.txt | 次にやること |
| docs/DEVELOPMENT.md | 開発環境・コマンド・構成 |
| docs/DATA_MODEL.md | テーブル定義・制約・インデックス |
| docs/ORDER_NORMALIZATION.md | CSV 取込・Import Profile・正規化・重複/競合 |
| docs/ALLOCATION_ENGINE.md | 引当ルール・競合制御・倉庫選択 |
| docs/FULFILLMENT_RULES.md | 注文状態遷移・Fulfillment・保留・キャンセル・Wave |
| docs/INVENTORY_RULES.md | OnHand/Allocated/Held/Available と在庫減算・Allocation 消化の一貫ルール |
| docs/PICK_PACK_RULES.md | Pick/Pack/作業割当/scan/例外 |
| docs/RETURN_RULES.md | 返品・検品・Disposition・Restock・交換 |
| docs/RBAC.md | ロール・権限マトリクス・個人情報表示範囲 |
| docs/SECURITY.md | 脅威と対策 |
| docs/OPERATIONS.md | 運用・監視・バックアップ/復元・障害対応 |
| docs/OPERATING_COSTS.md | 運用費（公式料金確認日付き） |
| docs/TEST_REPORT.md | テスト結果 |
| docs/RELEASE_CHECKLIST.md | 販売前チェック |
| buyer-docs/ | 購入者向け説明書（.txt）、CSV テンプレート、THIRD_PARTY_NOTICES.txt |

## 5. Phase 計画

| Phase | 内容 | 完了条件 |
|---|---|---|
| 0 | 技術/料金/ライセンス確認、設計文書、マルチテナント(RLS)/RBAC/引当競合 PoC、PWA シェル | PoC テスト green、文書初版 |
| 1 | Organization、Warehouse/Location、Users/RBAC/招待、Product/Barcode、Channel、ImportProfile | API+UI、RBAC テスト |
| 2 | CSV Import（文字コード→Profile→プレビュー→検証→重複→確定）、正規化、Order/Item、重複/競合 | 必須テスト 19,20,21,25 |
| 3 | 最小在庫台帳、Allocation、欠品/保留、複数倉庫、Allocation Job | 必須テスト 1-5 |
| 4 | Fulfillment、Wave（snapshot）、Pick List（印刷/PDF）、スマホ Pick、Short Pick | 必須テスト 6-9 |
| 5 | Packing Station、全数 scan 検品、誤出荷防止、強制完了（権限+理由） | 必須テスト 10,11 |
| 6 | Shipment、分割発送、Tracking 入力/CSV 取込/出力、出荷確定（冪等） | 必須テスト 12,13 |
| 7 | Return、到着 scan、検品、Disposition、Restock（冪等）、Exchange | 必須テスト 14-18 |
| 8 | 例外キュー、作業割当、ホーム/KPI、検索、CSV export | 画面+API テスト |
| 9 | 監査、個人情報最小表示、Backup/Restore、セキュリティ強化 | 必須テスト 22-24,26 |
| 10 | 負荷/競合（段階データ）、PC/iPhone/Android/iPad E2E 1-9、アクセシビリティ | TEST_REPORT |
| 11 | 購入者資料、デプロイ構成、運用費、販売前チェック | RELEASE_CHECKLIST |

未完成 Phase があれば全体完成と報告しない。

## 6. 人間の承認が必要なこと（勝手に行わない）

有料契約・実課金、本番公開（実ドメインでの公開）、実 EC アカウント接続、実顧客への通知、
実注文/実個人情報の利用、秘密情報（本番 API キー等）の使用。
サンプルデータ（Sample Commerce）は `is_sample=true` の組織に隔離し、本番組織と混在させない。

## 7. 今回広げない（Pro 版候補含む）

仕入発注/本格棚卸/需要予測（StockPilot 領域）、会計、見積/請求、決済、予約、制作物承認、
配送会社ラベル購入 API、各 EC API 大量連携、自動出品、広告、AI 需要予測/作業者評価、
ロボット倉庫、国際通関、危険物/温度管理、製造 MRP。
Pro 候補: EC API Connector/Webhook、配送ラベル API、StockPilot 双方向連携、高度 Order Routing、
Batch/Serial/Lot、3PL、顧客セルフ返品ポータル、SLA automation。
