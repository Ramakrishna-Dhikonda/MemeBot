import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type RedisClientType } from "redis";
import pino from "pino";
import {
  type IngestionEvent,
  type LiquidityEvent,
  type NewTokenEvent,
  type TradeSignal,
  type WhaleEvent
} from "@sqts/shared-types";
import { z } from "zod";

const strategyConfigSchema = z.object({
  strategy: z.enum(["sniper", "momentum_breakout"]).default("sniper"),
  minLiquidityUsd: z.number().positive().default(60000),
  targetLiquidityUsd: z.number().positive().default(200000),
  minWhaleAmountUsd: z.number().positive().default(50000),
  targetWhaleAmountUsd: z.number().positive().default(150000),
  expectedSlippageBps: z.number().int().positive().default(100),
  minConfidence: z.number().min(0).max(1).default(0.65),
  maxTokenAgeMs: z.number().int().positive().default(10 * 60 * 1000),
  cooldownMs: z.number().int().positive().default(60 * 1000),
  redis: z.object({
    url: z.string().min(1),
    publishTimeoutMs: z.number().int().positive().default(2000)
  }),
  timestampProvider: z
    .function()
    .args()
    .returns(z.string())
    .default(() => new Date().toISOString())
});

export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

interface TokenState {
  mintedAt: number;
  liquidityUsd: number;
  lastWhaleUsd: number;
  lastSignalAt: number;
}

class RedisBus {
  private readonly publisher: RedisClientType;
  private readonly subscriber: RedisClientType;
  private readonly logger = pino({ name: "strategy-redis" });
  private connected = false;

  constructor(private readonly url: string) {
    this.publisher = createClient({ url });
    this.subscriber = createClient({ url });
    this.publisher.on("error", (error) => {
      this.logger.error({ error: error.message }, "redis publisher error");
    });
    this.subscriber.on("error", (error) => {
      this.logger.error({ error: error.message }, "redis subscriber error");
    });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    await this.publisher.connect();
    await this.subscriber.connect();
    this.connected = true;
  }

  async subscribe(channels: string[], handler: (message: string) => void): Promise<void> {
    await this.connect();
    for (const channel of channels) {
      await this.subscriber.subscribe(channel, handler);
    }
  }

  async publish(channel: string, payload: TradeSignal, timeoutMs: number): Promise<void> {
    await this.connect();
    const message = JSON.stringify(payload);
    const publishPromise = this.publisher.publish(channel, message);
    await Promise.race([
      publishPromise,
      delay(timeoutMs).then(() => {
        throw new Error("redis publish timeout");
      })
    ]);
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }
    await this.publisher.disconnect();
    await this.subscriber.disconnect();
    this.connected = false;
  }
}

export class SniperStrategy {
  private readonly state = new Map<string, TokenState>();
  private readonly logger = pino({ name: "sniper-strategy" });

  constructor(private readonly config: StrategyConfig) {}

  evaluate(event: IngestionEvent): TradeSignal | null {
    if (event.topic === "new_token_events") {
      this.recordNewToken(event);
      return null;
    }

    if (event.topic === "liquidity_events") {
      this.recordLiquidity(event);
    }

    if (event.topic === "whale_events") {
      this.recordWhale(event);
    }

    return this.maybeSignal(event.mintAddress);
  }

  private recordNewToken(event: NewTokenEvent): void {
    this.state.set(event.mintAddress, {
      mintedAt: Date.parse(event.timestamp),
      liquidityUsd: 0,
      lastWhaleUsd: 0,
      lastSignalAt: 0
    });
  }

  private recordLiquidity(event: LiquidityEvent): void {
    const state = this.ensureState(event.mintAddress, event.timestamp);
    state.liquidityUsd = Math.max(state.liquidityUsd, event.liquidityUsd);
  }

  private recordWhale(event: WhaleEvent): void {
    const state = this.ensureState(event.mintAddress, event.timestamp);
    state.lastWhaleUsd = Math.max(state.lastWhaleUsd, event.amountUsd);
  }

  private ensureState(mintAddress: string, timestamp: string): TokenState {
    const existing = this.state.get(mintAddress);
    if (existing) {
      return existing;
    }
    const mintedAt = Date.parse(timestamp);
    const state = { mintedAt, liquidityUsd: 0, lastWhaleUsd: 0, lastSignalAt: 0 };
    this.state.set(mintAddress, state);
    return state;
  }

  private maybeSignal(mintAddress: string): TradeSignal | null {
    const state = this.state.get(mintAddress);
    if (!state) {
      return null;
    }

    const now = Date.now();
    if (now - state.mintedAt > this.config.maxTokenAgeMs) {
      return null;
    }

    if (now - state.lastSignalAt < this.config.cooldownMs) {
      return null;
    }

    if (state.liquidityUsd < this.config.minLiquidityUsd) {
      return null;
    }

    const whaleBoost = state.lastWhaleUsd >= this.config.minWhaleAmountUsd;
    const confidence = this.computeConfidence(state, whaleBoost);
    if (confidence < this.config.minConfidence) {
      return null;
    }

    state.lastSignalAt = now;
    this.logger.info({ mintAddress, confidence }, "sniper signal generated");

    return {
      id: crypto.randomUUID(),
      topic: "trade_signals",
      timestamp: this.config.timestampProvider(),
      strategy: this.config.strategy,
      mintAddress,
      side: "buy",
      confidence,
      expectedSlippageBps: this.config.expectedSlippageBps
    };
  }

  private computeConfidence(state: TokenState, whaleBoost: boolean): number {
    const liquidityScore = Math.min(1, state.liquidityUsd / this.config.targetLiquidityUsd) * 0.4;
    const whaleScore = whaleBoost
      ? Math.min(1, state.lastWhaleUsd / this.config.targetWhaleAmountUsd) * 0.2
      : 0;
    const freshnessScore =
      Math.max(0, 1 - (Date.now() - state.mintedAt) / this.config.maxTokenAgeMs) * 0.1;
    const base = 0.4;
    return Math.min(1, base + liquidityScore + whaleScore + freshnessScore);
  }
}

export class StrategyService {
  private readonly config: StrategyConfig;
  private readonly logger = pino({ name: "strategy-service" });
  private readonly bus: RedisBus;
  private readonly strategy: SniperStrategy;

  constructor(config: StrategyConfig, overrides?: { bus?: RedisBus; strategy?: SniperStrategy }) {
    this.config = strategyConfigSchema.parse(config);
    this.bus = overrides?.bus ?? new RedisBus(this.config.redis.url);
    this.strategy = overrides?.strategy ?? new SniperStrategy(this.config);
  }

  async start(): Promise<void> {
    await this.bus.subscribe(
      ["new_token_events", "liquidity_events", "whale_events"],
      (message) => {
        void this.handleMessage(message);
      }
    );
    this.logger.info("strategy service started");
  }

  async stop(): Promise<void> {
    await this.bus.disconnect();
  }

  async handleMessage(message: string): Promise<TradeSignal | null> {
    try {
      const event = JSON.parse(message) as IngestionEvent;
      const signal = this.strategy.evaluate(event);
      if (!signal) {
        return null;
      }
      await this.bus.publish("trade_signals", signal, this.config.redis.publishTimeoutMs);
      return signal;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      this.logger.error({ error: reason }, "failed to handle ingestion event");
      return null;
    }
  }
}
