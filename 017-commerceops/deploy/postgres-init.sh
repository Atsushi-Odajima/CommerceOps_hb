#!/bin/bash
# PostgreSQL 公式イメージの初回起動時にだけ実行される（/docker-entrypoint-initdb.d）。
# アプリ専用のユーザー（SUPERUSER / BYPASSRLS なし = 行レベルセキュリティが必ず効く）と、そのユーザーが所有するデータベースを作る。
set -euo pipefail
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD を設定してください}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE commerceops LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE DATABASE commerceops OWNER commerceops ENCODING 'UTF8' TEMPLATE template0;
SQL
