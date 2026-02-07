import { describe, expect, it } from "vitest";
import {
  BacktestingEngine,
  TickReplayer,
  type BacktestConfig,
  type PriceTick,
  type LiquidityTick,
  type BacktestTick
} from "../src/index.js";
import type { TradeSignal } from "@sqts/shared-types";

const baseConfig: BacktestConfig = {
  startingCapitalUsd: 1000,
  maxTradePct: 0.1,
  feeBps: 10,
  baseSlippageBps: 0,
  liquidityImpactBps: 0
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

describe("TickReplayer", () => {
  it("replays merged price and liquidity ticks", () => {
    const prices: PriceTick[] = [
      { timestamp: "2024-01-01T00:00:00.000Z", price: 1, volume: 100 },
      { timestamp: "2024-01-01T00:01:00.000Z", price: 1.1, volume: 120 }
    ];
    const liquidity: LiquidityTick[] = [
      { timestamp: "2024-01-01T00:00:00.000Z", liquidityUsd: 50000 },
      { timestamp: "2024-01-01T00:01:00.000Z", liquidityUsd: 55000 }
    ];

    const replayer = new TickReplayer();
    const ticks = replayer.buildTimeline(prices, liquidity);

    expect(ticks).toHaveLength(2);
    expect(ticks[1].price).toBe(1.1);
    expect(ticks[1].liquidityUsd).toBe(55000);
  });
});

describe("BacktestingEngine", () => {
  it("calculates pnl for buy and sell with slippage", () => {
    const ticks: BacktestTick[] = [
      {
        timestamp: "t1",
        price: 1,
        volume: 100,
        liquidityUsd: 100000
      },
      {
        timestamp: "t2",
        price: 1.2,
        volume: 120,
        liquidityUsd: 100000
      }
    ];

    const engine = new BacktestingEngine({ ...baseConfig, feeBps: 0, baseSlippageBps: 0 });
    const result = engine.run(ticks, (tick, context) => {
      if (tick.timestamp === "t1" && context.positionSize === 0) {
        return buySignal;
      }
      if (tick.timestamp === "t2" && context.positionSize > 0) {
        return sellSignal;
      }
      return null;
    });

    expect(result.report.totalPnlUsd).toBeGreaterThan(0);
    expect(result.trades).toHaveLength(2);
    expect(result.report.profitFactor).toBeGreaterThan(0);
  });

  it("enforces max trade percentage", () => {
    const ticks: BacktestTick[] = [
      {
        timestamp: "t1",
        price: 1,
        volume: 100,
        liquidityUsd: 100000
      }
    ];

    const engine = new BacktestingEngine(baseConfig);
    const result = engine.run(ticks, () => buySignal);
    expect(result.trades[0].sizeUsd).toBeCloseTo(100);
  });

  it("accounts for fees in pnl", () => {
    const ticks: BacktestTick[] = [
      {
        timestamp: "t1",
        price: 1,
        volume: 100,
        liquidityUsd: 100000
      },
      {
        timestamp: "t2",
        price: 1,
        volume: 100,
        liquidityUsd: 100000
      }
    ];

    const engine = new BacktestingEngine(baseConfig);
    const result = engine.run(ticks, (tick, context) => {
      if (tick.timestamp === "t1" && context.positionSize === 0) {
        return buySignal;
      }
      if (tick.timestamp === "t2" && context.positionSize > 0) {
        return sellSignal;
      }
      return null;
    });

    expect(result.report.totalPnlUsd).toBeLessThan(0);
  });

  it("computes performance metrics", () => {
    const ticks: BacktestTick[] = [
      {
        timestamp: "t1",
        price: 1,
        volume: 100,
        liquidityUsd: 100000
      },
      {
        timestamp: "t2",
        price: 0.8,
        volume: 100,
        liquidityUsd: 100000
      },
      {
        timestamp: "t3",
        price: 1,
        volume: 100,
        liquidityUsd: 100000
      }
    ];

    const engine = new BacktestingEngine({ ...baseConfig, feeBps: 0 });
    const result = engine.run(ticks, (tick, context) => {
      if (tick.timestamp === "t1" && context.positionSize === 0) {
        return buySignal;
      }
      return null;
    });

    expect(result.report.maxDrawdownPct).toBeGreaterThan(0);
    expect(result.report.sharpeRatio).toBeTypeOf("number");
  });
});
