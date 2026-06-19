import { Router } from "express";
import { db } from "@workspace/db";
import { positionsTable, tradesTable, botConfigTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getCurrentPrice } from "../lib/market-feed";
import { placeMarketOrder, closeMarketOrder, hasApiKeys } from "../lib/bybit-client";

const router = Router();

function enrichPosition(p: typeof positionsTable.$inferSelect, currentPrice: number) {
  const price = currentPrice > 0 ? currentPrice : parseFloat(p.entryPrice);
  const qty = parseFloat(p.quantity);
  const entry = parseFloat(p.entryPrice);
  const leverage = p.leverage ?? 1;
  const pnl = p.side === "long" ? (price - entry) * qty : (entry - price) * qty;
  const margin = entry > 0 && qty > 0 ? (entry * qty) / Math.max(leverage, 1) : 0;
  const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;
  return {
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    entryPrice: entry,
    currentPrice: price,
    quantity: qty,
    leverage: p.leverage,
    unrealizedPnl: pnl,
    unrealizedPnlPercent: pnlPct,
    strategy: p.strategy,
    mode: p.mode,
    stopLoss: p.stopLoss ? parseFloat(p.stopLoss) : null,
    takeProfit: p.takeProfit ? parseFloat(p.takeProfit) : null,
    openedAt: p.openedAt.toISOString(),
    bybitOrderId: p.bybitOrderId,
    presetName: p.presetName ?? null,
  };
}

router.get("/", async (req, res) => {
  try {
    const { mode } = req.query as { mode?: string };
    let rows;
    if (mode && mode !== "all") {
      rows = await db.select().from(positionsTable)
        .where(and(eq(positionsTable.isOpen, true), eq(positionsTable.mode, mode)))
        .orderBy(desc(positionsTable.openedAt));
    } else {
      rows = await db.select().from(positionsTable)
        .where(eq(positionsTable.isOpen, true))
        .orderBy(desc(positionsTable.openedAt));
    }
    const enriched = rows.map(p => enrichPosition(p, getCurrentPrice(p.symbol)));
    res.json(enriched);
  } catch (err) {
    req.log.error({ err }, "Failed to list positions");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const body = req.body;
    const currentPrice = getCurrentPrice(body.symbol);
    let bybitOrderId: string | null = null;

    if (body.mode === "live") {
      if (!hasApiKeys()) { res.status(400).json({ error: "API keys required for live trading" }); return; }
      const side = body.side === "long" ? "Buy" : "Sell";
      bybitOrderId = await placeMarketOrder(body.symbol, side, body.quantity, body.leverage);
      if (!bybitOrderId) { res.status(500).json({ error: "Failed to place order on Bybit" }); return; }
    }

    const entryPrice = currentPrice > 0 ? currentPrice : 0;
    const [pos] = await db.insert(positionsTable).values({
      symbol: body.symbol,
      side: body.side,
      entryPrice: String(entryPrice),
      quantity: String(body.quantity),
      leverage: body.leverage,
      strategy: "manual",
      mode: body.mode,
      stopLoss: body.stopLoss != null ? String(body.stopLoss) : null,
      takeProfit: body.takeProfit != null ? String(body.takeProfit) : null,
      bybitOrderId,
      isOpen: true,
    }).returning();

    res.status(201).json(enrichPosition(pos, currentPrice));
  } catch (err) {
    req.log.error({ err }, "Failed to open position");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [pos] = await db.select().from(positionsTable).where(eq(positionsTable.id, id));
    if (!pos) { res.status(404).json({ error: "Position not found" }); return; }
    res.json(enrichPosition(pos, getCurrentPrice(pos.symbol)));
  } catch (err) {
    req.log.error({ err }, "Failed to get position");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [pos] = await db.select().from(positionsTable).where(eq(positionsTable.id, id));
    if (!pos) { res.status(404).json({ error: "Position not found" }); return; }

    const price = getCurrentPrice(pos.symbol);
    const exitPrice = price > 0 ? price : parseFloat(pos.entryPrice);

    if (pos.mode === "live" && pos.bybitOrderId) {
      const side = pos.side === "long" ? "Buy" : "Sell";
      await closeMarketOrder(pos.symbol, side, parseFloat(pos.quantity));
    }

    const qty = parseFloat(pos.quantity);
    const entry = parseFloat(pos.entryPrice);
    const leverage = pos.leverage ?? 1;
    const pnl = pos.side === "long" ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
    const margin = entry > 0 && qty > 0 ? (entry * qty) / Math.max(leverage, 1) : 0;
    const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;

    await db.update(positionsTable).set({ isOpen: false, closedAt: new Date() }).where(eq(positionsTable.id, id));
    await db.insert(tradesTable).values({
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: String(exitPrice),
      quantity: pos.quantity,
      leverage: pos.leverage,
      pnl: String(pnl),
      pnlPercent: String(pnlPct),
      strategy: pos.strategy,
      mode: pos.mode,
      bybitOrderId: pos.bybitOrderId,
      openedAt: pos.openedAt,
    });

    const [closed] = await db.select().from(positionsTable).where(eq(positionsTable.id, id));
    res.json(enrichPosition(closed, exitPrice));
  } catch (err) {
    req.log.error({ err }, "Failed to close position");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
