FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js catalog-export.js products-data.js index.html ./
COPY public ./public
RUN mkdir -p /data /data/uploads
ENV DB_PATH=/data/watchop.db UPLOADS_DIR=/data/uploads PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz | grep -q '"ok":true' || exit 1
CMD ["node", "server.js"]
