import {
  MomentumStrategy,
  SniperStrategy,
  StrategyService,
  type StrategyConfig
} from "../src/index.js";
import type { IngestionEvent, TradeSignal } from "@sqts/shared-types";

const baseConfig: StrategyConfig = {
  mode: "combined",
  sniper: {
    minLiquidityUsd: 60000,
    minLiquidityGrowthUsd: 40000,
    targetLiquidityUsd: 200000,
    devWalletMaxUsd: 50000
  },
  momentum: {
    minLiquidityUsd: 50000,
    minLiquidityIncreaseUsd: 30000,
    volumeSpikeUsd: 80000
  },
  expectedSlippageBps: 100,
  minConfidence: 0.5,
  maxTokenAgeMs: 10 * 60 * 1000,
  cooldownMs: 60 * 1000,
  redis: { url: "redis://localhost:6379", publishTimeoutMs: 100 },
  service: { port: 4002 },
  timestampProvider: () => "2024-01-01T00:00:00.000Z"
};

class MockBus {
  public published: TradeSignal[] = [];
  async publish(_channel: string, payload: TradeSignal): Promise<void> {
    this.published.push(payload);
  }
  async subscribe(): Promise<void> {
    return;
  }
  async disconnect(): Promise<void> {
    return;
  }
}

class MockHealthServer {
  async start(): Promise<void> {
    return;
  }
  async stop(): Promise<void> {
    return;
  }
}

describe("SniperStrategy", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("signals when liquidity growth is strong and dev wallet is under threshold", () => {
    const strategy = new SniperStrategy(baseConfig);
    strategy.evaluate({
      id: "1",
      topic: "new_token_events",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint1",
      creator: "DevWallet"
    });

    strategy.evaluate({
      id: "2",
      topic: "liquidity_events",
      timestamp: "2024-01-01T00:00:05.000Z",
      mintAddress: "Mint1",
      poolAddress: "Pool",
      liquidityUsd: 70000
    });

    const signal = strategy.evaluate({
      id: "3",
      topic: "liquidity_events",
      timestamp: "2024-01-01T00:00:10.000Z",
      mintAddress: "Mint1",
      poolAddress: "Pool",
      liquidityUsd: 120000
    });

    expect(signal).not.toBeNull();
    expect(signal?.strategy).toBe("sniper");
    expect(signal?.confidence).toBeGreaterThan(0);
  });

  it("does not signal when dev wallet activity exceeds threshold", () => {
    const strategy = new SniperStrategy(baseConfig);
    strategy.evaluate({
      id: "1",
      topic: "new_token_events",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint2",
      creator: "DevWallet"
    });

    strategy.evaluate({
      id: "2",
      topic: "liquidity_events",
      timestamp: "2024-01-01T00:00:05.000Z",
      mintAddress: "Mint2",
      poolAddress: "Pool",
      liquidityUsd: 120000
    });

    const signal = strategy.evaluate({
      id: "3",
      topic: "whale_events",
      timestamp: "2024-01-01T00:00:10.000Z",
      walletAddress: "DevWallet",
      mintAddress: "Mint2",
      amountUsd: 90000
    });

    expect(signal).toBeNull();
  });

  it("does not signal when liquidity growth is below threshold", () => {
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
      timestamp: "2024-01-01T00:00:05.000Z",
      mintAddress: "Mint3",
      poolAddress: "Pool",
      liquidityUsd: 61000
    });

    const signal = strategy.evaluate({
      id: "3",
      topic: "liquidity_events",
      timestamp: "2024-01-01T00:00:10.000Z",
      mintAddress: "Mint3",
      poolAddress: "Pool",
      liquidityUsd: 80000
    });

    expect(signal).toBeNull();
  });
});

describe("MomentumStrategy", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("signals on liquidity increase momentum", () => {
    const strategy = new MomentumStrategy(baseConfig);
    strategy.evaluate({
      id: "1",
      topic: "new_token_events",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint4",
      creator: "creator"
    });

    strategy.evaluate({
      id: "2",
      topic: "liquidity_events",
      timestamp: "2024-01-01T00:00:05.000Z",
      mintAddress: "Mint4",
      poolAddress: "Pool",
      liquidityUsd: 60000
    });

    const signal = strategy.evaluate({
      id: "3",
      topic: "liquidity_events",
      timestamp: "2024-01-01T00:00:10.000Z",
      mintAddress: "Mint4",
      poolAddress: "Pool",
      liquidityUsd: 100000
    });

    expect(signal).not.toBeNull();
    expect(signal?.strategy).toBe("momentum_breakout");
  });

  it("signals on volume spike", () => {
    const strategy = new MomentumStrategy(baseConfig);
    strategy.evaluate({
      id: "1",
      topic: "new_token_events",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint5",
      creator: "creator"
    });

    const signal = strategy.evaluate({
      id: "2",
      topic: "whale_events",
      timestamp: "2024-01-01T00:00:05.000Z",
      walletAddress: "Whale",
      mintAddress: "Mint5",
      amountUsd: 120000
    });

    expect(signal).not.toBeNull();
  });

  it("does not signal when momentum thresholds are unmet", () => {
    const strategy = new MomentumStrategy(baseConfig);
    strategy.evaluate({
      id: "1",
      topic: "new_token_events",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint6",
      creator: "creator"
    });

    const signal = strategy.evaluate({
      id: "2",
      topic: "liquidity_events",
      timestamp: "2024-01-01T00:00:05.000Z",
      mintAddress: "Mint6",
      poolAddress: "Pool",
      liquidityUsd: 51000
    });

    expect(signal).toBeNull();
  });
});

describe("StrategyService", () => {
  it("publishes trade signals from both strategies", async () => {
    const bus = new MockBus();
    const service = new StrategyService(baseConfig, { bus, healthServer: new MockHealthServer() });
    const events: IngestionEvent[] = [
      {
        id: "1",
        topic: "new_token_events",
        timestamp: "2024-01-01T00:00:00.000Z",
        mintAddress: "Mint7",
        creator: "creator"
      },
      {
        id: "2",
        topic: "liquidity_events",
        timestamp: "2024-01-01T00:00:05.000Z",
        mintAddress: "Mint7",
        poolAddress: "Pool",
        liquidityUsd: 70000
      },
      {
        id: "3",
        topic: "liquidity_events",
        timestamp: "2024-01-01T00:00:10.000Z",
        mintAddress: "Mint7",
        poolAddress: "Pool",
        liquidityUsd: 120000
      },
      {
        id: "4",
        topic: "whale_events",
        timestamp: "2024-01-01T00:00:15.000Z",
        walletAddress: "Whale",
        mintAddress: "Mint7",
        amountUsd: 120000
      }
    ];

    for (const event of events) {
      await service.handleMessage(JSON.stringify(event));
    }

    expect(bus.published.length).toBeGreaterThanOrEqual(2);
    expect(bus.published[0]?.topic).toBe("trade_signals");
  });
});
