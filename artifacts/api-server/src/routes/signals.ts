import { Router } from "express";
import { db } from "@workspace/db";
import { signalsTable } from "@workspace/db";
import { desc } from "drizzle-orm";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { limit = "20" } = req.query as { limit?: string };
    const lim = Math.min(parseInt(limit) || 20, 200);
    const rows = await db.select().from(signalsTable).orderBy(desc(signalsTable.createdAt)).limit(lim);
    res.json(rows.map(s => ({
      id: s.id,
      symbol: s.symbol,
      strategy: s.strategy,
      direction: s.direction,
      strength: parseFloat(s.strength),
      price: parseFloat(s.price),
      description: s.description,
      acted: s.acted,
      createdAt: s.createdAt.toISOString(),
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to list signals");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
