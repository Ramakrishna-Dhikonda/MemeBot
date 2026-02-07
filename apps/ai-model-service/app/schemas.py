from __future__ import annotations

from pydantic import BaseModel, Field


class RugPullRequest(BaseModel):
    liquidity_usd: float = Field(..., gt=0)
    holder_count: int = Field(..., ge=0)
    age_days: float = Field(..., ge=0)
    volume_24h_usd: float = Field(..., ge=0)
    top_holder_share: float = Field(..., ge=0, le=1)


class RugPullResponse(BaseModel):
    risk_score: float
    risk_level: str


class PumpRequest(BaseModel):
    price_change_24h: float
    volume_spike: float = Field(..., ge=0)
    social_buzz: float = Field(..., ge=0, le=1)


class PumpResponse(BaseModel):
    pump_score: float
    pump_signal: str
