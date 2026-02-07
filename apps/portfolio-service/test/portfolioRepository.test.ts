import { createSequelize, initModels } from "../src/db.js";
import { PortfolioRepository } from "../src/portfolioRepository.js";

describe("PortfolioRepository", () => {
  it("rebuilds positions and pnl from trade history", async () => {
    const sequelize = createSequelize({
      url: "sqlite",
      ssl: false,
      dialect: "sqlite",
      storage: ":memory:",
      logging: false
    });
    const models = initModels(sequelize);
    await sequelize.sync();

    await models.Trade.bulkCreate([
      {
        symbol: "SOL",
        side: "buy",
        quantity: 10,
        priceUsd: 100,
        executedAt: new Date("2024-01-01T00:00:00Z")
      },
      {
        symbol: "SOL",
        side: "buy",
        quantity: 5,
        priceUsd: 120,
        executedAt: new Date("2024-01-02T00:00:00Z")
      },
      {
        symbol: "SOL",
        side: "sell",
        quantity: 8,
        priceUsd: 130,
        executedAt: new Date("2024-01-03T00:00:00Z")
      }
    ]);

    const repository = new PortfolioRepository(sequelize, models);
    const result = await repository.refreshFromTrades();
    const positions = await repository.fetchPositions();
    const pnl = await repository.fetchPnl();

    expect(result.positions).toHaveLength(1);
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe("SOL");
    expect(positions[0].quantity).toBeCloseTo(7);
    expect(positions[0].avgEntryPriceUsd).toBeCloseTo(106.6667, 3);
    expect(positions[0].realizedPnlUsd).toBeCloseTo(186.6667, 3);
    expect(positions[0].unrealizedPnlUsd).toBeCloseTo(163.3333, 3);

    expect(pnl.totalRealizedPnlUsd).toBeCloseTo(186.6667, 3);
    expect(pnl.totalUnrealizedPnlUsd).toBeCloseTo(163.3333, 3);

    await sequelize.close();
  });
});
