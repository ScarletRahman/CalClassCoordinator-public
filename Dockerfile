# One image runs the whole app: the planner (Next.js) and the watcher + Discord bot (Python).
# They share a volume mounted at /data. See OWNER_NOTES.md, "Hosting and deployment".

# ---- 1. build the web app -------------------------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /repo/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- 2. runtime: Python for the watcher, plus the Node binary for the web server ---------------
FROM python:3.13-slim-bookworm
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin app
COPY --from=web /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY pyproject.toml ./
COPY watcher/ ./watcher/
RUN pip install --no-cache-dir ".[prod]"

# Standalone Next.js output. outputFileTracingRoot is the repo root, so the server lives in web/.
COPY --from=web /repo/web/.next/standalone/ ./
COPY --from=web /repo/web/.next/static ./web/.next/static
COPY web/stub-data ./web/stub-data

# Committed datasets the planner reads (requirements, courses, predictions when they land).
COPY data/ ./data/
COPY deploy/watcher.prod.yaml deploy/start.sh ./deploy/
RUN chmod +x deploy/start.sh

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CCC_DATA_DIR=/app/data \
    DATABASE_PATH=/data/web/planner.db \
    WATCHER_DATA_DIR=/data/watcher \
    WATCHER_CONFIG=/app/deploy/watcher.prod.yaml \
    WATCHER_URL=http://127.0.0.1:8765 \
    PYTHONUNBUFFERED=1

VOLUME /data
EXPOSE 3000
ENTRYPOINT ["/app/deploy/start.sh"]
