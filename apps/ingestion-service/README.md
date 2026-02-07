# Ingestion Service

Node.js TypeScript service that listens to a Solana streaming API (Helius or other WebSocket RPC), parses ingestion events, and publishes structured messages to Redis pub/sub topics.

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `SOLANA_WS_URL` | WebSocket URL for Solana streaming API (Helius or other RPC). | required |
| `SOLANA_API_KEY` | API key for Helius (optional for other RPCs). | `""` |
| `SOLANA_REQUEST_ID` | JSON-RPC request ID for the subscription. | `1` |
| `SOLANA_MAX_RETRIES` | Max WebSocket reconnect attempts. | `5` |
| `SOLANA_RETRY_DELAY_MS` | Base delay between reconnect attempts. | `1000` |
| `SOLANA_WHALE_THRESHOLD_USD` | USD threshold to tag whale transfers. | `50000` |
| `REDIS_URL` | Redis connection URL. | required |
| `REDIS_PUBLISH_TIMEOUT_MS` | Timeout for publishing to Redis. | `2000` |
| `REDIS_PUBLISH_RETRIES` | Number of publish retries on failure. | `3` |
| `REDIS_RETRY_DELAY_MS` | Base delay between publish retries. | `500` |
| `DEFAULT_CREATOR` | Creator address fallback for new token events. | `unknown` |
| `PORT` | Health endpoint port. | `4001` |
| `LOG_LEVEL` | Pino log level. | `info` |

## Health endpoint

`GET /health` returns `{ "status": "ok" }`.

## Running locally

```bash
cd apps/ingestion-service
npm install
SOLANA_WS_URL="wss://rpc.example.com" \
REDIS_URL="redis://localhost:6379" \
DEFAULT_CREATOR="unknown" \
npm run build
node dist/index.js
```

## Running tests

```bash
cd apps/ingestion-service
npm test
```
