import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import pino from "pino";
import { createClient, type RedisClientType } from "redis";
import { loadConfig } from "./config.js";
import { createSequelize, initModels } from "./db.js";
import { PortfolioRepository } from "./portfolioRepository.js";

const createPublisher = (url: string, logger: pino.Logger): RedisClientType => {
  const client = createClient({ url });
  client.on("error", (error) => {
    logger.error({ error: error.message }, "redis publisher error");
  });
  return client;
};

const startServer = async (): Promise<void> => {
  const config = loadConfig();
  const logger = pino({ name: "portfolio-service", level: config.logLevel });
  const sequelize = createSequelize({
    url: config.database.url,
    ssl: config.database.ssl,
    logging: false
  });
  const models = initModels(sequelize);
  await sequelize.sync();

  const repository = new PortfolioRepository(sequelize, models);
  const publisher = createPublisher(config.redisUrl, logger);
  await publisher.connect();

  const app = express();
  app.use(express.json());

  app.get("/positions", async (_req, res) => {
    const positions = await repository.fetchPositions();
    res.json({ positions });
  });

  app.get("/pnl", async (_req, res) => {
    const pnl = await repository.fetchPnl();
    res.json(pnl);
  });

  app.post("/refresh", async (_req, res) => {
    const result = await repository.refreshFromTrades();
    const message = {
      id: crypto.randomUUID(),
      topic: "portfolio_updates",
      timestamp: new Date().toISOString(),
      positions: result.positions,
      ...result.pnl
    };
    await publisher.publish("portfolio_updates", JSON.stringify(message));
    res.json({ refreshed: true, ...result });
  });

  const server = http.createServer(app);
  server.listen(config.port, () => {
    logger.info({ port: config.port }, "portfolio service listening");
  });

  const shutdown = async (): Promise<void> => {
    logger.info("shutting down portfolio service");
    server.close();
    await publisher.disconnect();
    await sequelize.close();
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
};

if (process.env.NODE_ENV !== "test") {
  void startServer();
}
