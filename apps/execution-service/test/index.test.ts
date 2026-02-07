import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "@jest/globals";
import { WalletManager } from "@sqts/wallet-manager";
import { ExecutionService, type ExecutionConfig } from "../src/index.js";
import type { RiskApprovedOrder } from "@sqts/shared-types";

const keypair = Keypair.generate();
const walletMaterial = WalletManager.encryptKeypair(keypair.secretKey, "passphrase");

const baseConfig: ExecutionConfig = {
  rpc: {
    endpoints: ["https://example.com"],
    commitment: "confirmed",
    maxRetries: 1,
    retryDelayMs: 10
  },
  jupiter: {
    baseUrl: "https://example.com",
    slippageBps: 50
  },
  wallet: walletMaterial,
  redis: {
    url: "redis://localhost:6379",
    publishTimeoutMs: 100,
    publishRetries: 0,
    retryDelayMs: 1
  },
  baseMint: "USDC",
  priceApiUrl: "https://example.com/price",
  mintDecimals: {
    USDC: 6,
    Mint1: 9
  },
  maxRetries: 2,
  retryDelayMs: 1,
  confirmationCommitment: "confirmed",
  concurrency: 2,
  port: 4004,
  logLevel: "silent",
  timestampProvider: () => "2024-01-01T00:00:00.000Z"
};

class MockBus {
  public published: unknown[] = [];
  async publish(_channel: string, payload: unknown, _timeoutMs?: number): Promise<void> {
    this.published.push(payload);
  }
  async subscribe(): Promise<void> {
    return;
  }
  async disconnect(): Promise<void> {
    return;
  }
}

class MockOracle {
  constructor(private readonly price: number) {}
  async getUsdPrice(_mint?: string): Promise<number> {
    return this.price;
  }
}

class MockRpcPool {
  async sendRawTransaction(): Promise<string> {
    return "signature";
  }

  async withRetry<T>(
    fn: (connection: { confirmTransaction: (signature: string) => Promise<void> }) => Promise<T>
  ): Promise<T> {
    return fn({ confirmTransaction: async () => undefined });
  }
}

class MockTransactionBuilder {
  public lastAmount: number | null = null;
  private readonly tx: Transaction;
  private failFirst = false;

  constructor(failFirst = false) {
    this.failFirst = failFirst;
    this.tx = new Transaction();
    this.tx.feePayer = new PublicKey(keypair.publicKey);
    this.tx.recentBlockhash = keypair.publicKey.toBase58();
  }

  async fetchQuote(params: { amount: number }): Promise<{ outAmount: string; otherAmountThreshold: string; priceImpactPct: string; routePlan: Array<Record<string, unknown>>; }> {
    if (this.failFirst) {
      this.failFirst = false;
      throw new Error("quote failed");
    }
    this.lastAmount = params.amount;
    return {
      outAmount: "1",
      otherAmountThreshold: "1",
      priceImpactPct: "0.1",
      routePlan: []
    };
  }

  async fetchSwapTransaction(): Promise<Transaction> {
    return this.tx;
  }
}

const baseOrder: RiskApprovedOrder = {
  id: "order-1",
  topic: "risk_approved_orders",
  timestamp: "2024-01-01T00:00:00.000Z",
  signalId: "signal",
  mintAddress: "Mint1",
  side: "buy",
  sizeUsd: 250,
  maxSlippageBps: 100
};

describe("ExecutionService", () => {
  it("calculates buy input amounts in base token", async () => {
    const builder = new MockTransactionBuilder();
    const service = new ExecutionService(baseConfig, {
      transactionBuilder: builder as never,
      rpcPool: new MockRpcPool() as never,
      oracle: new MockOracle(2) as never,
      keypair,
      bus: new MockBus() as never
    });

    const result = await service.executeOrder(baseOrder);
    expect(result.status).toBe("filled");
    expect(builder.lastAmount).toBe(250 * 10 ** 6);
  });

  it("calculates sell input amounts using price oracle", async () => {
    const builder = new MockTransactionBuilder();
    const service = new ExecutionService(baseConfig, {
      transactionBuilder: builder as never,
      rpcPool: new MockRpcPool() as never,
      oracle: new MockOracle(5) as never,
      keypair,
      bus: new MockBus() as never
    });

    const sellOrder = { ...baseOrder, side: "sell" as const };
    await service.executeOrder(sellOrder);
    expect(builder.lastAmount).toBe(Math.floor((250 / 5) * 10 ** 9));
  });

  it("returns failed result when decimals are missing", async () => {
    const builder = new MockTransactionBuilder();
    const service = new ExecutionService(
      { ...baseConfig, mintDecimals: { USDC: 6 } },
      {
        transactionBuilder: builder as never,
        rpcPool: new MockRpcPool() as never,
        oracle: new MockOracle(5) as never,
        keypair,
        bus: new MockBus() as never
      }
    );

    const result = await service.executeOrder({ ...baseOrder, side: "sell" });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("missing decimals");
  });

  it("publishes execution results via handler", async () => {
    const builder = new MockTransactionBuilder();
    const bus = new MockBus();
    const service = new ExecutionService(baseConfig, {
      transactionBuilder: builder as never,
      rpcPool: new MockRpcPool() as never,
      oracle: new MockOracle(2) as never,
      keypair,
      bus: bus as never
    });

    await service.handleMessage(JSON.stringify(baseOrder));
    expect(bus.published).toHaveLength(1);
  });

  it("retries quote failures", async () => {
    const builder = new MockTransactionBuilder(true);
    const service = new ExecutionService(baseConfig, {
      transactionBuilder: builder as never,
      rpcPool: new MockRpcPool() as never,
      oracle: new MockOracle(2) as never,
      keypair,
      bus: new MockBus() as never
    });

    const result = await service.executeOrder(baseOrder);
    expect(result.status).toBe("filled");
  });
});
