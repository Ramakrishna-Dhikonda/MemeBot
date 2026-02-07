import { DataTypes, Model, Sequelize } from "sequelize";

export type DatabaseConfig = {
  url: string;
  ssl: boolean;
  logging?: boolean;
  dialect?: "postgres" | "sqlite";
  storage?: string;
};

export type PositionAttributes = {
  id: string;
  symbol: string;
  quantity: number;
  avgEntryPriceUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  createdAt?: Date;
  updatedAt?: Date;
};

export type TradeAttributes = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  priceUsd: number;
  executedAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
};

export class Position
  extends Model<PositionAttributes, Omit<PositionAttributes, "id">>
  implements PositionAttributes
{
  declare id: string;
  declare symbol: string;
  declare quantity: number;
  declare avgEntryPriceUsd: number;
  declare realizedPnlUsd: number;
  declare unrealizedPnlUsd: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

export class Trade
  extends Model<TradeAttributes, Omit<TradeAttributes, "id">>
  implements TradeAttributes
{
  declare id: string;
  declare symbol: string;
  declare side: "buy" | "sell";
  declare quantity: number;
  declare priceUsd: number;
  declare executedAt: Date;
  declare createdAt: Date;
  declare updatedAt: Date;
}

export type PortfolioModels = {
  Position: typeof Position;
  Trade: typeof Trade;
};

export const createSequelize = (config: DatabaseConfig): Sequelize => {
  const dialect = config.dialect ?? "postgres";
  if (dialect === "sqlite") {
    return new Sequelize({
      dialect: "sqlite",
      storage: config.storage ?? ":memory:",
      logging: config.logging ?? false
    });
  }

  return new Sequelize(config.url, {
    dialect: "postgres",
    logging: config.logging ?? false,
    dialectOptions: config.ssl
      ? {
          ssl: {
            require: true,
            rejectUnauthorized: false
          }
        }
      : undefined
  });
};

export const initModels = (sequelize: Sequelize): PortfolioModels => {
  Position.init(
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      symbol: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
      },
      quantity: {
        type: DataTypes.DOUBLE,
        allowNull: false
      },
      avgEntryPriceUsd: {
        type: DataTypes.DOUBLE,
        allowNull: false
      },
      realizedPnlUsd: {
        type: DataTypes.DOUBLE,
        allowNull: false
      },
      unrealizedPnlUsd: {
        type: DataTypes.DOUBLE,
        allowNull: false
      }
    },
    {
      sequelize,
      tableName: "positions"
    }
  );

  Trade.init(
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      symbol: {
        type: DataTypes.STRING,
        allowNull: false
      },
      side: {
        type: DataTypes.ENUM("buy", "sell"),
        allowNull: false
      },
      quantity: {
        type: DataTypes.DOUBLE,
        allowNull: false
      },
      priceUsd: {
        type: DataTypes.DOUBLE,
        allowNull: false
      },
      executedAt: {
        type: DataTypes.DATE,
        allowNull: false
      }
    },
    {
      sequelize,
      tableName: "trades",
      indexes: [{ fields: ["symbol", "executedAt"] }]
    }
  );

  return { Position, Trade };
};
