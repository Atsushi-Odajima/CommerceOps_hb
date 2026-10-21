# CommerceOps — EC受注・在庫・出荷の業務管理

注文CSVの取込から、在庫引当・ピッキング・梱包・出荷・返品までを管理する業務Webアプリです。

> **実装ブランチ：`claude/merge-csv-image-checker`**。この既定ブランチのREADMEは製品の案内です。以下のソース・資料リンクと起動手順は、実装ブランチを参照します。

## できること

- 注文の取込プロファイル、引当・分割出荷・検品と返品
- 統合済みの仕入・補充・棚卸し・在庫取消
- ブラウザ内の商品CSV×画像照合、権限・監査・競合制御

## 現在の範囲・制限

- ECモール・配送会社のAPI自動連携や公式送り状の発行は対象外です。
- 実物バーコード・プリンター・スマートフォンと、購入者固有のCSV形式での確認は未実施です。画像照合の画面は最小限の実装です。

## 実装の見どころ

**構成：** React / TypeScript / Vite、Node.js / Fastify、PostgreSQL、ジョブワーカー。

- [017-commerceops/server/src](https://github.com/Atsushi-Odajima/CommerceOps_hb/tree/claude%2Fmerge-csv-image-checker/017-commerceops/server/src)
- [017-commerceops/web/src](https://github.com/Atsushi-Odajima/CommerceOps_hb/tree/claude%2Fmerge-csv-image-checker/017-commerceops/web/src)
- [017-commerceops/e2e](https://github.com/Atsushi-Odajima/CommerceOps_hb/tree/claude%2Fmerge-csv-image-checker/017-commerceops/e2e)

## ローカルで試す

Node.js 22.12以上、PostgreSQL。サーバーとジョブワーカーを動かす構成です。

実装ブランチを取得し、次のディレクトリで作業します。

```sh
git clone --branch claude/merge-csv-image-checker https://github.com/Atsushi-Odajima/CommerceOps_hb.git
cd CommerceOps_hb/017-commerceops
npm ci
```

開発手順でDB・環境変数・初期化を設定し、開発時は npm run dev -w server と npm run dev -w web を別ターミナルで実行します。公開運用の起動・ワーカー設定は配備手順を参照してください。

環境設定・初期化の詳細：[セットアップ手順](https://github.com/Atsushi-Odajima/CommerceOps_hb/blob/claude%2Fmerge-csv-image-checker/017-commerceops/docs/DEVELOPMENT.md)。

## 検証方法

`017-commerceops/` の `package.json` に定義された主な確認コマンドです。DB・ブラウザ・外部ツールを要するものは、開発手順の事前設定が必要です。

```sh
npm run typecheck
npm run test
npm run e2e
npm run build
```

試験の実施環境・結果・未実施項目は、下記の記録を参照してください。画面エミュレーションと実機確認、モックと外部サービスでの確認を区別しています。

## 資料

- [017-commerceops/docs/DEVELOPMENT.md](https://github.com/Atsushi-Odajima/CommerceOps_hb/blob/claude%2Fmerge-csv-image-checker/017-commerceops/docs/DEVELOPMENT.md)
- [017-commerceops/NEXT_STEPS.txt](https://github.com/Atsushi-Odajima/CommerceOps_hb/blob/claude%2Fmerge-csv-image-checker/017-commerceops/NEXT_STEPS.txt)
- [017-commerceops/docs/TEST_REPORT.md](https://github.com/Atsushi-Odajima/CommerceOps_hb/blob/claude%2Fmerge-csv-image-checker/017-commerceops/docs/TEST_REPORT.md)
- [017-commerceops/docs/RELEASE_CHECKLIST.md](https://github.com/Atsushi-Odajima/CommerceOps_hb/blob/claude%2Fmerge-csv-image-checker/017-commerceops/docs/RELEASE_CHECKLIST.md)
- [017-commerceops/docs/DATA_MODEL.md](https://github.com/Atsushi-Odajima/CommerceOps_hb/blob/claude%2Fmerge-csv-image-checker/017-commerceops/docs/DATA_MODEL.md)
- [017-commerceops/DECISIONS.md](https://github.com/Atsushi-Odajima/CommerceOps_hb/blob/claude%2Fmerge-csv-image-checker/017-commerceops/DECISIONS.md)
- [017-commerceops/docs/SECURITY.md](https://github.com/Atsushi-Odajima/CommerceOps_hb/blob/claude%2Fmerge-csv-image-checker/017-commerceops/docs/SECURITY.md)
- [017-commerceops/docs/OPERATIONS.md](https://github.com/Atsushi-Odajima/CommerceOps_hb/blob/claude%2Fmerge-csv-image-checker/017-commerceops/docs/OPERATIONS.md)

## 制作・利用条件

制作・管理：**Atsushi Odajima**。実装・資料作成にはAI支援を利用しています。
ソース・同梱ライブラリ・フォント・モデル等の利用条件は、各ライセンスと第三者表記を参照してください。リポジトリの閲覧可能性と、再配布・商用利用の許諾は別です。
