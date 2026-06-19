/**
 * Real historical kline seeder using OKX public API.
 * OKX is accessible from this environment; Bybit/Binance REST are geo-blocked.
 *
 * OKX instId format: BTC-USDT (Bybit uses BTCUSDT)
 * OKX bar format:    1m, 5m, 15m, 1H, 4H, 1D  (we store as 1, 5, 15, 60, 240, D)
 */

import { logger } from "./logger";

interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Map our internal interval codes → OKX bar strings
const INTERVAL_MAP: Record<string, string> = {
  "1":   "1m",
  "3":   "3m",
  "5":   "5m",
  "15":  "15m",
  "30":  "30m",
  "60":  "1H",
  "120": "2H",
  "240": "4H",
  "360": "6H",
  "720": "12H",
  "D":   "1D",
  "W":   "1W",
  "M":   "1M",
};

function toOkxSymbol(bybitSymbol: string): string {
  // BTCUSDT → BTC-USDT, SOLUSDT → SOL-USDT
  // Strip trailing USDT, add -USDT
  const base = bybitSymbol.replace(/USDT$/, "");
  return `${base}-USDT`;
}

function toOkxBar(interval: string): string {
  return INTERVAL_MAP[interval] ?? "1H";
}

export async function fetchOkxKlines(
  symbol: string,
  interval: string,
  limit = 200
): Promise<Kline[]> {
  const instId = toOkxSymbol(symbol);
  const bar = toOkxBar(interval);
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${Math.min(limit, 300)}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "CryptoBot/1.0" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`OKX API ${res.status}: ${await res.text()}`);
  }

  const json = await res.json() as { code: string; msg: string; data: string[][] };

  if (json.code !== "0") {
    throw new Error(`OKX error ${json.code}: ${json.msg}`);
  }

  // OKX returns newest-first → reverse to oldest-first
  // Format: [ts_ms, open, high, low, close, vol_base, vol_ccy_quote, vol_quote, confirm]
  const candles: Kline[] = json.data
    .filter(row => row[8] === "1") // only confirmed candles
    .map(row => ({
      timestamp: parseInt(row[0]),
      open:  parseFloat(row[1]),
      high:  parseFloat(row[2]),
      low:   parseFloat(row[3]),
      close: parseFloat(row[4]),
      volume: parseFloat(row[5]),
    }))
    .reverse(); // oldest → newest

  return candles;
}

// In-flight tracking to avoid duplicate concurrent fetches for the same key
const inFlight = new Set<string>();

export async function seedFromOkx(
  klineCache: Map<string, Kline[]>,
  symbol: string,
  interval: string,
  minCandles = 50,
  force = false
): Promise<boolean> {
  const key = `${symbol}_${interval}`;
  const existing = klineCache.get(key) ?? [];

  if (!force && existing.length >= minCandles) return true; // already seeded
  if (inFlight.has(key)) return false; // already fetching

  inFlight.add(key);
  try {
    const candles = await fetchOkxKlines(symbol, interval, 200);
    if (candles.length > 0) {
      // Merge: keep existing real-time candles that are newer than OKX data
      const lastOkxTs = candles[candles.length - 1].timestamp;
      const newer = existing.filter(c => c.timestamp > lastOkxTs);
      klineCache.set(key, [...candles, ...newer].slice(-300));
      logger.info({ symbol, interval, count: candles.length }, "Kline cache seeded from OKX");
      return true;
    }
    return false;
  } catch (err) {
    logger.error({ err, symbol, interval }, "OKX kline seed failed");
    return false;
  } finally {
    inFlight.delete(key);
  }
}
