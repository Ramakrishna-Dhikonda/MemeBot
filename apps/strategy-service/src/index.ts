import crypto from "node:crypto";
import pino from "pino";
import {
  type IngestionEvent,
  type LiquidityEvent,
  type TradeSignal,
  type WhaleEvent
} from "@sqts/shared-types";
import { z } from "zod";

const strategyConfigSchema = z.object({
  strategy: z.enum(["sniper", "momentum_breakout"]).default("sniper"),
  minLiquidityUsd: z.number().positive().default(50000),
  minWhaleAmountUsd: z.number().positive().default(25000),
  expectedSlippageBps: z.number().int().positive().default(100),
  confidence: z.number().min(0).max(1).default(0.65),
  timestampProvider: z
    .function()
    .args()
    .returns(z.string())
    .default(() => new Date().toISOString())
});

export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

export class StrategyService {
  private readonly config: StrategyConfig;
  private readonly logger = pino({ name: "strategy-service" });

  constructor(config: StrategyConfig) {
    this.config = strategyConfigSchema.parse(config);
  }

  evaluate(event: IngestionEvent): TradeSignal | null {
    if (event.topic === "liquidity_events") {
      return this.evaluateLiquidity(event);
    }

    if (event.topic === "whale_events") {
      return this.evaluateWhale(event);
    }

    this.logger.debug({ topic: event.topic }, "no strategy signal for event");
    return null;
  }

  evaluateBatch(events: IngestionEvent[]): TradeSignal[] {
    const signals = events
      .map((event) => this.evaluate(event))
      .filter((signal): signal is TradeSignal => signal !== null);

    this.logger.info({ count: signals.length }, "strategy batch evaluation complete");
    return signals;
  }

  private evaluateLiquidity(event: LiquidityEvent): TradeSignal | null {
    if (event.liquidityUsd < this.config.minLiquidityUsd) {
      return null;
    }

    const signal: TradeSignal = {
      id: crypto.randomUUID(),
      topic: "trade_signals",
      timestamp: this.config.timestampProvider(),
      strategy: this.config.strategy,
      mintAddress: event.mintAddress,
      side: "buy",
      confidence: this.config.confidence,
      expectedSlippageBps: this.config.expectedSlippageBps
    };

    this.logger.info({ mintAddress: signal.mintAddress }, "liquidity signal created");
    return signal;
  }

  private evaluateWhale(event: WhaleEvent): TradeSignal | null {
    if (event.amountUsd < this.config.minWhaleAmountUsd) {
      return null;
    }

    const signal: TradeSignal = {
      id: crypto.randomUUID(),
      topic: "trade_signals",
      timestamp: this.config.timestampProvider(),
      strategy: this.config.strategy,
      mintAddress: event.mintAddress,
      side: "buy",
      confidence: Math.min(1, this.config.confidence + 0.1),
      expectedSlippageBps: this.config.expectedSlippageBps
    };

    this.logger.info({ mintAddress: signal.mintAddress }, "whale signal created");
    return signal;
  }
}
