# Backtesting Engine

The backtesting engine replays historical price and liquidity data through strategy functions, simulates order execution with fees/slippage, and generates a PnL report.

## Running the service

```bash
npm --workspace @sqts/backtesting-engine run build
PRICE_DATA_PATH=./data/prices.json \
LIQUIDITY_DATA_PATH=./data/liquidity.json \
SERVICE_PORT=4010 \
node apps/backtesting-engine/dist/index.js
```

The service starts an HTTP listener on port `4010` with a `/health` endpoint.

## Data format

Create a `data/` folder inside `apps/backtesting-engine` (or provide absolute paths) with two JSON files:

`prices.json`
```json
[
  { "timestamp": "2024-01-01T00:00:00.000Z", "price": 1.02, "volume": 1200 },
  { "timestamp": "2024-01-01T00:01:00.000Z", "price": 1.05, "volume": 900 }
]
```

`liquidity.json`
```json
[
  { "timestamp": "2024-01-01T00:00:00.000Z", "liquidityUsd": 75000 },
  { "timestamp": "2024-01-01T00:01:00.000Z", "liquidityUsd": 82000 }
]
```

Ticks are merged by timestamp. If one stream is missing a timestamp, the engine carries the last known value forward once both streams have emitted at least one tick.

## Adding new data

1. Place price history in `prices.json`.
2. Place liquidity snapshots in `liquidity.json`.
3. Ensure timestamps align to the same interval (e.g., 1-minute bars).
4. Restart the service to reload the data files.
