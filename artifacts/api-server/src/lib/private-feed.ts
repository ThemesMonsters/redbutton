/**
 * Bybit private WebSocket feed — balance, orders, positions in real-time.
 *
 * Bybit REST API is geo-blocked on Replit's AWS/CloudFront IPs, but the
 * WebSocket stream endpoint (stream.bybit.com) is NOT blocked. This module
 * subscribes to the `wallet` private topic to get live balance without REST.
 */

import { WebsocketClient } from "bybit-api";
import { logger } from "./logger";

interface WalletSnapshot {
  balance: number;
  equity: number;
  updatedAt: number;
}

let wsPrivate: WebsocketClient | null = null;
let walletCache: WalletSnapshot | null = null;
let initialized = false;

function handlePrivateMessage(data: any) {
  const topic: string = data.topic || "";

  // Debug: log every private message type so we can see what Bybit is sending
  if (topic && topic !== "pong") {
    logger.info({ topic, dataKeys: Object.keys(data) }, "Private WS message received");
  }

  if (topic === "wallet") {
    const list: any[] = Array.isArray(data.data) ? data.data : [data.data];
    for (const account of list) {
      if (!account) continue;

      let balance = parseFloat(account.totalWalletBalance || "0");
      let equity  = parseFloat(account.totalEquity       || "0");

      // CONTRACT / SPOT accounts store per-coin balances instead of totals
      if ((!balance && !equity) && Array.isArray(account.coin) && account.coin.length) {
        balance = account.coin.reduce(
          (s: number, c: any) => s + parseFloat(c.walletBalance || "0"), 0,
        );
        equity = account.coin.reduce(
          (s: number, c: any) => s + parseFloat(c.equity || c.walletBalance || "0"), 0,
        );
      }

      if (balance > 0 || equity > 0) {
        walletCache = { balance, equity, updatedAt: Date.now() };
        logger.info({ balance, equity, accountType: account.accountType }, "Private WS: wallet updated");
        return;
      }
    }
  }
}

export function initPrivateFeed(key: string, secret: string): void {
  if (initialized) return;
  initialized = true;

  try {
    wsPrivate = new WebsocketClient({ market: "v5", key, secret });

    wsPrivate.on("open", () => {
      logger.info("Bybit private WebSocket connected — wallet feed active");
    });

    wsPrivate.on("update", (data: any) => {
      const topic: string = data?.topic || "";
      // Log ALL update messages regardless of topic
      logger.info({ topic: topic || "(none)", op: data?.op, keys: Object.keys(data || {}) }, "Private WS update event");
      handlePrivateMessage(data);
    });

    // response events = subscription confirmations + pong
    (wsPrivate as any).on("response", (data: any) => {
      logger.info({ op: data?.op, success: data?.success, retMsg: data?.ret_msg }, "Private WS response event");
    });

    wsPrivate.on("close", () => {
      logger.warn("Bybit private WebSocket closed — will reconnect");
      initialized = false;
    });

    (wsPrivate as any).on("error", (err: any) => {
      logger.warn({ message: err?.message || String(err) }, "Bybit private WebSocket error");
      initialized = false;
    });

    // category is ignored for private topics; isPrivateTopic=true routes to the private WS key
    wsPrivate.subscribeV5(["wallet", "order", "position.linear"], "linear", true);
  } catch (err) {
    logger.error({ err }, "Failed to initialize private WebSocket");
    initialized = false;
  }
}

export function closePrivateFeed(): void {
  if (wsPrivate) {
    wsPrivate.closeAll();
    wsPrivate = null;
  }
  initialized = false;
  walletCache = null;
}

/** Allows browser-relay balance sync to inject a fresh snapshot into the cache */
export function setWalletCache(balance: number, equity: number): void {
  walletCache = { balance, equity, updatedAt: Date.now() };
  logger.info({ balance, equity }, "Wallet cache updated via browser relay sync");
}

/** Returns cached wallet balance from the private WS, or null if not yet received */
export function getPrivateBalance(): WalletSnapshot | null {
  if (!walletCache) return null;
  // Consider stale only after 24 h — Bybit only pushes wallet updates on changes,
  // so a stable set of open positions may produce no updates for hours.
  if (Date.now() - walletCache.updatedAt > 24 * 60 * 60_000) return null;
  return walletCache;
}

export function isPrivateFeedActive(): boolean {
  return initialized && wsPrivate !== null;
}
