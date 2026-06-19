import { Router } from "express";
import { db } from "@workspace/db";
import { botConfigTable, positionsTable, tradesTable, signalsTable } from "@workspace/db";
import { isRunning, getStartedAt, startBot, stopBot, syncPositionsFromBybit } from "../lib/bot-engine";
import { isWsConnected } from "../lib/market-feed";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

const router = Router();

async function getOrCreateConfig() {
  const configs = await db.select().from(botConfigTable).limit(1);
  if (configs.length) return configs[0];
  const [created] = await db.insert(botConfigTable).values({}).returning();
  return created;
}

function serializeConfig(config: typeof botConfigTable.$inferSelect) {
  return {
    id: config.id,
    symbols: config.symbols,
    mode: config.mode,
    strategies: config.strategies,
    positionSizeUsdt: parseFloat(config.positionSizeUsdt),
    maxPositions: config.maxPositions,
    leverage: config.leverage,
    stopLossUsdt: parseFloat(config.stopLossUsdt),
    takeProfitUsdt: parseFloat(config.takeProfitUsdt),
    paperBalance: parseFloat(config.paperBalance),
    averagingEnabled: config.averagingEnabled,
    averagingThresholdPercent: parseFloat(config.averagingThresholdPercent),
    maxAveragingCount: config.maxAveragingCount,
    takerFeeRate: parseFloat(config.takerFeeRate),
    volumeProfileParams: config.volumeProfileParams,
    fibonacciParams: config.fibonacciParams,
    orderBlockParams: config.orderBlockParams,
    updatedAt: config.updatedAt.toISOString(),
    wsConnected: isWsConnected(),
  };
}

router.get("/status", async (req, res) => {
  try {
    const config = await getOrCreateConfig();
    const openPositions = await db.select().from(positionsTable).where(eq(positionsTable.isOpen, true));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTrades = await db.select().from(tradesTable).where(sql`${tradesTable.closedAt} >= ${today}`);
    const todayPnl = todayTrades.reduce((sum, t) => sum + parseFloat(t.pnl), 0);
    const totalValue = openPositions.reduce((sum, p) => sum + parseFloat(p.entryPrice) * parseFloat(p.quantity), 0) || 10000;
    const todayPnlPercent = (todayPnl / totalValue) * 100;
    const lastSignal = await db.select().from(signalsTable).orderBy(sql`${signalsTable.createdAt} DESC`).limit(1);
    const startedAt = getStartedAt();
    const uptime = startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 1000) : null;

    res.json({
      running: isRunning(),
      mode: config.mode,
      activeSymbol: (config.symbols || [])[0] || "BTCUSDT",
      uptime,
      openPositionsCount: openPositions.length,
      todayPnl,
      todayPnlPercent,
      lastSignalAt: lastSignal[0]?.createdAt?.toISOString() || null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get bot status");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/start", async (req, res) => {
  try {
    await startBot();
    const config = await getOrCreateConfig();
    const openPositions = await db.select().from(positionsTable).where(eq(positionsTable.isOpen, true));
    res.json({
      running: true,
      mode: config.mode,
      activeSymbol: (config.symbols || [])[0] || "BTCUSDT",
      uptime: 0,
      openPositionsCount: openPositions.length,
      todayPnl: 0,
      todayPnlPercent: 0,
      lastSignalAt: null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to start bot");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/stop", async (req, res) => {
  try {
    await stopBot();
    const config = await getOrCreateConfig();
    res.json({
      running: false,
      mode: config.mode,
      activeSymbol: (config.symbols || [])[0] || "BTCUSDT",
      uptime: null,
      openPositionsCount: 0,
      todayPnl: 0,
      todayPnlPercent: 0,
      lastSignalAt: null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to stop bot");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/sync-positions", async (req, res) => {
  try {
    const result = await syncPositionsFromBybit();
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to sync positions from Bybit");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/config", async (req, res) => {
  try {
    const config = await getOrCreateConfig();
    res.json(serializeConfig(config));
  } catch (err) {
    req.log.error({ err }, "Failed to get bot config");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/config", async (req, res) => {
  try {
    const config = await getOrCreateConfig();
    const body = req.body;
    const [updated] = await db.update(botConfigTable)
      .set({
        symbols: body.symbols ?? config.symbols,
        mode: body.mode ?? config.mode,
        strategies: body.strategies ?? config.strategies,
        positionSizeUsdt: body.positionSizeUsdt != null ? String(body.positionSizeUsdt) : config.positionSizeUsdt,
        maxPositions: body.maxPositions ?? config.maxPositions,
        leverage: body.leverage ?? config.leverage,
        stopLossUsdt: body.stopLossUsdt != null ? String(body.stopLossUsdt) : config.stopLossUsdt,
        takeProfitUsdt: body.takeProfitUsdt != null ? String(body.takeProfitUsdt) : config.takeProfitUsdt,
        paperBalance: body.paperBalance != null ? String(body.paperBalance) : config.paperBalance,
        averagingEnabled: body.averagingEnabled != null ? body.averagingEnabled : config.averagingEnabled,
        averagingThresholdPercent: body.averagingThresholdPercent != null ? String(body.averagingThresholdPercent) : config.averagingThresholdPercent,
        maxAveragingCount: body.maxAveragingCount ?? config.maxAveragingCount,
        takerFeeRate: body.takerFeeRate != null ? String(body.takerFeeRate) : config.takerFeeRate,
        volumeProfileParams: body.volumeProfileParams ?? config.volumeProfileParams,
        fibonacciParams: body.fibonacciParams ?? config.fibonacciParams,
        orderBlockParams: body.orderBlockParams ?? config.orderBlockParams,
      })
      .where(eq(botConfigTable.id, config.id))
      .returning();

    // If bot is running, update subscriptions for new symbols
    if (isRunning() && body.symbols) {
      const { updateSubscriptions } = await import("../lib/market-feed");
      updateSubscriptions(body.symbols);
    }

    res.json(serializeConfig(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update bot config");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
