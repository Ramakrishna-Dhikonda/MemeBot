import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type RedisClientType } from "redis";
import pino from "pino";
import {
  type IngestionEvent,
  type LiquidityEvent,
  type NewTokenEvent,
  type TradeSignal,
  type WhaleEvent,
  type StrategyType
} from "@sqts/shared-types";
import { z } from "zod";

type StrategyMode = StrategyType | "combined";

const strategyConfigSchema = z.object({
  mode: z.enum(["sniper", "momentum_breakout", "combined"]).default("combined"),
  sniper: z.object({
    minLiquidityUsd: z.number().positive().default(60000),
    minLiquidityGrowthUsd: z.number().positive().default(40000),
    targetLiquidityUsd: z.number().positive().default(200000),
    devWalletMaxUsd: z.number().positive().default(50000)
  }),
  momentum: z.object({
    minLiquidityUsd: z.number().positive().default(50000),
    minLiquidityIncreaseUsd: z.number().positive().default(30000),
    volumeSpikeUsd: z.number().positive().default(80000)
  }),
  expectedSlippageBps: z.number().int().positive().default(100),
  minConfidence: z.number().min(0).max(1).default(0.6),
  maxTokenAgeMs: z.number().int().positive().default(10 * 60 * 1000),
  cooldownMs: z.number().int().positive().default(60 * 1000),
  redis: z.object({
    url: z.string().min(1),
    publishTimeoutMs: z.number().int().positive().default(2000)
  }),
  service: z.object({
    port: z.number().int().positive().default(4002)
  }),
  timestampProvider: z
    .function()
    .args()
    .returns(z.string())
    .default(() => new Date().toISOString())
});

export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

const envSchema = z.object({
  REDIS_URL: z.string().min(1),
  SERVICE_PORT: z.coerce.number().int().positive().default(4002),
  STRATEGY_MODE: z.enum(["sniper", "momentum_breakout", "combined"]).default("combined"),
  SNIPER_MIN_LIQUIDITY_USD: z.coerce.number().positive().default(60000),
  SNIPER_MIN_LIQUIDITY_GROWTH_USD: z.coerce.number().positive().default(40000),
  SNIPER_TARGET_LIQUIDITY_USD: z.coerce.number().positive().default(200000),
  SNIPER_DEV_WALLET_MAX_USD: z.coerce.number().positive().default(50000),
  MOMENTUM_MIN_LIQUIDITY_USD: z.coerce.number().positive().default(50000),
  MOMENTUM_MIN_LIQUIDITY_INCREASE_USD: z.coerce.number().positive().default(30000),
  MOMENTUM_VOLUME_SPIKE_USD: z.coerce.number().positive().default(80000),
  EXPECTED_SLIPPAGE_BPS: z.coerce.number().int().positive().default(100),
  MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  MAX_TOKEN_AGE_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  COOLDOWN_MS: z.coerce.number().int().positive().default(60 * 1000),
  REDIS_PUBLISH_TIMEOUT_MS: z.coerce.number().int().positive().default(2000)
});

export const loadConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): StrategyConfig => {
  const parsed = envSchema.parse(env);
  return strategyConfigSchema.parse({
    mode: parsed.STRATEGY_MODE,
    sniper: {
      minLiquidityUsd: parsed.SNIPER_MIN_LIQUIDITY_USD,
      minLiquidityGrowthUsd: parsed.SNIPER_MIN_LIQUIDITY_GROWTH_USD,
      targetLiquidityUsd: parsed.SNIPER_TARGET_LIQUIDITY_USD,
      devWalletMaxUsd: parsed.SNIPER_DEV_WALLET_MAX_USD
    },
    momentum: {
      minLiquidityUsd: parsed.MOMENTUM_MIN_LIQUIDITY_USD,
      minLiquidityIncreaseUsd: parsed.MOMENTUM_MIN_LIQUIDITY_INCREASE_USD,
      volumeSpikeUsd: parsed.MOMENTUM_VOLUME_SPIKE_USD
    },
    expectedSlippageBps: parsed.EXPECTED_SLIPPAGE_BPS,
    minConfidence: parsed.MIN_CONFIDENCE,
    maxTokenAgeMs: parsed.MAX_TOKEN_AGE_MS,
    cooldownMs: parsed.COOLDOWN_MS,
    redis: {
      url: parsed.REDIS_URL,
      publishTimeoutMs: parsed.REDIS_PUBLISH_TIMEOUT_MS
    },
    service: { port: parsed.SERVICE_PORT }
  });
};

interface TokenState {
  mintedAt: number;
  creator?: string;
  firstLiquidityUsd: number;
  lastLiquidityUsd: number;
  previousLiquidityUsd: number;
  lastWhaleUsd: number;
  lastDevWhaleUsd: number;
  lastSignalAt: Record<StrategyType, number>;
}

const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));

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

const buildSignal = (
  config: StrategyConfig,
  strategy: StrategyType,
  mintAddress: string,
  confidence: number
): TradeSignal => ({
  id: crypto.randomUUID(),
  topic: "trade_signals",
  timestamp: config.timestampProvider(),
  strategy,
  mintAddress,
  side: "buy",
  confidence: clamp(confidence),
  expectedSlippageBps: config.expectedSlippageBps
});

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
      creator: event.creator,
      firstLiquidityUsd: 0,
      lastLiquidityUsd: 0,
      previousLiquidityUsd: 0,
      lastWhaleUsd: 0,
      lastDevWhaleUsd: 0,
      lastSignalAt: { sniper: 0, momentum_breakout: 0 }
    });
  }

  private recordLiquidity(event: LiquidityEvent): void {
    const state = this.ensureState(event.mintAddress, event.timestamp);
    state.previousLiquidityUsd = state.lastLiquidityUsd;
    state.lastLiquidityUsd = Math.max(state.lastLiquidityUsd, event.liquidityUsd);
    if (state.firstLiquidityUsd === 0) {
      state.firstLiquidityUsd = state.lastLiquidityUsd;
    }
  }

  private recordWhale(event: WhaleEvent): void {
    const state = this.ensureState(event.mintAddress, event.timestamp);
    state.lastWhaleUsd = Math.max(state.lastWhaleUsd, event.amountUsd);
    if (state.creator && event.walletAddress === state.creator) {
      state.lastDevWhaleUsd = Math.max(state.lastDevWhaleUsd, event.amountUsd);
    }
  }

  private ensureState(mintAddress: string, timestamp: string): TokenState {
    const existing = this.state.get(mintAddress);
    if (existing) {
      return existing;
    }
    const mintedAt = Date.parse(timestamp);
    const state: TokenState = {
      mintedAt,
      firstLiquidityUsd: 0,
      lastLiquidityUsd: 0,
      previousLiquidityUsd: 0,
      lastWhaleUsd: 0,
      lastDevWhaleUsd: 0,
      lastSignalAt: { sniper: 0, momentum_breakout: 0 }
    };
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

    if (now - state.lastSignalAt.sniper < this.config.cooldownMs) {
      return null;
    }

    if (state.lastLiquidityUsd < this.config.sniper.minLiquidityUsd) {
      return null;
    }

    const liquidityGrowth = state.lastLiquidityUsd - state.firstLiquidityUsd;
    if (liquidityGrowth < this.config.sniper.minLiquidityGrowthUsd) {
      return null;
    }

    if (state.lastDevWhaleUsd >= this.config.sniper.devWalletMaxUsd) {
      return null;
    }

    const confidence = this.computeConfidence(state, liquidityGrowth);
    if (confidence < this.config.minConfidence) {
      return null;
    }

    state.lastSignalAt.sniper = now;
    this.logger.info({ mintAddress, confidence }, "sniper signal generated");

    return buildSignal(this.config, "sniper", mintAddress, confidence);
  }

  private computeConfidence(state: TokenState, liquidityGrowth: number): number {
    const liquidityScore =
      clamp(liquidityGrowth / this.config.sniper.targetLiquidityUsd) * 0.5;
    const devWalletScore = clamp(
      1 - state.lastDevWhaleUsd / this.config.sniper.devWalletMaxUsd
    ) * 0.2;
    const freshnessScore =
      clamp(1 - (Date.now() - state.mintedAt) / this.config.maxTokenAgeMs) * 0.2;
    const stabilityScore = clamp(state.lastWhaleUsd / this.config.sniper.devWalletMaxUsd) * 0.1;
    return clamp(liquidityScore + devWalletScore + freshnessScore + stabilityScore);
  }
}

export class MomentumStrategy {
  private readonly state = new Map<string, TokenState>();
  private readonly logger = pino({ name: "momentum-strategy" });

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
      creator: event.creator,
      firstLiquidityUsd: 0,
      lastLiquidityUsd: 0,
      previousLiquidityUsd: 0,
      lastWhaleUsd: 0,
      lastDevWhaleUsd: 0,
      lastSignalAt: { sniper: 0, momentum_breakout: 0 }
    });
  }

  private recordLiquidity(event: LiquidityEvent): void {
    const state = this.ensureState(event.mintAddress, event.timestamp);
    state.previousLiquidityUsd = state.lastLiquidityUsd;
    state.lastLiquidityUsd = Math.max(state.lastLiquidityUsd, event.liquidityUsd);
    if (state.firstLiquidityUsd === 0) {
      state.firstLiquidityUsd = state.lastLiquidityUsd;
    }
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
    const state: TokenState = {
      mintedAt,
      firstLiquidityUsd: 0,
      lastLiquidityUsd: 0,
      previousLiquidityUsd: 0,
      lastWhaleUsd: 0,
      lastDevWhaleUsd: 0,
      lastSignalAt: { sniper: 0, momentum_breakout: 0 }
    };
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

    if (now - state.lastSignalAt.momentum_breakout < this.config.cooldownMs) {
      return null;
    }

    if (state.lastLiquidityUsd < this.config.momentum.minLiquidityUsd) {
      return null;
    }

    const liquidityIncrease = Math.max(0, state.lastLiquidityUsd - state.previousLiquidityUsd);
    const volumeSpike = state.lastWhaleUsd >= this.config.momentum.volumeSpikeUsd;
    const priceMomentum = liquidityIncrease >= this.config.momentum.minLiquidityIncreaseUsd;

    if (!volumeSpike && !priceMomentum) {
      return null;
    }

    const confidence = this.computeConfidence(liquidityIncrease, volumeSpike);
    if (confidence < this.config.minConfidence) {
      return null;
    }

    state.lastSignalAt.momentum_breakout = now;
    this.logger.info({ mintAddress, confidence }, "momentum signal generated");
    return buildSignal(this.config, "momentum_breakout", mintAddress, confidence);
  }

  private computeConfidence(liquidityIncrease: number, volumeSpike: boolean): number {
    const liquidityScore =
      clamp(liquidityIncrease / this.config.momentum.minLiquidityIncreaseUsd) * 0.6;
    const volumeScore = volumeSpike ? 0.3 : 0;
    const consistencyScore = liquidityIncrease > 0 ? 0.1 : 0;
    return clamp(liquidityScore + volumeScore + consistencyScore);
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
      if (!req.url || req.url === "/") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            startedAt: this.startedAt.toISOString()
          })
        );
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

export class StrategyService {
  private readonly config: StrategyConfig;
  private readonly logger = pino({ name: "strategy-service" });
  private readonly bus: RedisBus;
  private readonly sniper: SniperStrategy;
  private readonly momentum: MomentumStrategy;
  private readonly healthServer: HealthServer;

  constructor(
    config: StrategyConfig,
    overrides?: {
      bus?: RedisBus;
      sniper?: SniperStrategy;
      momentum?: MomentumStrategy;
      healthServer?: HealthServer;
    }
  ) {
    this.config = strategyConfigSchema.parse(config);
    this.bus = overrides?.bus ?? new RedisBus(this.config.redis.url);
    this.sniper = overrides?.sniper ?? new SniperStrategy(this.config);
    this.momentum = overrides?.momentum ?? new MomentumStrategy(this.config);
    this.healthServer =
      overrides?.healthServer ?? new HealthServer(this.config.service.port, this.logger);
  }

  async start(): Promise<void> {
    await this.bus.subscribe(
      ["new_token_events", "liquidity_events", "whale_events"],
      (message) => {
        void this.handleMessage(message);
      }
    );
    await this.healthServer.start();
    this.logger.info("strategy service started");
  }

  async stop(): Promise<void> {
    await this.bus.disconnect();
    await this.healthServer.stop();
  }

  async handleMessage(message: string): Promise<TradeSignal[]> {
    try {
      const event = JSON.parse(message) as IngestionEvent;
      const signals = this.evaluateEvent(event);
      for (const signal of signals) {
        await this.bus.publish("trade_signals", signal, this.config.redis.publishTimeoutMs);
      }
      return signals;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      this.logger.error({ error: reason }, "failed to handle ingestion event");
      return [];
    }
  }

  private evaluateEvent(event: IngestionEvent): TradeSignal[] {
    const signals: TradeSignal[] = [];
    if (this.config.mode === "sniper" || this.config.mode === "combined") {
      const sniperSignal = this.sniper.evaluate(event);
      if (sniperSignal) {
        signals.push(sniperSignal);
      }
    }
    if (this.config.mode === "momentum_breakout" || this.config.mode === "combined") {
      const momentumSignal = this.momentum.evaluate(event);
      if (momentumSignal) {
        signals.push(momentumSignal);
      }
    }
    return signals;
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
  const logger = pino({ name: "strategy-service" });
  try {
    const config = loadConfigFromEnv();
    const service = new StrategyService(config);
    await service.start();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    logger.error({ error: reason }, "failed to start strategy service");
    process.exit(1);
  }
}
