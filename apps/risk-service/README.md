# Risk Service

The risk service validates incoming trade signals and publishes either approved orders or dead-lettered rejections.

## Risk Rules

The service enforces the following checks before approving a signal:

1. **Max capital per trade**: `sizeUsd` must be less than or equal to `RISK_MAX_TRADE_PCT * RISK_TOTAL_CAPITAL_USD`.
2. **Daily loss limit**: if realized losses for the current day are greater than or equal to `RISK_DAILY_LOSS_LIMIT_USD`, all new signals are rejected.
3. **Liquidity safety**: the latest `liquidity_events` value for the mint must be at least `RISK_MIN_LIQUIDITY_USD`.
4. **Token holder concentration**: the latest `whale_events` amount is compared to liquidity to estimate concentration (`whaleAmountUsd / liquidityUsd`). If this ratio exceeds `RISK_MAX_HOLDER_CONCENTRATION_PCT`, the signal is rejected.

Approved signals are published to `risk_approved_orders`. Rejections are published to the dead-letter topic with a reason code.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `REDIS_URL` | (required) | Redis connection string. |
| `RISK_TOTAL_CAPITAL_USD` | `200000` | Total capital used for sizing limits. |
| `RISK_MAX_TRADE_PCT` | `0.05` | Maximum percent of capital allowed per trade. |
| `RISK_MIN_LIQUIDITY_USD` | `75000` | Minimum liquidity required for approval. |
| `RISK_DAILY_LOSS_LIMIT_USD` | (required) | Daily realized loss limit before new trades are rejected. |
| `RISK_MAX_HOLDER_CONCENTRATION_PCT` | `0.2` | Maximum whale/liquidity ratio allowed. |
| `RISK_APPROVED_TOPIC` | `risk_approved_orders` | Topic for approved orders. |
| `RISK_DEAD_LETTER_TOPIC` | `risk_dead_letter` | Topic for rejected signals. |
| `RISK_PUBLISH_TIMEOUT_MS` | `2000` | Redis publish timeout in milliseconds. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `PORT` | `4003` | Health server port. |

## Runtime

The service subscribes to:

- `trade_signals`
- `liquidity_events`
- `whale_events`
- `portfolio_updates`

A health endpoint is available at `GET /health` on port `4003` (or `PORT`).
