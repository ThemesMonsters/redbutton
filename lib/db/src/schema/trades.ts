import { pgTable, serial, text, numeric, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  entryPrice: numeric("entry_price", { precision: 20, scale: 8 }).notNull(),
  exitPrice: numeric("exit_price", { precision: 20, scale: 8 }).notNull(),
  quantity: numeric("quantity", { precision: 20, scale: 8 }).notNull(),
  leverage: integer("leverage").notNull().default(1),
  pnl: numeric("pnl", { precision: 20, scale: 8 }).notNull(),
  pnlPercent: numeric("pnl_percent", { precision: 10, scale: 4 }).notNull(),
  strategy: text("strategy").notNull().default("manual"),
  mode: text("mode").notNull().default("paper"),
  bybitOrderId: text("bybit_order_id"),
  wasAveraged: boolean("was_averaged").notNull().default(false),
  averageCount: integer("average_count").notNull().default(0),
  presetName: text("preset_name"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type TradeRow = typeof tradesTable.$inferSelect;
