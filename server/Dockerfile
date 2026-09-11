FROM node:24-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/src ./src
COPY server/scripts ./scripts
COPY server/test ./test
COPY web/dist ./public
ENV NODE_ENV=production HOST=127.0.0.1 PORT=8787 STATIC_DIR=/app/public
CMD ["node", "src/index.js"]
