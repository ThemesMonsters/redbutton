import { Router } from "express";
import { db } from "@workspace/db";
import { strategyPresetsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

function serializePreset(p: typeof strategyPresetsTable.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    enabled: p.enabled,
    symbols: p.symbols,
    strategies: p.strategies,
    strategyMode: p.strategyMode,
    positionSizeUsdt: parseFloat(p.positionSizeUsdt),
    leverage: p.leverage,
    maxPositions: p.maxPositions,
    stopLossUsdt: parseFloat(p.stopLossUsdt),
    takeProfitUsdt: parseFloat(p.takeProfitUsdt),
    averagingEnabled: p.averagingEnabled,
    averagingThresholdPercent: parseFloat(p.averagingThresholdPercent),
    maxAveragingCount: p.maxAveragingCount,
    averagingAmountUsdt: parseFloat(p.averagingAmountUsdt),
    timeframe: p.timeframe,
    volumeProfileParams: p.volumeProfileParams,
    fibonacciParams: p.fibonacciParams,
    orderBlockParams: p.orderBlockParams,
    rsiParams: p.rsiParams,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

// GET /api/strategy-presets — list all presets
router.get("/", async (req, res) => {
  try {
    const presets = await db.select().from(strategyPresetsTable).orderBy(strategyPresetsTable.createdAt);
    res.json(presets.map(serializePreset));
  } catch (err) {
    (req as any).log.error({ err }, "Failed to list strategy presets");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/strategy-presets — create preset
router.post("/", async (req, res) => {
  try {
    const body = req.body as any;
    const [created] = await db.insert(strategyPresetsTable).values({
      name: body.name || "New Strategy",
      enabled: body.enabled ?? true,
      symbols: body.symbols || ["BTCUSDT"],
      strategies: body.strategies || ["volume_profile"],
      strategyMode: body.strategyMode || "OR",
      positionSizeUsdt: String(body.positionSizeUsdt ?? 1),
      leverage: body.leverage ?? 10,
      maxPositions: body.maxPositions ?? 3,
      stopLossUsdt: String(body.stopLossUsdt ?? 1),
      takeProfitUsdt: String(body.takeProfitUsdt ?? 2),
      averagingEnabled: body.averagingEnabled ?? false,
      averagingThresholdPercent: String(body.averagingThresholdPercent ?? 80),
      maxAveragingCount: body.maxAveragingCount ?? 2,
      averagingAmountUsdt: String(body.averagingAmountUsdt ?? 1),
      timeframe: body.timeframe || "60",
      volumeProfileParams: body.volumeProfileParams || { lookbackBars: 100, pocTolerance: 0.005 },
      fibonacciParams: body.fibonacciParams || { entryLevel: 0.618, slLevel: 0.786 },
      orderBlockParams: body.orderBlockParams || { lookbackBars: 50, minImpulsePercent: 1.5 },
      rsiParams: body.rsiParams || { period: 14, oversoldLevel: 30, overboughtLevel: 70 },
    }).returning();
    res.status(201).json(serializePreset(created));
  } catch (err) {
    (req as any).log.error({ err }, "Failed to create strategy preset");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/strategy-presets/:id — update preset
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const body = req.body as any;
    const updates: Partial<typeof strategyPresetsTable.$inferInsert> = {};
    if (body.name             !== undefined) updates.name             = body.name;
    if (body.enabled          !== undefined) updates.enabled          = body.enabled;
    if (body.symbols          !== undefined) updates.symbols          = body.symbols;
    if (body.strategies       !== undefined) updates.strategies       = body.strategies;
    if (body.strategyMode     !== undefined) updates.strategyMode     = body.strategyMode;
    if (body.positionSizeUsdt !== undefined) updates.positionSizeUsdt = String(body.positionSizeUsdt);
    if (body.leverage         !== undefined) updates.leverage         = body.leverage;
    if (body.maxPositions     !== undefined) updates.maxPositions     = body.maxPositions;
    if (body.stopLossUsdt     !== undefined) updates.stopLossUsdt     = String(body.stopLossUsdt);
    if (body.takeProfitUsdt   !== undefined) updates.takeProfitUsdt   = String(body.takeProfitUsdt);
    if (body.averagingEnabled !== undefined) updates.averagingEnabled = body.averagingEnabled;
    if (body.averagingThresholdPercent !== undefined) updates.averagingThresholdPercent = String(body.averagingThresholdPercent);
    if (body.maxAveragingCount !== undefined) updates.maxAveragingCount = body.maxAveragingCount;
    if (body.averagingAmountUsdt !== undefined) updates.averagingAmountUsdt = String(body.averagingAmountUsdt);
    if (body.timeframe        !== undefined) updates.timeframe        = body.timeframe;
    if (body.volumeProfileParams !== undefined) updates.volumeProfileParams = body.volumeProfileParams;
    if (body.fibonacciParams  !== undefined) updates.fibonacciParams  = body.fibonacciParams;
    if (body.orderBlockParams !== undefined) updates.orderBlockParams = body.orderBlockParams;
    if (body.rsiParams        !== undefined) updates.rsiParams        = body.rsiParams;

    const [updated] = await db.update(strategyPresetsTable).set(updates).where(eq(strategyPresetsTable.id, id)).returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(serializePreset(updated));
  } catch (err) {
    (req as any).log.error({ err }, "Failed to update strategy preset");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/strategy-presets/:id — delete preset
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    await db.delete(strategyPresetsTable).where(eq(strategyPresetsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    (req as any).log.error({ err }, "Failed to delete strategy preset");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
