from __future__ import annotations

from fastapi import FastAPI

from app.models import load_pump_detection_model, load_rug_pull_model
from app.schemas import PumpRequest, PumpResponse, RugPullRequest, RugPullResponse

app = FastAPI(title="AI Model Service", version="1.0.0")

rug_pull_model = load_rug_pull_model()
pump_detection_model = load_pump_detection_model()


@app.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/predict/rug", response_model=RugPullResponse)
async def predict_rug(request: RugPullRequest) -> RugPullResponse:
    features = [
        request.liquidity_usd,
        float(request.holder_count),
        request.age_days,
        request.volume_24h_usd,
        request.top_holder_share,
    ]
    risk_score = rug_pull_model.predict(features)
    risk_level = "high" if risk_score >= 0.6 else "low"
    return RugPullResponse(risk_score=risk_score, risk_level=risk_level)


@app.post("/predict/pump", response_model=PumpResponse)
async def predict_pump(request: PumpRequest) -> PumpResponse:
    features = [request.price_change_24h, request.volume_spike, request.social_buzz]
    pump_score = pump_detection_model.predict(features)
    pump_signal = "pump" if pump_score >= 0.6 else "stable"
    return PumpResponse(pump_score=pump_score, pump_signal=pump_signal)
