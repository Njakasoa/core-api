# syntax=docker/dockerfile:1
FROM oven/bun:1.3-slim

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production || bun install --production

# App source.
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Apply migrations then start. Stateless — scale horizontally behind a balancer.
CMD ["sh", "-c", "bun run db:migrate && bun src/index.ts"]
