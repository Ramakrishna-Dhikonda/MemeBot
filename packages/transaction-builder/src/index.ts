import { PublicKey, Transaction } from "@solana/web3.js";
import pino from "pino";
import { z } from "zod";

const jupiterConfigSchema = z.object({
  baseUrl: z.string().url().default("https://quote-api.jup.ag"),
  slippageBps: z.number().int().positive().default(50)
});

export type JupiterConfig = z.infer<typeof jupiterConfigSchema>;

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: number;
}

export interface QuoteResponse {
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: Array<Record<string, unknown>>;
}

export interface SwapResponse {
  swapTransaction: string;
}

export class TransactionBuilder {
  private readonly config: JupiterConfig;
  private readonly logger = pino({ name: "transaction-builder" });

  constructor(config: JupiterConfig) {
    this.config = jupiterConfigSchema.parse(config);
  }

  async fetchQuote(request: QuoteRequest): Promise<QuoteResponse> {
    const url = new URL("/v6/quote", this.config.baseUrl);
    url.searchParams.set("inputMint", request.inputMint);
    url.searchParams.set("outputMint", request.outputMint);
    url.searchParams.set("amount", request.amount.toString());
    url.searchParams.set("slippageBps", this.config.slippageBps.toString());

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Jupiter quote failed: ${response.status}`);
    }

    const data = (await response.json()) as QuoteResponse;
    this.logger.info({ outAmount: data.outAmount }, "quote received");
    return data;
  }

  async fetchSwapTransaction(
    quote: QuoteResponse,
    userPublicKey: PublicKey
  ): Promise<Transaction> {
    const url = new URL("/v6/swap", this.config.baseUrl);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: userPublicKey.toBase58(),
        wrapAndUnwrapSol: true
      })
    });

    if (!response.ok) {
      throw new Error(`Jupiter swap failed: ${response.status}`);
    }

    const data = (await response.json()) as SwapResponse;
    const swapTransaction = Transaction.from(Buffer.from(data.swapTransaction, "base64"));

    return swapTransaction;
  }
}
