import crypto from "node:crypto";
import pino from "pino";
import { type TradeSignal } from "@sqts/shared-types";
import { z } from "zod";

const backtestConfigSchema = z.object({
  startingCapitalUsd: z.number().positive().default(100000),
  maxTradePct: z.number().min(0).max(1).default(0.05),
  feeBps: z.number().min(0).max(100).default(10)
});

export type BacktestConfig = z.infer<typeof backtestConfigSchema>;

export interface PriceBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Trade {
  id: string;
  side: "buy" | "sell";
  timestamp: string;
  price: number;
  sizeUsd: number;
  quantity: number;
}

export interface BacktestResult {
  totalPnlUsd: number;
  totalReturnPct: number;
  equityCurve: Array<{ timestamp: string; equityUsd: number }>;
  trades: Trade[];
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
}

export interface StrategyContext {
  positionSize: number;
  cashUsd: number;
  lastSignal?: TradeSignal;
}

export type Strategy = (bar: PriceBar, context: StrategyContext) => TradeSignal | null;

class SeededRng {
  private state: number;
  constructor(seed: string) {
    const hash = crypto.createHash("sha256").update(seed).digest();
    this.state = hash.readUInt32LE(0);
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0xffffffff;
  }

  nextNormal(): number {
    const u1 = Math.max(this.next(), 1e-10);
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

export class PriceSimulator {
  private readonly logger = pino({ name: "price-simulator" });

  generateSeries(params: {
    seed: string;
    startPrice: number;
    steps: number;
    volatility: number;
    drift: number;
    intervalMs: number;
  }): PriceBar[] {
    const { seed, startPrice, steps, volatility, drift, intervalMs } = params;
    const rng = new SeededRng(seed);
    const bars: PriceBar[] = [];
    let price = startPrice;
    let timestamp = Date.now();

    for (let i = 0; i < steps; i += 1) {
      const normal = rng.nextNormal();
      const returnPct = (drift - 0.5 * volatility ** 2) + volatility * normal;
      const close = Math.max(0.01, price * Math.exp(returnPct));
      const high = Math.max(close, price) * (1 + rng.next() * 0.01);
      const low = Math.min(close, price) * (1 - rng.next() * 0.01);
      const volume = Math.max(1, rng.next() * 1000);

      bars.push({
        timestamp: new Date(timestamp).toISOString(),
        open: price,
        high,
        low,
        close,
        volume
      });

      price = close;
      timestamp += intervalMs;
    }

    this.logger.info({ steps }, "price series generated");
    return bars;
  }
}

export class BacktestingEngine {
  private readonly config: BacktestConfig;
  private readonly logger = pino({ name: "backtesting-engine" });

  constructor(config: BacktestConfig) {
    this.config = backtestConfigSchema.parse(config);
  }

  run(bars: PriceBar[], strategy: Strategy): BacktestResult {
    let cashUsd = this.config.startingCapitalUsd;
    let positionSize = 0;
    let positionCost = 0;
    const trades: Trade[] = [];
    const equityCurve: Array<{ timestamp: string; equityUsd: number }> = [];
    const returns: number[] = [];
    let previousEquity = this.config.startingCapitalUsd;

    for (const bar of bars) {
      const context: StrategyContext = { positionSize, cashUsd };
      const signal = strategy(bar, context);
      if (signal) {
        const maxTradeUsd = this.config.startingCapitalUsd * this.config.maxTradePct;
        if (signal.side === "buy" && cashUsd > 0) {
          const sizeUsd = Math.min(maxTradeUsd, cashUsd);
          const fee = sizeUsd * (this.config.feeBps / 10000);
          const netUsd = sizeUsd - fee;
          const quantity = netUsd / bar.close;
          positionSize += quantity;
          cashUsd -= sizeUsd;
          positionCost += netUsd;
          trades.push({
            id: crypto.randomUUID(),
            side: "buy",
            timestamp: bar.timestamp,
            price: bar.close,
            sizeUsd,
            quantity
          });
        }

        if (signal.side === "sell" && positionSize > 0) {
          const sizeUsd = Math.min(maxTradeUsd, positionSize * bar.close);
          const quantity = sizeUsd / bar.close;
          const fee = sizeUsd * (this.config.feeBps / 10000);
          cashUsd += sizeUsd - fee;
          positionSize -= quantity;
          positionCost = Math.max(0, positionCost - sizeUsd);
          trades.push({
            id: crypto.randomUUID(),
            side: "sell",
            timestamp: bar.timestamp,
            price: bar.close,
            sizeUsd,
            quantity
          });
        }
      }

      const equityUsd = cashUsd + positionSize * bar.close;
      equityCurve.push({ timestamp: bar.timestamp, equityUsd });
      const periodReturn = (equityUsd - previousEquity) / previousEquity;
      returns.push(periodReturn);
      previousEquity = equityUsd;
    }

    const totalPnlUsd = previousEquity - this.config.startingCapitalUsd;
    const totalReturnPct = totalPnlUsd / this.config.startingCapitalUsd;
    const maxDrawdownPct = this.calculateMaxDrawdown(equityCurve);
    const sharpeRatio = this.calculateSharpe(returns);
    const winRate = this.calculateWinRate(trades);

    this.logger.info({ totalPnlUsd, totalReturnPct }, "backtest complete");

    return {
      totalPnlUsd,
      totalReturnPct,
      equityCurve,
      trades,
      maxDrawdownPct,
      sharpeRatio,
      winRate
    };
  }

  private calculateMaxDrawdown(equityCurve: Array<{ equityUsd: number }>): number {
    let peak = equityCurve[0]?.equityUsd ?? this.config.startingCapitalUsd;
    let maxDrawdown = 0;

    for (const point of equityCurve) {
      if (point.equityUsd > peak) {
        peak = point.equityUsd;
      }
      const drawdown = (peak - point.equityUsd) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown;
  }

  private calculateSharpe(returns: number[]): number {
    if (returns.length === 0) {
      return 0;
    }
    const avg = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance =
      returns.reduce((sum, value) => sum + (value - avg) ** 2, 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) {
      return 0;
    }
    return avg / stdDev;
  }

  private calculateWinRate(trades: Trade[]): number {
    let wins = 0;
    let total = 0;
    let openTrade: Trade | undefined;

    for (const trade of trades) {
      if (trade.side === "buy") {
        openTrade = trade;
        continue;
      }

      if (trade.side === "sell" && openTrade) {
        total += 1;
        if (trade.price > openTrade.price) {
          wins += 1;
        }
        openTrade = undefined;
      }
    }

    if (total === 0) {
      return 0;
    }

    return wins / total;
  }
}
