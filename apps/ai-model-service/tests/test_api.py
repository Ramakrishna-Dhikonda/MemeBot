from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_predict_rug():
    payload = {
        "liquidity_usd": 20_000,
        "holder_count": 100,
        "age_days": 2,
        "volume_24h_usd": 5_000,
        "top_holder_share": 0.55,
    }
    response = client.post("/predict/rug", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert "risk_score" in body
    assert "risk_level" in body
    assert 0 <= body["risk_score"] <= 1


def test_predict_pump():
    payload = {
        "price_change_24h": 0.45,
        "volume_spike": 2.4,
        "social_buzz": 0.7,
    }
    response = client.post("/predict/pump", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert "pump_score" in body
    assert "pump_signal" in body
    assert 0 <= body["pump_score"] <= 1
