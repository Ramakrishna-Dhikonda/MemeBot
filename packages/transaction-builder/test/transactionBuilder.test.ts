import { describe, expect, it } from "vitest";
import { TransactionBuilder } from "../src/index.js";

describe("TransactionBuilder", () => {
  it("accepts configuration", () => {
    const builder = new TransactionBuilder({ baseUrl: "https://quote-api.jup.ag", slippageBps: 50 });
    expect(builder).toBeDefined();
  });
});
