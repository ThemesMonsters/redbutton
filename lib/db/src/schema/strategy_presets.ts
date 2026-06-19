import { pgTable, serial, text, numeric, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const strategyPresetsTable = pgTable("strategy_presets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  symbols: text("symbols").array().notNull().default(["BTCUSDT"]),
  strategies: text("strategies").array().notNull().default(["volume_profile"]),
  strategyMode: text("strategy_mode").notNull().default("OR"),
  positionSizeUsdt: numeric("position_size_usdt", { precision: 14, scale: 4 }).notNull().default("1"),
  leverage: integer("leverage").notNull().default(10),
  maxPositions: integer("max_positions").notNull().default(3),
  stopLossUsdt: numeric("stop_loss_usdt", { precision: 14, scale: 4 }).notNull().default("1"),
  takeProfitUsdt: numeric("take_profit_usdt", { precision: 14, scale: 4 }).notNull().default("2"),
  averagingEnabled: boolean("averaging_enabled").notNull().default(false),
  averagingThresholdPercent: numeric("averaging_threshold_percent", { precision: 10, scale: 4 }).notNull().default("80"),
  maxAveragingCount: integer("max_averaging_count").notNull().default(2),
  averagingAmountUsdt: numeric("averaging_amount_usdt", { precision: 14, scale: 4 }).notNull().default("1"),
  timeframe: text("timeframe").notNull().default("60"),
  volumeProfileParams: jsonb("volume_profile_params").default({ lookbackBars: 100, pocTolerance: 0.005 }),
  fibonacciParams: jsonb("fibonacci_params").default({ entryLevel: 0.618, slLevel: 0.786 }),
  orderBlockParams: jsonb("order_block_params").default({ lookbackBars: 50, minImpulsePercent: 1.5 }),
  rsiParams: jsonb("rsi_params").default({ period: 14, oversoldLevel: 30, overboughtLevel: 70 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertStrategyPresetSchema = createInsertSchema(strategyPresetsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertStrategyPreset = z.infer<typeof insertStrategyPresetSchema>;
export type StrategyPresetRow = typeof strategyPresetsTable.$inferSelect;
