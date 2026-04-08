# Deployment Guide

## Docker

Build and run the container:

```bash
docker build -t acme-store-api .
docker run -d \
  --name acme-api \
  -p 3000:3000 \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -v acme-data:/app/data \
  acme-store-api
```

The `Dockerfile` uses a multi-stage build: `node:20-alpine` for building, `node:20-alpine` (slim) for the runtime image. Final image size is ~85 MB.

## Environment Variables

| Variable       | Required | Description                          |
|---------------|----------|--------------------------------------|
| `JWT_SECRET`  | Yes      | 256-bit secret for signing JWTs      |
| `DB_PATH`     | No       | SQLite file path (default: `/app/data/store.db`) |
| `PORT`        | No       | Listen port (default: `3000`)        |
| `NODE_ENV`    | No       | Set to `production` for optimized logging |
| `LOG_LEVEL`   | No       | `debug`, `info`, `warn`, `error` (default: `info`) |

## Health Checks

The `/health` endpoint returns `200 OK` with `{ "status": "ok" }`. Configure your orchestrator to probe it:

```yaml
# Docker Compose example
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 10s
```

## Database Persistence

SQLite data lives at `DB_PATH`. In Docker, mount a named volume to `/app/data` to persist across container restarts. Back up the file with:

```bash
sqlite3 /app/data/store.db ".backup /backups/store-$(date +%F).db"
```

## Scaling

Since SQLite is file-based, horizontal scaling requires switching to PostgreSQL or MySQL. For single-node deployments:

- Use PM2 or the Node.js cluster module to utilize multiple CPU cores.
- Place Nginx or Caddy in front for TLS termination and static asset serving.
- Enable gzip compression at the reverse proxy layer.

For multi-node deployments, migrate the data layer to a networked database and deploy behind a load balancer. The stateless JWT auth strategy means no session affinity is needed.

## Monitoring

- Expose Prometheus metrics via `/metrics` (optional middleware).
- Forward structured JSON logs to your aggregator (ELK, Loki, Datadog).
- Set alerts on `/health` failures and p99 latency > 200 ms.
