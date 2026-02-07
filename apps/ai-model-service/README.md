# AI Model Service

FastAPI service providing inference for the rug pull predictor and pump detection models.

## Requirements

- Python 3.11+

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run locally

```bash
uvicorn app.main:app --host 0.0.0.0 --port 5000
```

## Endpoints

### POST /predict/rug

Request body:

```json
{
  "liquidity_usd": 20000,
  "holder_count": 100,
  "age_days": 2,
  "volume_24h_usd": 5000,
  "top_holder_share": 0.55
}
```

Response:

```json
{
  "risk_score": 0.9,
  "risk_level": "high"
}
```

### POST /predict/pump

Request body:

```json
{
  "price_change_24h": 0.45,
  "volume_spike": 2.4,
  "social_buzz": 0.7
}
```

Response:

```json
{
  "pump_score": 0.8,
  "pump_signal": "pump"
}
```

## Tests

```bash
pytest
```

## Docker

```bash
docker build -t ai-model-service .
docker run --rm -p 5000:5000 ai-model-service
```
