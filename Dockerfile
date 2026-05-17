# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build \
    && rm -rf node_modules \
    && pnpm install --frozen-lockfile --prod --ignore-scripts \
    && pnpm rebuild better-sqlite3 sqlite-vec


FROM node:20-bookworm-slim AS runtime

RUN useradd -r -u 10001 -m rembric

WORKDIR /app

COPY --from=builder --chown=rembric:rembric /app/dist           ./dist
COPY --from=builder --chown=rembric:rembric /app/node_modules   ./node_modules
COPY --from=builder --chown=rembric:rembric /app/package.json   ./

USER rembric

ENV REMBRIC_DATA_DIR=/data \
    REMBRIC_HOST=0.0.0.0 \
    REMBRIC_PORT=8787

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz',{headers:{Authorization:'Bearer '+process.env.REMBRIC_ADMIN_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["start"]
