import { pgTable, serial, text, numeric, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const signalsTable = pgTable("signals", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  strategy: text("strategy").notNull(),
  direction: text("direction").notNull(),
  strength: numeric("strength", { precision: 5, scale: 4 }).notNull(),
  price: numeric("price", { precision: 20, scale: 8 }).notNull(),
  description: text("description").notNull(),
  acted: boolean("acted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSignalSchema = createInsertSchema(signalsTable).omit({ id: true, createdAt: true });
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type SignalRow = typeof signalsTable.$inferSelect;
