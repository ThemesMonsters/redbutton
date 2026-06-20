import { db } from "@workspace/db";
import { botConfigTable, positionsTable, tradesTable, signalsTable, strategyPresetsTable } from "@workspace/db";
import type { BotConfigRow } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger";
import { hasApiKeys, setPositionTpSl, setApiKeys, placeMarketOrder, closeMarketOrder, getClosedPnlSnapshot } from "./bybit-client";
import { initMarketFeed, getCurrentPrice, getKlinesFromCache, updateSubscriptions, getLiquidationClusters } from "./market-feed";
import { initPrivateFeed, getPrivateBalance } from "./private-feed";
import { setRelayKeys, queueFetchPositions } from "./live-order-relay";
import { initWSApiClient } from "./bybit-ws-api";

/** Minimum order qty and step for each symbol (Bybit linear perpetuals). */
const QTY_RULES: Record<string, { min: number; step: number; decimals: number }> = {
  BTCUSDT:  { min: 0.001,  step: 0.001,  decimals: 3 },
  ETHUSDT:  { min: 0.01,   step: 0.01,   decimals: 2 },
  SOLUSDT:  { min: 0.1,    step: 0.1,    decimals: 1 },
  BNBUSDT:  { min: 0.01,   step: 0.01,   decimals: 2 },
  XRPUSDT:  { min: 1,      step: 1,      decimals: 0 },
  NEARUSDT: { min: 1,      step: 1,      decimals: 0 },
  DOGEUSDT: { min: 1,      step: 1,      decimals: 0 },
  AVAXUSDT: { min: 0.1,    step: 0.1,    decimals: 1 },
  ADAUSDT:  { min: 1,      step: 1,      decimals: 0 },
  DOTUSDT:  { min: 0.1,    step: 0.1,    decimals: 1 },
  POLUSDT:  { min: 1,      step: 1,      decimals: 0 },
  TRXUSDT:  { min: 10,     step: 10,     decimals: 0 },
  LTCUSDT:  { min: 0.01,   step: 0.01,   decimals: 2 },
  LINKUSDT: { min: 0.1,    step: 0.1,    decimals: 1 },
  UNIUSDT:  { min: 0.1,    step: 0.1,    decimals: 1 },
  ATOMUSDT: { min: 0.1,    step: 0.1,    decimals: 1 },
  MATICUSDT:{ min: 1,      step: 1,      decimals: 0 },
};
const DEFAULT_QTY_RULE = { min: 0.01, step: 0.01, decimals: 2 };

function getMinMarginRequired(symbol: string, currentPrice: number, leverage: number): number {
  const rule = QTY_RULES[symbol] ?? DEFAULT_QTY_RULE;
  return (rule.min * currentPrice) / leverage;
}

function snapQty(
  symbol: string,
  rawQty: number,
  effectiveBalance: number,
  leverage: number,
  currentPrice: number,
  maxMarginUsdt?: number,
): number | null {
  const rule = QTY_RULES[symbol] ?? DEFAULT_QTY_RULE;
  const snapped = Math.floor(rawQty / rule.step) * rule.step;
  const rounded = parseFloat(snapped.toFixed(rule.decimals));
  if (rounded >= rule.min) return rounded;
  const minMarginRequired = getMinMarginRequired(symbol, currentPrice, leverage);
  if (maxMarginUsdt != null && minMarginRequired > maxMarginUsdt) return null;
  if (minMarginRequired <= effectiveBalance) return rule.min;
  return null;
}

function getEffectiveBalance(mode: "live" | "paper", globalConfig: BotConfigRow | undefined): number {
  if (mode === "live") {
    const wb = getPrivateBalance();
    const equity = wb?.equity ?? 0;
    const li = parseFloat(String(globalConfig?.liveInitialBalance ?? "0"));
    if (equity > 0) return equity;
    if (li > 0) return li;
    return parseFloat(String(globalConfig?.paperBalance)) || 10000;
  }
  return parseFloat(String(globalConfig?.paperBalance)) || 10000;
}

function getAveragingSkipReason(
  minMarginRequiredUsdt: number,
  averagingAmountUsdt: number,
  averagingBalance: number,
): string {
  if (minMarginRequiredUsdt > averagingAmountUsdt) {
    return `minimum required margin (${minMarginRequiredUsdt.toFixed(4)} USDT) exceeds configured averaging budget (${averagingAmountUsdt.toFixed(4)} USDT)`;
  }
  if (minMarginRequiredUsdt > averagingBalance) {
    return `insufficient balance (${averagingBalance.toFixed(4)} USDT) for minimum required margin (${minMarginRequiredUsdt.toFixed(4)} USDT)`;
  }
  return "quantity could not be rounded to a valid exchange size";
}

/**
 * Compute the price move needed so that, after paying both entry and exit taker
 * fees, the net PnL equals `targetUsdt`.
 *
 * For a long TP/short SL (profit direction):
 *   net = (exit - entry) * qty - (entry + exit) * qty * rate  =>  exit = (targetUsdt + entry*qty*(1+rate)) / (qty*(1-rate))
 *   priceMove = exit - entry = (targetUsdt + 2*entry*qty*rate) / (qty*(1-rate))
 *
 * For a long SL/short TP (loss direction, targetUsdt is the max loss in USDT):
 *   total_loss = (entry - exit) * qty + (entry + exit) * qty * rate = targetUsdt
 *   priceMove = entry - exit = (targetUsdt - 2*entry*qty*rate) / (qty*(1-rate))
 *   Clamped to >= targetUsdt/qty so we never move the SL closer than the un-adjusted level.
 *
 * Falls back to simple targetUsdt/qty when rate is 0.
 */
function feeAdjustedPriceMove(
  targetUsdt: number,
  qty: number,
  entryPrice: number,
  feeRate: number,
  direction: "profit" | "loss",
): number {
  if (feeRate <= 0 || qty <= 0) return targetUsdt / qty;
  // feeRate >= 1 (100%) is not a realistic Bybit rate; guard against divide-by-zero
  if (feeRate >= 1) {
    logger.warn({ feeRate }, "feeAdjustedPriceMove: unrealistic feeRate >= 1, falling back to no-fee calculation");
    return targetUsdt / qty;
  }
  const denom = qty * (1 - feeRate);
  if (direction === "profit") {
    // TP: move AWAY from entry — larger price change to cover fees
    return (targetUsdt + 2 * entryPrice * qty * feeRate) / denom;
  } else {
    // SL: move TOWARD entry — smaller price change because fees add to loss
    const raw = (targetUsdt - 2 * entryPrice * qty * feeRate) / denom;
    // Never let fees push SL so close that it's inside the raw targetUsdt/qty band
    return Math.max(raw, targetUsdt / qty);
  }
}

interface BotState {
  running: boolean;
  startedAt: Date | null;
  intervalId: NodeJS.Timeout | null;
}

const state: BotState = { running: false, startedAt: null, intervalId: null };

function fmtPrice(price: number): string {
  if (price >= 1000)  return price.toFixed(1);
  if (price >= 10)    return price.toFixed(2);
  if (price >= 1)     return price.toFixed(4);
  if (price >= 0.01)  return price.toFixed(5);
  return price.toFixed(6);
}

export function isRunning() { return state.running; }
export function getStartedAt() { return state.startedAt; }

export async function loadApiKeysFromDb() {
  try {
    const configs = await db.select({
      bybitApiKey: botConfigTable.bybitApiKey,
      bybitApiSecret: botConfigTable.bybitApiSecret,
    }).from(botConfigTable).limit(1);
    const config = configs[0];
    if (config?.bybitApiKey && config?.bybitApiSecret) {
      setApiKeys(config.bybitApiKey, config.bybitApiSecret);
      setRelayKeys(config.bybitApiKey, config.bybitApiSecret);
      initPrivateFeed(config.bybitApiKey, config.bybitApiSecret);
      initWSApiClient(config.bybitApiKey, config.bybitApiSecret);
      logger.info("Loaded Bybit API keys from database");
    }
  } catch (err) {
    logger.error({ err }, "Failed to load API keys from DB");
  }
}

export async function syncPositionsFromBybit(config?: any): Promise<{ imported: number; closed: number; found: number }> {
  const cfgRows = config ? null : await db.select().from(botConfigTable).limit(1);
  const effectiveConfig = config ?? cfgRows?.[0];

  const bybitPositions = await queueFetchPositions();
  const active = bybitPositions.filter((p: any) => parseFloat(p.size ?? "0") > 0);

  const dbPositions = await db.select().from(positionsTable).where(eq(positionsTable.isOpen, true));
  const liveDbPositions = dbPositions.filter(p => p.mode === "live");

  let imported = 0;
  let closed = 0;

  for (const bp of active) {
    const symbol = bp.symbol as string;
    const side   = bp.side === "Buy" ? "long" : "short";
    const alreadyTracked = liveDbPositions.find(p => p.symbol === symbol && p.side === side);
    if (alreadyTracked) continue;

    const entryPrice = parseFloat(bp.avgPrice ?? bp.entryPrice ?? "0");
    const qty        = parseFloat(bp.size ?? "0");
    const leverage   = parseInt(bp.leverage ?? String(effectiveConfig?.leverage ?? 20));
    const tp         = bp.takeProfit && parseFloat(bp.takeProfit) > 0 ? bp.takeProfit : null;
    const sl         = bp.stopLoss  && parseFloat(bp.stopLoss)  > 0 ? bp.stopLoss  : null;

    await db.insert(positionsTable).values({
      symbol, side, entryPrice: String(entryPrice), quantity: String(qty),
      leverage, strategy: "bybit-sync", mode: "live", stopLoss: sl, takeProfit: tp, bybitOrderId: null,
    });
    logger.info({ symbol, side, qty, entryPrice, tp, sl }, "Position sync: imported from Bybit");
    imported++;
  }

  for (const dbPos of liveDbPositions) {
    const stillOpen = active.find(
      (bp: any) => bp.symbol === dbPos.symbol && (bp.side === "Buy" ? "long" : "short") === dbPos.side
    );
    if (!stillOpen) {
      await db.update(positionsTable).set({ isOpen: false }).where(eq(positionsTable.id, dbPos.id));
      logger.info({ symbol: dbPos.symbol, side: dbPos.side }, "Position sync: closed in DB — no longer open on Bybit");
      closed++;
    }
  }

  logger.info({ found: active.length, imported, closed }, "Position sync complete");
  return { imported, closed, found: active.length };
}

export async function startBot() {
  if (state.running) return;
  await loadApiKeysFromDb();

  const configs = await db.select().from(botConfigTable).limit(1);
  const globalConfig = configs[0];
  const presets = await db.select().from(strategyPresetsTable).where(eq(strategyPresetsTable.enabled, true));

  const allSymbols = [...new Set([
    ...(globalConfig?.symbols ?? ["BTCUSDT"]),
    ...presets.flatMap(p => p.symbols),
  ])];

  await initMarketFeed(allSymbols);
  state.running = true;
  state.startedAt = new Date();
  logger.info({ presets: presets.length, symbols: allSymbols }, "Bot started");

  if (globalConfig?.mode === "live") {
    syncPositionsFromBybit(globalConfig).catch(() => {});
  }

  runCycle();
  state.intervalId = setInterval(runCycle, 60_000);
}

export async function stopBot() {
  if (!state.running) return;
  state.running = false;
  state.startedAt = null;
  if (state.intervalId) { clearInterval(state.intervalId); state.intervalId = null; }
  logger.info("Bot stopped");
}

async function runCycle() {
  try {
    const configs = await db.select().from(botConfigTable).limit(1);
    if (!configs.length) return;
    const globalConfig = configs[0];
    const mode = globalConfig.mode || "paper";

    if (mode === "live" && !hasApiKeys()) {
      logger.warn("Live mode configured but no API keys — skipping cycle");
      return;
    }

    const presets = await db.select().from(strategyPresetsTable).where(eq(strategyPresetsTable.enabled, true));
    if (presets.length === 0) {
      logger.debug("No enabled strategy presets — skipping cycle");
      return;
    }

    const allSymbols = [...new Set(presets.flatMap(p => p.symbols))];
    updateSubscriptions(allSymbols);

    for (const preset of presets) {
      for (const symbol of preset.symbols) {
        await evaluateSymbol(symbol, preset, mode, globalConfig);
      }
    }
  } catch (err) {
    logger.error({ err }, "Bot cycle error");
  }
}

async function evaluateSymbol(symbol: string, preset: any, mode: string, globalConfig: any) {
  const timeframe = preset.timeframe || "60";
  const klines = getKlinesFromCache(symbol, timeframe, 200);
  if (klines.length < 30) {
    logger.debug({ symbol, preset: preset.name, klinesLen: klines.length }, "eval: insufficient klines");
    return;
  }

  const currentPrice = getCurrentPrice(symbol);
  if (currentPrice <= 0) {
    logger.debug({ symbol, currentPrice }, "eval: no price");
    return;
  }

  const strategies: string[] = preset.strategies || ["volume_profile"];

  const signals: Array<{
    strategy: string;
    direction: "long" | "short" | "neutral";
    strength: number;
    description: string;
  }> = [];

  // ─── Volume Profile (always 1H data) ─────────────────────────────────────
  if (strategies.includes("volume_profile")) {
    const vp = (preset.volumeProfileParams as any) || {};
    const lookback = vp.lookbackBars || 100;
    const klines1h = getKlinesFromCache(symbol, "60", lookback + 10);
    const slice1h = klines1h.slice(-Math.min(lookback, klines1h.length));
    if (slice1h.length >= 20) {
      const poc = computePOC(slice1h);
      if (poc > 0) {
        const diff = Math.abs(currentPrice - poc) / poc;
        const tolerance = 0.005;
        if (diff < tolerance) {
          const dir: "long" | "short" = currentPrice >= poc ? "long" : "short";
          const strength = Math.max(0.5, 1 - diff / tolerance);
          signals.push({ strategy: "volume_profile", direction: dir, strength, description: `1H POC at ${fmtPrice(poc)} (±${(diff * 100).toFixed(2)}%) — ${dir}` });
        }
      }
    }
  }

  // ─── Fibonacci (single level entry, configurable) ─────────────────────────
  if (strategies.includes("fibonacci")) {
    const fp = (preset.fibonacciParams as any) || {};
    const entryLevel = fp.entryLevel ?? 0.618;
    const slLevel    = fp.slLevel    ?? 0.786;
    const tolerance  = 0.005;

    const klines1h = getKlinesFromCache(symbol, "60", 220);
    if (klines1h.length >= 55) {
      const completed = klines1h.slice(-51, -1);
      const avgVol = completed.reduce((s: number, k: any) => s + k.volume, 0) / completed.length;

      let highestIdx = 0;
      for (let i = 1; i < completed.length; i++) {
        if (completed[i].high > completed[highestIdx].high) highestIdx = i;
      }
      const swingHigh = completed[highestIdx].high;

      const beforeStart = Math.max(0, highestIdx - 20);
      const beforeSlice = completed.slice(beforeStart, highestIdx);
      if (beforeSlice.length >= 3) {
        const swingLowCandle = beforeSlice.reduce((min: any, k: any) => k.low < min.low ? k : min, beforeSlice[0]);
        const swingLow = swingLowCandle.low;
        const candlesInRise = highestIdx - beforeStart - beforeSlice.findIndex((k: any) => k === swingLowCandle);

        const rise = (swingHigh - swingLow) / swingLow;
        const volumeOk = completed[highestIdx].volume > avgVol;

        if (rise >= 0.05 && candlesInRise <= 20 && volumeOk) {
          const range = swingHigh - swingLow;
          const entryPrice = swingHigh - range * entryLevel;
          const stopPrice  = swingHigh - range * slLevel;
          void stopPrice;

          const atLevel = Math.abs(currentPrice - entryPrice) / entryPrice < tolerance;

          const lastC = completed[completed.length - 1];
          const prevC = completed[completed.length - 2];
          const confirmed = lastC.close >= entryPrice * (1 - tolerance * 0.5) &&
            (lastC.close > entryPrice || (prevC && lastC.low > prevC.low));

          if (atLevel && confirmed) {
            signals.push({
              strategy: "fibonacci",
              direction: "long",
              strength: 0.85,
              description: `1H Fib: swing +${(rise * 100).toFixed(1)}%, entry level ${entryLevel} @ ${fmtPrice(entryPrice)} (SL lvl ${slLevel})`,
            });
          }
        }
      }
    }
  }

  if (strategies.includes("order_blocks")) {
    const op = (preset.orderBlockParams as any) || {};
    const lookback = Math.min(op.lookbackBars || 50, 200);
    const minImpulse = (op.minImpulsePercent || 1.5) / 100;
    const klines1h = getKlinesFromCache(symbol, "60", lookback + 10);
    const slice1h = klines1h.slice(-Math.min(lookback, klines1h.length));
    if (slice1h.length >= 10) {
      const ob = findOrderBlock(slice1h, minImpulse);
      if (ob) {
        const inZone = currentPrice >= ob.low && currentPrice <= ob.high;
        if (inZone) {
          signals.push({ strategy: "order_blocks", direction: ob.direction, strength: 0.8, description: `1H OB zone ${fmtPrice(ob.low)}–${fmtPrice(ob.high)} (${ob.direction})` });
        }
      }
    }
  }

  if (strategies.includes("rsi")) {
    const rp = (preset.rsiParams as any) || {};
    const period = rp.period || 14;
    const oversold = rp.oversoldLevel || 30;
    const overbought = rp.overboughtLevel || 70;

    if (klines.length >= period + 2) {
      const rsiSeries = computeRSI(klines, period);
      if (rsiSeries.length >= 2) {
        const curr = rsiSeries[rsiSeries.length - 1].value;
        const prev = rsiSeries[rsiSeries.length - 2].value;
        const klines1h = getKlinesFromCache(symbol, "60", 55);
        const avgVol1h = klines1h.slice(-50).reduce((s: number, k: any) => s + k.volume, 0) / Math.max(klines1h.slice(-50).length, 1);
        const curVol1h = klines1h[klines1h.length - 1]?.volume ?? 0;
        const volumeOk = curVol1h >= avgVol1h * 0.9;

        if (volumeOk) {
          if (prev < oversold && curr >= oversold) {
            signals.push({ strategy: "rsi", direction: "long", strength: 0.75, description: `RSI ${curr.toFixed(1)} crossed above ${oversold} + 1H vol ✓` });
          } else if (prev > overbought && curr <= overbought) {
            signals.push({ strategy: "rsi", direction: "short", strength: 0.75, description: `RSI ${curr.toFixed(1)} crossed below ${overbought} + 1H vol ✓` });
          }
        }
      }
    }
  }

  if (strategies.includes("liquidation")) {
    const klines1h = getKlinesFromCache(symbol, "60", 60);
    if (klines1h.length >= 5) {
      const clusters = getLiquidationClusters(symbol);
      const strong = clusters.filter(c => c.percentile >= 90);

      if (strong.length > 0) {
        const sweepCandle = klines1h[klines1h.length - 2];
        const atr = computeATR(klines1h, 14);
        const nearbyCount = (lvl: number) =>
          klines1h.slice(-6, -1).filter((k: any) => Math.abs(k.close - lvl) / Math.max(lvl, 1) < 0.005).length;

        for (const cl of strong) {
          if (cl.side !== "long") continue;
          if (cl.price >= currentPrice) continue;
          if (nearbyCount(cl.price) > 5) continue;
          const swept = sweepCandle.low <= cl.price * 1.002;
          const closed_ok = sweepCandle.close > cl.price;
          const range = sweepCandle.high - sweepCandle.low;
          const bodyRatio = range > 0 ? (sweepCandle.close - sweepCandle.low) / range : 0;
          if (swept && closed_ok && bodyRatio > 0.6) {
            signals.push({
              strategy: "liquidation",
              direction: "long",
              strength: 0.9,
              description: `Liq sweep LONG: cluster $${cl.totalSize.toFixed(0)} @ ${fmtPrice(cl.price)}, body ${(bodyRatio * 100).toFixed(0)}%, ATR ${fmtPrice(atr)}`,
            });
            break;
          }
        }

        for (const cl of strong) {
          if (cl.side !== "short") continue;
          if (cl.price <= currentPrice) continue;
          if (nearbyCount(cl.price) > 5) continue;
          const swept = sweepCandle.high >= cl.price * 0.998;
          const closed_ok = sweepCandle.close < cl.price;
          const range = sweepCandle.high - sweepCandle.low;
          const bodyRatio = range > 0 ? (sweepCandle.close - sweepCandle.low) / range : 0;
          if (swept && closed_ok && bodyRatio < 0.4) {
            signals.push({
              strategy: "liquidation",
              direction: "short",
              strength: 0.9,
              description: `Liq sweep SHORT: cluster $${cl.totalSize.toFixed(0)} @ ${fmtPrice(cl.price)}, body ${(bodyRatio * 100).toFixed(0)}%`,
            });
            break;
          }
        }
      }
    }
  }

  if (signals.length === 0) return;

  for (const sig of signals) {
    await db.insert(signalsTable).values({
      symbol, strategy: sig.strategy, direction: sig.direction,
      strength: String(sig.strength), price: String(currentPrice),
      description: sig.description, acted: false,
    });
  }

  const strategyMode = (preset.strategyMode as string) || "OR";
  const longs = signals.filter(s => s.direction === "long");
  const shorts = signals.filter(s => s.direction === "short");

  let dominant: "long" | "short" | null = null;
  let domSignals: typeof signals = [];

  if (strategyMode === "AND") {
    const allAgreeOnLong = longs.length === strategies.length;
    const allAgreeOnShort = shorts.length === strategies.length;
    if (allAgreeOnLong) { dominant = "long"; domSignals = longs; }
    else if (allAgreeOnShort) { dominant = "short"; domSignals = shorts; }
    else { logger.warn({ symbol, preset: preset.name }, "eval: AND mode — strategies disagree, skip"); return; }
  } else {
    dominant = longs.length > shorts.length ? "long" : shorts.length > longs.length ? "short" : null;
    if (!dominant) { logger.warn({ symbol, preset: preset.name }, "eval: OR mode — tie, skip"); return; }
    domSignals = dominant === "long" ? longs : shorts;
  }

  const avgStrength = domSignals.reduce((s, x) => s + x.strength, 0) / domSignals.length;
  if (avgStrength < 0.5) return;

  const openPositions = await db.select().from(positionsTable)
    .where(and(eq(positionsTable.isOpen, true), eq(positionsTable.mode, mode)));

  const presetPositions = openPositions.filter(p => p.presetName === preset.name);
  const maxPositions = preset.maxPositions || 3;
  if (presetPositions.length >= maxPositions) {
    logger.warn({ symbol, preset: preset.name, open: presetPositions.length, maxPositions }, "eval: max preset positions reached");
    return;
  }

  const alreadyOpen = presetPositions.find(p => p.symbol === symbol);
  if (alreadyOpen) {
    logger.warn({ symbol, preset: preset.name }, "eval: already has position for this symbol in this preset");
    return;
  }

  logger.info({ symbol, dominant, avgStrength, mode, preset: preset.name }, "eval: SIGNAL — placing order");

  const leverage = preset.leverage || 10;
  const marginUsdt = parseFloat(String(preset.positionSizeUsdt ?? 1));
  const notional = marginUsdt * leverage;
  const rawQty = notional / currentPrice;

  const effectiveBalance = getEffectiveBalance(mode, globalConfig);

  const qty = snapQty(symbol, rawQty, effectiveBalance, leverage, currentPrice);
  if (qty === null) {
    logger.warn({ symbol, rawQty, marginUsdt, leverage, preset: preset.name }, "qty below minimum — skipping");
    return;
  }

  const stopLossUsdt = parseFloat(String(preset.stopLossUsdt ?? 1));
  const takeProfitUsdt = parseFloat(String(preset.takeProfitUsdt ?? 2));
  const feeRate = parseFloat(String(globalConfig?.takerFeeRate ?? 0.00055));
  const slPriceMove = feeAdjustedPriceMove(stopLossUsdt, qty, currentPrice, feeRate, "loss");
  const tpPriceMove = feeAdjustedPriceMove(takeProfitUsdt, qty, currentPrice, feeRate, "profit");
  const sl = dominant === "long" ? currentPrice - slPriceMove : currentPrice + slPriceMove;
  const tp = dominant === "long" ? currentPrice + tpPriceMove : currentPrice - tpPriceMove;

  let bybitOrderId: string | null = null;
  if (mode === "live") {
    const side = dominant === "long" ? "Buy" : "Sell";
    const posIdx = dominant === "long" ? 1 : 2;
    try {
      bybitOrderId = await placeMarketOrder(
        symbol, side, qty, leverage,
        preset.averagingEnabled ? undefined : sl,
        tp, posIdx,
      );
      if (!bybitOrderId) {
        logger.error({ symbol, side, preset: preset.name }, "placeMarketOrder returned null — skipping");
        return;
      }
    } catch (err) {
      logger.error({ err, symbol, preset: preset.name }, "placeMarketOrder threw — skipping");
      return;
    }
  }

  const strategyLabel = domSignals.map(s => s.strategy).join("+");

  await db.insert(positionsTable).values({
    symbol, side: dominant,
    entryPrice: String(currentPrice),
    quantity: String(qty),
    leverage,
    strategy: strategyLabel,
    mode,
    stopLoss: String(sl),
    takeProfit: String(tp),
    isOpen: true,
    averageCount: 0,
    bybitOrderId,
    presetName: preset.name,
  });

  await db.update(signalsTable).set({ acted: true }).where(
    and(eq(signalsTable.symbol, symbol), eq(signalsTable.acted, false))
  );

  logger.info({ symbol, side: dominant, price: currentPrice, qty, leverage, strategy: strategyLabel, mode, preset: preset.name }, "Position opened by bot");
}

function computePOC(klines: any[]): number {
  if (!klines.length) return 0;
  const priceVolMap = new Map<number, number>();
  for (const k of klines) {
    const bucket = Math.round(((k.high + k.low) / 2) / (k.close * 0.001)) * (k.close * 0.001);
    priceVolMap.set(bucket, (priceVolMap.get(bucket) || 0) + k.volume);
  }
  let maxVol = 0; let poc = 0;
  for (const [price, vol] of priceVolMap) {
    if (vol > maxVol) { maxVol = vol; poc = price; }
  }
  return poc;
}

function findOrderBlock(klines: any[], minImpulse: number): { low: number; high: number; direction: "long" | "short" } | null {
  for (let i = klines.length - 3; i >= 1; i--) {
    const curr = klines[i]; const next = klines[i + 1];
    if (!curr || !next) continue;
    const change = (next.close - curr.close) / Math.max(curr.close, 1);
    if (Math.abs(change) >= minImpulse) {
      return {
        low: Math.min(curr.open, curr.close),
        high: Math.max(curr.open, curr.close),
        direction: change > 0 ? "long" : "short",
      };
    }
  }
  return null;
}

export function computeRSI(klines: any[], period: number = 14): { time: number; value: number }[] {
  if (klines.length < period + 1) return [];
  const closes = klines.map((k: any) => k.close);
  const result: { time: number; value: number }[] = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
  }
  avgGain /= period; avgLoss /= period;
  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  result.push({ time: Math.floor(klines[period].timestamp / 1000), value: avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0) });
  for (let i = period + 1; i < klines.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    result.push({ time: Math.floor(klines[i].timestamp / 1000), value: avgLoss === 0 ? 100 : 100 - 100 / (1 + rs) });
  }
  return result;
}

function computeATR(klines: any[], period: number = 14): number {
  if (klines.length < period + 1) return 0;
  const trs = klines.slice(1).map((k: any, i: number) => {
    const prev = klines[i];
    return Math.max(k.high - k.low, Math.abs(k.high - prev.close), Math.abs(k.low - prev.close));
  });
  const recent = trs.slice(-period);
  return recent.reduce((s: number, v: number) => s + v, 0) / recent.length;
}

let presetsCache: any[] = [];
let presetsCacheTime = 0;

async function getCachedPresets(): Promise<any[]> {
  const now = Date.now();
  if (now - presetsCacheTime > 30_000) {
    presetsCache = await db.select().from(strategyPresetsTable);
    presetsCacheTime = now;
  }
  return presetsCache;
}

export async function checkPositionsTpSl() {
  try {
    const configs = await db.select().from(botConfigTable).limit(1);
    const globalConfig = configs[0];
    const slippagePct = parseFloat(String(globalConfig?.slippagePercent ?? 0.05)) / 100;
    const takerFeeRate = parseFloat(String(globalConfig?.takerFeeRate ?? 0.00055));

    const presets = await getCachedPresets();
    const presetMap = new Map<string, any>(presets.map(p => [p.name, p]));

    const positions = await db.select().from(positionsTable).where(eq(positionsTable.isOpen, true));

    for (const pos of positions) {
      if (processingPositionIds.has(pos.id)) continue;
      processingPositionIds.add(pos.id);

      try {
        const currentPrice = getCurrentPrice(pos.symbol);
        if (currentPrice <= 0) { processingPositionIds.delete(pos.id); continue; }

        const qty = parseFloat(pos.quantity);
        const entryPrice = parseFloat(pos.entryPrice);
        const sl = pos.stopLoss ? parseFloat(pos.stopLoss) : null;
        const tp = pos.takeProfit ? parseFloat(pos.takeProfit) : null;

        const preset = pos.presetName ? presetMap.get(pos.presetName) : null;
        const averagingEnabled = preset?.averagingEnabled ?? globalConfig?.averagingEnabled ?? false;
        const averagingThreshold = parseFloat(String(preset?.averagingThresholdPercent ?? globalConfig?.averagingThresholdPercent ?? 80)) / 100;
        const maxAveragingCount = preset?.maxAveragingCount ?? globalConfig?.maxAveragingCount ?? 2;
        const averagingAmountUsdt = parseFloat(String(preset?.averagingAmountUsdt ?? preset?.positionSizeUsdt ?? 1));
        const leverage = pos.leverage ?? preset?.leverage ?? globalConfig?.leverage ?? 10;
        const stopLossUsdt = parseFloat(String(preset?.stopLossUsdt ?? globalConfig?.stopLossUsdt ?? 1));
        const takeProfitUsdt = parseFloat(String(preset?.takeProfitUsdt ?? globalConfig?.takeProfitUsdt ?? 2));

        if (averagingEnabled && pos.averageCount < maxAveragingCount && sl) {
          const slDistance = Math.abs(entryPrice - sl);
          const priceMove = pos.side === "long" ? entryPrice - currentPrice : currentPrice - entryPrice;
          const lossRatio = slDistance > 0 ? priceMove / slDistance : 0;

          if (lossRatio >= averagingThreshold) {
            logger.info({ symbol: pos.symbol, preset: pos.presetName, lossRatio: (lossRatio * 100).toFixed(1) + "%" }, "Averaging triggered");

            const avgNotional = averagingAmountUsdt * leverage;
            const averagingBalance = getEffectiveBalance(pos.mode, globalConfig);
            const minMarginRequiredUsdt = getMinMarginRequired(pos.symbol, currentPrice, leverage);
            const addQty = snapQty(
              pos.symbol,
              avgNotional / currentPrice,
              averagingBalance,
              leverage,
              currentPrice,
              averagingAmountUsdt,
            );
            if (addQty === null) {
              const skipReason = getAveragingSkipReason(minMarginRequiredUsdt, averagingAmountUsdt, averagingBalance);
              logger.warn(
                { symbol: pos.symbol, averagingAmountUsdt, averagingBalance, minMarginRequiredUsdt, leverage, currentPrice, preset: pos.presetName, skipReason },
                "Averaging skipped",
              );
              continue;
            }

            const newQty = qty + addQty;
            const newEntry = (entryPrice * qty + currentPrice * addQty) / newQty;

            const newSlMove = feeAdjustedPriceMove(stopLossUsdt, newQty, currentPrice, takerFeeRate, "loss");
            const newTpMove = feeAdjustedPriceMove(takeProfitUsdt, newQty, newEntry, takerFeeRate, "profit");
            const newSl = pos.side === "long" ? currentPrice - newSlMove : currentPrice + newSlMove;
            const newTp = pos.side === "long" ? newEntry + newTpMove : newEntry - newTpMove;

            if (pos.mode === "live") {
              const side = pos.side === "long" ? "Buy" : "Sell";
              const posIdx = pos.side === "long" ? 1 : 2;
              try {
                const avgOrderId = await placeMarketOrder(pos.symbol, side, addQty, leverage, undefined, undefined, posIdx);
                if (!avgOrderId) throw new Error("placeMarketOrder returned null");
                await setPositionTpSl(pos.symbol, side, undefined, newTp);
              } catch (err) {
                logger.error({ err, symbol: pos.symbol }, "Failed to place averaging order");
                continue;
              }
            }

            await db.update(positionsTable).set({
              entryPrice: String(newEntry),
              quantity: String(newQty),
              stopLoss: String(newSl),
              takeProfit: String(newTp),
              averageCount: pos.averageCount + 1,
              strategy: pos.strategy.includes("+avg") ? pos.strategy : pos.strategy + "+avg",
            }).where(eq(positionsTable.id, pos.id));

            logger.info({ symbol: pos.symbol, oldEntry: entryPrice, newEntry, newQty, newSl, newTp }, "Position averaged in-place");
            continue;
          }
        }

        const slAllowed = !averagingEnabled && (pos.averageCount ?? 0) === 0;
        if (pos.side === "long") {
          if (sl && currentPrice <= sl && slAllowed) { await closePosition(pos, sl, slippagePct, "sl", takerFeeRate); continue; }
          if (tp && currentPrice >= tp) { await closePosition(pos, tp, slippagePct, "tp", takerFeeRate); continue; }
        } else {
          if (sl && currentPrice >= sl && slAllowed) { await closePosition(pos, sl, slippagePct, "sl", takerFeeRate); continue; }
          if (tp && currentPrice <= tp) { await closePosition(pos, tp, slippagePct, "tp", takerFeeRate); continue; }
        }
      } finally {
        processingPositionIds.delete(pos.id);
      }
    }
  } catch (err) {
    logger.error({ err }, "SL/TP check error");
  }
}

async function closePosition(pos: any, triggerPrice: number, slippagePct: number, reason: "tp" | "sl", takerFeeRate: number = 0) {
  const updated = await db
    .update(positionsTable)
    .set({ isOpen: false, closedAt: new Date() })
    .where(and(eq(positionsTable.id, pos.id), eq(positionsTable.isOpen, true)))
    .returning({ id: positionsTable.id });
  if (updated.length === 0) {
    logger.warn({ posId: pos.id, symbol: pos.symbol }, "closePosition: already closed — skipping");
    return;
  }

  if (pos.mode === "live") {
    const positionSide = pos.side === "long" ? "Buy" : "Sell";
    const posIdx = pos.side === "long" ? 1 : 2;
    try {
      const closeRes = await closeMarketOrder(pos.symbol, positionSide, parseFloat(pos.quantity), posIdx);
      const exchangeSnapshot = await getClosedPnlSnapshot(pos.symbol, {
        orderId: closeRes.orderId,
        openedAt: pos.openedAt,
        expectedQty: parseFloat(pos.quantity),
      });
      if (exchangeSnapshot) {
        const settledPos = {
          ...pos,
          entryPrice: String(exchangeSnapshot.entryPrice),
          quantity: String(exchangeSnapshot.closedQty),
          leverage: exchangeSnapshot.leverage ?? pos.leverage,
        };
        const pnlPercent = computePnlPercent(
          exchangeSnapshot.closedPnl,
          exchangeSnapshot.entryPrice,
          exchangeSnapshot.closedQty,
          settledPos.leverage,
        );
        await insertClosedTrade(settledPos, exchangeSnapshot.exitPrice, exchangeSnapshot.closedPnl, pnlPercent);
        logger.info(
          { symbol: pos.symbol, reason, exitPrice: exchangeSnapshot.exitPrice, pnl: exchangeSnapshot.closedPnl.toFixed(4), pnlPercent: pnlPercent.toFixed(2) + "%", preset: pos.presetName },
          "Position closed by SL/TP using Bybit closed PnL snapshot",
        );
        return;
      }
      if (closeRes.executionPrice && closeRes.executionPrice > 0) {
        const pnl = computeClosedPnl(pos, closeRes.executionPrice, takerFeeRate);
        await insertClosedTrade(pos, closeRes.executionPrice, pnl.pnl, pnl.pnlPercent);
        logger.info(
          { symbol: pos.symbol, reason, exitPrice: closeRes.executionPrice, pnl: pnl.pnl.toFixed(4), pnlPercent: pnl.pnlPercent.toFixed(2) + "%", preset: pos.presetName },
          "Position closed by SL/TP using exchange execution price",
        );
        return;
      }
      logger.warn({ symbol: pos.symbol, reason, triggerPrice }, "Close order submitted, but execution price unavailable — falling back to trigger-based accounting");
    } catch (err) {
      logger.error({ err, symbol: pos.symbol }, "Failed to close position via WS-API/REST");
    }
  }

  const shouldApplyPaperSlippage = reason === "sl" && pos.mode === "paper";
  const accountedExit = shouldApplyPaperSlippage
    ? (pos.side === "long" ? triggerPrice * (1 - slippagePct) : triggerPrice * (1 + slippagePct))
    : triggerPrice;

  const pnl = computeClosedPnl(pos, accountedExit, pos.mode === "live" ? takerFeeRate : 0);
  await insertClosedTrade(pos, accountedExit, pnl.pnl, pnl.pnlPercent);
  logger.info(
    { symbol: pos.symbol, reason, exitPrice: accountedExit, pnl: pnl.pnl.toFixed(4), pnlPercent: pnl.pnlPercent.toFixed(2) + "%", preset: pos.presetName },
    "Position closed by SL/TP",
  );
}

function computeClosedPnl(pos: any, exitPrice: number, takerFeeRate: number = 0): { pnl: number; pnlPercent: number } {
  const qty = parseFloat(pos.quantity);
  const entry = parseFloat(pos.entryPrice);
  const pnl = pos.side === "long" ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
  const feesUsdt = takerFeeRate > 0 ? (entry * qty + exitPrice * qty) * takerFeeRate : 0;
  const netPnl = pnl - feesUsdt;
  const pnlPercent = computePnlPercent(netPnl, entry, qty, pos.leverage);
  return { pnl: netPnl, pnlPercent };
}

function computePnlPercent(pnl: number, entryPrice: number, qty: number, leverage: number | null | undefined): number {
  const effectiveLeverage = leverage ?? 1;
  const margin = entryPrice > 0 && qty > 0 ? (entryPrice * qty) / Math.max(effectiveLeverage, 1) : 0;
  return margin > 0 ? (pnl / margin) * 100 : 0;
}

async function insertClosedTrade(pos: any, exitPrice: number, pnl: number, pnlPercent: number) {
  await db.insert(tradesTable).values({
    symbol: pos.symbol, side: pos.side,
    entryPrice: pos.entryPrice, exitPrice: String(exitPrice),
    quantity: pos.quantity, leverage: pos.leverage,
    pnl: String(pnl), pnlPercent: String(pnlPercent),
    strategy: pos.strategy, mode: pos.mode,
    bybitOrderId: pos.bybitOrderId,
    wasAveraged: (pos.averageCount ?? 0) > 0,
    averageCount: pos.averageCount ?? 0,
    presetName: pos.presetName,
    openedAt: pos.openedAt,
  });
}

const processingPositionIds = new Set<number>();
let tpSlRunning = false;

setInterval(async () => {
  if (tpSlRunning) return;
  tpSlRunning = true;
  try {
    await checkPositionsTpSl();
  } finally {
    tpSlRunning = false;
  }
}, 10_000);
