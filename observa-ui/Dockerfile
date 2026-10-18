# ---- stage 1: build the React web UI (web/ -> web/dist) ----
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- stage 2: the server (Express API + the built UI, no build tools) ----
FROM node:22-alpine

# tini: proper signal handling; su-exec: drop from root to the "node" user after fixing volume ownership
RUN apk add --no-cache tini su-exec

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY config ./config
COPY --from=web /web/dist ./web/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data CONFIG_DIR=/app/config
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=10 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
