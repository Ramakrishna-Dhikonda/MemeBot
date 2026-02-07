import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .optional()
    .default("postgres://postgres:postgres@localhost:5432/portfolio"),
  DATABASE_SSL: z.coerce.boolean().optional().default(false),
  REDIS_URL: z.string().min(1).optional().default("redis://localhost:6379"),
  PORT: z.coerce.number().int().positive().optional().default(4005),
  LOG_LEVEL: z.string().optional().default("info")
});

const configSchema = z.object({
  database: z.object({
    url: z.string().min(1),
    ssl: z.boolean()
  }),
  redisUrl: z.string().min(1),
  port: z.number().int().positive(),
  logLevel: z.string().min(1)
});

export type PortfolioConfig = z.infer<typeof configSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): PortfolioConfig => {
  const parsed = envSchema.parse(env);
  return configSchema.parse({
    database: {
      url: parsed.DATABASE_URL,
      ssl: parsed.DATABASE_SSL
    },
    redisUrl: parsed.REDIS_URL,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL
  });
};
