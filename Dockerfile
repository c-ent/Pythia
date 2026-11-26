FROM node:24-alpine AS build
RUN npm install -g pnpm@12.16.1
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter server... --filter web...
COPY server server
COPY web web
# The server serves the built PWA from the same origin as /api (T18).
RUN pnpm --filter web build \
 && pnpm --filter server build \
 && pnpm --filter server deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production
ENV PYTHIA_WEB_DIR=/app/web
# git for the read-only repo mirrors (T15). /data/repos is created here so a
# named volume mounted on it starts out owned by the node user.
RUN apk add --no-cache git \
 && mkdir -p /data/repos \
 && chown node:node /data/repos
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules node_modules
COPY --from=build /repo/server/dist dist
COPY --from=build /repo/server/migrations migrations
COPY --from=build /repo/web/dist web
USER node
CMD ["sh", "-c", "node dist/db/migrateCli.js && exec node dist/index.js"]
