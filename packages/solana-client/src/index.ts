import { Connection, type Commitment, type TransactionSignature } from "@solana/web3.js";
import pino from "pino";
import { z } from "zod";

const rpcConfigSchema = z.object({
  endpoints: z.array(z.string().url()).nonempty(),
  commitment: z.custom<Commitment>().default("confirmed"),
  maxRetries: z.number().int().positive().default(3),
  retryDelayMs: z.number().int().positive().default(500)
});

export type RpcConfig = z.infer<typeof rpcConfigSchema>;

export class SolanaRpcPool {
  private readonly endpoints: string[];
  private readonly commitment: Commitment;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private index = 0;
  private readonly logger = pino({ name: "solana-client" });

  constructor(config: RpcConfig) {
    const parsed = rpcConfigSchema.parse(config);
    this.endpoints = parsed.endpoints;
    this.commitment = parsed.commitment;
    this.maxRetries = parsed.maxRetries;
    this.retryDelayMs = parsed.retryDelayMs;
  }

  get connection(): Connection {
    return new Connection(this.endpoints[this.index], this.commitment);
  }

  rotateEndpoint(): void {
    this.index = (this.index + 1) % this.endpoints.length;
    this.logger.warn({ index: this.index }, "rotated rpc endpoint");
  }

  async withRetry<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastError: Error | undefined;

    while (attempt < this.maxRetries) {
      try {
        const result = await fn(this.connection);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("unknown error");
        this.logger.warn({ attempt, error: lastError.message }, "rpc attempt failed");
        this.rotateEndpoint();
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
      attempt += 1;
    }

    throw lastError ?? new Error("rpc failed with unknown error");
  }

  async sendRawTransaction(rawTransaction: Buffer): Promise<TransactionSignature> {
    return this.withRetry(async (connection) => connection.sendRawTransaction(rawTransaction));
  }
}
