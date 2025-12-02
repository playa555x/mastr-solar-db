FROM oven/bun:latest

WORKDIR /app

COPY package.json ./
COPY bun.lock ./
COPY server.ts ./
COPY mastr-solar.db ./

RUN bun install --frozen-lockfile

EXPOSE 8080

ENV PORT=8080

CMD ["bun", "run", "server.ts"]
