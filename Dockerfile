FROM oven/bun:latest

WORKDIR /app

COPY server.ts ./
COPY mastr-solar.db ./
COPY static ./static

EXPOSE 8080

ENV PORT=8080

CMD ["bun", "server.ts"]
