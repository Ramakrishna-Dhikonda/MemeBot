import { describe, expect, it } from "vitest";
import {
  BacktestingEngine,
  PriceSimulator,
  type PriceBar,
  type BacktestConfig
} from "../src/index.js";
import type { TradeSignal } from "@sqts/shared-types";

const baseConfig: BacktestConfig = {
  startingCapitalUsd: 1000,
  maxTradePct: 0.1,
  feeBps: 10
};

const buySignal: TradeSignal = {
  id: "signal",
  topic: "trade_signals",
  timestamp: "2024-01-01T00:00:00.000Z",
  strategy: "sniper",
  mintAddress: "Mint1",
  side: "buy",
  confidence: 0.9,
  expectedSlippageBps: 50
};

const sellSignal: TradeSignal = { ...buySignal, side: "sell" };

describe("PriceSimulator", () => {
  it("generates deterministic price series", () => {
    const simulator = new PriceSimulator();
    const series = simulator.generateSeries({
      seed: "seed",
      startPrice: 1,
      steps: 5,
      volatility: 0.1,
      drift: 0.01,
      intervalMs: 60000
    });

    expect(series).toHaveLength(5);
    expect(series[0].close).toBeGreaterThan(0);
  });
});

describe("BacktestingEngine", () => {
  it("calculates pnl for buy and sell", () => {
    const bars: PriceBar[] = [
      { timestamp: "t1", open: 1, high: 1.1, low: 1, close: 1, volume: 100 },
      { timestamp: "t2", open: 1.2, high: 1.3, low: 1.2, close: 1.2, volume: 120 }
    ];

    const engine = new BacktestingEngine({ ...baseConfig, feeBps: 0 });
    const result = engine.run(bars, (bar, context) => {
      if (bar.timestamp === "t1" && context.positionSize === 0) {
        return buySignal;
      }
      if (bar.timestamp === "t2" && context.positionSize > 0) {
        return sellSignal;
      }
      return null;
    });

    expect(result.totalPnlUsd).toBeGreaterThan(0);
    expect(result.trades).toHaveLength(2);
  });

  it("enforces max trade percentage", () => {
    const bars: PriceBar[] = [
      { timestamp: "t1", open: 1, high: 1, low: 1, close: 1, volume: 100 }
    ];

    const engine = new BacktestingEngine(baseConfig);
    const result = engine.run(bars, () => buySignal);
    expect(result.trades[0].sizeUsd).toBeCloseTo(100);
  });

  it("accounts for fees in pnl", () => {
    const bars: PriceBar[] = [
      { timestamp: "t1", open: 1, high: 1, low: 1, close: 1, volume: 100 },
      { timestamp: "t2", open: 1, high: 1, low: 1, close: 1, volume: 100 }
    ];

    const engine = new BacktestingEngine(baseConfig);
    const result = engine.run(bars, (bar, context) => {
      if (bar.timestamp === "t1" && context.positionSize === 0) {
        return buySignal;
      }
      if (bar.timestamp === "t2" && context.positionSize > 0) {
        return sellSignal;
      }
      return null;
    });

    expect(result.totalPnlUsd).toBeLessThan(0);
  });

  it("computes drawdown", () => {
    const bars: PriceBar[] = [
      { timestamp: "t1", open: 1, high: 1, low: 1, close: 1, volume: 100 },
      { timestamp: "t2", open: 0.8, high: 0.8, low: 0.8, close: 0.8, volume: 100 },
      { timestamp: "t3", open: 1, high: 1, low: 1, close: 1, volume: 100 }
    ];

    const engine = new BacktestingEngine({ ...baseConfig, feeBps: 0 });
    const result = engine.run(bars, () => null);

    expect(result.maxDrawdownPct).toBeGreaterThan(0);
  });
});
