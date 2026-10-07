export const APP_VERSION = '1.0.0';
/**
 * データ形式の版（テーブル・列の構成が変わるマイグレーションで上げる）。バックアップ互換性判定に使う。
 * 索引だけのマイグレーション（例: 0002_scale_indexes）では上げない（バックアップの中身は変わらないため）。
 */
export const SCHEMA_VERSION = 2; // 2: 0004_stockpilot_merge（仕入先・発注・補充設定・棚卸・取消）
