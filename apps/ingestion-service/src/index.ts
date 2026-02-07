import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type RedisClientType } from "redis";
import WebSocket from "ws";
import pino from "pino";
import {
  type EventPayload,
  type IngestionEvent,
  type LiquidityEvent,
  type NewTokenEvent,
  type WhaleEvent
} from "@sqts/shared-types";
import { z } from "zod";

const ingestionConfigSchema = z.object({
  helius: z.object({
    wsUrl: z.string().url(),
    apiKey: z.string().min(1),
    requestId: z.number().int().positive().default(1),
    maxRetries: z.number().int().positive().default(5),
    retryDelayMs: z.number().int().positive().default(1000),
    whaleThresholdUsd: z.number().positive().default(50000)
  }),
  redis: z.object({
    url: z.string().min(1),
    publishTimeoutMs: z.number().int().positive().default(2000)
  }),
  defaultCreator: z.string().min(1),
  timestampProvider: z
    .function()
    .args()
    .returns(z.string())
    .default(() => new Date().toISOString())
});

export type IngestionConfig = z.infer<typeof ingestionConfigSchema>;

interface HeliusTokenTransfer {
  mint?: string;
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount?: number;
  tokenPrice?: number;
}

interface HeliusNativeTransfer {
  amount?: number;
  fromUserAccount?: string;
  toUserAccount?: string;
  price?: number;
}

interface HeliusLiquidityEvent {
  poolAddress?: string;
  mint?: string;
  liquidityUsd?: number;
}

interface HeliusTransaction {
  type?: string;
  signature?: string;
  timestamp?: number;
  feePayer?: string;
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
  events?: {
    liquidity?: HeliusLiquidityEvent;
    token?: { mint?: string; metadataUri?: string };
  };
}

const heliusEnvelopeSchema = z.object({
  params: z
    .object({
      result: z.union([z.array(z.unknown()), z.unknown()])
    })
    .optional(),
  result: z.union([z.array(z.unknown()), z.unknown()]).optional()
});

export interface Publisher {
  connect(): Promise<void>;
  publish(channel: string, payload: EventPayload, timeoutMs: number): Promise<void>;
  disconnect(): Promise<void>;
}

export class RedisPublisher implements Publisher {
  private readonly client: RedisClientType;
  private readonly logger = pino({ name: "ingestion-redis" });
  private connected = false;

  constructor(private readonly url: string) {
    this.client = createClient({ url });
    this.client.on("error", (error) => {
      this.logger.error({ error: error.message }, "redis error");
    });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    await this.client.connect();
    this.connected = true;
    this.logger.info("redis connected");
  }

  async publish(channel: string, payload: EventPayload, timeoutMs: number): Promise<void> {
    await this.connect();
    const message = JSON.stringify(payload);
    const publishPromise = this.client.publish(channel, message);
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
    await this.client.disconnect();
    this.connected = false;
  }
}

export class HeliusStreamClient {
  private socket: WebSocket | null = null;
  private shouldReconnect = true;
  private attempts = 0;
  private readonly logger = pino({ name: "helius-stream" });

  constructor(
    private readonly config: IngestionConfig["helius"],
    private readonly onMessage: (tx: HeliusTransaction) => void
  ) {}

  start(): void {
    this.shouldReconnect = true;
    this.connect();
  }

  stop(): void {
    this.shouldReconnect = false;
    if (this.socket) {
      this.socket.close();
    }
  }

  private connect(): void {
    const url = new URL(this.config.wsUrl);
    url.searchParams.set("api-key", this.config.apiKey);
    this.socket = new WebSocket(url.toString());

    this.socket.on("open", () => {
      this.logger.info("helius ws connected");
      this.attempts = 0;
      this.subscribe();
    });

    this.socket.on("message", (data) => {
      try {
        const text = data.toString();
        const parsed = JSON.parse(text);
        const envelope = heliusEnvelopeSchema.parse(parsed);
        const result = envelope.params?.result ?? envelope.result;
        if (!result) {
          return;
        }
        const items = Array.isArray(result) ? result : [result];
        items.forEach((item) => this.onMessage(item as HeliusTransaction));
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown parse error";
        this.logger.warn({ error: message }, "failed to parse helius message");
      }
    });

    this.socket.on("close", () => {
      this.logger.warn("helius ws closed");
      void this.scheduleReconnect();
    });

    this.socket.on("error", (error) => {
      this.logger.error({ error: error.message }, "helius ws error");
    });
  }

  private subscribe(): void {
    if (!this.socket) {
      return;
    }
    const payload = {
      jsonrpc: "2.0",
      id: this.config.requestId,
      method: "transactionSubscribe",
      params: [
        {
          failed: false
        },
        {
          commitment: "confirmed",
          encoding: "jsonParsed",
          transactionDetails: "full",
          showRewards: false
        }
      ]
    };
    this.socket.send(JSON.stringify(payload));
  }

  private async scheduleReconnect(): Promise<void> {
    if (!this.shouldReconnect) {
      return;
    }
    this.attempts += 1;
    if (this.attempts > this.config.maxRetries) {
      this.logger.error("helius ws max retries exceeded");
      return;
    }
    await delay(this.config.retryDelayMs * this.attempts);
    this.connect();
  }
}

export class HeliusEventParser {
  constructor(private readonly config: IngestionConfig) {}

  parse(tx: HeliusTransaction): IngestionEvent[] {
    const events: IngestionEvent[] = [];

    const tokenMint = this.extractTokenMint(tx);
    if (tokenMint) {
      const newTokenEvent: NewTokenEvent = {
        id: crypto.randomUUID(),
        topic: "new_token_events",
        timestamp: this.config.timestampProvider(),
        mintAddress: tokenMint,
        creator: tx.feePayer ?? this.config.defaultCreator,
        metadataUri: tx.events?.token?.metadataUri
      };
      events.push(newTokenEvent);
    }

    const liquidity = this.extractLiquidity(tx);
    if (liquidity) {
      const liquidityEvent: LiquidityEvent = {
        id: crypto.randomUUID(),
        topic: "liquidity_events",
        timestamp: this.config.timestampProvider(),
        mintAddress: liquidity.mintAddress,
        poolAddress: liquidity.poolAddress,
        liquidityUsd: liquidity.liquidityUsd
      };
      events.push(liquidityEvent);
    }

    const whaleEvents = this.extractWhaleTransfers(tx);
    whaleEvents.forEach((whale) => {
      const whaleEvent: WhaleEvent = {
        id: crypto.randomUUID(),
        topic: "whale_events",
        timestamp: this.config.timestampProvider(),
        walletAddress: whale.walletAddress,
        mintAddress: whale.mintAddress,
        amountUsd: whale.amountUsd
      };
      events.push(whaleEvent);
    });

    return events;
  }

  private extractTokenMint(tx: HeliusTransaction): string | null {
    if (tx.type?.toUpperCase().includes("TOKEN_MINT")) {
      return tx.events?.token?.mint ?? tx.tokenTransfers?.[0]?.mint ?? null;
    }

    if (tx.events?.token?.mint) {
      return tx.events.token.mint;
    }

    return null;
  }

  private extractLiquidity(tx: HeliusTransaction): {
    mintAddress: string;
    poolAddress: string;
    liquidityUsd: number;
  } | null {
    if (!tx.type?.toUpperCase().includes("LIQUIDITY") && !tx.events?.liquidity) {
      return null;
    }

    const mintAddress =
      tx.events?.liquidity?.mint ?? tx.tokenTransfers?.[0]?.mint ?? "";
    const poolAddress = tx.events?.liquidity?.poolAddress ?? tx.signature ?? "";
    const liquidityUsd =
      tx.events?.liquidity?.liquidityUsd ??
      this.sumTransferUsd(tx.tokenTransfers ?? []);

    if (!mintAddress || !poolAddress || liquidityUsd <= 0) {
      return null;
    }

    return { mintAddress, poolAddress, liquidityUsd };
  }

  private extractWhaleTransfers(tx: HeliusTransaction): Array<{
    walletAddress: string;
    mintAddress: string;
    amountUsd: number;
  }> {
    const whales: Array<{ walletAddress: string; mintAddress: string; amountUsd: number }> = [];

    const tokenTransfers = tx.tokenTransfers ?? [];
    for (const transfer of tokenTransfers) {
      const amountUsd = (transfer.tokenAmount ?? 0) * (transfer.tokenPrice ?? 0);
      if (amountUsd >= this.config.helius.whaleThresholdUsd) {
        whales.push({
          walletAddress: transfer.toUserAccount ?? transfer.fromUserAccount ?? "unknown",
          mintAddress: transfer.mint ?? "unknown",
          amountUsd
        });
      }
    }

    const nativeTransfers = tx.nativeTransfers ?? [];
    for (const transfer of nativeTransfers) {
      const amountUsd = (transfer.amount ?? 0) * (transfer.price ?? 0);
      if (amountUsd >= this.config.helius.whaleThresholdUsd) {
        whales.push({
          walletAddress: transfer.toUserAccount ?? transfer.fromUserAccount ?? "unknown",
          mintAddress: "SOL",
          amountUsd
        });
      }
    }

    return whales;
  }

  private sumTransferUsd(transfers: HeliusTokenTransfer[]): number {
    return transfers.reduce((sum, transfer) => {
      const amount = transfer.tokenAmount ?? 0;
      const price = transfer.tokenPrice ?? 0;
      return sum + amount * price;
    }, 0);
  }
}

export class IngestionService {
  private readonly config: IngestionConfig;
  private readonly logger = pino({ name: "ingestion-service" });
  private readonly publisher: Publisher;
  private readonly streamClient: HeliusStreamClient;
  private readonly parser: HeliusEventParser;

  constructor(
    config: IngestionConfig,
    overrides?: { publisher?: Publisher; streamClient?: HeliusStreamClient }
  ) {
    this.config = ingestionConfigSchema.parse(config);
    this.publisher = overrides?.publisher ?? new RedisPublisher(this.config.redis.url);
    this.parser = new HeliusEventParser(this.config);
    this.streamClient =
      overrides?.streamClient ??
      new HeliusStreamClient(this.config.helius, (tx) => {
      void this.handleTransaction(tx);
    });
  }

  start(): void {
    this.streamClient.start();
  }

  async stop(): Promise<void> {
    this.streamClient.stop();
    await this.publisher.disconnect();
  }

  async handleTransaction(tx: HeliusTransaction): Promise<IngestionEvent[]> {
    const events = this.parser.parse(tx);
    for (const event of events) {
      await this.publish(event);
    }
    return events;
  }

  private async publish(event: IngestionEvent): Promise<void> {
    const timeout = this.config.redis.publishTimeoutMs;
    await this.publisher.publish(event.topic, event, timeout);
    this.logger.info({ topic: event.topic, id: event.id }, "event published");
  }

  get eventParser(): HeliusEventParser {
    return this.parser;
  }
}
