FROM node:20-alpine

WORKDIR /app

# The server needs express + ws since the console port (0.5.0) — the add-on is
# no longer dependency-free. Deps first so this layer caches on code-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./server/
COPY frontend/ ./frontend/
# Vendored HA integration — installed into /config by integration-installer.js.
COPY integration/ ./integration/

COPY run.sh /
RUN chmod a+x /run.sh

CMD ["/run.sh"]
