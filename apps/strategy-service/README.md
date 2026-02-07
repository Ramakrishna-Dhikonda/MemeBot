# Strategy Service

TypeScript microservice that subscribes to ingestion topics, evaluates sniper + momentum strategies, and publishes normalized trade signals.

## Features

- Subscribes to Redis topics:
  - `new_token_events`
  - `liquidity_events`
  - `whale_events`
- Strategies:
  - **Sniper**: BUY when liquidity growth is strong and dev wallet activity stays under a threshold.
  - **Momentum**: BUY on liquidity (price proxy) acceleration or volume spike.
- Publishes `trade_signals` payloads aligned with `@sqts/shared-types`.
- Confidence scores normalized to `0.0 - 1.0`.
- Health endpoint on `GET /` (port 4002).

## Configuration

All environment variables are validated at startup.

| Variable | Description | Default |
| --- | --- | --- |
| `REDIS_URL` | Redis connection string | **required** |
| `SERVICE_PORT` | Health server port | `4002` |
| `STRATEGY_MODE` | `sniper`, `momentum_breakout`, or `combined` | `combined` |
| `SNIPER_MIN_LIQUIDITY_USD` | Minimum liquidity before sniper considers a token | `60000` |
| `SNIPER_MIN_LIQUIDITY_GROWTH_USD` | Minimum liquidity growth for sniper | `40000` |
| `SNIPER_TARGET_LIQUIDITY_USD` | Target liquidity for confidence scaling | `200000` |
| `SNIPER_DEV_WALLET_MAX_USD` | Maximum dev wallet whale activity allowed | `50000` |
| `MOMENTUM_MIN_LIQUIDITY_USD` | Minimum liquidity before momentum considers a token | `50000` |
| `MOMENTUM_MIN_LIQUIDITY_INCREASE_USD` | Liquidity increase required for momentum signal | `30000` |
| `MOMENTUM_VOLUME_SPIKE_USD` | Whale amount to treat as volume spike | `80000` |
| `EXPECTED_SLIPPAGE_BPS` | Expected slippage in basis points | `100` |
| `MIN_CONFIDENCE` | Minimum confidence to emit a signal | `0.6` |
| `MAX_TOKEN_AGE_MS` | Max age (ms) for token consideration | `600000` |
| `COOLDOWN_MS` | Cooldown between signals | `60000` |
| `REDIS_PUBLISH_TIMEOUT_MS` | Redis publish timeout in ms | `2000` |

## Example signal

```json
{
  "id": "9f4c77c6-4f5d-42d6-9a52-1df0b5104c64",
  "topic": "trade_signals",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "strategy": "sniper",
  "mintAddress": "So11111111111111111111111111111111111111112",
  "side": "buy",
  "confidence": 0.82,
  "expectedSlippageBps": 100
}
```

## Running locally

```bash
export REDIS_URL=redis://localhost:6379
npm run build
node dist/index.js
```

## Tests

```bash
npm test
```
