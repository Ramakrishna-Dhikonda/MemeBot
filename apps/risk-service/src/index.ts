import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type RedisClientType } from "redis";
import pino from "pino";
import {
  type LiquidityEvent,
  type RiskApprovedOrder,
  type TradeSignal
} from "@sqts/shared-types";
import { z } from "zod";

const riskConfigSchema = z.object({
  totalCapitalUsd: z.number().positive().default(200000),
  maxTradePct: z.number().min(0).max(1).default(0.05),
  minLiquidityUsd: z.number().positive().default(75000),
  minConfidence: z.number().min(0).max(1).default(0.7),
  maxPositionUsd: z.number().positive().default(30000),
  maxTotalExposureUsd: z.number().positive().default(120000),
  maxSlippageBps: z.number().int().positive().default(150),
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

export type RiskConfig = z.infer<typeof riskConfigSchema>;

class RedisBus {
  private readonly publisher: RedisClientType;
  private readonly subscriber: RedisClientType;
  private readonly logger = pino({ name: "risk-redis" });
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

  async publish(channel: string, payload: RiskApprovedOrder, timeoutMs: number): Promise<void> {
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
  private readonly logger = pino({ name: "risk-service" });
  private readonly bus: RedisBus;
  private readonly positions = new Map<string, number>();
  private readonly liquidityByMint = new Map<string, number>();
  private totalExposureUsd = 0;

  constructor(config: RiskConfig, overrides?: { bus?: RedisBus }) {
    this.config = riskConfigSchema.parse(config);
    this.bus = overrides?.bus ?? new RedisBus(this.config.redis.url);
  }

  async start(): Promise<void> {
    await this.bus.subscribe(["trade_signals", "liquidity_events"], (message) => {
      void this.handleMessage(message);
    });
    this.logger.info("risk service started");
  }

  async stop(): Promise<void> {
    await this.bus.disconnect();
  }

  async handleMessage(message: string): Promise<RiskApprovedOrder | null> {
    try {
      const parsed = JSON.parse(message) as TradeSignal | LiquidityEvent;
      if (parsed.topic === "liquidity_events") {
        this.liquidityByMint.set(parsed.mintAddress, parsed.liquidityUsd);
        return null;
      }

      const order = this.approveSignal(parsed);
      if (!order) {
        return null;
      }

      await this.bus.publish("risk_approved_orders", order, this.config.redis.publishTimeoutMs);
      return order;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      this.logger.error({ error: reason }, "failed to handle risk message");
      return null;
    }
  }

  approveSignal(signal: TradeSignal): RiskApprovedOrder | null {
    if (signal.confidence < this.config.minConfidence) {
      this.logger.warn({ signalId: signal.id }, "signal confidence too low");
      return null;
    }

    const liquidityUsd = this.liquidityByMint.get(signal.mintAddress) ?? 0;
    if (liquidityUsd < this.config.minLiquidityUsd) {
      this.logger.warn({ mintAddress: signal.mintAddress }, "liquidity below safety threshold");
      return null;
    }

    const currentPosition = this.positions.get(signal.mintAddress) ?? 0;
    const maxOrderSize = this.config.totalCapitalUsd * this.config.maxTradePct;
    const availablePosition = this.config.maxPositionUsd - currentPosition;
    const availableExposure = this.config.maxTotalExposureUsd - this.totalExposureUsd;
    const allocatable = Math.min(maxOrderSize, availablePosition, availableExposure);

    if (signal.side === "buy") {
      if (allocatable <= 0) {
        this.logger.warn({ mintAddress: signal.mintAddress }, "risk limits reached");
        return null;
      }
      return this.buildOrder(signal, allocatable);
    }

    if (currentPosition <= 0) {
      this.logger.warn({ mintAddress: signal.mintAddress }, "no position to sell");
      return null;
    }

    const sizeUsd = Math.min(currentPosition, maxOrderSize);
    return this.buildOrder(signal, sizeUsd);
  }

  recordFill(order: RiskApprovedOrder, filledSizeUsd: number): void {
    const signedSize = order.side === "buy" ? filledSizeUsd : -filledSizeUsd;
    const currentPosition = this.positions.get(order.mintAddress) ?? 0;
    const updated = Math.max(0, currentPosition + signedSize);

    this.positions.set(order.mintAddress, updated);
    this.totalExposureUsd = Math.max(0, this.totalExposureUsd + signedSize);
    this.logger.info(
      { mintAddress: order.mintAddress, positionUsd: updated },
      "risk position updated"
    );
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.positions.entries());
  }

  private buildOrder(signal: TradeSignal, sizeUsd: number): RiskApprovedOrder {
    const order: RiskApprovedOrder = {
      id: crypto.randomUUID(),
      topic: "risk_approved_orders",
      timestamp: this.config.timestampProvider(),
      signalId: signal.id,
      mintAddress: signal.mintAddress,
      side: signal.side,
      sizeUsd,
      maxSlippageBps: Math.min(this.config.maxSlippageBps, signal.expectedSlippageBps)
    };

    this.logger.info({ mintAddress: order.mintAddress, sizeUsd }, "order approved");
    return order;
  }
}
