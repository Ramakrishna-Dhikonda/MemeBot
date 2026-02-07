# Portfolio Service

Tracks portfolio positions, realized/unrealized PnL, and trade history backed by PostgreSQL. The service publishes portfolio refresh updates to the `portfolio_updates` Redis topic.

## Setup

```bash
npm install
```

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://postgres:postgres@localhost:5432/portfolio` |
| `DATABASE_SSL` | Enable SSL for PostgreSQL | `false` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `PORT` | HTTP port | `4005` |
| `LOG_LEVEL` | Logger level | `info` |

## Running

```bash
npm run --workspace @sqts/portfolio-service build
node apps/portfolio-service/dist/index.js
```

## REST API

- `GET /positions` → list current positions
- `GET /pnl` → total realized/unrealized PnL
- `POST /refresh` → rebuild positions from trade history, publish update to Redis

## Notes

- Trades are expected to already exist in the `trades` table (from upstream services).
- Refresh recalculates positions from trade history and persists them in the `positions` table.
