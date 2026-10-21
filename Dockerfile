FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-fund --no-audit
COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
COPY test ./test
COPY scripts ./scripts
COPY examples/plugins ./examples/plugins
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-fund --no-audit

FROM node:22.23.2-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/host/src ./dist/src
COPY --from=build /app/assets ./assets
RUN mkdir /app/data /app/plugins && chown node:node /app/data /app/plugins
USER node
CMD ["node", "dist/src/main.js"]
