# Pathology manifest collaboration service.
#
# Multi-stage build:
#   deps   -> installs dev tooling (typescript) needed by the verify stage
#   final  -> runtime image with ZERO production npm dependencies; it only
#             needs the Node runtime plus the application sources.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# The official node image defaults to NODE_ENV=production, which would make
# npm skip devDependencies; the type-check stage needs typescript.
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS final
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data
COPY --chown=node:node src ./src
COPY --chown=node:node test ./test
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node types ./types
COPY --chown=node:node tsconfig.json package.json ./
# node_modules is present solely so the one-shot verify service can type-check.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
USER node
EXPOSE 8080
# Exec form on purpose: it bypasses the shell so $(...) is not expanded by sh.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "--experimental-strip-types", "src/index.ts"]
