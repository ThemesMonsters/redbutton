/**
 * Browser Relay — executes live Bybit requests from the browser.
 *
 * Bybit blocks order endpoints (REST + WS /v5/trade) on Replit/AWS server IPs.
 * The user's browser is NOT blocked. This hook polls our server for pending
 * signed requests and executes them directly against api.bybit.com.
 *
 * Supports both POST (orders, leverage, TP/SL) and GET (position fetch) requests.
 *
 * Security: The API secret never leaves the server. The browser only receives
 * an already-signed payload (valid 30 s) and sends it to Bybit.
 */

import { useEffect } from "react";

const POLL_MS = 700;
const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

async function executeRequest(order: {
  id: number;
  method?: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}) {
  let bybitOrderId: string | undefined;
  let responseBody: string | undefined;
  let error: string | undefined;

  try {
    const method = (order.method ?? "POST").toUpperCase();
    let resp: Response;

    if (method === "GET") {
      // Body field contains the query string for GET requests.
      const url = `${order.url}?${order.body}`;
      const headers = { ...order.headers };
      delete headers["Content-Type"];
      resp = await fetch(url, { method: "GET", headers });
    } else {
      resp = await fetch(order.url, {
        method: "POST",
        headers: order.headers,
        body: order.body,
      });
    }

    const json = await resp.json();
    responseBody = JSON.stringify(json);

    // 0       = success
    // 110043  = leverage not modified (already at target) — treat as success
    // 110025  = position not found / already closed — treat as success for close orders
    // 110045  = position qty is zero — treat as success for close orders
    const OK_CODES = [0, 110043, 110025, 110045];
    if (OK_CODES.includes(json.retCode)) {
      bybitOrderId = json.result?.orderId ?? "relay-ok";
    } else {
      error = `retCode ${json.retCode}: ${json.retMsg}`;
    }
  } catch (e: any) {
    error = e?.message ?? "fetch failed";
  }

  await fetch(`${BASE}/api/live-orders/${order.id}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bybitOrderId, responseBody, error }),
  }).catch(() => {});
}

export function useLiveOrderRelay() {
  useEffect(() => {
    let alive = true;
    const executing = new Set<number>();

    async function poll() {
      if (!alive) return;
      try {
        const res = await fetch(`${BASE}/api/live-orders/pending`);
        if (res.ok) {
          const data = await res.json();
          for (const order of data.orders ?? []) {
            if (!executing.has(order.id)) {
              executing.add(order.id);
              executeRequest(order).finally(() => executing.delete(order.id));
            }
          }
        }
      } catch {
        // network error — just wait and retry
      }
      if (alive) setTimeout(poll, POLL_MS);
    }

    poll();
    return () => { alive = false; };
  }, []);
}
