# Self-hosted Word Atlas: static app + SQLite progress sync (scripts/serve.mjs).
#   docker compose up -d --build
# ATLAS_BASE must match the sub-path the reverse proxy serves (e.g. /words/).

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG ATLAS_BASE=/
RUN ATLAS_BASE=$ATLAS_BASE npm run build \
  # Media goes in its own image layer below, so code-only changes don't re-ship ~700 MB.
  && rm -rf dist/atlas/img dist/atlas/thumb dist/atlas/audio

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY public/atlas/img dist/atlas/img
COPY public/atlas/thumb dist/atlas/thumb
COPY public/atlas/audio dist/atlas/audio
COPY scripts/serve.mjs scripts/serve.mjs
COPY --from=build /app/dist dist
ARG ATLAS_BASE=/
ENV ATLAS_BASE=$ATLAS_BASE
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4182
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:4182/api/sync/healthcheck?rev=0" >/dev/null || exit 1
CMD ["node", "scripts/serve.mjs", "--host", "0.0.0.0", "--port", "4182", "--db", "/data/progress.db"]
