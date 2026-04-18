# Stage 1: Native Compilation Builder
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Required for node-gyp, node-llama-cpp, better-sqlite3 native compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    cmake \
    git \
    libsqlcipher-dev \
 && rm -rf /var/lib/apt/lists/*

# Copy workspace package definitions first
COPY package.json package-lock.json ./
COPY packages/ ./packages/

# Install all dependencies (including devdeps needed for build)
RUN npm ci
RUN npm install --no-save better-sqlite3-multiple-ciphers

# Copy full application code for TS compilation
COPY . .

# Build the Typescript application
RUN npm run build

# Strip dev dependencies to keep the image lightweight
RUN npm prune --omit=dev
RUN npm install --no-save --omit=dev better-sqlite3-multiple-ciphers

# Stage 2: Runtime Image
FROM node:22-bookworm-slim

WORKDIR /app

# Install libgomp1 which is usually required by node-llama-cpp logic (cpu threading)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    libsqlcipher0 \
 && rm -rf /var/lib/apt/lists/*

# Copy production node_modules with prebuilt native bindings
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Copy compiled backend assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/capabilities ./capabilities

# Configure Operational Environment
ENV NODE_ENV=production
# Force JSON logs for datadog/cloudwatch friendliness 
ENV KINDX_LOG_JSON=1
ENV KINDX_SQLITE_DRIVER=better-sqlite3-multiple-ciphers

# Isolate homedir so config and cache are persisted easily
ENV HOME=/data
RUN mkdir -p /data && chown -R node:node /data
USER node

# Expose standard MCP server port
EXPOSE 8181

# Default ENTRYPOINT bypasses unneeded shell layers
ENTRYPOINT ["node", "dist/kindx.js"]

# Defaults to running MCP daemon on http standard binding
CMD ["mcp", "--http", "--port", "8181"]
