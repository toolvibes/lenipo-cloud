FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
ENV NODE_ENV=production EXPORT_DIR=/var/lib/lenipo-cloud/exports
WORKDIR /app
RUN mkdir -p /var/lib/lenipo-cloud/exports && chown -R node:node /var/lib/lenipo-cloud
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node legal ./legal
COPY --chown=node:node package.json ./
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health > /dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
