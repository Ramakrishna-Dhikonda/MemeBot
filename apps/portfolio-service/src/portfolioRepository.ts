import type { Sequelize } from "sequelize";
import type { PortfolioModels, PositionAttributes, TradeAttributes } from "./db.js";

export type PositionSnapshot = Omit<PositionAttributes, "id" | "createdAt" | "updatedAt">;
export type PnlSummary = {
  totalRealizedPnlUsd: number;
  totalUnrealizedPnlUsd: number;
};

export type RefreshResult = {
  positions: PositionSnapshot[];
  pnl: PnlSummary;
};

type PositionAccumulator = {
  symbol: string;
  quantity: number;
  avgEntryPriceUsd: number;
  realizedPnlUsd: number;
  lastPriceUsd: number;
};

export const computePositionsFromTrades = (
  trades: TradeAttributes[]
): { positions: PositionSnapshot[]; pnl: PnlSummary } => {
  const positions = new Map<string, PositionAccumulator>();

  for (const trade of trades) {
    const existing = positions.get(trade.symbol) ?? {
      symbol: trade.symbol,
      quantity: 0,
      avgEntryPriceUsd: 0,
      realizedPnlUsd: 0,
      lastPriceUsd: trade.priceUsd
    };

    if (trade.side === "buy") {
      const newQty = existing.quantity + trade.quantity;
      const totalCost = existing.quantity * existing.avgEntryPriceUsd + trade.quantity * trade.priceUsd;
      existing.quantity = newQty;
      existing.avgEntryPriceUsd = newQty > 0 ? totalCost / newQty : 0;
      existing.lastPriceUsd = trade.priceUsd;
    } else {
      const realized = (trade.priceUsd - existing.avgEntryPriceUsd) * trade.quantity;
      existing.realizedPnlUsd += realized;
      existing.quantity = Math.max(existing.quantity - trade.quantity, 0);
      if (existing.quantity === 0) {
        existing.avgEntryPriceUsd = 0;
      }
      existing.lastPriceUsd = trade.priceUsd;
    }

    positions.set(trade.symbol, existing);
  }

  const positionSnapshots: PositionSnapshot[] = [];
  let totalRealizedPnlUsd = 0;
  let totalUnrealizedPnlUsd = 0;

  for (const position of positions.values()) {
    const unrealized =
      position.quantity > 0
        ? (position.lastPriceUsd - position.avgEntryPriceUsd) * position.quantity
        : 0;
    const snapshot: PositionSnapshot = {
      symbol: position.symbol,
      quantity: position.quantity,
      avgEntryPriceUsd: position.avgEntryPriceUsd,
      realizedPnlUsd: position.realizedPnlUsd,
      unrealizedPnlUsd: unrealized
    };
    totalRealizedPnlUsd += position.realizedPnlUsd;
    totalUnrealizedPnlUsd += unrealized;
    positionSnapshots.push(snapshot);
  }

  return {
    positions: positionSnapshots,
    pnl: {
      totalRealizedPnlUsd,
      totalUnrealizedPnlUsd
    }
  };
};

export class PortfolioRepository {
  constructor(
    private readonly sequelize: Sequelize,
    private readonly models: PortfolioModels
  ) {}

  async fetchPositions(): Promise<PositionSnapshot[]> {
    const rows = await this.models.Position.findAll({ order: [["symbol", "ASC"]] });
    return rows.map((row) => {
      const data = row.get();
      return {
        symbol: data.symbol,
        quantity: data.quantity,
        avgEntryPriceUsd: data.avgEntryPriceUsd,
        realizedPnlUsd: data.realizedPnlUsd,
        unrealizedPnlUsd: data.unrealizedPnlUsd
      };
    });
  }

  async fetchPnl(): Promise<PnlSummary> {
    const positions = await this.fetchPositions();
    return positions.reduce(
      (acc, position) => {
        acc.totalRealizedPnlUsd += position.realizedPnlUsd;
        acc.totalUnrealizedPnlUsd += position.unrealizedPnlUsd;
        return acc;
      },
      { totalRealizedPnlUsd: 0, totalUnrealizedPnlUsd: 0 }
    );
  }

  async refreshFromTrades(): Promise<RefreshResult> {
    const trades = await this.models.Trade.findAll({ order: [["executedAt", "ASC"]] });
    const computed = computePositionsFromTrades(trades.map((trade) => trade.get()));

    await this.sequelize.transaction(async (transaction) => {
      await this.models.Position.destroy({ where: {}, truncate: true, transaction });
      if (computed.positions.length > 0) {
        await this.models.Position.bulkCreate(computed.positions, { transaction });
      }
    });

    return computed;
  }
}
