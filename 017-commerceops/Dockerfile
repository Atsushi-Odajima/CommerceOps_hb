# syntax=docker/dockerfile:1
# CommerceOps 本番イメージ（API + 画面の静的配信 + Job worker を 1 コンテナで動かす）
#   docker build -t commerceops .
# 実行時に必要な環境変数は docs/DEPLOY.md（DATABASE_URL, APP_BASE_URL など）。

# ---- build: 画面（web/dist）とサーバー（server/dist）をビルド ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY server/package.json server/
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN npm ci --workspace server --workspace web --include-workspace-root --no-audit --no-fund
COPY server server
COPY web web
RUN npm run build -w web && npm run build -w server

# ---- runtime: 本番依存だけを入れ、ビルド成果物をコピー ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIST_DIR=/app/web/dist
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY server/package.json server/
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
# 返品写真・バックアップの一時ファイルの保存先（永続ボリュームをマウントする）
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/server
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 起動時にマイグレーション → API → 同一プロセスの Job worker（RUN_WORKER=true）
CMD ["node", "dist/index.js"]
