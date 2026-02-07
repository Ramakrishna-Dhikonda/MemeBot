import crypto from "node:crypto";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type RedisClientType } from "redis";
import pino from "pino";
import {
  type LiquidityEvent,
  type PortfolioUpdate,
  type RiskApprovedOrder,
  type RiskRejectedSignal,
  type TradeSignal,
  type WhaleEvent
} from "@sqts/shared-types";
import { z } from "zod";

const envSchema = z.object({
  REDIS_URL: z.string().min(1),
  RISK_TOTAL_CAPITAL_USD: z.coerce.number().positive().optional().default(200000),
  RISK_MAX_TRADE_PCT: z.coerce.number().min(0).max(1).optional().default(0.05),
  RISK_MIN_LIQUIDITY_USD: z.coerce.number().positive().optional().default(75000),
  RISK_DAILY_LOSS_LIMIT_USD: z.coerce.number().positive(),
  RISK_MAX_HOLDER_CONCENTRATION_PCT: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.2),
  RISK_APPROVED_TOPIC: z.string().optional().default("risk_approved_orders"),
  RISK_DEAD_LETTER_TOPIC: z.string().optional().default("risk_dead_letter"),
  RISK_PUBLISH_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(2000),
  LOG_LEVEL: z.string().optional().default("info"),
  PORT: z.coerce.number().int().positive().optional().default(4003)
});

const riskConfigSchema = z.object({
  totalCapitalUsd: z.number().positive(),
  maxTradePct: z.number().min(0).max(1),
  minLiquidityUsd: z.number().positive(),
  dailyLossLimitUsd: z.number().positive(),
  maxHolderConcentrationPct: z.number().min(0).max(1),
  redis: z.object({
    url: z.string().min(1),
    publishTimeoutMs: z.number().int().positive()
  }),
  topics: z.object({
    approved: z.string().min(1),
    deadLetter: z.string().min(1)
  }),
  logLevel: z.string().min(1),
  port: z.number().int().positive(),
  timestampProvider: z
    .function()
    .args()
    .returns(z.string())
    .default(() => new Date().toISOString())
});

export type RiskConfig = z.infer<typeof riskConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): RiskConfig => {
  const parsed = envSchema.parse(env);
  return riskConfigSchema.parse({
    totalCapitalUsd: parsed.RISK_TOTAL_CAPITAL_USD,
    maxTradePct: parsed.RISK_MAX_TRADE_PCT,
    minLiquidityUsd: parsed.RISK_MIN_LIQUIDITY_USD,
    dailyLossLimitUsd: parsed.RISK_DAILY_LOSS_LIMIT_USD,
    maxHolderConcentrationPct: parsed.RISK_MAX_HOLDER_CONCENTRATION_PCT,
    redis: {
      url: parsed.REDIS_URL,
      publishTimeoutMs: parsed.RISK_PUBLISH_TIMEOUT_MS
    },
    topics: {
      approved: parsed.RISK_APPROVED_TOPIC,
      deadLetter: parsed.RISK_DEAD_LETTER_TOPIC
    },
    logLevel: parsed.LOG_LEVEL,
    port: parsed.PORT
  });
};

const tradeSignalSchema = z.object({
  id: z.string().min(1),
  topic: z.literal("trade_signals"),
  timestamp: z.string().min(1),
  strategy: z.string().min(1),
  mintAddress: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  confidence: z.number().min(0).max(1),
  expectedSlippageBps: z.number().int().nonnegative(),
  sizeUsd: z.number().positive()
});

const liquidityEventSchema = z.object({
  id: z.string().min(1),
  topic: z.literal("liquidity_events"),
  timestamp: z.string().min(1),
  mintAddress: z.string().min(1),
  poolAddress: z.string().min(1),
  liquidityUsd: z.number().nonnegative()
});

const whaleEventSchema = z.object({
  id: z.string().min(1),
  topic: z.literal("whale_events"),
  timestamp: z.string().min(1),
  walletAddress: z.string().min(1),
  mintAddress: z.string().min(1),
  amountUsd: z.number().nonnegative()
});

const portfolioUpdateSchema = z.object({
  id: z.string().min(1),
  topic: z.literal("portfolio_updates"),
  timestamp: z.string().min(1),
  mintAddress: z.string().min(1),
  positionSize: z.number(),
  avgEntryPriceUsd: z.number(),
  realizedPnlUsd: z.number().optional(),
  unrealizedPnlUsd: z.number().optional()
});

type RedisMessage = TradeSignal | LiquidityEvent | WhaleEvent | PortfolioUpdate;

type RiskDecision =
  | { approved: true; order: RiskApprovedOrder }
  | { approved: false; reason: string };

class RedisBus {
  private readonly publisher: RedisClientType;
  private readonly subscriber: RedisClientType;
  private readonly logger: pino.Logger;
  private connected = false;

  constructor(private readonly url: string, logger: pino.Logger) {
    this.publisher = createClient({ url });
    this.subscriber = createClient({ url });
    this.logger = logger;
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

  async publish(channel: string, payload: RiskApprovedOrder | RiskRejectedSignal, timeoutMs: number): Promise<void> {
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

export class RiskService {
  private readonly config: RiskConfig;
  private readonly logger: pino.Logger;
  private readonly bus: RedisBus;
  private readonly liquidityByMint = new Map<string, number>();
  private readonly whaleAmountByMint = new Map<string, number>();
  private dailyLossUsd = 0;
  private lossDate = "";

  constructor(config: RiskConfig, overrides?: { bus?: RedisBus; logger?: pino.Logger }) {
    this.config = riskConfigSchema.parse(config);
    this.logger = overrides?.logger ?? pino({ name: "risk-service", level: this.config.logLevel });
    this.bus = overrides?.bus ?? new RedisBus(this.config.redis.url, this.logger);
  }

  async start(): Promise<void> {
    await this.bus.subscribe(
      ["trade_signals", "liquidity_events", "whale_events", "portfolio_updates"],
      (message) => {
        void this.handleMessage(message);
      }
    );
    this.logger.info("risk service started");
  }

  async stop(): Promise<void> {
    await this.bus.disconnect();
  }

  async handleMessage(message: string): Promise<RiskApprovedOrder | null> {
    let parsed: RedisMessage | undefined;
    try {
      parsed = JSON.parse(message) as RedisMessage;
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, "invalid json payload");
      return null;
    }

    if (parsed.topic === "liquidity_events") {
      const event = liquidityEventSchema.parse(parsed);
      this.liquidityByMint.set(event.mintAddress, event.liquidityUsd);
      return null;
    }

    if (parsed.topic === "whale_events") {
      const event = whaleEventSchema.parse(parsed);
      this.whaleAmountByMint.set(event.mintAddress, event.amountUsd);
      return null;
    }

    if (parsed.topic === "portfolio_updates") {
      const event = portfolioUpdateSchema.parse(parsed);
      this.applyPortfolioUpdate(event);
      return null;
    }

    if (parsed.topic !== "trade_signals") {
      this.logger.warn({ topic: parsed.topic }, "unsupported topic");
      return null;
    }

    const parsedSignal = tradeSignalSchema.safeParse(parsed);
    if (!parsedSignal.success) {
      this.logger.warn({ issues: parsedSignal.error.issues }, "invalid trade signal payload");
      return null;
    }

    const decision = this.evaluateSignal(parsedSignal.data);
    if (decision.approved) {
      await this.bus.publish(
        this.config.topics.approved,
        decision.order,
        this.config.redis.publishTimeoutMs
      );
      return decision.order;
    }

    await this.publishRejection(parsedSignal.data, decision.reason);
    return null;
  }

  private applyPortfolioUpdate(event: PortfolioUpdate): void {
    this.resetDailyLossIfNeeded(event.timestamp);
    if (typeof event.realizedPnlUsd === "number" && event.realizedPnlUsd < 0) {
      this.dailyLossUsd += Math.abs(event.realizedPnlUsd);
      this.logger.info(
        { dailyLossUsd: this.dailyLossUsd },
        "updated daily loss from portfolio update"
      );
    }
  }

  private resetDailyLossIfNeeded(timestamp: string): void {
    const date = timestamp.slice(0, 10);
    if (date !== this.lossDate) {
      this.lossDate = date;
      this.dailyLossUsd = 0;
    }
  }

  private evaluateSignal(signal: TradeSignal & { sizeUsd: number }): RiskDecision {
    this.resetDailyLossIfNeeded(signal.timestamp);

    if (this.dailyLossUsd >= this.config.dailyLossLimitUsd) {
      return { approved: false, reason: "daily_loss_limit_exceeded" };
    }

    const maxTradeSize = this.config.totalCapitalUsd * this.config.maxTradePct;
    if (signal.sizeUsd > maxTradeSize) {
      return { approved: false, reason: "max_trade_pct_exceeded" };
    }

    const liquidityUsd = this.liquidityByMint.get(signal.mintAddress);
    if (!liquidityUsd || liquidityUsd < this.config.minLiquidityUsd) {
      return { approved: false, reason: "liquidity_below_threshold" };
    }

    const whaleAmountUsd = this.whaleAmountByMint.get(signal.mintAddress);
    if (whaleAmountUsd === undefined) {
      return { approved: false, reason: "holder_concentration_unavailable" };
    }

    const concentration = whaleAmountUsd / Math.max(liquidityUsd, 1);
    if (concentration > this.config.maxHolderConcentrationPct) {
      return { approved: false, reason: "holder_concentration_too_high" };
    }

    const order: RiskApprovedOrder = {
      id: crypto.randomUUID(),
      topic: "risk_approved_orders",
      timestamp: this.config.timestampProvider(),
      signalId: signal.id,
      mintAddress: signal.mintAddress,
      side: signal.side,
      sizeUsd: signal.sizeUsd,
      maxSlippageBps: signal.expectedSlippageBps
    };

    this.logger.info({ signalId: signal.id, sizeUsd: order.sizeUsd }, "order approved");
    return { approved: true, order };
  }

  private async publishRejection(signal: TradeSignal, reason: string): Promise<void> {
    const rejection: RiskRejectedSignal = {
      id: crypto.randomUUID(),
      topic: "risk_dead_letter",
      timestamp: this.config.timestampProvider(),
      signalId: signal.id,
      mintAddress: signal.mintAddress,
      reason
    };
    this.logger.warn({ signalId: signal.id, reason }, "signal rejected");
    await this.bus.publish(
      this.config.topics.deadLetter,
      rejection,
      this.config.redis.publishTimeoutMs
    );
  }
}

const startServer = async (): Promise<void> => {
  const config = loadConfig();
  const logger = pino({ name: "risk-service", level: config.logLevel });
  const service = new RiskService(config, { logger });

  await service.start();

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  server.listen(config.port, () => {
    logger.info({ port: config.port }, "health server listening");
  });

  const shutdown = async (): Promise<void> => {
    logger.info("shutting down risk service");
    server.close();
    await service.stop();
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
};

if (process.env.NODE_ENV !== "test") {
  void startServer();
}
