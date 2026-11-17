FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
# Saved tables live here; the compose file mounts a volume on it.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server/index.js"]
