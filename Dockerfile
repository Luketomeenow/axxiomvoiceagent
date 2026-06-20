# Backend (Hono on Bun) for Railway. Uses the official Bun image so the runtime
# is guaranteed regardless of how deps were installed locally.
FROM oven/bun:1

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json ./
RUN bun install

# App source.
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./

# Railway injects PORT; the app reads it via src/config/env.ts (default 3000).
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
