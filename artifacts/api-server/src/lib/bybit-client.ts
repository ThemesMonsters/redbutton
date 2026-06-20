import { RestClientV5 } from "bybit-api";
import { logger } from "./logger";
import { submitOrderWS } from "./bybit-ws-api";

// api.bytick.com bypasses the Amazon CloudFront geo-restriction that blocks
// many cloud hosting providers (AWS, Replit, etc.) from reaching api.bybit.com
const BYBIT_BASE_URL = "https://api.bytick.com";
const EXECUTION_LIST_LIMIT = 50;
const MAX_EXECUTION_FETCH_RETRIES = 5;
const EXECUTION_FETCH_RETRY_DELAY_MS = 200;

let authClient: RestClientV5 | null = null;
let publicClient: RestClientV5 | null = null;

let _storedKey: string | null = null;
let _storedSecret: string | null = null;

export function setApiKeys(key: string | null, secret: string | null) {
  _storedKey = key || null;
  _storedSecret = secret || null;
  authClient = null;
}

export function hasApiKeys(): boolean {
  return !!(
    (process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET) ||
    (_storedKey && _storedSecret)
  );
}

/** Strip key/secret from bybit-api error objects before logging */
function sanitizeErr(err: unknown): unknown {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e.requestOptions && typeof e.requestOptions === "object") {
      const opts = { ...(e.requestOptions as Record<string, unknown>) };
      if (opts.key)    opts.key    = "***";
      if (opts.secret) opts.secret = "***";
      return { ...e, requestOptions: opts };
    }
  }
  return err;
}

export function getPublicClient(): RestClientV5 {
  if (!publicClient) {
    publicClient = new RestClientV5({ testnet: false, baseUrl: BYBIT_BASE_URL });
  }
  return publicClient;
}

export function getAuthClient(): RestClientV5 | null {
  if (!hasApiKeys()) return null;
  if (!authClient) {
    const key = process.env.BYBIT_API_KEY || _storedKey!;
    const secret = process.env.BYBIT_API_SECRET || _storedSecret!;
    authClient = new RestClientV5({ key, secret, testnet: false, baseUrl: BYBIT_BASE_URL });
  }
  return authClient;
}

export async function getKlinesRest(symbol: string, interval: string = "60", limit: number = 200): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>> {
  try {
    const pub = getPublicClient();
    const res = await pub.getKline({ category: "linear", symbol, interval: interval as any, limit });
    if (res.retCode !== 0) throw new Error(res.retMsg);
    return (res.result.list || []).map((k: string[]) => ({
      timestamp: parseInt(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    })).reverse();
  } catch (err) {
    logger.error({ err: sanitizeErr(err), symbol }, "REST kline fetch failed");
    return [];
  }
}

export async function getLiveBalance() {
  const auth = getAuthClient();
  if (!auth) return null;

  // Bybit accounts can be UNIFIED (UTA), CONTRACT, or SPOT.
  // Try each in order and return the first successful non-zero result.
  const accountTypes = ["UNIFIED", "CONTRACT", "SPOT"] as const;

  for (const accountType of accountTypes) {
    try {
      const res = await auth.getWalletBalance({ accountType });
      if (res.retCode !== 0) {
        logger.warn({ accountType, retCode: res.retCode, retMsg: res.retMsg }, "getWalletBalance non-zero retCode");
        continue;
      }
      const account = res.result.list?.[0];
      if (!account) continue;

      const balance = parseFloat(account.totalWalletBalance || "0");
      const equity  = parseFloat(account.totalEquity       || "0");

      // CONTRACT accounts expose balance differently — sum coin balances
      let resolvedBalance = balance;
      let resolvedEquity  = equity;
      if ((!balance && !equity) && account.coin?.length) {
        resolvedBalance = account.coin.reduce((s: number, c: any) => s + parseFloat(c.walletBalance || "0"), 0);
        resolvedEquity  = account.coin.reduce((s: number, c: any) => s + parseFloat(c.equity       || c.walletBalance || "0"), 0);
      }

      if (resolvedBalance > 0 || resolvedEquity > 0) {
        logger.info({ accountType, balance: resolvedBalance, equity: resolvedEquity }, "Live balance fetched");
        return { balance: resolvedBalance, equity: resolvedEquity };
      }
    } catch (err) {
      logger.warn({ err: sanitizeErr(err), accountType }, "getLiveBalance attempt failed");
    }
  }

  logger.error("getLiveBalance: all account types returned zero or failed");
  return null;
}

export async function placeMarketOrder(
  symbol: string,
  side: "Buy" | "Sell",
  qty: number,
  leverage: number,
  stopLoss?: number,
  takeProfit?: number,
  positionIdx?: number,
): Promise<string | null> {
  // --- Try to set leverage via REST (best-effort; swallow CloudFront 403) ---
  const auth = getAuthClient();
  if (auth) {
    try {
      await auth.setLeverage({ category: "linear", symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) });
    } catch (err: any) {
      const code = err?.code ?? err?.status ?? 0;
      // 403 = CloudFront geo-block; 110043 = leverage not modified (already set)
      if (code !== 403 && err?.retCode !== 110043) {
        logger.warn({ err: sanitizeErr(err), symbol, leverage }, "setLeverage failed — continuing with existing leverage");
      }
    }
  }

  const extraParams = {
    ...(positionIdx !== undefined ? { positionIdx: positionIdx as 0 | 1 | 2 } : {}),
    ...(stopLoss   ? { stopLoss:   String(stopLoss.toFixed(8)),   slTriggerBy: "LastPrice" as const } : {}),
    ...(takeProfit ? { takeProfit: String(takeProfit.toFixed(8)), tpTriggerBy: "LastPrice" as const } : {}),
  };

  // --- Place order via WS-API (/v5/private — not CloudFront-blocked) ---
  try {
    const res: any = await submitOrderWS({
      category: "linear",
      symbol,
      side,
      orderType: "Market",
      qty: String(qty),
      ...extraParams,
    });
    if (res?.retCode !== 0) throw new Error(res?.retMsg ?? "Unknown WS-API error");
    logger.info({ symbol, side, qty, leverage, stopLoss, takeProfit, positionIdx }, "Market order placed via WS-API (/v5/private)");
    return res.result?.orderId ?? res.result?.orderID ?? null;
  } catch (err: any) {
    logger.error({ err: sanitizeErr(err) }, "Failed to place market order via WS-API — falling back to REST");
  }

  // --- Fallback: REST (may be geo-blocked on cloud hosting) ---
  if (!auth) return null;
  try {
    const res = await auth.submitOrder({
      category: "linear",
      symbol,
      side,
      orderType: "Market",
      qty: String(qty),
      ...extraParams,
    });
    if (res.retCode !== 0) throw new Error(res.retMsg);
    logger.info({ symbol, side, qty, leverage, stopLoss, takeProfit, positionIdx }, "Market order placed via REST");
    return res.result.orderId || null;
  } catch (err) {
    logger.error({ err: sanitizeErr(err) }, "Failed to place market order");
    return null;
  }
}

/**
 * Update SL/TP on an existing Bybit position (e.g. after averaging).
 * Uses setTradingStop so the exchange enforces the new levels autonomously.
 */
export async function setPositionTpSl(
  symbol: string,
  side: "Buy" | "Sell",
  stopLoss?: number,
  takeProfit?: number,
): Promise<boolean> {
  const auth = getAuthClient();
  if (!auth) return false;
  try {
    // Hedge Mode: positionIdx 1 = long side, 2 = short side (0 = one-way mode)
    const positionIdx = side === "Buy" ? 1 : 2;
    const res = await auth.setTradingStop({
      category: "linear",
      symbol,
      positionIdx,
      ...(stopLoss   ? { stopLoss:   String(stopLoss.toFixed(8)),   slTriggerBy: "LastPrice" } : {}),
      ...(takeProfit ? { takeProfit: String(takeProfit.toFixed(8)), tpTriggerBy: "LastPrice" } : {}),
    });
    if (res.retCode !== 0) throw new Error(res.retMsg);
    logger.info({ symbol, side, stopLoss, takeProfit }, "Exchange SL/TP updated via setTradingStop");
    return true;
  } catch (err) {
    logger.error({ err: sanitizeErr(err), symbol }, "Failed to set exchange SL/TP");
    return false;
  }
}

export async function closeMarketOrder(
  symbol: string,
  side: "Buy" | "Sell",
  qty: number,
  positionIdx?: number,
): Promise<{ success: boolean; orderId: string | null; executionPrice: number | null }> {
  const result = { success: false, orderId: null as string | null, executionPrice: null as number | null };
  const closeSide = side === "Buy" ? "Sell" : "Buy";
  const closeParams = {
    category: "linear" as const,
    symbol,
    side: closeSide,
    orderType: "Market" as const,
    qty: String(qty),
    reduceOnly: true,
    ...(positionIdx !== undefined ? { positionIdx } : {}),
  };

  // --- Close via WS-API first (bypasses CloudFront) ---
  try {
    const res: any = await submitOrderWS(closeParams);
    const rc = res?.retCode;
    if (rc !== 0) {
      if (rc === 110025 || rc === 110045) {
        logger.info({ symbol, retCode: rc }, "Position already closed by exchange SL/TP");
        return { success: true, orderId: null, executionPrice: null };
      }
      throw new Error(res?.retMsg ?? "Unknown WS-API error");
    }
    const orderId = res?.result?.orderId ?? res?.result?.orderID ?? null;
    result.success = true;
    result.orderId = orderId;
    if (orderId) {
      result.executionPrice = await fetchCloseExecutionPrice(symbol, orderId);
    }
    logger.info({ symbol, side, closeSide, qty, orderId, executionPrice: result.executionPrice }, "Position closed via WS-API (/v5/private)");
    return result;
  } catch (err: any) {
    logger.warn({ err: sanitizeErr(err) }, "WS-API close failed — trying REST fallback");
  }

  // --- Fallback: REST ---
  const auth = getAuthClient();
  if (!auth) return result;
  try {
    const res = await auth.submitOrder(closeParams as any);
    if (res.retCode !== 0) {
      if (res.retCode === 110025 || res.retCode === 110045) {
        logger.info({ symbol, retCode: res.retCode }, "Position already closed by exchange SL/TP — skipping our close");
        return { success: true, orderId: null, executionPrice: null };
      }
      throw new Error(res.retMsg);
    }
    const orderId = res.result.orderId || null;
    result.success = true;
    result.orderId = orderId;
    if (orderId) {
      result.executionPrice = await fetchCloseExecutionPrice(symbol, orderId);
    }
    logger.info({ symbol, side, closeSide, qty, orderId, executionPrice: result.executionPrice }, "Position closed via REST");
    return result;
  } catch (err) {
    logger.error({ err: sanitizeErr(err) }, "Failed to close market order on Bybit");
    return result;
  }
}

type ClosedPnlSnapshot = {
  orderId: string;
  entryPrice: number;
  exitPrice: number;
  closedPnl: number;
  closedQty: number;
  leverage: number | null;
  updatedTime: number;
};

export async function getClosedPnlSnapshot(
  symbol: string,
  options: { orderId?: string | null; openedAt?: Date | string; expectedQty?: number } = {},
): Promise<ClosedPnlSnapshot | null> {
  const auth = getAuthClient();
  if (!auth) return null;

  const openedAtMs = options.openedAt ? new Date(options.openedAt).getTime() : null;
  const expectedQty = options.expectedQty && Number.isFinite(options.expectedQty) ? options.expectedQty : null;
  const qtyTolerance = expectedQty ? Math.max(1e-8, expectedQty * 1e-6) : null;

  for (let attempt = 0; attempt < MAX_EXECUTION_FETCH_RETRIES; attempt++) {
    try {
      const res = await auth.getClosedPnL({
        category: "linear",
        symbol,
        limit: EXECUTION_LIST_LIMIT,
      });
      const records = (res.result?.list ?? []).map((item: any) => ({
        orderId: String(item.orderId ?? ""),
        entryPrice: parseFloat(item.avgEntryPrice ?? "0"),
        exitPrice: parseFloat(item.avgExitPrice ?? "0"),
        closedPnl: parseFloat(item.closedPnl ?? "0"),
        closedQty: parseFloat(item.closedSize ?? item.qty ?? "0"),
        leverage: item.leverage != null ? parseFloat(item.leverage) : null,
        updatedTime: parseInt(item.updatedTime ?? item.createdTime ?? "0", 10),
      })).filter((item: ClosedPnlSnapshot) =>
        item.orderId &&
        item.entryPrice > 0 &&
        item.exitPrice > 0 &&
        item.closedQty > 0 &&
        Number.isFinite(item.closedPnl),
      );

      const matched = records.find((item: ClosedPnlSnapshot) => item.orderId === options.orderId)
        ?? records
          .filter((item: ClosedPnlSnapshot) => {
            if (openedAtMs && item.updatedTime < openedAtMs - 60_000) return false;
            if (qtyTolerance != null && expectedQty != null && Math.abs(item.closedQty - expectedQty) > qtyTolerance) return false;
            return true;
          })
          .sort((a: ClosedPnlSnapshot, b: ClosedPnlSnapshot) => b.updatedTime - a.updatedTime)[0];

      if (matched) return matched;
    } catch (err) {
      if (attempt === MAX_EXECUTION_FETCH_RETRIES - 1) {
        logger.warn({ err: sanitizeErr(err), symbol, orderId: options.orderId }, "Unable to fetch closed PnL snapshot");
      }
    }

    if (attempt < MAX_EXECUTION_FETCH_RETRIES - 1) {
      await new Promise(resolve => setTimeout(resolve, EXECUTION_FETCH_RETRY_DELAY_MS));
    }
  }

  return null;
}

async function fetchCloseExecutionPrice(symbol: string, orderId: string): Promise<number | null> {
  const auth = getAuthClient();
  if (!auth) return null;

  for (let attempt = 0; attempt < MAX_EXECUTION_FETCH_RETRIES; attempt++) {
    try {
      const execRes = await auth.getExecutionList({
        category: "linear",
        symbol,
        orderId,
        limit: EXECUTION_LIST_LIMIT,
      });
      const execList = execRes.result?.list ?? [];
      const fills = execList
        .map((e: any) => ({
          price: parseFloat(e.execPrice ?? "0"),
          qty: parseFloat(e.execQty ?? "0"),
        }))
        .filter((f: any) => f.price > 0 && f.qty > 0);

      if (fills.length > 0) {
        const totalQty = fills.reduce((sum: number, f: any) => sum + f.qty, 0);
        if (!Number.isFinite(totalQty) || totalQty <= 0) return null;
        const weightedPriceSum = fills.reduce((sum: number, f: any) => sum + f.price * f.qty, 0);
        return weightedPriceSum / totalQty;
      }
    } catch (err) {
      if (attempt === MAX_EXECUTION_FETCH_RETRIES - 1) {
        logger.warn({ err: sanitizeErr(err), symbol, orderId }, "Unable to fetch execution list for close order");
      }
    }
    if (attempt < MAX_EXECUTION_FETCH_RETRIES - 1) {
      await new Promise(resolve => setTimeout(resolve, EXECUTION_FETCH_RETRY_DELAY_MS));
    }
  }

  try {
    const histRes = await auth.getHistoricOrders({
      category: "linear",
      symbol,
      orderId,
      limit: 1,
    } as any);
    const first = histRes.result?.list?.[0] as any;
    const avgPrice = parseFloat(first?.avgPrice ?? "0");
    if (avgPrice > 0) return avgPrice;
  } catch (err) {
    logger.warn({ err: sanitizeErr(err), symbol, orderId }, "Unable to fetch historic order for close price fallback");
  }

  return null;
}
