# 運用費 (OPERATING_COSTS.md)

> 料金確認日: **2026-09-30**（根拠: `docs/research/pricing-2026-09-30.md`）。
> 実行環境の制約で各社公式料金ページを直接開けなかったため、AWS Price List API・Cloudflare/Supabase 公式ドキュメントで
> 直接確認できた値を [A]、公式ドメインの検索抜粋のみの値を [B] と表記する。**契約前に必ず公式ページで再確認すること。**
> 金額は USD 税抜（為替・消費税は別途）。本書は販売保証値ではない。

## 1. 構成要素

| 要素 | 必須 | 内容 | 選択肢 |
|---|---|---|---|
| Hosting（API + 静的配信 + Job worker） | ✓ | Node.js 22 コンテナ 1 台（512MB〜）。Job worker は同一プロセス（RUN_WORKER=true） | Render / Fly.io / AWS Lightsail / さくら VPS / 自社サーバー |
| DB | ✓ | PostgreSQL 16（`pg_trgm`, `btree_gin`）、自動バックアップ/PITR 推奨 | Render Postgres / Fly Managed Postgres / Supabase / Lightsail DB / Neon |
| Job | ✓（追加費用なし） | PostgreSQL テーブルのキュー。Redis 等は不要 | – |
| Auth | ✓（追加費用なし） | 自前セッション認証。外部 IdP 不要 | – |
| Log | 推奨 | stdout の JSON ログ。PaaS 標準ログ or 外部（Better Stack Free 3GB/月[B], Grafana Cloud Free 50GB[B]） | |
| Storage | 任意 | 返品写真（DATA_DIR の永続ディスク or S3 互換）、バックアップファイル保管 | 永続ディスク / Cloudflare R2 [A] / S3 東京 [A] |
| Backup | ✓ | DB のマネージドバックアップ/PITR + 組織単位バックアップ（.ndjson.gz）を別ストレージへ | |
| Email | 任意 | 初版は招待/パスワードリセットをリンク表示方式（メール送信なしで運用可）。送る場合は SMTP/API | Resend Free 3,000 通/月[B]、Amazon SES $0.10/1,000 通[A] |

## 2. 構成例と月額目安（USD）

### A. 最小（〜50 注文/日、1 倉庫）
| 項目 | 例 | 月額目安 |
|---|---|---|
| Hosting | AWS Lightsail 東京 1GB（$7 [A]）または Render Starter $7 [B]（Singapore） | $7 |
| DB | Lightsail マネージド PostgreSQL 1GB Standard ≈ $15 [A]（7 日 PITR [B]） | $15 |
| Storage/Backup | Cloudflare R2 無料枠 10GB 以内 [A] | $0 |
| Email | 送信なし or Resend Free | $0 |
| **合計** | | **約 $22/月** |

### B. 標準（〜500 注文/日、1〜2 倉庫）
| 項目 | 例 | 月額目安 |
|---|---|---|
| Hosting | Lightsail 東京 2GB ≈ $12 [A] / Render Standard 2GB $25 [B] | $12〜25 |
| DB | Lightsail PostgreSQL 2GB ≈ $30 [A] / Supabase Pro $25 + Small compute 約 $15（Tokyo 可）[A] | $30〜40 |
| Storage/Backup | R2 数十 GB（$0.015/GB-月 [A]） | $1 未満 |
| Log | Better Stack Free / PaaS 標準 | $0 |
| **合計** | | **約 $45〜65/月** |

### C. 大規模（〜5,000 注文/日、複数倉庫）
| 項目 | 例 | 月額目安 |
|---|---|---|
| Hosting | Lightsail 東京 4GB ≈ $24 [A] ×（API/worker 分離で 2 台） | $48 |
| DB | Lightsail PostgreSQL 8GB HA ≈ $230 [A] / Fly MPG Launch $282（東京 nrt）[B] | $230〜280 |
| Storage/Backup | R2 / S3 東京 | $1〜5 |
| Log | 有料プラン（取り込み量次第） | $10〜30 |
| **合計** | | **約 $290〜370/月** |

東京リージョンの有無: Fly.io（nrt）・Supabase（Tokyo）・AWS（東京）・さくらは国内。Render・Railway・Neon は Singapore が最寄り（レイテンシ・データ所在の要件を購入者が判断）。
無料枠のみでの本番運用は非推奨（Render Free DB は 30 日で失効・バックアップなし、Supabase Free は 7 日無操作で停止・バックアップなし [A/B]）。

## 3. データ増加・負荷の試算方法

1 注文あたりの行数（標準的なフロー: 明細 3 行・1 箱・返品率 5%）:
| テーブル | 行数/注文 | 備考 |
|---|---|---|
| orders | 1 | |
| order_items / allocations / fulfillment_items / pick_task_lines | 各 約 3 | |
| pick_events | 約 3〜6 | 1 scan = 1 行（誤 scan 含む） |
| pack_events | 約 3〜5 | |
| shipments / shipment_items | 1 / 3 | |
| inventory_movements | 約 3 | 出荷時 |
| order_status_history | 約 8 | |
| audit_logs | 約 5〜10 | |
| returns 関連 | 0.05 × 数行 | |

**実測（Phase 10、TEST_REPORT.md §8）: 1 注文あたり約 22.6KB**（索引・監査ログ・状態履歴・在庫移動・Pick/梱包の記録込み。10.25 万注文で 22.3KB、51.25 万注文で 22.6KB と件数に比例）。
組織バックアップ（gzip）は 1 注文あたり約 2.5KB、作成速度は検証環境で約 510 注文/秒。**販売保証値ではない。**

| 注文/日 | 年間注文数 | 年間 DB 増加（実測ベース） | 組織バックアップ（1 年分, gzip） | 1 日の業務処理の実測（v3, TEST_REPORT §7） | 推奨 DB |
|---|---|---|---|---|---|
| 50 | 約 1.8 万 | 約 0.4GB | 約 45MB・1 分未満 | 取込〜出荷 約 4 秒 | 1GB |
| 500 | 約 18 万 | 約 3.9GB | 約 450MB・約 6 分（画面の上限を超えるため CLI） | 約 33 秒（Picker/Packer 各 4 人並行） | 2GB |
| 5,000 | 約 180 万 | 約 39GB | 約 4.5GB・約 1 時間（CLI） | 約 6.3 分（取込〜出荷の全工程、Picker/Packer 各 4 人並行） | 8GB 以上 + HA |

- 上の DB 増加は注文・返品等の業務データのみ。PITR/バックアップの保管容量はその 1〜2 倍を見込む。写真（返品検品、1 枚 最大 10MB）は別途。
- 5,000 注文/日の 1 年分（180 万注文）は未実測（実測の最大は 51.25 万注文）。KPI（30 日）は 51 万注文規模で約 1.6 秒、件数に比例して長くなる見込み。
- 組織が複数ある DB では、統計情報の更新（15 分ごとの保守処理、OPERATIONS.md §8.1）が動いていることを前提とする。

試算手順:
1. `load/` の生成スクリプトで N 注文分のデータを作成し `pg_total_relation_size` を合計 → 1 注文あたりバイト数を得る。
2. × 1 日の注文数 × 保持日数 = DB 容量。PITR/バックアップ容量はその 1〜2 倍を見込む。
3. Job 負荷: 取込（CSV 行数に比例）、引当（対象注文数 × 明細数）、Wave 作成（Fulfillment 数）を実測時間から換算。
4. 同時接続: 作業者数 × 1〜2 接続（プール上限 `DATABASE_POOL_MAX`）。

## 4. 購入者が確認すべき事項
- 各社の最新料金・為替・消費税、商用利用条件、データ所在（国内保管要件）、バックアップ保持期間、SLA。
- メール送信を行う場合の送信ドメイン認証（SPF/DKIM）と送信量。
- 本書の値は 2026-09-30 時点の調査であり、将来の改定を保証しない。
