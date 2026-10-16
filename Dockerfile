# Claw3D - 3D agent visualization for OpenClaw.
# Multi-stage build: install prod deps -> build Next.js -> run with custom server.

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Set to 1 for plain-HTTP hosting (drops upgrade-insecure-requests + HSTS; baked into routes-manifest).
ARG STUDIO_ALLOW_HTTP=
ENV STUDIO_ALLOW_HTTP=$STUDIO_ALLOW_HTTP
# Build-time gateway URL (overridden at runtime by CLAW3D_GATEWAY_URL).
ENV NEXT_PUBLIC_GATEWAY_URL=ws://127.0.0.1:18789
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
# GitHub CLI for the office GitHub screen (studio runs `gh` server-side; needs >=2.48 for --slurp).
# ponytail: amd64 release only; add TARGETARCH mapping if this ever builds on arm64.
ARG GH_VERSION=2.74.0
ARG GH_SHA256=e55c9d49dc49c0b0fef0a9acd3510482fd9e27ff52ae80f8a6e838cd25b4cd89
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ADD https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz /tmp/gh.tgz
RUN echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c - \
  && tar -xzf /tmp/gh.tgz -C /tmp \
  && mv /tmp/gh_${GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/gh \
  && rm -rf /tmp/gh.tgz /tmp/gh_${GH_VERSION}_linux_amd64
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy built app + custom server + production node_modules only.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/server ./server
COPY --from=deps /app/node_modules ./node_modules
# next.config.ts needs typescript at runtime; without it Next yarn-installs all devDeps on start.
COPY --from=builder /app/node_modules/typescript ./node_modules/typescript
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts

EXPOSE 3000

CMD ["node", "server/index.js"]
