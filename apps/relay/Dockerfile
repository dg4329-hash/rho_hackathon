# Railway / container deploy for the mesh relay (monorepo).
# Root context; Nixpacks/Railway should set PORT.
FROM node:22-bookworm-slim

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/relay/package.json apps/relay/
COPY apps/daemon/package.json apps/daemon/
COPY apps/feed/package.json apps/feed/

RUN pnpm install --frozen-lockfile

COPY packages/protocol packages/protocol
COPY apps/relay apps/relay

ENV NODE_ENV=production
EXPOSE 8080
CMD ["pnpm", "-F", "relay", "start"]
