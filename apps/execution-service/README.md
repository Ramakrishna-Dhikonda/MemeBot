# Execution Service

The execution service listens for risk-approved orders, builds swaps via Jupiter,
and sends signed transactions to Solana. Results are published back to Redis.

## Responsibilities

- Subscribe to Redis channel `risk_approved_orders`.
- Fetch Jupiter quotes + swap transactions.
- Sign and submit transactions with the configured wallet.
- Confirm transactions and publish to `execution_results`.
- Run concurrently with an async queue and retry on transient failures.

## Configuration

The service is configured via environment variables:

| Variable | Description |
| --- | --- |
| `SOLANA_RPC_URLS` | Comma-separated RPC endpoints. |
| `SOLANA_COMMITMENT` | Commitment level for RPC calls (default: `confirmed`). |
| `SOLANA_RPC_MAX_RETRIES` | RPC retry attempts. |
| `SOLANA_RPC_RETRY_DELAY_MS` | Delay between RPC retries. |
| `JUPITER_BASE_URL` | Jupiter API base URL. |
| `JUPITER_SLIPPAGE_BPS` | Slippage basis points. |
| `WALLET_ENCRYPTED_KEY` | Encrypted key blob (hex). |
| `WALLET_SALT` | Wallet salt (hex). |
| `WALLET_IV` | Wallet IV (hex). |
| `WALLET_PASSPHRASE` | Wallet passphrase. |
| `REDIS_URL` | Redis connection URL. |
| `REDIS_PUBLISH_TIMEOUT_MS` | Timeout for Redis publish. |
| `REDIS_PUBLISH_RETRIES` | Redis publish retries. |
| `REDIS_RETRY_DELAY_MS` | Delay between Redis publish retries. |
| `BASE_MINT` | Mint address for the base asset (e.g., USDC). |
| `PRICE_API_URL` | Price API URL (default: Jupiter price API). |
| `MINT_DECIMALS` | JSON map of mint to decimals. |
| `EXECUTION_MAX_RETRIES` | Retry attempts for execution steps. |
| `EXECUTION_RETRY_DELAY_MS` | Delay between execution retries. |
| `CONFIRMATION_COMMITMENT` | Confirmation commitment (default: `confirmed`). |
| `EXECUTION_CONCURRENCY` | Async queue concurrency (default: `4`). |
| `PORT` | HTTP health port (default: `4004`). |
| `LOG_LEVEL` | Pino log level (default: `info`). |

## Health Check

The service exposes a health endpoint at:

```
GET /health
```

## Running Locally

```
npm --workspace @sqts/execution-service run build
node apps/execution-service/dist/index.js
```

## Tests

```
npm --workspace @sqts/execution-service run test
```
