FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/timesheet.db COOKIE_SECURE=1 TRUST_PROXY=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
