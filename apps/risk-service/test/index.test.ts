import { describe, expect, it } from "vitest";
import { RiskService, type RiskConfig } from "../src/index.js";
import type { LiquidityEvent, TradeSignal } from "@sqts/shared-types";

const baseConfig: RiskConfig = {
  totalCapitalUsd: 200000,
  maxTradePct: 0.05,
  minLiquidityUsd: 75000,
  minConfidence: 0.7,
  maxPositionUsd: 30000,
  maxTotalExposureUsd: 120000,
  maxSlippageBps: 150,
  redis: { url: "redis://localhost:6379", publishTimeoutMs: 100 },
  timestampProvider: () => "2024-01-01T00:00:00.000Z"
};

class MockBus {
  public published: unknown[] = [];
  async publish(_channel: string, payload: unknown, _timeoutMs?: number): Promise<void> {
    this.published.push(payload);
  }
  async subscribe(): Promise<void> {
    return;
  }
  async disconnect(): Promise<void> {
    return;
  }
}

const signal: TradeSignal = {
  id: "signal-1",
  topic: "trade_signals",
  timestamp: "2024-01-01T00:00:00.000Z",
  strategy: "sniper",
  mintAddress: "Mint1",
  side: "buy",
  confidence: 0.9,
  expectedSlippageBps: 120
};

describe("RiskService", () => {
  it("rejects low confidence signals", () => {
    const service = new RiskService(baseConfig, { bus: new MockBus() as never });
    (service as unknown as { liquidityByMint: Map<string, number> }).liquidityByMint.set(
      "Mint1",
      100000
    );
    const result = service.approveSignal({ ...signal, confidence: 0.5 });
    expect(result).toBeNull();
  });

  it("rejects signals with insufficient liquidity", () => {
    const service = new RiskService(baseConfig, { bus: new MockBus() as never });
    const result = service.approveSignal(signal);
    expect(result).toBeNull();
  });

  it("approves buy signals within limits", () => {
    const service = new RiskService(baseConfig, { bus: new MockBus() as never });
    (service as unknown as { liquidityByMint: Map<string, number> }).liquidityByMint.set(
      "Mint1",
      100000
    );
    const result = service.approveSignal(signal);
    expect(result).not.toBeNull();
    expect(result?.sizeUsd).toBeGreaterThan(0);
  });

  it("rejects sell signal when no position", () => {
    const service = new RiskService(baseConfig, { bus: new MockBus() as never });
    (service as unknown as { liquidityByMint: Map<string, number> }).liquidityByMint.set(
      "Mint1",
      100000
    );
    const result = service.approveSignal({ ...signal, side: "sell" });
    expect(result).toBeNull();
  });

  it("updates position on fills", () => {
    const service = new RiskService(baseConfig, { bus: new MockBus() as never });
    service.recordFill(
      {
        id: "order-1",
        topic: "risk_approved_orders",
        timestamp: "2024-01-01T00:00:00.000Z",
        signalId: "signal-1",
        mintAddress: "Mint1",
        side: "buy",
        sizeUsd: 5000,
        maxSlippageBps: 100
      },
      5000
    );

    const snapshot = service.snapshot();
    expect(snapshot.Mint1).toBe(5000);
  });

  it("handles liquidity events through message handler", async () => {
    const bus = new MockBus();
    const service = new RiskService(baseConfig, { bus: bus as never });
    const liquidity: LiquidityEvent = {
      id: "liq-1",
      topic: "liquidity_events",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint1",
      poolAddress: "Pool",
      liquidityUsd: 90000
    };
    await service.handleMessage(JSON.stringify(liquidity));
    expect(
      (service as unknown as { liquidityByMint: Map<string, number> }).liquidityByMint.get(
        "Mint1"
      )
    ).toBe(90000);
  });
});
