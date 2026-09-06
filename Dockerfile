# 1 image: Node (server.js + lib/) + Python3 (core/ engine, pure-HTTP -- không cần Chrome/Xvfb).
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PYTHON_BIN=python3

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY core/requirements.txt ./core/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r core/requirements.txt

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./server.js
COPY lib ./lib
COPY public ./public
COPY core ./core

RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8099
CMD ["node", "server.js"]
