import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createClient, type RedisClientType } from "redis";
import pino from "pino";
import {
  type ExecutionResult,
  type RiskApprovedOrder
} from "@sqts/shared-types";
import { SolanaRpcPool, type RpcConfig } from "@sqts/solana-client";
import { TransactionBuilder, type JupiterConfig } from "@sqts/transaction-builder";
import { WalletManager, type EncryptedKeyMaterial } from "@sqts/wallet-manager";
import { z } from "zod";

const executionConfigSchema = z.object({
  rpc: z.custom<RpcConfig>(),
  jupiter: z.custom<JupiterConfig>(),
  wallet: z.custom<EncryptedKeyMaterial>(),
  redis: z.object({
    url: z.string().min(1),
    publishTimeoutMs: z.number().int().positive().default(2000)
  }),
  baseMint: z.string().min(1),
  priceApiUrl: z.string().url().default("https://price.jup.ag/v4/price"),
  mintDecimals: z.record(z.number().int().nonnegative()),
  maxRetries: z.number().int().positive().default(3),
  retryDelayMs: z.number().int().positive().default(500),
  timestampProvider: z
    .function()
    .args()
    .returns(z.string())
    .default(() => new Date().toISOString())
});

export type ExecutionConfig = z.infer<typeof executionConfigSchema>;

class RedisBus {
  private readonly publisher: RedisClientType;
  private readonly subscriber: RedisClientType;
  private readonly logger = pino({ name: "execution-redis" });
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

  async publish(channel: string, payload: ExecutionResult, timeoutMs: number): Promise<void> {
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

class PriceOracle {
  constructor(private readonly apiUrl: string) {}

  async getUsdPrice(mint: string): Promise<number> {
    const url = new URL(this.apiUrl);
    url.searchParams.set("ids", mint);
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`price fetch failed: ${response.status}`);
    }
    const data = (await response.json()) as { data?: Record<string, { price: number }> };
    const price = data.data?.[mint]?.price;
    if (!price || Number.isNaN(price)) {
      throw new Error(`missing price for mint ${mint}`);
    }
    return price;
  }
}

export class ExecutionService {
  private readonly config: ExecutionConfig;
  private readonly rpcPool: SolanaRpcPool;
  private readonly transactionBuilder: TransactionBuilder;
  private readonly keypair: Keypair;
  private readonly logger = pino({ name: "execution-service" });
  private readonly bus: RedisBus;
  private readonly oracle: PriceOracle;

  constructor(
    config: ExecutionConfig,
    overrides?: {
      bus?: RedisBus;
      oracle?: PriceOracle;
      transactionBuilder?: TransactionBuilder;
      rpcPool?: SolanaRpcPool;
      keypair?: Keypair;
    }
  ) {
    this.config = executionConfigSchema.parse(config);
    this.rpcPool = overrides?.rpcPool ?? new SolanaRpcPool(this.config.rpc);
    this.transactionBuilder =
      overrides?.transactionBuilder ?? new TransactionBuilder(this.config.jupiter);
    if (overrides?.keypair) {
      this.keypair = overrides.keypair;
    } else {
      const walletManager = new WalletManager();
      this.keypair = walletManager.loadKeypair(this.config.wallet);
    }
    this.bus = overrides?.bus ?? new RedisBus(this.config.redis.url);
    this.oracle = overrides?.oracle ?? new PriceOracle(this.config.priceApiUrl);
  }

  async start(): Promise<void> {
    await this.bus.subscribe(["risk_approved_orders"], (message) => {
      void this.handleMessage(message);
    });
    this.logger.info("execution service started");
  }

  async stop(): Promise<void> {
    await this.bus.disconnect();
  }

  async handleMessage(message: string): Promise<ExecutionResult | null> {
    try {
      const order = JSON.parse(message) as RiskApprovedOrder;
      const result = await this.executeOrder(order);
      await this.bus.publish("execution_results", result, this.config.redis.publishTimeoutMs);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      this.logger.error({ error: reason }, "failed to execute order message");
      return null;
    }
  }

  async executeOrder(order: RiskApprovedOrder): Promise<ExecutionResult> {
    const started = Date.now();
    const inputMint = order.side === "buy" ? this.config.baseMint : order.mintAddress;
    const outputMint = order.side === "buy" ? order.mintAddress : this.config.baseMint;
    const amount = await this.calculateInputAmount(order, inputMint);

    try {
      const quote = await this.withRetry(() =>
        this.transactionBuilder.fetchQuote({
          inputMint,
          outputMint,
          amount
        })
      );

      const swapTransaction = await this.withRetry(() =>
        this.transactionBuilder.fetchSwapTransaction(quote, new PublicKey(this.keypair.publicKey))
      );

      swapTransaction.sign(this.keypair);
      const signature = await this.withRetry(() =>
        this.rpcPool.sendRawTransaction(swapTransaction.serialize())
      );

      const latencyMs = Date.now() - started;
      this.logger.info({ signature, orderId: order.id, latencyMs }, "order executed");

      return {
        id: crypto.randomUUID(),
        topic: "execution_results",
        timestamp: this.config.timestampProvider(),
        orderId: order.id,
        signature,
        status: "filled",
        filledSizeUsd: order.sizeUsd
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown execution error";
      this.logger.error({ orderId: order.id, error: message }, "order execution failed");

      return {
        id: crypto.randomUUID(),
        topic: "execution_results",
        timestamp: this.config.timestampProvider(),
        orderId: order.id,
        signature: "",
        status: "failed",
        error: message
      };
    }
  }

  private async calculateInputAmount(order: RiskApprovedOrder, inputMint: string): Promise<number> {
    const decimals = this.config.mintDecimals[inputMint];
    if (decimals === undefined) {
      throw new Error(`missing decimals for mint ${inputMint}`);
    }

    if (order.side === "buy") {
      return Math.floor(order.sizeUsd * 10 ** decimals);
    }

    const priceUsd = await this.withRetry(() => this.oracle.getUsdPrice(order.mintAddress));
    const tokenAmount = order.sizeUsd / priceUsd;
    return Math.floor(tokenAmount * 10 ** decimals);
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastError: Error | undefined;

    while (attempt < this.config.maxRetries) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("unknown error");
        this.logger.warn({ attempt, error: lastError.message }, "execution attempt failed");
        await delay(this.config.retryDelayMs * (attempt + 1));
        attempt += 1;
      }
    }

    throw lastError ?? new Error("execution failed after retries");
  }
}
