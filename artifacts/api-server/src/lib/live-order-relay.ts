/**
 * Browser Relay — live order placement via the user's browser.
 *
 * WHY THIS EXISTS:
 *   Bybit blocks ALL trading endpoints (REST + WS /v5/trade) on Replit/AWS IPs
 *   via CloudFront. The user's browser is NOT blocked. This module:
 *
 *   1. Signs the Bybit request server-side (API secret never leaves server)
 *   2. Stores the signed payload in DB with status "pending"
 *   3. The browser polls GET /api/live-orders/pending, executes the fetch() to
 *      api.bybit.com (from its non-blocked IP), and POSTs the result back
 *   4. This function polls the DB until the result arrives (max 60 s)
 */

import crypto from "node:crypto";
import { db } from "@workspace/db";
import { liveOrderQueueTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const BYBIT_ORDER_URL        = "https://api.bybit.com/v5/order/create";
const BYBIT_SET_LEVERAGE_URL = "https://api.bybit.com/v5/position/set-leverage";
const BYBIT_POSITIONS_URL    = "https://api.bybit.com/v5/position/list";
const RECV_WINDOW = "30000";
const POLL_MS     = 400;
const TIMEOUT_MS  = 60_000;

let _key: string | null = null;
let _secret: string | null = null;

export function setRelayKeys(key: string | null, secret: string | null) {
  _key = key;
  _secret = secret;
}

export function getRelayKeys() {
  return { key: _key, secret: _secret };
}

function sign(signInput: string, key: string, secret: string) {
  const ts = String(Date.now());
  const val = ts + key + RECV_WINDOW + signInput;
  const sig = crypto.createHmac("sha256", secret).update(val).digest("hex");
  return { ts, sig };
}

/**
 * Queue any signed Bybit API request for browser execution.
 * For POST: body is JSON, signed over body.
 * For GET:  body stores the query string, signed over query string;
 *           browser appends it to the URL.
 * Returns the full responseBody on success (or bybitOrderId for order requests).
 * Throws on failure or timeout.
 */
async function queueBybitRequest(
  url: string,
  params: Record<string, unknown>,
  method: "POST" | "GET" = "POST",
): Promise<string> {
  const key    = _key    ?? process.env.BYBIT_API_KEY    ?? null;
  const secret = _secret ?? process.env.BYBIT_API_SECRET ?? null;
  if (!key || !secret) throw new Error("No API keys configured");

  let body: string;
  if (method === "GET") {
    body = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString();
  } else {
    body = JSON.stringify(params);
  }

  const { ts, sig } = sign(body, key, secret);
  const requestId = crypto.randomUUID();

  await db.insert(liveOrderQueueTable).values({
    requestId,
    method,
    url,
    body,
    apiKey: key,
    sign: sig,
    ts,
    recvWindow: RECV_WINDOW,
    status: "pending",
  });

  logger.info({ requestId, method, endpoint: url.split("/v5/")[1], symbol: params.symbol }, "Bybit request queued for browser relay");

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const rows = await db.select().from(liveOrderQueueTable)
      .where(eq(liveOrderQueueTable.requestId, requestId)).limit(1);
    const row = rows[0];
    if (!row) throw new Error("Request record disappeared");
    if (row.status === "done")   return row.responseBody ?? row.bybitOrderId ?? "ok";
    if (row.status === "failed") throw new Error(row.errorMessage ?? "Browser relay: request failed");
  }
  throw new Error("Browser relay: timed out waiting for browser to execute request");
}

/**
 * Queue an order for browser execution. Returns the Bybit orderId on success.
 * Throws if the order fails or times out.
 */
export async function queueLiveOrder(params: Record<string, unknown>): Promise<string> {
  logger.info({ symbol: params.symbol, side: params.side, qty: params.qty }, "Live order queued for browser relay");
  return queueBybitRequest(BYBIT_ORDER_URL, params, "POST");
}

/**
 * Update TP (and optionally SL) on an open Bybit position via browser relay (best-effort).
 * Uses /v5/position/trading-stop so it applies to the whole position regardless of qty.
 */
export async function queueUpdateTpSl(
  symbol: string,
  positionIdx: number,
  takeProfit: string,
  stopLoss?: string,
): Promise<void> {
  const params: Record<string, unknown> = {
    category: "linear",
    symbol,
    positionIdx,
    takeProfit,
  };
  if (stopLoss !== undefined) params.stopLoss = stopLoss;
  try {
    await queueBybitRequest("https://api.bybit.com/v5/position/trading-stop", params, "POST");
    logger.info({ symbol, positionIdx, takeProfit, stopLoss }, "TP/SL updated on Bybit via browser relay");
  } catch (err: any) {
    logger.warn({ err: err.message, symbol }, "queueUpdateTpSl failed — continuing");
  }
}

/**
 * Set leverage on Bybit for a symbol via browser relay (best-effort — never throws).
 * Must be called before opening a position so Bybit uses the correct leverage.
 */
export async function queueSetLeverage(symbol: string, leverage: number): Promise<void> {
  try {
    await queueBybitRequest(BYBIT_SET_LEVERAGE_URL, {
      category:     "linear",
      symbol,
      buyLeverage:  String(leverage),
      sellLeverage: String(leverage),
    }, "POST");
    logger.info({ symbol, leverage }, "Leverage set via browser relay");
  } catch (err: any) {
    logger.warn({ err: err.message, symbol, leverage }, "queueSetLeverage failed — continuing with existing leverage");
  }
}

/**
 * Fetch all open linear positions from Bybit via browser relay.
 * Returns the array of position objects from Bybit's response.
 * Throws if the request fails or times out.
 */
export async function queueFetchPositions(): Promise<any[]> {
  const raw = await queueBybitRequest(BYBIT_POSITIONS_URL, {
    category:    "linear",
    settleCoin:  "USDT",
    limit:       "200",
  }, "GET");
  try {
    const parsed = JSON.parse(raw);
    if (parsed.retCode !== 0) throw new Error(`Bybit retCode ${parsed.retCode}: ${parsed.retMsg}`);
    return parsed.result?.list ?? [];
  } catch (err: any) {
    throw new Error(`Failed to parse Bybit positions response: ${err.message}`);
  }
}
