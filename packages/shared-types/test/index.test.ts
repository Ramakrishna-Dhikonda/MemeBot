import { describe, expect, it } from "vitest";
import type { TradeSignal } from "../src/index.js";

describe("shared-types", () => {
  it("enforces trade signal structure", () => {
    const signal: TradeSignal = {
      id: "sig-1",
      topic: "trade_signals",
      timestamp: new Date().toISOString(),
      strategy: "sniper",
      mintAddress: "Mint111",
      side: "buy",
      confidence: 0.9,
      expectedSlippageBps: 50
    };

    expect(signal.strategy).toBe("sniper");
  });
});
