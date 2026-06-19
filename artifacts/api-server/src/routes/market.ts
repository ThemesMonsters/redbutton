import { Router } from "express";
import { db } from "@workspace/db";
import { botConfigTable, positionsTable, signalsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getAllTickers, getKlinesFromCache, getCurrentPrice, initMarketFeed, isWsConnected, ensureKlines } from "../lib/market-feed";
import { computeRSI } from "../lib/bot-engine";

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];

const router = Router();

let feedInitialized = false;
async function ensureFeed(symbols: string[]) {
  if (feedInitialized && isWsConnected()) return;
  feedInitialized = true;
  await initMarketFeed(symbols);
}


router.get("/ticker", async (req, res) => {
  try {
    const { symbol } = req.query as { symbol?: string };
    const symbols = symbol ? [symbol] : DEFAULT_SYMBOLS;
    await ensureFeed(symbols);
    const tickers = getAllTickers(symbols);
    res.json(tickers);
  } catch (err) {
    req.log.error({ err }, "Failed to get ticker");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/klines", async (req, res) => {
  try {
    const { symbol, interval = "60", limit = "200" } = req.query as { symbol?: string; interval?: string; limit?: string };
    if (!symbol) { res.status(400).json({ error: "symbol is required" }); return; }
    await ensureFeed([symbol]);
    await ensureKlines(symbol, interval);
    const klines = getKlinesFromCache(symbol, interval, parseInt(limit));
    res.json(klines);
  } catch (err) {
    req.log.error({ err }, "Failed to get klines");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/levels", async (req, res) => {
  try {
    const { symbol, interval = "60", strategies: strategiesQ } = req.query as {
      symbol?: string; interval?: string; strategies?: string;
    };
    if (!symbol) { res.status(400).json({ error: "symbol is required" }); return; }

    await ensureFeed([symbol]);

    const configs = await db.select().from(botConfigTable).limit(1);
    const config = configs[0];
    const enabledStrategies: string[] = strategiesQ
      ? strategiesQ.split(",")
      : (config?.strategies ?? ["volume_profile"]);

    const klines = getKlinesFromCache(symbol, interval, 300);
    const currentPrice = getCurrentPrice(symbol);

    // Unified indicator lookback — all indicators use the same N most-recent candles
    const indicatorLookback = Math.min(config?.indicatorLookback ?? 100, klines.length);
    const slice = klines.slice(-indicatorLookback);

    // ── Volume Profile POC + Histogram ────────────────────────────────
    let poc: number | null = null;
    let volumeProfile: { price: number; volume: number; relVol: number }[] = [];
    if (enabledStrategies.includes("volume_profile") && slice.length >= 10) {
      const vp = (config?.volumeProfileParams as any) || {};
      const pocTolerance = vp.pocTolerance || 0.001;
      poc = computePOC(slice, pocTolerance);
      volumeProfile = computeVolumeProfile(slice, 40);
    }

    // ── Fibonacci Levels ───────────────────────────────────────────────
    let fibHigh: number | null = null;
    let fibLow: number | null = null;
    const fibLevels: { ratio: number; price: number; label: string }[] = [];
    if (enabledStrategies.includes("fibonacci") && slice.length >= 10) {
      const fp = (config?.fibonacciParams as any) || {};
      const ratios: number[] = fp.levels || [0.236, 0.382, 0.5, 0.618, 0.786];
      fibHigh = Math.max(...slice.map((k: any) => k.high));
      fibLow = Math.min(...slice.map((k: any) => k.low));
      for (const ratio of ratios) {
        const price = fibHigh - (fibHigh - fibLow) * ratio;
        fibLevels.push({ ratio, price, label: `Fib ${(ratio * 100).toFixed(1)}%` });
      }
    }

    // ── Order Blocks (max 3, most recent) ─────────────────────────────
    const orderBlocks: { low: number; high: number; direction: "long" | "short" }[] = [];
    if (slice.length >= 10) {
      const op = (config?.orderBlockParams as any) || {};
      const minImpulse = (op.minImpulsePercent || 1.5) / 100;
      for (let i = slice.length - 3; i >= 1 && orderBlocks.length < 3; i--) {
        const curr = slice[i]; const next = slice[i + 1];
        if (!curr || !next) continue;
        const change = (next.close - curr.close) / Math.max(curr.close, 1);
        if (Math.abs(change) >= minImpulse) {
          orderBlocks.push({
            low: Math.min(curr.open, curr.close),
            high: Math.max(curr.open, curr.close),
            direction: change > 0 ? "long" : "short",
          });
        }
      }
    }

    // ── RSI ────────────────────────────────────────────────────────────
    let rsiValue: number | null = null;
    let rsiValues: { time: number; value: number }[] = [];
    if (klines.length >= 15) {
      const rp = (config?.rsiParams as any) || {};
      const rsiPeriod = rp.period || 14;
      const full = computeRSI(klines, rsiPeriod);
      rsiValues = full;
      rsiValue = full.length > 0 ? full[full.length - 1].value : null;
    }

    // ── Open positions for this symbol ─────────────────────────────────
    const positions = await db.select().from(positionsTable)
      .where(and(eq(positionsTable.symbol, symbol), eq(positionsTable.isOpen, true)));

    const openPositions = positions.map(p => {
      const qty = parseFloat(p.quantity);
      const entry = parseFloat(p.entryPrice);
      const pnl = p.side === "long"
        ? (currentPrice - entry) * qty
        : (entry - currentPrice) * qty;
      return {
        id: p.id,
        side: p.side,
        entryPrice: entry,
        quantity: qty,
        leverage: p.leverage,
        unrealizedPnl: pnl,
        stopLoss: p.stopLoss ? parseFloat(p.stopLoss) : null,
        takeProfit: p.takeProfit ? parseFloat(p.takeProfit) : null,
      };
    });

    // ── Recent signals for this symbol ─────────────────────────────────
    const rawSignals = await db.select().from(signalsTable)
      .where(eq(signalsTable.symbol, symbol))
      .orderBy(desc(signalsTable.createdAt))
      .limit(10);

    const recentSignals = rawSignals.map(s => ({
      strategy: s.strategy,
      direction: s.direction,
      price: parseFloat(s.price),
      strength: parseFloat(s.strength),
      createdAt: s.createdAt.toISOString(),
    }));

    res.json({
      symbol,
      currentPrice,
      poc,
      fibHigh,
      fibLow,
      fibLevels,
      orderBlocks,
      openPositions,
      recentSignals,
      rsiValue,
      rsiValues,
      volumeProfile,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get strategy levels");
    res.status(500).json({ error: "Internal server error" });
  }
});

function computePOC(klines: any[], tolerance = 0.001): number {
  if (!klines.length) return 0;
  const priceVolMap = new Map<number, number>();
  for (const k of klines) {
    const bucket = Math.round(((k.high + k.low) / 2) / (k.close * tolerance)) * (k.close * tolerance);
    priceVolMap.set(bucket, (priceVolMap.get(bucket) || 0) + k.volume);
  }
  let maxVol = 0; let poc = 0;
  for (const [price, vol] of priceVolMap) {
    if (vol > maxVol) { maxVol = vol; poc = price; }
  }
  return poc;
}

function computeVolumeProfile(klines: any[], numBuckets = 40): { price: number; volume: number; relVol: number }[] {
  if (!klines.length) return [];
  const high = Math.max(...klines.map((k: any) => k.high));
  const low = Math.min(...klines.map((k: any) => k.low));
  const range = high - low;
  if (range === 0) return [];

  const bucketSize = range / numBuckets;
  const buckets = new Array<number>(numBuckets).fill(0);

  for (const k of klines) {
    const kRange = k.high - k.low;
    for (let i = 0; i < numBuckets; i++) {
      const bLow = low + i * bucketSize;
      const bHigh = bLow + bucketSize;
      const oLow = Math.max(k.low, bLow);
      const oHigh = Math.min(k.high, bHigh);
      if (oHigh > oLow) {
        const fraction = kRange > 0 ? (oHigh - oLow) / kRange : 1 / numBuckets;
        buckets[i] += k.volume * fraction;
      }
    }
  }

  const maxVol = Math.max(...buckets);
  return buckets.map((vol, i) => ({
    price: low + (i + 0.5) * bucketSize,
    volume: vol,
    relVol: maxVol > 0 ? vol / maxVol : 0,
  }));
}

export default router;
