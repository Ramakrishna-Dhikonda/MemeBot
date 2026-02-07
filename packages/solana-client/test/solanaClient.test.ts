import { describe, expect, it } from "vitest";
import { SolanaRpcPool } from "../src/index.js";

const dummyConfig = {
  endpoints: ["https://api.mainnet-beta.solana.com", "https://example.invalid"],
  commitment: "confirmed",
  maxRetries: 1,
  retryDelayMs: 1
} as const;

describe("SolanaRpcPool", () => {
  it("rotates endpoints", () => {
    const pool = new SolanaRpcPool(dummyConfig);
    const first = pool.connection.rpcEndpoint;
    pool.rotateEndpoint();
    const second = pool.connection.rpcEndpoint;
    expect(first).not.toBe(second);
  });
});
