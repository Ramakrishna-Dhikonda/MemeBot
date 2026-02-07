import {
  HeliusEventParser,
  IngestionService,
  type IngestionConfig,
  type Publisher
} from "../src/index.js";

const baseConfig: IngestionConfig = {
  helius: {
    wsUrl: "wss://example.com",
    apiKey: "test",
    requestId: 1,
    maxRetries: 1,
    retryDelayMs: 10,
    whaleThresholdUsd: 50000
  },
  redis: {
    url: "redis://localhost:6379",
    publishTimeoutMs: 100,
    publishRetries: 1,
    retryDelayMs: 5
  },
  defaultCreator: "creator",
  logLevel: "silent",
  port: 4001,
  timestampProvider: () => "2024-01-01T00:00:00.000Z"
};

class MockPublisher implements Publisher {
  public published: Array<{ channel: string; payload: unknown }> = [];
  async connect(): Promise<void> {
    return;
  }
  async publish(channel: string, payload: unknown, _timeoutMs: number): Promise<void> {
    this.published.push({ channel, payload });
  }
  async disconnect(): Promise<void> {
    return;
  }
}

interface HeliusTxInput {
  type?: string;
  signature?: string;
  feePayer?: string;
  tokenTransfers?: Array<{ mint?: string; tokenAmount?: number; tokenPrice?: number }>;
  nativeTransfers?: Array<{ amount?: number; price?: number }>;
  events?: {
    liquidity?: { poolAddress?: string; mint?: string; liquidityUsd?: number };
    token?: { mint?: string };
  };
}

describe("HeliusEventParser", () => {
  it("parses new token events", () => {
    const parser = new HeliusEventParser(baseConfig);
    const events = parser.parse({
      type: "TOKEN_MINT",
      feePayer: "creator-wallet",
      events: { token: { mint: "Mint111" } }
    });

    expect(events).toHaveLength(1);
    expect(events[0].topic).toBe("new_token_events");
    expect(events[0].mintAddress).toBe("Mint111");
  });

  it("parses liquidity events", () => {
    const parser = new HeliusEventParser(baseConfig);
    const events = parser.parse({
      type: "LIQUIDITY_ADD",
      signature: "PoolSig",
      events: { liquidity: { poolAddress: "Pool1", mint: "Mint1", liquidityUsd: 120000 } }
    });

    expect(events).toHaveLength(1);
    expect(events[0].topic).toBe("liquidity_events");
    expect(events[0].liquidityUsd).toBe(120000);
  });

  it("parses whale token transfers", () => {
    const parser = new HeliusEventParser(baseConfig);
    const events = parser.parse({
      tokenTransfers: [{ mint: "Mint2", tokenAmount: 1000, tokenPrice: 100 }]
    });

    expect(events).toHaveLength(1);
    expect(events[0].topic).toBe("whale_events");
    expect(events[0].amountUsd).toBe(100000);
  });

  it("parses whale native transfers", () => {
    const parser = new HeliusEventParser(baseConfig);
    const events = parser.parse({
      nativeTransfers: [{ amount: 100, price: 600 }]
    });

    expect(events).toHaveLength(1);
    expect(events[0].topic).toBe("whale_events");
    expect(events[0].mintAddress).toBe("SOL");
  });

  it("parses multiple event types in a single transaction", () => {
    const parser = new HeliusEventParser(baseConfig);
    const events = parser.parse({
      type: "TOKEN_MINT_LIQUIDITY",
      signature: "PoolSig",
      feePayer: "creator-wallet",
      tokenTransfers: [{ mint: "Mint2", tokenAmount: 1000, tokenPrice: 100 }],
      events: {
        token: { mint: "Mint111" },
        liquidity: { poolAddress: "Pool1", mint: "Mint1", liquidityUsd: 120000 }
      }
    });

    expect(events.map((event) => event.topic)).toEqual(
      expect.arrayContaining(["new_token_events", "liquidity_events", "whale_events"])
    );
  });
});

describe("IngestionService", () => {
  it("publishes parsed events", async () => {
    const publisher = new MockPublisher();
    const service = new IngestionService(baseConfig, { publisher });
    const events = await service.handleTransaction({
      type: "TOKEN_MINT",
      feePayer: "creator-wallet",
      events: { token: { mint: "Mint111" } }
    } as HeliusTxInput);

    expect(events).toHaveLength(1);
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0].channel).toBe("new_token_events");
  });

  it("publishes every event emitted by the parser", async () => {
    const publisher = new MockPublisher();
    const service = new IngestionService(baseConfig, { publisher });
    const events = await service.handleTransaction({
      type: "LIQUIDITY_ADD",
      signature: "PoolSig",
      tokenTransfers: [{ mint: "Mint2", tokenAmount: 1000, tokenPrice: 100 }],
      events: {
        liquidity: { poolAddress: "Pool1", mint: "Mint1", liquidityUsd: 120000 }
      }
    } as HeliusTxInput);

    expect(events).toHaveLength(2);
    expect(publisher.published).toHaveLength(2);
    expect(publisher.published.map((item) => item.channel)).toEqual(
      expect.arrayContaining(["liquidity_events", "whale_events"])
    );
  });
});
