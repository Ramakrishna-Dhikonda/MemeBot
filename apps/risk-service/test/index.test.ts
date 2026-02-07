import { describe, expect, it } from "@jest/globals";
import { RiskService, type RiskConfig } from "../src/index.js";
import type {
  LiquidityEvent,
  PortfolioUpdate,
  TradeSignal,
  WhaleEvent
} from "@sqts/shared-types";

const baseConfig: RiskConfig = {
  totalCapitalUsd: 200000,
  maxTradePct: 0.05,
  minLiquidityUsd: 75000,
  dailyLossLimitUsd: 15000,
  maxHolderConcentrationPct: 0.2,
  redis: { url: "redis://localhost:6379", publishTimeoutMs: 100 },
  topics: { approved: "risk_approved_orders", deadLetter: "risk_dead_letter" },
  logLevel: "silent",
  port: 4003,
  timestampProvider: () => "2024-01-01T00:00:00.000Z"
};

class MockBus {
  public published: { channel: string; payload: unknown }[] = [];
  async publish(channel: string, payload: unknown): Promise<void> {
    this.published.push({ channel, payload });
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
  expectedSlippageBps: 120,
  sizeUsd: 5000
};

const liquidityEvent: LiquidityEvent = {
  id: "liq-1",
  topic: "liquidity_events",
  timestamp: "2024-01-01T00:00:00.000Z",
  mintAddress: "Mint1",
  poolAddress: "Pool",
  liquidityUsd: 100000
};

const whaleEvent: WhaleEvent = {
  id: "whale-1",
  topic: "whale_events",
  timestamp: "2024-01-01T00:00:00.000Z",
  walletAddress: "Wallet",
  mintAddress: "Mint1",
  amountUsd: 10000
};

describe("RiskService", () => {
  it("rejects signals that exceed max trade percent", async () => {
    const bus = new MockBus();
    const service = new RiskService(baseConfig, { bus: bus as never });

    await service.handleMessage(JSON.stringify(liquidityEvent));
    await service.handleMessage(JSON.stringify(whaleEvent));

    await service.handleMessage(
      JSON.stringify({ ...signal, sizeUsd: baseConfig.totalCapitalUsd * 0.1 })
    );

    expect(bus.published[0]?.channel).toBe("risk_dead_letter");
    expect((bus.published[0]?.payload as { reason?: string }).reason).toBe(
      "max_trade_pct_exceeded"
    );
  });

  it("rejects signals when daily loss limit is breached", async () => {
    const bus = new MockBus();
    const service = new RiskService(baseConfig, { bus: bus as never });

    const portfolioUpdate: PortfolioUpdate = {
      id: "port-1",
      topic: "portfolio_updates",
      timestamp: "2024-01-01T00:00:00.000Z",
      mintAddress: "Mint1",
      positionSize: 100,
      avgEntryPriceUsd: 1,
      realizedPnlUsd: -20000
    };

    await service.handleMessage(JSON.stringify(portfolioUpdate));
    await service.handleMessage(JSON.stringify(liquidityEvent));
    await service.handleMessage(JSON.stringify(whaleEvent));
    await service.handleMessage(JSON.stringify(signal));

    expect(bus.published[0]?.channel).toBe("risk_dead_letter");
    expect((bus.published[0]?.payload as { reason?: string }).reason).toBe(
      "daily_loss_limit_exceeded"
    );
  });

  it("rejects signals when holder concentration is too high", async () => {
    const bus = new MockBus();
    const service = new RiskService(baseConfig, { bus: bus as never });

    await service.handleMessage(JSON.stringify(liquidityEvent));
    await service.handleMessage(
      JSON.stringify({ ...whaleEvent, amountUsd: 50000, id: "whale-2" })
    );
    await service.handleMessage(JSON.stringify(signal));

    expect(bus.published[0]?.channel).toBe("risk_dead_letter");
    expect((bus.published[0]?.payload as { reason?: string }).reason).toBe(
      "holder_concentration_too_high"
    );
  });

  it("approves signals that pass all checks", async () => {
    const bus = new MockBus();
    const service = new RiskService(baseConfig, { bus: bus as never });

    await service.handleMessage(JSON.stringify(liquidityEvent));
    await service.handleMessage(JSON.stringify(whaleEvent));
    await service.handleMessage(JSON.stringify(signal));

    expect(bus.published[0]?.channel).toBe("risk_approved_orders");
    expect((bus.published[0]?.payload as { signalId?: string }).signalId).toBe("signal-1");
  });
});
