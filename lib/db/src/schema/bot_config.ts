import { pgTable, serial, text, numeric, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botConfigTable = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  symbols: text("symbols").array().notNull().default(["BTCUSDT", "ETHUSDT", "SOLUSDT"]),
  mode: text("mode").notNull().default("paper"),
  strategies: text("strategies").array().notNull().default(["volume_profile"]),
  positionSizeUsdt: numeric("position_size_usdt", { precision: 14, scale: 4 }).notNull().default("2"),
  maxPositions: integer("max_positions").notNull().default(3),
  leverage: integer("leverage").notNull().default(5),
  stopLossUsdt: numeric("stop_loss_usdt", { precision: 14, scale: 4 }).notNull().default("2"),
  takeProfitUsdt: numeric("take_profit_usdt", { precision: 14, scale: 4 }).notNull().default("0.4"),
  paperBalance: numeric("paper_balance", { precision: 14, scale: 2 }).notNull().default("10000"),
  averagingEnabled: boolean("averaging_enabled").notNull().default(false),
  averagingThresholdPercent: numeric("averaging_threshold_percent", { precision: 10, scale: 4 }).notNull().default("80"),
  maxAveragingCount: integer("max_averaging_count").notNull().default(2),
  slippagePercent: numeric("slippage_percent", { precision: 10, scale: 4 }).notNull().default("0.05"),
  takerFeeRate: numeric("taker_fee_rate", { precision: 10, scale: 6 }).notNull().default("0.00055"),
  indicatorLookback: integer("indicator_lookback").notNull().default(100),
  volumeProfileParams: jsonb("volume_profile_params").default({ lookbackBars: 100, valueBars: 20, pocTolerance: 0.001 }),
  fibonacciParams: jsonb("fibonacci_params").default({ swingLookback: 50, levels: [0.236, 0.382, 0.5, 0.618, 0.786], entryLevel: 0.618 }),
  orderBlockParams: jsonb("order_block_params").default({ lookbackBars: 50, minImpulsePercent: 1.5, mitigation: true }),
  strategyMode: text("strategy_mode").notNull().default("OR"),
  timeframe: text("timeframe").notNull().default("60"),
  rsiParams: jsonb("rsi_params").default({ period: 14, oversoldLevel: 30, overboughtLevel: 70 }),
  liveInitialBalance: numeric("live_initial_balance", { precision: 14, scale: 2 }).notNull().default("0"),
  bybitApiKey: text("bybit_api_key"),
  bybitApiSecret: text("bybit_api_secret"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBotConfigSchema = createInsertSchema(botConfigTable).omit({ id: true });
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type BotConfigRow = typeof botConfigTable.$inferSelect;
