import crypto from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
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
  timestampProvider: z
    .function()
    .args()
    .returns(z.string())
    .default(() => new Date().toISOString())
});

export type ExecutionConfig = z.infer<typeof executionConfigSchema>;

export class ExecutionService {
  private readonly config: ExecutionConfig;
  private readonly rpcPool: SolanaRpcPool;
  private readonly transactionBuilder: TransactionBuilder;
  private readonly keypair: Keypair;
  private readonly logger = pino({ name: "execution-service" });

  constructor(config: ExecutionConfig) {
    this.config = executionConfigSchema.parse(config);
    this.rpcPool = new SolanaRpcPool(this.config.rpc);
    this.transactionBuilder = new TransactionBuilder(this.config.jupiter);
    const walletManager = new WalletManager();
    this.keypair = walletManager.loadKeypair(this.config.wallet);
  }

  async executeOrder(params: {
    order: RiskApprovedOrder;
    inputMint: string;
    outputMint: string;
    amount: number;
  }): Promise<ExecutionResult> {
    const { order, inputMint, outputMint, amount } = params;

    try {
      const quote = await this.transactionBuilder.fetchQuote({
        inputMint,
        outputMint,
        amount
      });

      const swapTransaction = await this.transactionBuilder.fetchSwapTransaction(
        quote,
        new PublicKey(this.keypair.publicKey)
      );

      swapTransaction.sign(this.keypair);
      const signature = await this.rpcPool.sendRawTransaction(swapTransaction.serialize());

      this.logger.info({ signature, orderId: order.id }, "order executed");

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
}
