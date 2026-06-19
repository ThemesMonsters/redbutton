/**
 * Real-time market data feed via Bybit WebSocket.
 * Historical klines seeded from OKX public API (accessible; Bybit REST is geo-blocked).
 * Falls back to price simulator if WebSocket is unavailable.
 */

import { WebsocketClient } from "bybit-api";
import { logger } from "./logger";
import { getSimulatedPrice, getSimulatedKlines, getSimulatedTicker, getAllSimulatedTickers } from "./price-simulator";
import { seedFromOkx } from "./kline-seeder";

interface TickerSnapshot {
  symbol: string;
  lastPrice: number;
  change24h: number;
  changePercent24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  updatedAt: number;
}

interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface LiqEvent {
  price: number;
  size: number;   // USD notional
  side: "long" | "short"; // which side was liquidated
  ts: number;
}

const tickers = new Map<string, TickerSnapshot>();
const klineCache = new Map<string, Kline[]>(); // key = `${symbol}_${interval}`
const liqBuffer = new Map<string, LiqEvent[]>(); // symbol → recent liquidation events (24 h)
const subscribedSymbols = new Set<string>();

let wsClient: WebsocketClient | null = null;
let wsConnected = false;
let wsAttempted = false;

const DEFAULT_KLINE_INTERVAL = "60";
const KLINE_CACHE_SIZE = 300;

// All intervals the chart can request — pre-seed these on startup
const SEED_INTERVALS = ["1", "5", "15", "60", "240", "D"];

function initWs(): Promise<boolean> {
  if (wsConnected) return Promise.resolve(true);
  if (wsAttempted && !wsConnected) return Promise.resolve(false);
  wsAttempted = true;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      logger.warn("WebSocket connection timeout — using price simulator");
      wsConnected = false;
      resolve(false);
    }, 8000);

    wsClient = new WebsocketClient({ market: "v5" });

    wsClient.on("open", () => {
      logger.info("Bybit WebSocket connected — real market data active");
      clearTimeout(timeout);
      wsConnected = true;
      resolve(true);
    });

    (wsClient as any).on("error", (err: any) => {
      logger.error({ err }, "WebSocket error");
      clearTimeout(timeout);
      wsConnected = false;
      resolve(false);
    });

    wsClient.on("close", () => {
      logger.warn("WebSocket closed — will reconnect automatically");
      wsConnected = false;
    });

    wsClient.on("reconnect", () => {
      logger.info("WebSocket reconnecting...");
    });

    wsClient.on("reconnected", () => {
      logger.info("WebSocket reconnected");
      wsConnected = true;
      resubscribeAll();
    });

    wsClient.on("update", (data: any) => {
      handleWsMessage(data);
    });

    wsClient.subscribeV5(["tickers.BTCUSDT"], "linear");
  });
}

function handleWsMessage(data: any) {
  const topic: string = data.topic || "";

  if (topic.startsWith("tickers.")) {
    const rawData = data.data;
    if (!rawData?.symbol) return;

    const sym = rawData.symbol;
    const prev = tickers.get(sym);
    const lastPrice = parseFloat(rawData.lastPrice || String(prev?.lastPrice || 0));
    const pct = parseFloat(rawData.price24hPcnt || "0");

    tickers.set(sym, {
      symbol: sym,
      lastPrice,
      change24h: pct * parseFloat(rawData.prevPrice24h || String(lastPrice)),
      changePercent24h: pct * 100,
      volume24h: parseFloat(rawData.volume24h || String(prev?.volume24h || 0)),
      high24h: parseFloat(rawData.highPrice24h || String(prev?.high24h || lastPrice)),
      low24h: parseFloat(rawData.lowPrice24h || String(prev?.low24h || lastPrice)),
      updatedAt: Date.now(),
    });
  }

  if (topic.startsWith("kline.")) {
    const parts = topic.split(".");
    const interval = parts[1];
    const symbol = parts[2];
    const klineList: any[] = Array.isArray(data.data) ? data.data : [data.data];
    const cacheKey = `${symbol}_${interval}`;
    let arr = klineCache.get(cacheKey) || [];

    for (const k of klineList) {
      if (!k) continue;
      const candle: Kline = {
        timestamp: parseInt(k.start),
        open: parseFloat(k.open),
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
        volume: parseFloat(k.volume),
      };
      const last = arr[arr.length - 1];
      if (last && last.timestamp === candle.timestamp) {
        arr[arr.length - 1] = candle; // update current (forming) candle
      } else {
        arr.push(candle);
        if (arr.length > KLINE_CACHE_SIZE) arr.shift();
      }
    }
    klineCache.set(cacheKey, arr);
  }

  if (topic.startsWith("liquidation.")) {
    const symbol = topic.split(".")[1];
    const d = data.data;
    if (!d || !d.price || !d.size) return;
    const price = parseFloat(d.price);
    const size  = parseFloat(d.size) * price; // USD notional
    // Bybit: side=Buy means a Buy order was liquidated (long position killed)
    const side: "long" | "short" = d.side === "Buy" ? "long" : "short";
    const events = liqBuffer.get(symbol) || [];
    events.push({ price, size, side, ts: Date.now() });
    // Keep only 24 h of events
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    liqBuffer.set(symbol, events.filter(e => e.ts > cutoff));
  }
}

function resubscribeAll() {
  if (!wsClient || !wsConnected) return;
  const topics: string[] = [];
  for (const sym of subscribedSymbols) {
    topics.push(`tickers.${sym}`);
    topics.push(`kline.${DEFAULT_KLINE_INTERVAL}.${sym}`);
    topics.push(`liquidation.${sym}`);
  }
  if (topics.length) wsClient.subscribeV5(topics, "linear");
}

async function ensureSubscribed(symbol: string) {
  if (!wsConnected) return;
  if (subscribedSymbols.has(symbol)) return;
  subscribedSymbols.add(symbol);
  if (wsClient) {
    wsClient.subscribeV5([
      `tickers.${symbol}`,
      `kline.${DEFAULT_KLINE_INTERVAL}.${symbol}`,
      `liquidation.${symbol}`,
    ], "linear");
  }
}

/** Seed klines from OKX for one symbol across all chart intervals */
async function seedAllIntervals(symbol: string) {
  // Seed intervals in parallel, limit concurrency to avoid rate-limiting
  for (const interval of SEED_INTERVALS) {
    await seedFromOkx(klineCache, symbol, interval, 50).catch(() => {});
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function initMarketFeed(symbols: string[]) {
  const isLive = await initWs();

  if (isLive && wsClient) {
    const topics: string[] = [];
    for (const sym of symbols) {
      if (!subscribedSymbols.has(sym)) {
        subscribedSymbols.add(sym);
        topics.push(`tickers.${sym}`);
        topics.push(`kline.${DEFAULT_KLINE_INTERVAL}.${sym}`);
        topics.push(`liquidation.${sym}`);
      }
    }
    if (topics.length) wsClient.subscribeV5(topics, "linear");
  }

  // Seed real historical klines from OKX for all symbols + all intervals
  // Run in background so it doesn't block bot start
  Promise.all(symbols.map(seedAllIntervals)).catch(err =>
    logger.error({ err }, "Kline seeding batch failed")
  );

  return isLive;
}

export function updateSubscriptions(symbols: string[]) {
  if (!wsClient || !wsConnected) return;
  const topics: string[] = [];
  const newSymbols: string[] = [];
  for (const sym of symbols) {
    if (!subscribedSymbols.has(sym)) {
      subscribedSymbols.add(sym);
      topics.push(`tickers.${sym}`);
      topics.push(`kline.${DEFAULT_KLINE_INTERVAL}.${sym}`);
      topics.push(`liquidation.${sym}`);
      newSymbols.push(sym);
    }
  }
  if (topics.length) {
    wsClient.subscribeV5(topics, "linear");
    Promise.all(newSymbols.map(seedAllIntervals)).catch(() => {});
  }
}

/** Ensure klines for a specific symbol+interval are seeded (on-demand) */
export async function ensureKlines(symbol: string, interval: string): Promise<void> {
  await ensureSubscribed(symbol);
  const key = `${symbol}_${interval}`;
  const cached = klineCache.get(key) ?? [];
  if (cached.length >= 50) return; // already enough
  await seedFromOkx(klineCache, symbol, interval, 50);
}

export function getCurrentPrice(symbol: string): number {
  const t = tickers.get(symbol);
  if (t && Date.now() - t.updatedAt < 60_000) return t.lastPrice;
  return getSimulatedPrice(symbol);
}

export function getTicker(symbol: string): TickerSnapshot | null {
  const t = tickers.get(symbol);
  if (t && Date.now() - t.updatedAt < 60_000) return t;
  return null;
}

export function getAllTickers(symbols?: string[]): TickerSnapshot[] {
  const now = Date.now();
  const syms = symbols || [...subscribedSymbols];
  return syms.map(sym => {
    const t = tickers.get(sym);
    if (t && now - t.updatedAt < 60_000) return t;
    const sim = getSimulatedTicker(sym);
    return { ...sim, updatedAt: now };
  });
}

export function getKlinesFromCache(symbol: string, interval: string, limit: number): Kline[] {
  const key = `${symbol}_${interval}`;
  const cached = klineCache.get(key) || [];
  if (cached.length >= 20) return cached.slice(-limit);
  // Fallback to simulator only if OKX seed hasn't completed yet
  return getSimulatedKlines(symbol, interval, limit);
}

export function isWsConnected(): boolean {
  return wsConnected;
}

export function getWsStatus() {
  return {
    connected: wsConnected,
    subscribedSymbols: [...subscribedSymbols],
    cachedTickers: tickers.size,
  };
}

/**
 * Return clustered liquidation levels for a symbol.
 * Clusters events within 0.5% of each other by side.
 * `percentile` = 0–100 of how large this cluster is vs all others in last 24 h.
 */
export function getLiquidationClusters(symbol: string): Array<{
  price: number;
  totalSize: number;
  side: "long" | "short";
  percentile: number;
}> {
  const events = liqBuffer.get(symbol);
  if (!events || events.length === 0) return [];

  // Merge events within 0.5% of each other (same side)
  const clusters: Array<{ price: number; totalSize: number; side: "long" | "short" }> = [];
  for (const ev of events) {
    const existing = clusters.find(
      c => c.side === ev.side && Math.abs(c.price - ev.price) / Math.max(c.price, 1) < 0.005
    );
    if (existing) {
      // Volume-weighted average price
      const combined = existing.totalSize + ev.size;
      existing.price = (existing.price * existing.totalSize + ev.price * ev.size) / combined;
      existing.totalSize = combined;
    } else {
      clusters.push({ price: ev.price, totalSize: ev.size, side: ev.side });
    }
  }

  if (clusters.length === 0) return [];
  const sorted = clusters.map(c => c.totalSize).sort((a, b) => a - b);
  return clusters.map(c => {
    const rank = sorted.filter(s => s <= c.totalSize).length;
    return { ...c, percentile: (rank / sorted.length) * 100 };
  });
}
