/**
 * Price simulator for paper trading when Bybit API is not accessible.
 * Generates realistic OHLCV data with random walk + trend.
 * Prices calibrated to real market levels (mid-2026).
 */

interface PriceState {
  price: number;
  trend: number;
  volatility: number;
  volume: number;
  lastUpdate: number;
}

const BASE_PRICES: Record<string, { price: number; volatility: number }> = {
  BTCUSDT:   { price: 64000,  volatility: 0.0025 },
  ETHUSDT:   { price: 1680,   volatility: 0.003  },
  SOLUSDT:   { price: 68,     volatility: 0.004  },
  BNBUSDT:   { price: 580,    volatility: 0.0028 },
  XRPUSDT:   { price: 2.30,   volatility: 0.004  },
  DOGEUSDT:  { price: 0.35,   volatility: 0.005  },
  ADAUSDT:   { price: 0.75,   volatility: 0.004  },
  AVAXUSDT:  { price: 20.0,   volatility: 0.004  },
  POLUSDT:   { price: 0.22,   volatility: 0.005  },
  DOTUSDT:   { price: 4.5,    volatility: 0.004  },
  ATOMUSDT:  { price: 4.5,    volatility: 0.004  },
  LTCUSDT:   { price: 85,     volatility: 0.003  },
  TRXUSDT:   { price: 0.26,   volatility: 0.004  },
  LINKUSDT:  { price: 12.5,   volatility: 0.004  },
  NEARUSDT:  { price: 2.5,    volatility: 0.005  },
};

const states = new Map<string, PriceState>();

function getState(symbol: string): PriceState {
  if (!states.has(symbol)) {
    const base = BASE_PRICES[symbol] || { price: 100, volatility: 0.003 };
    states.set(symbol, {
      price: base.price,
      trend: (Math.random() - 0.5) * 0.001,
      volatility: base.volatility,
      volume: base.price * 1000 * (Math.random() * 0.5 + 0.75),
      lastUpdate: Date.now(),
    });
  }
  return states.get(symbol)!;
}

function tick(symbol: string): PriceState {
  const s = getState(symbol);
  const now = Date.now();
  const elapsed = (now - s.lastUpdate) / 1000; // seconds
  const steps = Math.min(Math.ceil(elapsed / 5), 10); // advance max 10 steps

  for (let i = 0; i < steps; i++) {
    // Mean-reverting trend
    s.trend = s.trend * 0.95 + (Math.random() - 0.5) * 0.0002;
    // Random walk with volatility
    const shock = (Math.random() - 0.5) * 2 * s.volatility;
    s.price = s.price * (1 + s.trend + shock);
    // Prevent extreme drift
    const base = BASE_PRICES[symbol];
    if (base) {
      const drift = (s.price - base.price) / base.price;
      if (Math.abs(drift) > 0.15) s.trend = -drift * 0.01;
    }
    s.volume = s.volume * 0.99 + Math.random() * s.price * 500;
  }
  s.lastUpdate = now;
  return s;
}

export function getSimulatedTicker(symbol: string) {
  const s = tick(symbol);
  const base = BASE_PRICES[symbol] || { price: s.price, volatility: 0.003 };
  const change24h = (s.price - base.price * 0.98) * (Math.random() > 0.5 ? 1 : -1);
  const change24hPct = (change24h / base.price) * 100;
  const high = s.price * (1 + Math.random() * 0.02);
  const low = s.price * (1 - Math.random() * 0.02);
  return {
    symbol,
    lastPrice: s.price,
    change24h,
    changePercent24h: change24hPct,
    volume24h: s.volume,
    high24h: high,
    low24h: low,
  };
}

export function getSimulatedKlines(symbol: string, interval: string, limit: number) {
  const s = getState(symbol);
  const intervalMs = parseIntervalMs(interval);
  const now = Date.now();
  const klines = [];

  let price = s.price * (1 - 0.05 * Math.random()); // start slightly lower
  let vol = s.volume;
  const base = BASE_PRICES[symbol] || { price: s.price, volatility: 0.003 };
  let trend = 0;

  for (let i = limit; i >= 0; i--) {
    const ts = now - i * intervalMs;
    trend = trend * 0.95 + (Math.random() - 0.5) * 0.0003;
    const shock = (Math.random() - 0.5) * 2 * base.volatility;
    price = price * (1 + trend + shock);
    // Soft pin to base price
    const drift = (price - base.price) / base.price;
    if (Math.abs(drift) > 0.1) trend -= drift * 0.005;

    const open = price;
    const wickH = Math.random() * base.volatility * 2;
    const wickL = Math.random() * base.volatility * 2;
    const closeChange = (Math.random() - 0.5) * base.volatility * 2;
    const close = open * (1 + closeChange);
    const high = Math.max(open, close) * (1 + wickH);
    const low = Math.min(open, close) * (1 - wickL);
    vol = vol * 0.97 + Math.random() * base.price * 200;

    klines.push({ timestamp: ts, open, high, low, close, volume: vol });
    price = close;
  }
  return klines;
}

export function getSimulatedPrice(symbol: string): number {
  return tick(symbol).price;
}

export function getAllSimulatedTickers() {
  return Object.keys(BASE_PRICES).map(s => getSimulatedTicker(s));
}

function parseIntervalMs(interval: string): number {
  const map: Record<string, number> = {
    "1": 60_000, "3": 180_000, "5": 300_000, "15": 900_000,
    "30": 1_800_000, "60": 3_600_000, "120": 7_200_000,
    "240": 14_400_000, "360": 21_600_000, "720": 43_200_000,
    "D": 86_400_000, "W": 604_800_000, "M": 2_592_000_000,
  };
  return map[interval] || 3_600_000;
}
