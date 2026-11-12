# Образ ftech для продакшна: сборка TypeScript отдельно, в итоговом образе — только то, что нужно для работы.
# Сборка: docker build -t ftech .   Запуск — через deploy/docker-compose.yml (см. docs/DEPLOY.md).

FROM node:22.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22.12.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
COPY --chown=root:root migrations ./migrations
COPY --chown=root:root public ./public
# Без root: процесс не может менять свои файлы и систему контейнера.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
