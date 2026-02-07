import { describe, expect, it, vi } from "vitest";
import {
  SniperStrategy,
  StrategyService,
  type StrategyConfig
} from "../src/index.js";
import type { IngestionEvent, TradeSignal } from "@sqts/shared-types";

const baseConfig: StrategyConfig = {
  strategy: "sniper",
  minLiquidityUsd: 60000,
  targetLiquidityUsd: 200000,
  minWhaleAmountUsd: 50000,
  targetWhaleAmountUsd: 150000,
  expectedSlippageBps: 100,
  minConfidence: 0.65,
  maxTokenAgeMs: 10 * 60 * 1000,
  cooldownMs: 60 * 1000,
  redis: { url: "redis://localhost:6379", publishTimeoutMs: 100 },
  timestampProvider: () => "2024-01-01T00:00:00.000Z"
};

class MockBus {
  public published: TradeSignal[] = [];
  async publish(_channel: string, payload: TradeSignal, _timeoutMs?: number): Promise<void> {
    this.published.push(payload);
  }
  async subscribe(): Promise<void> {
    return;
  }
  async disconnect(): Promise<void> {
    return;
  }
}

describe("SniperStrategy", () => {
  it("returns null for new token events", () => {
    const strategy = new SniperStrategy(baseConfig);
    const signal = strategy.evaluate({
      id: "1",
      topic: "new_token_events",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint1",
      creator: "creator"
    });

    expect(signal).toBeNull();
  });

  it("creates signal when liquidity and whale thresholds met", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const strategy = new SniperStrategy(baseConfig);
    strategy.evaluate({
      id: "1",
      topic: "new_token_events",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint1",
      creator: "creator"
    });

    strategy.evaluate({
      id: "2",
      topic: "liquidity_events",
      timestamp: "2024-01-01T00:00:10.000Z",
      mintAddress: "Mint1",
      poolAddress: "Pool",
      liquidityUsd: 150000
    });

    const signal = strategy.evaluate({
      id: "3",
      topic: "whale_events",
      timestamp: "2024-01-01T00:00:20.000Z",
      walletAddress: "Whale",
      mintAddress: "Mint1",
      amountUsd: 90000
    });

    expect(signal).not.toBeNull();
    expect(signal?.topic).toBe("trade_signals");
    vi.useRealTimers();
  });

  it("does not signal when liquidity is below threshold", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const strategy = new SniperStrategy(baseConfig);
    strategy.evaluate({
      id: "1",
      topic: "new_token_events",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint2",
      creator: "creator"
    });

    const signal = strategy.evaluate({
      id: "2",
      topic: "liquidity_events",
      timestamp: "2024-01-01T00:00:10.000Z",
      mintAddress: "Mint2",
      poolAddress: "Pool",
      liquidityUsd: 10000
    });

    expect(signal).toBeNull();
    vi.useRealTimers();
  });

  it("respects cooldown between signals", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const strategy = new SniperStrategy(baseConfig);
    strategy.evaluate({
      id: "1",
      topic: "new_token_events",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint3",
      creator: "creator"
    });

    strategy.evaluate({
      id: "2",
      topic: "liquidity_events",
      timestamp: "2024-01-01T00:00:10.000Z",
      mintAddress: "Mint3",
      poolAddress: "Pool",
      liquidityUsd: 200000
    });

    const first = strategy.evaluate({
      id: "3",
      topic: "whale_events",
      timestamp: "2024-01-01T00:00:20.000Z",
      walletAddress: "Whale",
      mintAddress: "Mint3",
      amountUsd: 90000
    });
    const second = strategy.evaluate({
      id: "4",
      topic: "whale_events",
      timestamp: "2024-01-01T00:00:25.000Z",
      walletAddress: "Whale",
      mintAddress: "Mint3",
      amountUsd: 90000
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    vi.useRealTimers();
  });
});

describe("StrategyService", () => {
  it("publishes trade signals", async () => {
    const bus = new MockBus();
    const service = new StrategyService(baseConfig, { bus });
    const event: IngestionEvent = {
      id: "1",
      topic: "liquidity_events",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint4",
      poolAddress: "Pool",
      liquidityUsd: 200000
    };

    const newToken: IngestionEvent = {
      id: "2",
      topic: "new_token_events",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint4",
      creator: "creator"
    };

    const whale: IngestionEvent = {
      id: "3",
      topic: "whale_events",
      timestamp: "2024-01-01T00:00:10.000Z",
      walletAddress: "Whale",
      mintAddress: "Mint4",
      amountUsd: 100000
    };

    await service.handleMessage(JSON.stringify(newToken));
    await service.handleMessage(JSON.stringify(event));
    await service.handleMessage(JSON.stringify(whale));

    expect(bus.published).toHaveLength(1);
  });
});
