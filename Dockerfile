# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- web build
FROM node:22-alpine AS web
WORKDIR /build

COPY web/package.json ./
RUN npm install --no-audit --no-fund

COPY web/ ./
RUN npm run build

# ------------------------------------------------------------------ runtime
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server/src ./src
COPY server/data ./data
RUN mkdir -p /app/state

# The API server also serves the built SPA, so this is a single-process image.
COPY --from=web /build/dist ./public

EXPOSE 8080

# Container-native healthcheck so `docker compose up --wait` blocks until the
# API genuinely answers, rather than merely until the process exists.
HEALTHCHECK --interval=10s --timeout=4s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
