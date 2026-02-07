import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { type Commitment, Keypair, PublicKey } from "@solana/web3.js";
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
    publishTimeoutMs: z.number().int().positive().default(2000),
    publishRetries: z.number().int().nonnegative().default(3),
    retryDelayMs: z.number().int().positive().default(500)
  }),
  baseMint: z.string().min(1),
  priceApiUrl: z.string().url().default("https://price.jup.ag/v4/price"),
  mintDecimals: z.record(z.number().int().nonnegative()),
  maxRetries: z.number().int().positive().default(3),
  retryDelayMs: z.number().int().positive().default(500),
  confirmationCommitment: z.custom<Commitment>().default("confirmed"),
  concurrency: z.number().int().positive().default(4),
  port: z.number().int().positive().default(4004),
  logLevel: z.string().default("info"),
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
  private readonly logger: pino.Logger;
  private connected = false;

  constructor(
    private readonly url: string,
    private readonly publishRetries: number,
    private readonly retryDelayMs: number,
    logLevel: string
  ) {
    this.publisher = createClient({ url });
    this.subscriber = createClient({ url });
    this.logger = pino({ name: "execution-redis", level: logLevel });
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
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.publishRetries; attempt += 1) {
      try {
        const publishPromise = this.publisher.publish(channel, message);
        await Promise.race([
          publishPromise,
          delay(timeoutMs).then(() => {
            throw new Error("redis publish timeout");
          })
        ]);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("redis publish failed");
        if (attempt < this.publishRetries) {
          this.logger.warn(
            { error: lastError.message, attempt: attempt + 1 },
            "redis publish retry"
          );
          await delay(this.retryDelayMs * (attempt + 1));
        }
      }
    }
    if (lastError) {
      throw lastError;
    }
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

class AsyncQueue {
  private readonly pending: Array<{
    task: () => Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private running = 0;

  constructor(private readonly concurrency: number) {}

  enqueue(task: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this.runNext();
    });
  }

  get size(): number {
    return this.pending.length;
  }

  private runNext(): void {
    if (this.running >= this.concurrency) {
      return;
    }
    const item = this.pending.shift();
    if (!item) {
      return;
    }
    this.running += 1;
    item
      .task()
      .then(() => item.resolve())
      .catch((error) => item.reject(error instanceof Error ? error : new Error("queue failed")))
      .finally(() => {
        this.running -= 1;
        this.runNext();
      });
  }
}

export class ExecutionService {
  private readonly config: ExecutionConfig;
  private readonly rpcPool: SolanaRpcPool;
  private readonly transactionBuilder: TransactionBuilder;
  private readonly keypair: Keypair;
  private readonly logger: pino.Logger;
  private readonly bus: RedisBus;
  private readonly oracle: PriceOracle;
  private readonly queue: AsyncQueue;

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
    this.logger = pino({ name: "execution-service", level: this.config.logLevel });
    this.rpcPool = overrides?.rpcPool ?? new SolanaRpcPool(this.config.rpc);
    this.transactionBuilder =
      overrides?.transactionBuilder ?? new TransactionBuilder(this.config.jupiter);
    if (overrides?.keypair) {
      this.keypair = overrides.keypair;
    } else {
      const walletManager = new WalletManager();
      this.keypair = walletManager.loadKeypair(this.config.wallet);
    }
    this.bus =
      overrides?.bus ??
      new RedisBus(
        this.config.redis.url,
        this.config.redis.publishRetries,
        this.config.redis.retryDelayMs,
        this.config.logLevel
      );
    this.oracle = overrides?.oracle ?? new PriceOracle(this.config.priceApiUrl);
    this.queue = new AsyncQueue(this.config.concurrency);
  }

  async start(): Promise<void> {
    await this.bus.subscribe(["risk_approved_orders"], (message) => {
      void this.queue
        .enqueue(() => this.handleMessage(message).then(() => undefined))
        .catch((error) => {
          this.logger.error(
            { error: error.message, queueSize: this.queue.size },
            "queued execution failed"
          );
        });
    });
    this.logger.info({ concurrency: this.config.concurrency }, "execution service started");
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
      await this.confirmTransaction(signature);

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

  private async confirmTransaction(signature: string): Promise<void> {
    await this.withRetry(() =>
      this.rpcPool.withRetry((connection) =>
        connection.confirmTransaction(signature, this.config.confirmationCommitment)
      )
    );
    this.logger.info({ signature }, "transaction confirmed");
  }
}

const envSchema = z.object({
  SOLANA_RPC_URLS: z.string().min(1),
  SOLANA_COMMITMENT: z.string().optional().default("confirmed"),
  SOLANA_RPC_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  SOLANA_RPC_RETRY_DELAY_MS: z.coerce.number().int().positive().default(500),
  JUPITER_BASE_URL: z.string().url(),
  JUPITER_SLIPPAGE_BPS: z.coerce.number().int().positive().default(50),
  WALLET_ENCRYPTED_KEY: z.string().min(1),
  WALLET_SALT: z.string().min(1),
  WALLET_IV: z.string().min(1),
  WALLET_PASSPHRASE: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REDIS_PUBLISH_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  REDIS_PUBLISH_RETRIES: z.coerce.number().int().nonnegative().default(3),
  REDIS_RETRY_DELAY_MS: z.coerce.number().int().positive().default(500),
  BASE_MINT: z.string().min(1),
  PRICE_API_URL: z.string().url().default("https://price.jup.ag/v4/price"),
  MINT_DECIMALS: z.string().min(1),
  EXECUTION_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  EXECUTION_RETRY_DELAY_MS: z.coerce.number().int().positive().default(500),
  CONFIRMATION_COMMITMENT: z.string().optional().default("confirmed"),
  EXECUTION_CONCURRENCY: z.coerce.number().int().positive().default(4),
  PORT: z.coerce.number().int().positive().default(4004),
  LOG_LEVEL: z.string().default("info")
});

export function loadConfigFromEnv(): ExecutionConfig {
  const env = envSchema.parse(process.env);
  const mintDecimals = JSON.parse(env.MINT_DECIMALS) as Record<string, number>;
  return {
    rpc: {
      endpoints: env.SOLANA_RPC_URLS.split(",").map((endpoint) => endpoint.trim()),
      commitment: env.SOLANA_COMMITMENT as Commitment,
      maxRetries: env.SOLANA_RPC_MAX_RETRIES,
      retryDelayMs: env.SOLANA_RPC_RETRY_DELAY_MS
    },
    jupiter: {
      baseUrl: env.JUPITER_BASE_URL,
      slippageBps: env.JUPITER_SLIPPAGE_BPS
    },
    wallet: {
      encryptedKey: env.WALLET_ENCRYPTED_KEY,
      salt: env.WALLET_SALT,
      iv: env.WALLET_IV,
      passphrase: env.WALLET_PASSPHRASE
    },
    redis: {
      url: env.REDIS_URL,
      publishTimeoutMs: env.REDIS_PUBLISH_TIMEOUT_MS,
      publishRetries: env.REDIS_PUBLISH_RETRIES,
      retryDelayMs: env.REDIS_RETRY_DELAY_MS
    },
    baseMint: env.BASE_MINT,
    priceApiUrl: env.PRICE_API_URL,
    mintDecimals,
    maxRetries: env.EXECUTION_MAX_RETRIES,
    retryDelayMs: env.EXECUTION_RETRY_DELAY_MS,
    confirmationCommitment: env.CONFIRMATION_COMMITMENT as Commitment,
    concurrency: env.EXECUTION_CONCURRENCY,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    timestampProvider: () => new Date().toISOString()
  };
}

export async function startExecutionService(
  config: ExecutionConfig
): Promise<{ service: ExecutionService; close: () => Promise<void> }> {
  const service = new ExecutionService(config);
  await service.start();

  const logger = pino({ name: "execution-health", level: config.logLevel });
  const app = express();
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, "health endpoint listening");
  });

  const close = async (): Promise<void> => {
    await service.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  return { service, close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const logger = pino({ name: "execution-entry" });
  try {
    const config = loadConfigFromEnv();
    logger.level = config.logLevel;
    startExecutionService(config).catch((error) => {
      logger.error({ error: error.message }, "failed to start execution service");
      process.exitCode = 1;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to load config";
    logger.error({ error: message }, "failed to start execution service");
    process.exitCode = 1;
  }
}
