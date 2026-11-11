FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node src/server.mjs ./src/server.mjs
COPY --chown=node:node src/core/store.mjs src/core/provider.mjs ./src/core/
COPY --chown=node:node src/api/gateway.mjs ./src/api/
COPY --chown=node:node src/frontend/public ./src/frontend/public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node AGENTS.md ./AGENTS.md
USER node
ENV NODE_ENV=production PORT=8045 HOST=0.0.0.0
EXPOSE 8045
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8045/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
