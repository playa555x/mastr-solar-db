FROM oven/bun:latest

WORKDIR /app

COPY package.json ./
COPY server.ts ./
COPY index.html ./
COPY *.db ./

RUN bun install

ENV PORT=8080

CMD ["bun", "server.ts"]
