import { Router } from "express";
import { db } from "@workspace/db";
import { tradesTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { limit = "50", mode } = req.query as { limit?: string; mode?: string };
    const lim = Math.min(parseInt(limit) || 50, 500);
    let rows;
    if (mode && mode !== "all") {
      rows = await db.select().from(tradesTable).where(eq(tradesTable.mode, mode)).orderBy(desc(tradesTable.closedAt)).limit(lim);
    } else {
      rows = await db.select().from(tradesTable).orderBy(desc(tradesTable.closedAt)).limit(lim);
    }
    res.json(rows.map(t => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      entryPrice: parseFloat(t.entryPrice),
      exitPrice: parseFloat(t.exitPrice),
      quantity: parseFloat(t.quantity),
      leverage: t.leverage,
      pnl: parseFloat(t.pnl),
      pnlPercent: parseFloat(t.pnlPercent),
      strategy: t.strategy,
      mode: t.mode,
      openedAt: t.openedAt.toISOString(),
      closedAt: t.closedAt?.toISOString() ?? new Date().toISOString(),
      bybitOrderId: t.bybitOrderId,
      wasAveraged: t.wasAveraged ?? false,
      averageCount: t.averageCount ?? 0,
      presetName: t.presetName ?? null,
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to list trades");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
