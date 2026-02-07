import crypto from "node:crypto";
import pino from "pino";
import {
  type IngestionEvent,
  type LiquidityEvent,
  type NewTokenEvent,
  type WhaleEvent
} from "@sqts/shared-types";
import { z } from "zod";

const ingestionConfigSchema = z.object({
  source: z.string().min(1),
  defaultCreator: z.string().min(1),
  timestampProvider: z
    .function()
    .args()
    .returns(z.string())
    .default(() => new Date().toISOString())
});

export type IngestionConfig = z.infer<typeof ingestionConfigSchema>;

export interface RawTokenListing {
  mintAddress: string;
  creator?: string;
  metadataUri?: string;
}

export interface RawLiquidityEvent {
  mintAddress: string;
  poolAddress: string;
  liquidityUsd: number;
}

export interface RawWhaleTransfer {
  walletAddress: string;
  mintAddress: string;
  amountUsd: number;
}

export class IngestionService {
  private readonly config: IngestionConfig;
  private readonly logger = pino({ name: "ingestion-service" });

  constructor(config: IngestionConfig) {
    this.config = ingestionConfigSchema.parse(config);
  }

  ingestTokenListing(listing: RawTokenListing): NewTokenEvent {
    const event: NewTokenEvent = {
      id: crypto.randomUUID(),
      topic: "new_token_events",
      timestamp: this.config.timestampProvider(),
      mintAddress: listing.mintAddress,
      creator: listing.creator ?? this.config.defaultCreator,
      metadataUri: listing.metadataUri
    };

    this.logger.info({ mintAddress: event.mintAddress }, "token listing ingested");
    return event;
  }

  ingestLiquidityUpdate(update: RawLiquidityEvent): LiquidityEvent {
    const event: LiquidityEvent = {
      id: crypto.randomUUID(),
      topic: "liquidity_events",
      timestamp: this.config.timestampProvider(),
      mintAddress: update.mintAddress,
      poolAddress: update.poolAddress,
      liquidityUsd: update.liquidityUsd
    };

    this.logger.info({ pool: event.poolAddress }, "liquidity update ingested");
    return event;
  }

  ingestWhaleTransfer(transfer: RawWhaleTransfer): WhaleEvent {
    const event: WhaleEvent = {
      id: crypto.randomUUID(),
      topic: "whale_events",
      timestamp: this.config.timestampProvider(),
      walletAddress: transfer.walletAddress,
      mintAddress: transfer.mintAddress,
      amountUsd: transfer.amountUsd
    };

    this.logger.info({ walletAddress: event.walletAddress }, "whale transfer ingested");
    return event;
  }

  ingestBatch(inputs: {
    listings?: RawTokenListing[];
    liquidity?: RawLiquidityEvent[];
    whales?: RawWhaleTransfer[];
  }): IngestionEvent[] {
    const events: IngestionEvent[] = [];
    inputs.listings?.forEach((listing) => events.push(this.ingestTokenListing(listing)));
    inputs.liquidity?.forEach((update) => events.push(this.ingestLiquidityUpdate(update)));
    inputs.whales?.forEach((transfer) => events.push(this.ingestWhaleTransfer(transfer)));

    this.logger.info({ count: events.length }, "batch ingestion complete");
    return events;
  }
}
