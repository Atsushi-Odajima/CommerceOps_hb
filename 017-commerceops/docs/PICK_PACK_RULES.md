# Pick / Pack / 作業割当ルール (PICK_PACK_RULES.md)

## 1. 作業割当（claim / release / timeout）

- 対象: PickTask、PackSession（Wave は作成者/担当者を記録）。**1 Task = 1 active assignee**。
- claim（条件付き UPDATE。二重 claim は 1 人だけ成功）:
  ```sql
  UPDATE pick_tasks SET assignee_user_id=$me, claimed_at=now(), claim_expires_at=now()+$ttl
   WHERE organization_id=$org AND id=$task AND status IN ('open','in_progress')
     AND (assignee_user_id IS NULL OR assignee_user_id=$me OR claim_expires_at < now())
  RETURNING id
  ```
- TTL は組織設定 `claimTimeoutMinutes`（既定 30 分）。scan のたびに延長（heartbeat）。
- release: 担当者本人 or `waves.manage` 権限者。進捗（ピック済数量）は保持され、別の人が続きから再開できる。
- timeout: 期限切れの claim は他の作業者が claim 可能。Job `assignments.expire` が期限切れ担当を外し監査ログに残す。
- 管理者は割当・付け替え（force reassign）が可能（監査ログ）。
- 倉庫スコープ: 作業者に倉庫制限がある場合、その倉庫のタスク以外は閲覧・claim 不可。

## 2. スマホ Pick Mode（iPhone / Android）

1. 「自分のタスク」から PickTask を開始（claim）。
2. 次のロケーションを大きく表示（ロケーション順）。商品名・SKU・画像（任意）・必要数・ピック済数。
3. **ロケーションのバーコード/QR を読む** → 期待と違えば「誤ロケーション」警告（誤 scan として記録）。
4. **商品コードを読む** → 期待 SKU と違えば「誤 SKU」警告し拒否（数量は加算しない、誤 scan 記録）。
5. 1 scan = 1 個。複数個をまとめて確定するには数量を手入力し **確認ダイアログ** を経る（読取だけで大量確定しない）。
   必要数を超える数量は拒否。
6. 行が必要数に達したら次のロケーションへ。全行完了（ピック済 or Short）でタスク完了。
7. カメラが使えない/読めない場合: ハンディスキャナ（キーボード入力 + Enter）または手入力 fallback。

### Pick Event
`pick_events`: picker, timestamp(server/client), warehouse, location, SKU(product), qty, wave, fulfillment, task, line,
event_type(`pick`/`correction`/`short`/`mis_scan_location`/`mis_scan_sku`), result, scanned_code, reason, `client_event_id`。

- **冪等**: クライアントは scan ごとに UUID `client_event_id` を生成。同じ ID の再送は既存結果を返し二重加算しない
  （`UNIQUE NULLS NOT DISTINCT (organization_id, client_event_id, pick_task_line_id)`）。
- **訂正**: ピック済数量を直接上書きしない。負数の `correction` イベント（元イベント参照）を追加する。
  梱包開始後の Fulfillment に対する訂正は不可。
- ピック済数量 = Σ pick/correction イベント。`pick_task_lines.picked_qty` と `fulfillment_items.picked_qty` は同一トランザクションで更新するキャッシュ。

### Short Pick（棚に商品がない）
- 理由: `not_found`（現物なし）/ `damaged`（破損）/ `wrong_location`（Location 違い）/ `qty_short`（数量不足）/ `other`
- 残数量を short として記録し、該当 Allocation の short 分を解放、在庫は on_hand を減らさず `held` へ（INVENTORY_RULES.md）。
- 例外 `short_pick`（注文側）と `inventory_mismatch`（在庫側）を作成し Manager へ。**注文を勝手にキャンセルしない。**
- Manager の解決手段: 「別倉庫へ再割当」（Fulfillment から short 分を外し、指定倉庫で引当 → 新 Fulfillment）/
  「バックログへ戻す」（後で再引当）/「揃った分で先行出荷」/ 顧客合意のうえ明細取消。
  在庫側は「紛失確定（on_hand 減）」「発見（held 解除）」。

### オフライン
- Pick scan のみオフライン下書き可。IndexedDB に保存し「未同期 N 件」と明示。再接続時に順番に送信し、
  サーバーはタスク担当・行の残数・Allocation 状態を **再検証**（担当が変わっていれば拒否）。
- Pack 完了・Shipment 確定・在庫調整・Return Restock はオフラインで確定しない（ボタン無効 + 説明表示）。

## 3. Packing Station（PC / iPad 専用）

1. 注文/作業票コード（Fulfillment 番号の QR/Code128、または注文番号）を読む → Fulfillment を開く（PackSession claim）。
   ピック未完了・保留中・別の人が作業中なら開始不可。
2. SKU ごとに **必要数 / scan 済 / 残数** を表示。
3. 商品を 1 個ずつ scan。
   - 別 SKU → 大きな赤い警告 + 音（誤 SKU）。同一商品グループの別バリエーションなら「別 variant」と表示。
   - 同じ Wave の別注文の商品なら「別注文(F-xxxx)の商品」と表示。
   - 必要数超過 → 「数量過多」警告。
   - いずれも数量は加算せず、誤 scan として pack_events と PackSession.mis_scan_count に記録（KPI/監査）。
4. 全 SKU の scan 済 = 必要数で「梱包完了」が有効化。複数箱モードでは「箱を閉じて次の箱」で box_no を進める。
5. 完了時に箱ごとの下書き Shipment を作成、Fulfillment は packed。
- **冪等**: pack scan も `client_event_id` UNIQUE。完了 API も requestId で冪等。
- **強制完了**: 全数一致前の完了は `pack.force_complete` 権限（Owner / Operations Manager）+ 理由必須 +
  強い警告ダイアログ。例外 `forced_pack` と監査ログを残す。通常は全数一致必須（必要 2 / scan 1 では完了不可）。
- scan 訂正（1 個取り消し）は負数イベント。セッション取消時は scan をリセット（イベントは履歴として残る）。

### 実装メモ（Phase5）
- 開始条件: 全数ピック済み（未解決の Short なし）・保留なし・取消/出荷済みでない。注文番号で読んだ場合、梱包可能な出荷作業が複数あれば選択させる。
- 担当: 1 Fulfillment = 1 active PackSession（部分 UNIQUE + Fulfillment 行ロック）。同じ Packer は再開、作業期限（claimTimeoutMinutes）切れは他の Packer が引継ぎ、
  作業中のセッションの引継ぎは管理者（fulfillment.manage）のみ `takeover: true` で可能（監査ログ pack.takeover）。
- ロック順序は Fulfillment → PackSession（注文キャンセル・保留とのデッドロック回避）。
- 誤 scan の判定順: 未登録コード → 同じ Wave の別注文の商品 → 同じ商品グループ（group_code）の別 variant → この注文にない SKU → 数量過多。
  いずれも数量は加算せず pack_events（mis_scan_*）と mis_scan_count に記録し、画面は大きな赤表示 + 警告音。
- まとめ入力（qty > 1）は同じ商品を 1 個以上 scan して商品を確認した後のみ（SCAN_FIRST）。2 段階確認。
- 複数箱: 「箱を閉じて次の箱へ」（空の箱は閉じられない）。完了時に箱ごとに下書き Shipment（送付先スナップショット、配送方法、既定の配送会社）を作成。
- 完了は requestId で冪等（同じ requestId の再送は同じ荷物を返す）。強制完了は未検品分を梱包扱いにし、forced_pack 例外（重要度 高）と監査ログを残す。
- 梱包取消（unpack）: 梱包済み・未出荷のみ。下書き Shipment を取消し packed_qty を 0 に戻す（イベントは履歴として残る）。出荷確定済みの箱がある場合は不可。
- 保留中は scan・完了不可（ON_HOLD）。注文キャンセル（confirm 必須）でセッションは中止され、以降の scan は拒否。
- 画面: PC / iPad（/pack）。オフライン時は scan・完了を無効化（オフライン確定しない）。納品書（価格なし・備考なし）は /print/packing-slip。

## 4. 帳票
- Pick List（Wave 単位、SKU/Location 集約、ロケーション順、Wave バーコード）
- Packing Slip（納品書: 注文番号・商品・数量、Fulfillment コード）
- Shipment 作業票（箱番号・追跡番号・内容）
- Return 受領票（RMA コード）
- 注文識別コード（Order/Fulfillment の QR・Code128）
いずれもブラウザ印刷（紙 / PDF 保存）。配送会社公式送り状は再現しない。
