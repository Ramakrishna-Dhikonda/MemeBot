from __future__ import annotations

from dataclasses import dataclass


@dataclass
class RugPullPredictorModel:
    """Simple heuristic model for rug pull risk estimation."""

    def predict(self, features: list[float]) -> float:
        liquidity, holder_count, age_days, volume_24h, top_holder_share = features
        risk = 0.0
        risk += 0.4 if liquidity < 50_000 else 0.1
        risk += 0.2 if holder_count < 250 else 0.05
        risk += 0.2 if age_days < 7 else 0.05
        risk += 0.1 if volume_24h < 25_000 else 0.05
        risk += 0.1 if top_holder_share > 0.4 else 0.05
        return min(max(risk, 0.0), 1.0)


@dataclass
class PumpDetectionModel:
    """Simple heuristic model for pump detection probability."""

    def predict(self, features: list[float]) -> float:
        price_change_24h, volume_spike, social_buzz = features
        probability = 0.0
        probability += 0.5 if price_change_24h > 0.3 else 0.1
        probability += 0.3 if volume_spike > 2.0 else 0.1
        probability += 0.2 if social_buzz > 0.6 else 0.05
        return min(max(probability, 0.0), 1.0)


def load_rug_pull_model() -> RugPullPredictorModel:
    return RugPullPredictorModel()


def load_pump_detection_model() -> PumpDetectionModel:
    return PumpDetectionModel()
