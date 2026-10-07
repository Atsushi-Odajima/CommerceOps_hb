# ロール・権限 (RBAC.md)

権限定義の唯一の正は `server/src/auth/permissions.ts`。本書はその写し。
**UI 非表示だけでなく、すべての API がサーバー側で権限を検証する。**

## 1. 判定の 3 段階

1. **認証**: 有効なセッション（Cookie）+ 状態変更リクエストは CSRF トークン一致。
2. **権限**: セッションのアクティブ組織における membership.role → permission 集合に必要権限が含まれるか（なければ 403）。
3. **範囲**:
   - 組織: すべての業務テーブルは RLS（`organization_id = app_org_id()`）+ SQL の明示条件。別組織の ID を URL に入れても 404。
   - 倉庫: membership.warehouse_ids（NULL = 全倉庫）。倉庫に属する操作（Wave/Pick/Pack/在庫調整/返品検品など）は範囲外なら 403/404。
   - 担当: Pick/Pack は claim した本人のみ scan 可（管理者は付け替え可）。

## 2. 権限一覧

| 権限 | 内容 |
|---|---|
| org.manage | 組織設定（引当設定・締切・claim タイムアウト等） |
| users.manage | ユーザー招待・ロール・倉庫範囲・無効化 |
| warehouses.manage | 倉庫・ロケーション |
| channels.manage | 販売チャネル・Import Profile |
| products.read / products.manage | 商品（SKU・名称・バーコード・ロケーション）参照 / 編集 |
| customers.manage | 顧客マスター編集 |
| orders.read | 注文参照（個人情報を除く） |
| orders.read_pii | 顧客・送付先の全項目（氏名/住所/電話/メール） |
| orders.read_ship_to | 送付先の氏名・住所のみ（電話・メールなし）※梱包用 |
| orders.import | 注文 CSV 取込 |
| orders.edit | メモ・優先度・住所変更（出荷前のみ） |
| orders.hold | 保留・解除 |
| orders.cancel | 注文/明細キャンセル |
| inventory.read / inventory.adjust | 在庫参照 / 在庫調整・入荷・移動・held 解消・誤登録の取消・発注入荷 |
| purchasing.read / purchasing.manage | 仕入先・発注・補充候補の参照 / 仕入先・補充設定・発注の作成〜打切り（ADR-040） |
| stocktake.count / stocktake.confirm | 棚卸の開始・計数・差異確認 / 棚卸の確定・中止 |
| allocation.manage | 引当実行・手動引当/解除・先行出荷 |
| fulfillment.manage | Fulfillment 操作・Short Pick の解決・再割当 |
| waves.read / waves.manage | Wave・Pick List 参照 / 作成・取消・タスク割当 |
| pick.execute | Pick 実行 |
| pack.execute | 梱包 |
| pack.force_complete | 全数一致前の強制梱包完了（理由必須） |
| shipments.read / shipments.manage | 出荷参照 / 追跡番号・出荷確定・追跡 CSV 取込 |
| returns.read | 返品参照 |
| returns.request | 返品受付・承認・却下・取消 |
| returns.receive | 返品到着 scan |
| returns.inspect | 返品検品・Disposition（Restock 等の在庫処理） |
| exchanges.create | 交換作成 |
| exceptions.read / exceptions.report / exceptions.manage | 例外参照 / 現場からの例外報告 / 対応・解決・無視 |
| kpi.read | KPI・ダッシュボード集計 |
| audit.read | 監査ログ |
| export.csv | 個人情報を含む CSV エクスポート |
| backup.manage | バックアップ作成・ダウンロード・復元 |

## 3. ロール × 権限

| 権限 | Owner | Operations Manager | Picker | Packer | Customer Support |
|---|:-:|:-:|:-:|:-:|:-:|
| org.manage / users.manage / warehouses.manage / channels.manage / backup.manage | ✓ | – | – | – | – |
| products.read | ✓ | ✓ | ✓ | ✓ | ✓ |
| products.manage | ✓ | ✓ | – | – | – |
| customers.manage | ✓ | ✓ | – | – | ✓ |
| orders.read / orders.read_pii | ✓ | ✓ | – | – | ✓ |
| orders.read_ship_to | ✓ | ✓ | – | ✓ | ✓ |
| orders.import / orders.cancel | ✓ | ✓ | – | – | – |
| orders.edit / orders.hold | ✓ | ✓ | – | – | ✓ |
| inventory.read | ✓ | ✓ | – | – | ✓ |
| inventory.adjust | ✓ | ✓ | – | – | **–** |
| purchasing.read / purchasing.manage | ✓ | ✓ | – | – | – |
| stocktake.count | ✓ | ✓ | ✓ | – | – |
| stocktake.confirm | ✓ | ✓ | – | – | – |
| allocation.manage / fulfillment.manage / waves.manage | ✓ | ✓ | – | – | – |
| waves.read | ✓ | ✓ | ✓ | – | – |
| pick.execute | ✓ | ✓ | ✓ | – | – |
| pack.execute | ✓ | ✓ | – | ✓ | – |
| pack.force_complete | ✓ | ✓ | – | – | – |
| shipments.read | ✓ | ✓ | – | ✓ | ✓ |
| shipments.manage | ✓ | ✓ | – | – | – |
| returns.read / returns.request / exchanges.create | ✓ | ✓ | – | – | ✓ |
| returns.receive | ✓ | ✓ | – | ✓ | – |
| returns.inspect | ✓ | ✓ | **–** | – | – |
| exceptions.read | ✓ | ✓ | – | – | ✓ |
| exceptions.report | ✓ | ✓ | ✓ | ✓ | ✓ |
| exceptions.manage | ✓ | ✓ | – | – | – |
| kpi.read / audit.read / export.csv | ✓ | ✓ | – | – | – |

設計判断:
- Support の住所変更（orders.edit）は顧客対応上必要なため許可（在庫・権限には触れない）。キャンセルは Manager 以上。
- Picker は注文・顧客情報 API に一切アクセスできない（Pick API は注文番号/Fulfillment 番号のみ返す）。
- Packer は納品書の同梱確認のため送付先の氏名・住所のみ閲覧可（電話・メールは不可）。
- 最後の Owner は削除/降格できない（組織がロックアウトされるのを防ぐ）。

## 4. 個人情報の表示範囲

| 項目 | read_pii | read_ship_to | なし |
|---|:-:|:-:|:-:|
| 購入者 氏名/メール/電話 | ✓ | – | – |
| 送付先 氏名・郵便番号・住所 | ✓ | ✓ | – |
| 送付先 電話 | ✓ | – | – |
| 注文番号・外部注文番号・商品・数量・状態 | ✓ | ✓ | Pick 画面では注文番号のみ |

- 一覧画面は氏名と都道府県程度に留め、電話/メールは詳細画面のみ。
- 個人情報を含む CSV エクスポートは `export.csv` 必須 + 監査ログ。
- 検索: 顧客名・郵便番号での検索は `orders.read_pii` 保持者のみ。それ以外のロールには個人情報一致の結果を返さない。
- サーバーログに氏名・住所・電話・メール・リクエストボディを出力しない（pino redact）。

## 5. テスト対応
- R22: 組織 A のユーザーが組織 B の注文 ID を API に指定 → 404（存在を漏らさない）
- R23: Picker が返品 Disposition API → 403
- R24: Support が在庫調整 API → 403
- E2E-7: 各ロールで許可操作が成功し、禁止 API が拒否される（権限マトリクスを網羅する自動テスト `rbac-matrix.test.ts`）
