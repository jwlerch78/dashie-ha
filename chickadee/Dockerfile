FROM node:20-alpine

WORKDIR /app

# Brain-runtime stub is dependency-free (Node core http only) — no npm install.
COPY server/ ./server/

COPY run.sh /
RUN chmod a+x /run.sh

CMD ["/run.sh"]
