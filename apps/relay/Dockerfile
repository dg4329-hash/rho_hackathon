# Railway / container deploy for the mesh relay (monorepo). Build context = repo root:
#   docker build -f apps/relay/Dockerfile .
# Railway sets PORT (relay falls back to 8080). Set ROOM_SECRET in Railway variables, or room keys reset on every deploy.
FROM node:22-bookworm-slim

WORKDIR /app
# pnpm via npm, not corepack: avoids corepack signature-key failures on older base images. Version matches package.json packageManager.
# tar + gzip (used at startup to build /plugin.tgz) are Essential packages in Debian, so they are already in the slim image.
RUN npm install -g pnpm@10.32.1 && pnpm --version && tar --version | head -1

# Manifests first so the dependency layer caches. apps/tray (Electron) is deliberately not copied: the relay never needs it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/relay/package.json apps/relay/
COPY apps/daemon/package.json apps/daemon/
COPY apps/feed/package.json apps/feed/

# Installs devDependencies too (NODE_ENV is not production yet): tsx (root) runs the relay, esbuild (daemon) builds the bundle.
RUN pnpm install --frozen-lockfile

COPY packages/protocol packages/protocol
COPY apps/daemon apps/daemon
COPY hooks hooks
# Served as GET /plugin.tgz: the relay tars .claude-plugin/marketplace.json + plugin/ at startup (buildPluginTgz in apps/relay/src/index.ts).
COPY plugin plugin
COPY .claude-plugin .claude-plugin
COPY apps/relay apps/relay

# Single-file daemon bundle, served at GET /mesh.mjs for the one-command join (curl …/install.sh | bash).
RUN pnpm -F daemon bundle && test -s apps/daemon/dist/mesh.mjs && test -s hooks/emit.js && test -s .claude-plugin/marketplace.json && test -d plugin

ENV NODE_ENV=production
EXPOSE 8080
CMD ["pnpm", "-F", "relay", "start"]
