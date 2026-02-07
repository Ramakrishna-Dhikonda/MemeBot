import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { z } from "zod";
import { type TradeSignal } from "@sqts/shared-types";

const backtestConfigSchema = z.object({
  startingCapitalUsd: z.number().positive().default(100000),
  maxTradePct: z.number().min(0).max(1).default(0.05),
  feeBps: z.number().min(0).max(100).default(10),
  baseSlippageBps: z.number().min(0).max(500).default(25),
  liquidityImpactBps: z.number().min(0).max(500).default(50)
});

export type BacktestConfig = z.infer<typeof backtestConfigSchema>;

const serviceConfigSchema = z.object({
  servicePort: z.number().int().positive().default(4010),
  priceDataPath: z.string().min(1),
  liquidityDataPath: z.string().min(1)
});

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

const priceTickSchema = z.object({
  timestamp: z.string(),
  price: z.number().positive(),
  volume: z.number().nonnegative()
});

const liquidityTickSchema = z.object({
  timestamp: z.string(),
  liquidityUsd: z.number().nonnegative()
});

export interface PriceTick extends z.infer<typeof priceTickSchema> {}
export interface LiquidityTick extends z.infer<typeof liquidityTickSchema> {}

export interface BacktestTick {
  timestamp: string;
  price: number;
  volume: number;
  liquidityUsd: number;
}

export interface Trade {
  id: string;
  side: "buy" | "sell";
  timestamp: string;
  price: number;
  sizeUsd: number;
  quantity: number;
  feeUsd: number;
  slippageBps: number;
}

export interface PnlReport {
  totalPnlUsd: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
  avgTradePnlUsd: number;
  profitFactor: number;
}

export interface BacktestResult {
  report: PnlReport;
  equityCurve: Array<{ timestamp: string; equityUsd: number }>;
  trades: Trade[];
}

export interface StrategyContext {
  positionSize: number;
  cashUsd: number;
  lastPrice: number;
  lastLiquidityUsd: number;
}

export type Strategy = (tick: BacktestTick, context: StrategyContext) => TradeSignal | null;

export class HistoricalDataReader {
  async load(pricePath: string, liquidityPath: string): Promise<{
    prices: PriceTick[];
    liquidity: LiquidityTick[];
  }> {
    const [pricePayload, liquidityPayload] = await Promise.all([
      fs.readFile(pricePath, "utf8"),
      fs.readFile(liquidityPath, "utf8")
    ]);

    const priceJson = JSON.parse(pricePayload) as unknown;
    const liquidityJson = JSON.parse(liquidityPayload) as unknown;

    const prices = z.array(priceTickSchema).parse(priceJson);
    const liquidity = z.array(liquidityTickSchema).parse(liquidityJson);

    return { prices, liquidity };
  }
}

export class TickReplayer {
  private readonly logger = pino({ name: "tick-replayer" });

  buildTimeline(prices: PriceTick[], liquidity: LiquidityTick[]): BacktestTick[] {
    const timeline = new Map<number, Partial<BacktestTick>>();

    for (const tick of prices) {
      const timestamp = Date.parse(tick.timestamp);
      timeline.set(timestamp, {
        timestamp: tick.timestamp,
        price: tick.price,
        volume: tick.volume
      });
    }

    for (const tick of liquidity) {
      const timestamp = Date.parse(tick.timestamp);
      const existing = timeline.get(timestamp) ?? { timestamp: tick.timestamp };
      timeline.set(timestamp, { ...existing, liquidityUsd: tick.liquidityUsd });
    }

    const merged = Array.from(timeline.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, tick]) => tick);

    const replay: BacktestTick[] = [];
    let lastPrice: number | undefined;
    let lastVolume = 0;
    let lastLiquidity: number | undefined;

    for (const tick of merged) {
      if (tick.price !== undefined) {
        lastPrice = tick.price;
        lastVolume = tick.volume ?? lastVolume;
      }
      if (tick.liquidityUsd !== undefined) {
        lastLiquidity = tick.liquidityUsd;
      }
      if (lastPrice === undefined || lastLiquidity === undefined) {
        continue;
      }
      replay.push({
        timestamp: tick.timestamp ?? new Date().toISOString(),
        price: lastPrice,
        volume: lastVolume,
        liquidityUsd: lastLiquidity
      });
    }

    this.logger.info({ ticks: replay.length }, "timeline built");
    return replay;
  }
}

export class BacktestingEngine {
  private readonly config: BacktestConfig;
  private readonly logger = pino({ name: "backtesting-engine" });

  constructor(config: BacktestConfig) {
    this.config = backtestConfigSchema.parse(config);
  }

  run(ticks: BacktestTick[], strategy: Strategy): BacktestResult {
    let cashUsd = this.config.startingCapitalUsd;
    let positionSize = 0;
    const trades: Trade[] = [];
    const equityCurve: Array<{ timestamp: string; equityUsd: number }> = [];
    const returns: number[] = [];
    let previousEquity = this.config.startingCapitalUsd;
    let lastPrice = ticks[0]?.price ?? 0;
    let lastLiquidityUsd = ticks[0]?.liquidityUsd ?? 0;

    for (const tick of ticks) {
      lastPrice = tick.price;
      lastLiquidityUsd = tick.liquidityUsd;
      const context: StrategyContext = {
        positionSize,
        cashUsd,
        lastPrice,
        lastLiquidityUsd
      };
      const signal = strategy(tick, context);
      if (signal) {
        const maxTradeUsd = this.config.startingCapitalUsd * this.config.maxTradePct;
        const slippageBps = this.calculateSlippage(
          maxTradeUsd,
          lastLiquidityUsd,
          signal.expectedSlippageBps
        );
        if (signal.side === "buy" && cashUsd > 0) {
          const sizeUsd = Math.min(maxTradeUsd, cashUsd);
          const executionPrice = tick.price * (1 + slippageBps / 10000);
          const feeUsd = sizeUsd * (this.config.feeBps / 10000);
          const netUsd = sizeUsd - feeUsd;
          const quantity = netUsd / executionPrice;
          positionSize += quantity;
          cashUsd -= sizeUsd;
          trades.push({
            id: crypto.randomUUID(),
            side: "buy",
            timestamp: tick.timestamp,
            price: executionPrice,
            sizeUsd,
            quantity,
            feeUsd,
            slippageBps
          });
        }

        if (signal.side === "sell" && positionSize > 0) {
          const sizeUsd = Math.min(maxTradeUsd, positionSize * tick.price);
          const executionPrice = tick.price * (1 - slippageBps / 10000);
          const quantity = sizeUsd / tick.price;
          const feeUsd = sizeUsd * (this.config.feeBps / 10000);
          cashUsd += sizeUsd - feeUsd;
          positionSize -= quantity;
          trades.push({
            id: crypto.randomUUID(),
            side: "sell",
            timestamp: tick.timestamp,
            price: executionPrice,
            sizeUsd,
            quantity,
            feeUsd,
            slippageBps
          });
        }
      }

      const equityUsd = cashUsd + positionSize * tick.price;
      equityCurve.push({ timestamp: tick.timestamp, equityUsd });
      const periodReturn = (equityUsd - previousEquity) / previousEquity;
      returns.push(periodReturn);
      previousEquity = equityUsd;
    }

    const report = this.generateReport(trades, equityCurve, returns, previousEquity);

    this.logger.info({ totalPnlUsd: report.totalPnlUsd }, "backtest complete");

    return { report, equityCurve, trades };
  }

  private calculateSlippage(
    orderUsd: number,
    liquidityUsd: number,
    expectedSlippageBps = 0
  ): number {
    if (liquidityUsd <= 0) {
      return this.config.baseSlippageBps + expectedSlippageBps;
    }
    const impactBps = (orderUsd / liquidityUsd) * this.config.liquidityImpactBps;
    return this.config.baseSlippageBps + expectedSlippageBps + impactBps;
  }

  private generateReport(
    trades: Trade[],
    equityCurve: Array<{ equityUsd: number }>,
    returns: number[],
    endingEquity: number
  ): PnlReport {
    const totalPnlUsd = endingEquity - this.config.startingCapitalUsd;
    const totalReturnPct = totalPnlUsd / this.config.startingCapitalUsd;
    const maxDrawdownPct = this.calculateMaxDrawdown(equityCurve);
    const sharpeRatio = this.calculateSharpe(returns);
    const { winRate, avgTradePnlUsd, profitFactor } = this.calculateTradeStats(trades);

    return {
      totalPnlUsd,
      totalReturnPct,
      maxDrawdownPct,
      sharpeRatio,
      winRate,
      avgTradePnlUsd,
      profitFactor
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

  private calculateTradeStats(trades: Trade[]): {
    winRate: number;
    avgTradePnlUsd: number;
    profitFactor: number;
  } {
    let wins = 0;
    let total = 0;
    let openTrade: Trade | undefined;
    let totalPnlUsd = 0;
    let grossProfit = 0;
    let grossLoss = 0;

    for (const trade of trades) {
      if (trade.side === "buy") {
        openTrade = trade;
        continue;
      }

      if (trade.side === "sell" && openTrade) {
        total += 1;
        const pnl = (trade.price - openTrade.price) * trade.quantity;
        totalPnlUsd += pnl;
        if (pnl > 0) {
          wins += 1;
          grossProfit += pnl;
        } else {
          grossLoss += Math.abs(pnl);
        }
        openTrade = undefined;
      }
    }

    const winRate = total === 0 ? 0 : wins / total;
    const avgTradePnlUsd = total === 0 ? 0 : totalPnlUsd / total;
    const profitFactor = grossLoss === 0 ? grossProfit : grossProfit / grossLoss;

    return { winRate, avgTradePnlUsd, profitFactor };
  }
}

class HealthServer {
  private server?: http.Server;
  private readonly startedAt = new Date();

  constructor(private readonly port: number, private readonly logger: pino.Logger) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.server = http.createServer((req, res) => {
      if (!req.url || req.url === "/" || req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            startedAt: this.startedAt.toISOString()
          })
        );
        return;
      }

      if (req.url === "/run" && req.method === "POST") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "accepted" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(this.port, resolve);
    });
    this.logger.info({ port: this.port }, "health server listening");
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
  }
}

export class BacktestingService {
  private readonly logger = pino({ name: "backtesting-service" });
  private readonly engine: BacktestingEngine;
  private readonly replayer = new TickReplayer();
  private readonly reader = new HistoricalDataReader();
  private readonly healthServer: HealthServer;

  constructor(
    private readonly config: BacktestConfig,
    private readonly serviceConfig: ServiceConfig
  ) {
    this.engine = new BacktestingEngine(config);
    this.healthServer = new HealthServer(serviceConfig.servicePort, this.logger);
  }

  async start(strategy: Strategy): Promise<BacktestResult> {
    const data = await this.reader.load(
      this.serviceConfig.priceDataPath,
      this.serviceConfig.liquidityDataPath
    );
    const ticks = this.replayer.buildTimeline(data.prices, data.liquidity);
    const result = this.engine.run(ticks, strategy);
    await this.healthServer.start();
    this.logger.info({ totalPnlUsd: result.report.totalPnlUsd }, "backtest finished");
    return result;
  }

  async stop(): Promise<void> {
    await this.healthServer.stop();
  }
}

const isMain = (): boolean => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return fileURLToPath(import.meta.url) === entry;
};

if (isMain()) {
  const logger = pino({ name: "backtesting-engine" });
  try {
    const priceDataPath = process.env.PRICE_DATA_PATH ?? "";
    const liquidityDataPath = process.env.LIQUIDITY_DATA_PATH ?? "";
    const servicePort = process.env.SERVICE_PORT
      ? Number(process.env.SERVICE_PORT)
      : 4010;
    const serviceConfig = serviceConfigSchema.parse({
      servicePort,
      priceDataPath,
      liquidityDataPath
    });

    const config = backtestConfigSchema.parse({
      startingCapitalUsd: process.env.STARTING_CAPITAL_USD
        ? Number(process.env.STARTING_CAPITAL_USD)
        : undefined,
      maxTradePct: process.env.MAX_TRADE_PCT ? Number(process.env.MAX_TRADE_PCT) : undefined,
      feeBps: process.env.FEE_BPS ? Number(process.env.FEE_BPS) : undefined,
      baseSlippageBps: process.env.BASE_SLIPPAGE_BPS
        ? Number(process.env.BASE_SLIPPAGE_BPS)
        : undefined,
      liquidityImpactBps: process.env.LIQUIDITY_IMPACT_BPS
        ? Number(process.env.LIQUIDITY_IMPACT_BPS)
        : undefined
    });

    const service = new BacktestingService(config, serviceConfig);
    const strategy: Strategy = (tick, context) => {
      if (context.positionSize === 0 && tick.liquidityUsd > 100000) {
        return {
          id: crypto.randomUUID(),
          topic: "trade_signals",
          timestamp: tick.timestamp,
          strategy: "momentum_breakout",
          mintAddress: "backtest",
          side: "buy",
          confidence: 0.7,
          expectedSlippageBps: 50
        };
      }
      if (context.positionSize > 0 && tick.price > context.lastPrice * 1.02) {
        return {
          id: crypto.randomUUID(),
          topic: "trade_signals",
          timestamp: tick.timestamp,
          strategy: "momentum_breakout",
          mintAddress: "backtest",
          side: "sell",
          confidence: 0.7,
          expectedSlippageBps: 50
        };
      }
      return null;
    };

    await service.start(strategy);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    logger.error({ error: reason }, "failed to start backtesting service");
    process.exit(1);
  }
}
