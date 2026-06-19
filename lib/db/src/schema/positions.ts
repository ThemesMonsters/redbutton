import { pgTable, serial, text, numeric, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const positionsTable = pgTable("positions", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  entryPrice: numeric("entry_price", { precision: 20, scale: 8 }).notNull(),
  quantity: numeric("quantity", { precision: 20, scale: 8 }).notNull(),
  leverage: integer("leverage").notNull().default(1),
  strategy: text("strategy").notNull().default("manual"),
  mode: text("mode").notNull().default("paper"),
  stopLoss: numeric("stop_loss", { precision: 20, scale: 8 }),
  takeProfit: numeric("take_profit", { precision: 20, scale: 8 }),
  bybitOrderId: text("bybit_order_id"),
  isOpen: boolean("is_open").notNull().default(true),
  averageCount: integer("average_count").notNull().default(0),
  parentPositionId: integer("parent_position_id"),
  presetName: text("preset_name"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const insertPositionSchema = createInsertSchema(positionsTable).omit({ id: true, openedAt: true, closedAt: true });
export type InsertPosition = z.infer<typeof insertPositionSchema>;
export type PositionRow = typeof positionsTable.$inferSelect;
