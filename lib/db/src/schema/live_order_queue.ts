import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const liveOrderQueueTable = pgTable("live_order_queue", {
  id: serial("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  status: text("status").notNull().default("pending"),
  method: text("method").notNull().default("POST"),
  url: text("url").notNull(),
  body: text("body").notNull(),
  apiKey: text("api_key").notNull(),
  sign: text("sign").notNull(),
  ts: text("ts").notNull(),
  recvWindow: text("recv_window").notNull().default("30000"),
  bybitOrderId: text("bybit_order_id"),
  responseBody: text("response_body"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
});
