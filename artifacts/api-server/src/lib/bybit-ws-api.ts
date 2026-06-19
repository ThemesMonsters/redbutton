/**
 * Bybit WS-API client — places orders over WebSocket.
 *
 * ENVIRONMENT ISSUE:
 *   Bybit REST API (api.bybit.com / api.bytick.com) is geo-blocked by CloudFront
 *   on Replit / AWS IPs.
 *
 *   stream.bybit.com/v5/TRADE is ALSO blocked from Replit (403 on WS upgrade).
 *   stream.bybit.com/v5/PRIVATE is NOT blocked — wallet/order/position feeds work fine.
 *
 * WORKAROUND:
 *   Redirect the WebsocketAPIClient to connect on /v5/private instead of /v5/trade
 *   by passing wsUrl: 'wss://stream.bybit.com/v5/private'.
 *   Bybit supports order-placement operations on the private WS endpoint since 2024.
 */

import { WebsocketAPIClient } from "bybit-api";
import { logger } from "./logger";

const WS_ORDER_TIMEOUT_MS = 8000;

let wsApiClient: WebsocketAPIClient | null = null;
let initialized = false;

export function initWSApiClient(key: string, secret: string): void {
  if (initialized) return;
  initialized = true;
  wsApiClient = new WebsocketAPIClient({
    market: "v5",
    key,
    secret,
    // /v5/trade is CloudFront-blocked on Replit; /v5/private uses different CDN path and works.
    // Bybit unified the Trade WS and Private WS — order ops are accepted on /v5/private.
    wsUrl: "wss://stream.bybit.com/v5/private",
  } as any);
  logger.info("Bybit WS-API client initialised — orders via stream.bybit.com/v5/private");
}

export function getWSApiClient(): WebsocketAPIClient | null {
  return wsApiClient;
}

/**
 * Submit a single order via WS-API with a hard timeout.
 * Returns the raw Bybit response, or throws on error/timeout.
 */
export async function submitOrderWS(params: Record<string, unknown>): Promise<unknown> {
  if (!wsApiClient) throw new Error("WS-API client not initialised");

  const orderPromise = wsApiClient.submitNewOrder(params as any);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`WS-API submitNewOrder timed out after ${WS_ORDER_TIMEOUT_MS}ms`)), WS_ORDER_TIMEOUT_MS),
  );
  return Promise.race([orderPromise, timeoutPromise]);
}

export function closeWSApiClient(): void {
  if (wsApiClient) {
    try { wsApiClient.getWSClient().closeAll(); } catch { /* ignore */ }
    wsApiClient = null;
  }
  initialized = false;
}
