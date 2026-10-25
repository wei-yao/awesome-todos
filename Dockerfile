FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs store.mjs index.html ./
ENV NODE_ENV=production
USER node
CMD ["node", "server.mjs"]
