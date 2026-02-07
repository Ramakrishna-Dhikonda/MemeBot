import crypto from "node:crypto";
import pino from "pino";
import { type RiskApprovedOrder, type TradeSignal } from "@sqts/shared-types";
import { z } from "zod";

const riskConfigSchema = z.object({
  maxPositionUsd: z.number().positive().default(20000),
  maxTotalExposureUsd: z.number().positive().default(100000),
  orderSizeUsd: z.number().positive().default(5000),
  maxSlippageBps: z.number().int().positive().default(150),
  timestampProvider: z
    .function()
    .args()
    .returns(z.string())
    .default(() => new Date().toISOString())
});

export type RiskConfig = z.infer<typeof riskConfigSchema>;

export class RiskService {
  private readonly config: RiskConfig;
  private readonly logger = pino({ name: "risk-service" });
  private readonly positions = new Map<string, number>();
  private totalExposureUsd = 0;

  constructor(config: RiskConfig) {
    this.config = riskConfigSchema.parse(config);
  }

  approveSignal(signal: TradeSignal): RiskApprovedOrder | null {
    const currentPosition = this.positions.get(signal.mintAddress) ?? 0;

    if (signal.side === "buy") {
      const availablePosition = this.config.maxPositionUsd - currentPosition;
      const availableExposure = this.config.maxTotalExposureUsd - this.totalExposureUsd;
      const allocatable = Math.min(availablePosition, availableExposure, this.config.orderSizeUsd);

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

    const sizeUsd = Math.min(this.config.orderSizeUsd, currentPosition);
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
